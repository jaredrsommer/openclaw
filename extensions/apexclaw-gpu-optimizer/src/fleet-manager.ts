/**
 * Fleet manager for distributing agents across multiple low-end GPU nodes.
 *
 * Manages a fleet of 4x GTX 1070 Ti (8GB each) machines, each running
 * Ollama + optional custom Qwen3 MoE via vLLM. Distributes agent workloads
 * based on node capabilities, current load, and task requirements.
 *
 * 4-Node Architecture (mirrors MoonDev's 6-OpenClaw setup with 4 GPUs):
 *
 *   Node 1 "Sentinel"  — Real-time feeds: Stream Observer + Liquidation Detector + Signal Classifier
 *                         Loads: Qwen 3B (always hot) for lowest latency
 *
 *   Node 2 "Strategist" — Custom Qwen3 MoE via vLLM: Sentiment + Anomaly + Order Generation
 *                         Loads: Your trading-trained MoE model
 *
 *   Node 3 "Coder"      — RBI pipeline: Backtest code gen + implementation assist
 *                         Loads: Qwen Coder 7B / DeepSeek R1 7B
 *
 *   Node 4 "Queen"       — Orchestrator: Risk Manager + Queen supervisor + dashboard host
 *                         Loads: Qwen 7B general + coordinates API calls to Claude/Grok/NVIDIA
 *                         Runs the dashboard web server
 */

import type { AgentTemplate } from "./trading-agents.js";
import type { RouterConfig, RouteDecision, TradingTaskType } from "./tiered-router.js";
import { routeTask } from "./tiered-router.js";
import { resolveGpuProfile, type GpuProfile } from "./gpu-profiles.js";

export type FleetNodeConfig = {
  /** Unique node identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Hostname or IP */
  host: string;
  /** Ollama port (default 11434) */
  ollamaPort: number;
  /** vLLM port (default 8000) */
  vllmPort: number;
  /** GPU VRAM in MB */
  gpuVramMb: number;
  /** Node role: determines which agents get assigned here */
  role: "sentinel" | "strategist" | "coder" | "queen";
  /** Whether custom Qwen3 MoE is loaded on this node */
  hasCustomQwen: boolean;
  /** Max concurrent inference requests */
  maxConcurrency: number;
  /** Agents permanently assigned to this node */
  assignedAgents: string[];
  /** Whether this node hosts the dashboard */
  isDashboardHost: boolean;
};

export type FleetNode = FleetNodeConfig & {
  /** Current active inference count */
  currentLoad: number;
  /** Resolved GPU profile */
  gpuProfile: GpuProfile;
  /** Is this node healthy/reachable */
  healthy: boolean;
  /** Last health check timestamp */
  lastHealthCheck: number;
  /** Loaded Ollama models discovered at health check */
  loadedModels: string[];
  /** GPU utilization percentage (0-100) from last check */
  gpuUtilPct: number;
  /** Total inferences completed since start */
  totalInferences: number;
  /** Uptime in ms */
  uptimeMs: number;
  /** Last error message if unhealthy */
  lastError: string;
};

export type FleetConfig = {
  nodes: FleetNodeConfig[];
  /** Health check interval in ms (default 15000 for 4-node) */
  healthCheckIntervalMs: number;
  /** Timeout for health checks in ms (default 5000) */
  healthCheckTimeoutMs: number;
  /** Dashboard server port (default 3939) */
  dashboardPort: number;
};

