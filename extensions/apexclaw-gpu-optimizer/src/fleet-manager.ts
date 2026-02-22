/**
 * Fleet manager for distributing agents across multiple low-end GPU nodes.
 *
 * Manages a fleet of 1070 Ti (or similar 8GB) machines, each running
 * Ollama + the custom Qwen3 MoE via vLLM. Distributes agent workloads
 * based on node capabilities, current load, and task requirements.
 */

import type { AgentTemplate } from "./trading-agents.js";
import type { RouterConfig, RouteDecision, TradingTaskType } from "./tiered-router.js";
import { routeTask } from "./tiered-router.js";
import { resolveGpuProfile, type GpuProfile } from "./gpu-profiles.js";

export type FleetNodeConfig = {
  /** Unique node identifier */
  id: string;
  /** Hostname or IP */
  host: string;
  /** Ollama port (default 11434) */
  ollamaPort: number;
  /** vLLM port (default 8000) */
  vllmPort: number;
  /** GPU VRAM in MB */
  gpuVramMb: number;
  /** Node role: determines which agents get assigned here */
  role: "fast" | "general" | "reasoning" | "mixed";
  /** Whether custom Qwen3 MoE is loaded on this node */
  hasCustomQwen: boolean;
  /** Max concurrent inference requests */
  maxConcurrency: number;
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
};

export type FleetConfig = {
  nodes: FleetNodeConfig[];
  /** Health check interval in ms (default 30000) */
  healthCheckIntervalMs: number;
  /** Timeout for health checks in ms (default 5000) */
  healthCheckTimeoutMs: number;
};

/**
 * Default fleet configuration for a 3-node 1070 Ti cluster.
 * Adjust hosts to match your actual network.
 */
export const DEFAULT_FLEET_CONFIG: FleetConfig = {
  healthCheckIntervalMs: 30000,
  healthCheckTimeoutMs: 5000,
  nodes: [
    {
      id: "node-1-fast",
      host: "192.168.1.101",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "fast",
      hasCustomQwen: false,
      maxConcurrency: 1,
    },
    {
      id: "node-2-trading",
      host: "192.168.1.102",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "general",
      hasCustomQwen: true,
      maxConcurrency: 1,
    },
    {
      id: "node-3-reasoning",
      host: "192.168.1.103",
      ollamaPort: 11434,
      vllmPort: 8000,
      gpuVramMb: 8192,
      role: "reasoning",
      hasCustomQwen: false,
      maxConcurrency: 1,
    },
  ],
};

export class FleetManager {
  private nodes: Map<string, FleetNode> = new Map();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: FleetConfig) {
    for (const nodeConfig of config.nodes) {
      this.nodes.set(nodeConfig.id, {
        ...nodeConfig,
        currentLoad: 0,
        gpuProfile: resolveGpuProfile(nodeConfig.gpuVramMb),
        healthy: false,
        lastHealthCheck: 0,
      });
    }
  }

  /** Start health checking all nodes */
  start(): void {
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
    const checks = Array.from(this.nodes.values()).map((node) =>
      this.checkNodeHealth(node),
    );
    await Promise.allSettled(checks);
  }

  /** Check a single node's Ollama health */
  private async checkNodeHealth(node: FleetNode): Promise<void> {
    try {
      const response = await fetch(
        `http://${node.host}:${node.ollamaPort}/api/tags`,
        { signal: AbortSignal.timeout(this.config.healthCheckTimeoutMs) },
      );
      node.healthy = response.ok;
      node.lastHealthCheck = Date.now();
    } catch {
      node.healthy = false;
      node.lastHealthCheck = Date.now();
    }
  }

  /** Get all healthy nodes */
  getHealthyNodes(): FleetNode[] {
    return Array.from(this.nodes.values()).filter((n) => n.healthy);
  }

  /** Find the best node for a given agent template */
  findNodeForAgent(agent: AgentTemplate): FleetNode | undefined {
    const candidates = this.getHealthyNodes()
      .filter((node) => {
        // Match role preference
        if (agent.preferredNodeRole === "any") return true;
        if (node.role === "mixed") return true;
        return node.role === agent.preferredNodeRole;
      })
      .filter((node) => node.currentLoad < node.maxConcurrency);

    // Sort by least loaded
    candidates.sort((a, b) => a.currentLoad - b.currentLoad);
    return candidates[0];
  }

  /** Route a task to the best available node, returning routing decision */
  routeToFleet(taskType: TradingTaskType): { node: FleetNode; route: RouteDecision } | undefined {
    const healthyNodes = this.getHealthyNodes();
    if (healthyNodes.length === 0) return undefined;

    // Find least-loaded node with capacity
    const available = healthyNodes
      .filter((n) => n.currentLoad < n.maxConcurrency)
      .sort((a, b) => a.currentLoad - b.currentLoad);

    const node = available[0];
    if (!node) return undefined;

    const routerConfig: RouterConfig = {
      gpuVramMb: node.gpuVramMb,
      localOllamaUrl: `http://${node.host}:${node.ollamaPort}`,
      localVllmUrl: `http://${node.host}:${node.vllmPort}/v1`,
      hasNvidiaApi: Boolean(process.env.NVIDIA_API_KEY),
      hasGrokApi: Boolean(process.env.XAI_API_KEY || process.env.GROK_API_KEY),
      hasClaudeApi: Boolean(process.env.ANTHROPIC_API_KEY),
      maxLocalConcurrency: node.maxConcurrency,
      currentLocalLoad: node.currentLoad,
      customQwenAvailable: node.hasCustomQwen,
    };

    const route = routeTask(taskType, routerConfig);
    return { node, route };
  }

  /** Mark a node as busy (increment load) */
  acquireSlot(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node || node.currentLoad >= node.maxConcurrency) return false;
    node.currentLoad++;
    return true;
  }

  /** Release a node slot (decrement load) */
  releaseSlot(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (node && node.currentLoad > 0) {
      node.currentLoad--;
    }
  }

  /** Get fleet status summary */
  getStatus(): {
    totalNodes: number;
    healthyNodes: number;
    totalCapacity: number;
    currentLoad: number;
    nodes: Array<{
      id: string;
      host: string;
      healthy: boolean;
      load: string;
      role: string;
      gpu: string;
    }>;
  } {
    const all = Array.from(this.nodes.values());
    const healthy = all.filter((n) => n.healthy);

    return {
      totalNodes: all.length,
      healthyNodes: healthy.length,
      totalCapacity: healthy.reduce((sum, n) => sum + n.maxConcurrency, 0),
      currentLoad: healthy.reduce((sum, n) => sum + n.currentLoad, 0),
      nodes: all.map((n) => ({
        id: n.id,
        host: `${n.host}:${n.ollamaPort}`,
        healthy: n.healthy,
        load: `${n.currentLoad}/${n.maxConcurrency}`,
        role: n.role,
        gpu: n.gpuProfile.name,
      })),
    };
  }
}