/**
 * Default fleet configuration for a 4-node GTX 1070 Ti cluster.
 * Each node has a dedicated purpose — no model swapping needed.
 */
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  healthCheckIntervalMs: 15000,
  healthCheckTimeoutMs: 5000,
  dashboardPort: 3939,
  nodes: [
    {
      id: "node-1-sentinel",
      name: "Sentinel",
      host: "192.168.1.101",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "sentinel",
      hasCustomQwen: false,
      maxConcurrency: 2,
      assignedAgents: ["stream-observer", "signal-classifier", "liquidation-detector"],
      isDashboardHost: false,
    },
    {
      id: "node-2-strategist",
      name: "Strategist",
      host: "192.168.1.102",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "strategist",
      hasCustomQwen: true,
      maxConcurrency: 1,
      assignedAgents: ["sentiment-analyzer", "anomaly-hunter"],
      isDashboardHost: false,
    },
    {
      id: "node-3-coder",
      name: "Coder",
      host: "192.168.1.103",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "coder",
      hasCustomQwen: false,
      maxConcurrency: 1,
      assignedAgents: ["rbi-researcher", "rbi-backtester", "rbi-implementer"],
      isDashboardHost: false,
    },
    {
      id: "node-4-queen",
      name: "Queen",
      host: "192.168.1.104",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "queen",
      hasCustomQwen: false,
      maxConcurrency: 1,
      assignedAgents: ["risk-manager", "polymarket-analyst"],
      isDashboardHost: true,
    },
  ],
};

/** Event types emitted by the fleet manager for the dashboard */
export type FleetEvent =
  | { type: "health-check"; timestamp: number; nodes: FleetNodeStatus[] }
  | { type: "task-routed"; timestamp: number; taskType: TradingTaskType; nodeId: string; route: RouteDecision }
  | { type: "task-completed"; timestamp: number; taskType: TradingTaskType; nodeId: string; durationMs: number }
  | { type: "node-down"; timestamp: number; nodeId: string; error: string }
  | { type: "node-recovered"; timestamp: number; nodeId: string }
  | { type: "queen-directive"; timestamp: number; action: string; reason: string };

export type FleetNodeStatus = {
  id: string;
  name: string;
  host: string;
  role: string;
  healthy: boolean;
  load: string;
  gpu: string;
  gpuUtilPct: number;
  loadedModels: string[];
  assignedAgents: string[];
  totalInferences: number;
  uptimeMs: number;
  lastError: string;
};

export type FleetEventListener = (event: FleetEvent) => void;

export class FleetManager {
  private nodes: Map<string, FleetNode> = new Map();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = Date.now();
  private eventListeners: FleetEventListener[] = [];
  /** Recent events kept for dashboard init (last 200) */
  private eventLog: FleetEvent[] = [];

  constructor(private config: FleetConfig) {
    for (const nodeConfig of config.nodes) {
      this.nodes.set(nodeConfig.id, {
        ...nodeConfig,
        currentLoad: 0,
        gpuProfile: resolveGpuProfile(nodeConfig.gpuVramMb),
        healthy: false,
        lastHealthCheck: 0,
        loadedModels: [],
        gpuUtilPct: 0,
        totalInferences: 0,
        uptimeMs: 0,
        lastError: "",
      });
    }
  }

  /** Subscribe to fleet events (used by dashboard WebSocket) */
  onEvent(listener: FleetEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  /** Get recent event log for dashboard initialization */
  getEventLog(): FleetEvent[] {
    return [...this.eventLog];
  }

  private emit(event: FleetEvent): void {
    this.eventLog.push(event);
    if (this.eventLog.length > 200) this.eventLog.shift();
    for (const listener of this.eventListeners) {
      try { listener(event); } catch { /* ignore listener errors */ }
    }
  }

  /** Start health checking all nodes */
  start(): void {
    this.startTime = Date.now();
    this.checkAllHealth();
    this.healthCheckTimer = setInterval(
      () => this.checkAllHealth(),
      this.config.healthCheckIntervalMs,
    );
  }

  /** Stop the fleet manager */
  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Check health of all nodes in parallel */
  async checkAllHealth(): Promise<void> {
    const previousHealth = new Map<string, boolean>();
    for (const [id, node] of this.nodes) {
      previousHealth.set(id, node.healthy);
    }

    const checks = Array.from(this.nodes.values()).map((node) =>
      this.checkNodeHealth(node),
    );
    await Promise.allSettled(checks);

    // Emit recovery / down events
    for (const [id, node] of this.nodes) {
      const wasHealthy = previousHealth.get(id) ?? false;
      if (!wasHealthy && node.healthy) {
        this.emit({ type: "node-recovered", timestamp: Date.now(), nodeId: id });
      } else if (wasHealthy && !node.healthy) {
        this.emit({ type: "node-down", timestamp: Date.now(), nodeId: id, error: node.lastError });
      }
    }

    // Emit health check summary
    this.emit({
      type: "health-check",
      timestamp: Date.now(),
      nodes: this.getNodeStatuses(),
    });
  }

  /** Check a single node's Ollama health + discover loaded models */
  private async checkNodeHealth(node: FleetNode): Promise<void> {
    try {
      const response = await fetch(
        `http://${node.host}:${node.ollamaPort}/api/tags`,
        { signal: AbortSignal.timeout(this.config.healthCheckTimeoutMs) },
      );
      if (response.ok) {
        node.healthy = true;
        node.lastError = "";
        node.uptimeMs = Date.now() - this.startTime;
        try {
          const data = await response.json() as { models?: Array<{ name?: string }> };
          node.loadedModels = (data.models ?? [])
            .map((m) => m.name ?? "")
            .filter(Boolean);
        } catch {
          node.loadedModels = [];
        }
      } else {
        node.healthy = false;
        node.lastError = `HTTP ${response.status}`;
      }
      node.lastHealthCheck = Date.now();
    } catch (err) {
      node.healthy = false;
      node.lastError = String(err instanceof Error ? err.message : err);
      node.lastHealthCheck = Date.now();
    }
  }

  /** Get all healthy nodes */
  getHealthyNodes(): FleetNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.healthy);
  }

  /** Get all nodes */
  getAllNodes(): FleetNode[] {
    return Array.from(this.nodes.values());
  }

  /** Find the best node for a given agent template */
  findNodeForAgent(agent: AgentTemplate): FleetNode | undefined {
    // First try nodes that have this agent explicitly assigned
    const assigned = this.getHealthyNodes().filter((n) =>
      n.assignedAgents.includes(agent.id) && n.currentLoad < n.maxConcurrency,
    );
    if (assigned.length > 0) {
      assigned.sort((a, b) => a.currentLoad - b.currentLoad);
      return assigned[0];
    }

    // Fall back to role-based matching
    const roleMap: Record<string, string[]> = {
      fast: ["sentinel"],
      general: ["strategist", "queen"],
      reasoning: ["coder", "queen"],
      any: ["sentinel", "strategist", "coder", "queen"],
    };

    const targetRoles = roleMap[agent.preferredNodeRole] ?? ["queen"];
    const candidates = this.getHealthyNodes()
      .filter((node) => targetRoles.includes(node.role))
      .filter((node) => node.currentLoad < node.maxConcurrency);

    candidates.sort((a, b) => a.currentLoad - b.currentLoad);
    return candidates[0];
  }

  /** Route a task to the best available node, returning routing decision */
  routeToFleet(taskType: TradingTaskType): { node: FleetNode; route: RouteDecision } | undefined {
    const healthyNodes = this.getHealthyNodes();
    if (healthyNodes.length === 0) return undefined;

    // Smart routing: match task type to the node that owns that agent
    const agentTaskMap: Record<string, string[]> = {
      sentinel: ["stream-observation", "signal-classification", "liquidation-detection"],
      strategist: ["sentiment-analysis", "anomaly-detection", "order-generation"],
      coder: ["rbi-research", "rbi-backtest", "rbi-implement"],
      queen: ["risk-assessment", "polymarket-analysis", "market-summary", "general"],
    };

    // Find the dedicated node for this task type
    let targetNode: FleetNode | undefined;
    for (const node of healthyNodes) {
      const tasks = agentTaskMap[node.role] ?? [];
      if (tasks.includes(taskType) && node.currentLoad < node.maxConcurrency) {
        targetNode = node;
        break;
      }
    }

    // Fallback to least-loaded node
    if (!targetNode) {
      const available = healthyNodes
        .filter((n) => n.currentLoad < n.maxConcurrency)
        .sort((a, b) => a.currentLoad - b.currentLoad);
      targetNode = available[0];
    }

    if (!targetNode) return undefined;

    const routerConfig: RouterConfig = {
      gpuVramMb: targetNode.gpuVramMb,
      localOllamaUrl: `http://${targetNode.host}:${targetNode.ollamaPort}`,
      localVllmUrl: `http://${targetNode.host}:${targetNode.vllmPort}/v1`,
      hasNvidiaApi: Boolean(process.env.NVIDIA_API_KEY),
      hasGrokApi: Boolean(process.env.XAI_API_KEY || process.env.GROK_API_KEY),
      hasClaudeApi: Boolean(process.env.ANTHROPIC_API_KEY),
      maxLocalConcurrency: targetNode.maxConcurrency,
      currentLocalLoad: targetNode.currentLoad,
      customQwenAvailable: targetNode.hasCustomQwen,
    };

    const route = routeTask(taskType, routerConfig);
    this.emit({
      type: "task-routed",
      timestamp: Date.now(),
      taskType,
      nodeId: targetNode.id,
      route,
    });
    return { node: targetNode, route };
  }

  /** Mark a node as busy (increment load) */
  acquireSlot(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.currentLoad >= node.maxConcurrency) return false;
    node.currentLoad++;
    return true;
  }

  /** Release a node slot (decrement load) */
  releaseSlot(nodeId: string, taskType?: TradingTaskType, durationMs?: number): void {
    const node = this.nodes.get(nodeId);
    if (node && node.currentLoad > 0) {
      node.currentLoad--;
      node.totalInferences++;
      if (taskType) {
        this.emit({
          type: "task-completed",
          timestamp: Date.now(),
          taskType,
          nodeId,
          durationMs: durationMs ?? 0,
        });
      }
    }
  }

  /** Get the dashboard host node */
  getDashboardHost(): FleetNode | undefined {
    return Array.from(this.nodes.values()).find((n) => n.isDashboardHost);
  }

  /** Get node statuses for dashboard rendering */
  getNodeStatuses(): FleetNodeStatus[] {
    return Array.from(this.nodes.values()).map((n) => ({
      id: n.id,
      name: n.name,
      host: `${n.host}:${n.ollamaPort}`,
      role: n.role,
      healthy: n.healthy,
      load: `${n.currentLoad}/${n.maxConcurrency}`,
      gpu: n.gpuProfile.name,
      gpuUtilPct: n.gpuUtilPct,
      loadedModels: n.loadedModels,
      assignedAgents: n.assignedAgents,
      totalInferences: n.totalInferences,
      uptimeMs: n.uptimeMs,
      lastError: n.lastError,
    }));
  }

  /** Get fleet status summary */
  getStatus(): {
    totalNodes: number;
    healthyNodes: number;
    totalCapacity: number;
    currentLoad: number;
    totalInferences: number;
    uptimeMs: number;
    dashboardUrl: string | null;
    nodes: FleetNodeStatus[];
  } {
    const all = Array.from(this.nodes.values());
    const healthy = all.filter((n) => n.healthy);
    const dashHost = this.getDashboardHost();

    return {
      totalNodes: all.length,
      healthyNodes: healthy.length,
      totalCapacity: healthy.reduce((sum, n) => sum + n.maxConcurrency, 0),
      currentLoad: healthy.reduce((sum, n) => sum + n.currentLoad, 0),
      totalInferences: all.reduce((sum, n) => sum + n.totalInferences, 0),
      uptimeMs: Date.now() - this.startTime,
      dashboardUrl: dashHost
        ? `http://${dashHost.host}:${this.config.dashboardPort}`
        : null,
      nodes: this.getNodeStatuses(),
    };
  }
}
