/**
 * Queen Orchestrator — the supervisor agent that coordinates the 4-node fleet.
 *
 * Modeled after MoonDev's "queen" agent concept: a central coordinator that
 * monitors all worker nodes, manages the RBI pipeline flow, enforces risk
 * limits, and can issue fleet-wide directives (pause trading, rebalance, etc).
 *
 * The Queen runs on Node 4 alongside the dashboard and is the only agent
 * allowed to call paid APIs (Claude Max) for critical reasoning decisions.
 */

import { FleetManager, type FleetEvent, type FleetNodeStatus } from "./fleet-manager.js";
import { ALL_AGENTS, getContinuousAgents, getScheduledAgents, type AgentTemplate } from "./trading-agents.js";
import type { TradingTaskType } from "./tiered-router.js";

export type QueenState = "running" | "paused" | "emergency-stop" | "starting";

export type AgentState = {
  agentId: string;
  nodeId: string;
  status: "running" | "idle" | "error" | "stopped";
  lastRunAt: number;
  lastResult: string;
  runCount: number;
  errorCount: number;
};

export type RbiPipelineState = {
  status: "idle" | "researching" | "backtesting" | "implementing" | "complete" | "failed";
  currentStrategyId: string | null;
  stage: "research" | "backtest" | "implement" | null;
  progress: number;
  lastOutput: string;
};

export type PortfolioSnapshot = {
  timestamp: number;
  totalValueUsd: number;
  pnlTodayUsd: number;
  pnlTodayPct: number;
  openPositions: number;
  activeStrategies: number;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  maxDrawdownPct: number;
};

export type OrchestratorSnapshot = {
  state: QueenState;
  uptime: number;
  agents: AgentState[];
  rbiPipeline: RbiPipelineState;
  portfolio: PortfolioSnapshot;
  fleet: {
    totalNodes: number;
    healthyNodes: number;
    totalInferences: number;
    nodes: FleetNodeStatus[];
  };
  recentEvents: FleetEvent[];
  tierStats: {
    local: { calls: number; costUsd: number };
    freeApi: { calls: number; costUsd: number };
    paidApi: { calls: number; costUsd: number };
  };
};

export class QueenOrchestrator {
  private state: QueenState = "starting";
  private agentStates: Map<string, AgentState> = new Map();
  private rbiPipeline: RbiPipelineState = {
    status: "idle",
    currentStrategyId: null,
    stage: null,
    progress: 0,
    lastOutput: "",
  };
  private portfolio: PortfolioSnapshot = {
    timestamp: Date.now(),
    totalValueUsd: 0,
    pnlTodayUsd: 0,
    pnlTodayPct: 0,
    openPositions: 0,
    activeStrategies: 0,
    riskLevel: "LOW",
    maxDrawdownPct: 0,
  };
  private tierStats = {
    local: { calls: 0, costUsd: 0 },
    freeApi: { calls: 0, costUsd: 0 },
    paidApi: { calls: 0, costUsd: 0 },
  };
  private schedulerTimers: ReturnType<typeof setInterval>[] = [];

  constructor(private fleet: FleetManager) {
    // Initialize agent states
    for (const agent of ALL_AGENTS) {
      this.agentStates.set(agent.id, {
        agentId: agent.id,
        nodeId: "",
        status: "stopped",
        lastRunAt: 0,
        lastResult: "",
        runCount: 0,
        errorCount: 0,
      });
    }

    // Listen to fleet events for tier stats
    this.fleet.onEvent((event) => {
      if (event.type === "task-routed") {
        const tier = event.route.tier;
        if (tier === "local") this.tierStats.local.calls++;
        else if (tier === "free-api") this.tierStats.freeApi.calls++;
        else if (tier === "paid-api") {
          this.tierStats.paidApi.calls++;
          this.tierStats.paidApi.costUsd += event.route.estimatedCostUsd;
        }
      }
    });
  }

  /** Start the orchestrator: assign agents to nodes and begin scheduling */
  async start(): Promise<void> {
    this.state = "starting";
    this.fleet.start();

    // Wait for initial health check
    await this.fleet.checkAllHealth();

    // Assign continuous agents to their nodes
    for (const agent of getContinuousAgents()) {
      this.assignAgent(agent);
    }

    // Set up scheduled agents
    for (const agent of getScheduledAgents()) {
      this.scheduleAgent(agent);
    }

    this.state = "running";
  }

  /** Stop all agents and the orchestrator */
  stop(): void {
    this.state = "paused";
    for (const timer of this.schedulerTimers) {
      clearInterval(timer);
    }
    this.schedulerTimers = [];
    this.fleet.stop();

    for (const [, agentState] of this.agentStates) {
      agentState.status = "stopped";
    }
  }

  /** Emergency stop — halt all trading immediately */
  emergencyStop(reason: string): void {
    this.state = "emergency-stop";
    this.stop();

    this.fleet.onEvent(() => {});
    const event: FleetEvent = {
      type: "queen-directive",
      timestamp: Date.now(),
      action: "EMERGENCY_STOP",
      reason,
    };
    // Emit to any remaining listeners
    for (const listener of (this.fleet as unknown as { eventListeners: Array<(e: FleetEvent) => void> }).eventListeners ?? []) {
      try { listener(event); } catch { /* */ }
    }
  }

  /** Assign a continuous agent to its preferred node */
  private assignAgent(agent: AgentTemplate): void {
    const node = this.fleet.findNodeForAgent(agent);
    const agentState = this.agentStates.get(agent.id);
    if (!agentState) return;

    if (node) {
      agentState.nodeId = node.id;
      agentState.status = "running";
      agentState.lastRunAt = Date.now();
    } else {
      agentState.status = "error";
      agentState.lastResult = "No healthy node available for assignment";
    }
  }

  /** Schedule a periodic agent */
  private scheduleAgent(agent: AgentTemplate): void {
    // Parse simple cron intervals (e.g., "*/5 * * * *" = every 5 min)
    const intervalMs = this.parseCronInterval(agent.schedule ?? "*/5 * * * *");
    const timer = setInterval(() => {
      if (this.state !== "running") return;
      this.runScheduledAgent(agent);
    }, intervalMs);
    this.schedulerTimers.push(timer);
  }

  private parseCronInterval(cron: string): number {
    const parts = cron.split(" ");
    const minutePart = parts[0] ?? "*/5";
    const match = /^\*\/(\d+)$/.exec(minutePart);
    if (match) return parseInt(match[1]!, 10) * 60 * 1000;
    // Hourly check for hour-based schedules
    const hourPart = parts[1] ?? "*";
    const hourMatch = /^\*\/(\d+)$/.exec(hourPart);
    if (hourMatch) return parseInt(hourMatch[1]!, 10) * 3600 * 1000;
    return 5 * 60 * 1000; // Default 5 min
  }

  private runScheduledAgent(agent: AgentTemplate): void {
    const agentState = this.agentStates.get(agent.id);
    if (!agentState) return;

    const result = this.fleet.routeToFleet(agent.taskType);
    if (result) {
      agentState.nodeId = result.node.id;
      agentState.status = "running";
      agentState.lastRunAt = Date.now();
      agentState.runCount++;
    } else {
      agentState.errorCount++;
      agentState.lastResult = "No available node";
    }
  }

  /** Trigger an RBI pipeline run */
  startRbiPipeline(hypothesis: string): void {
    this.rbiPipeline = {
      status: "researching",
      currentStrategyId: `rbi-${Date.now()}`,
      stage: "research",
      progress: 0,
      lastOutput: `Starting research on: ${hypothesis}`,
    };
  }

  /** Advance RBI pipeline to next stage */
  advanceRbiPipeline(result: string): void {
    if (this.rbiPipeline.stage === "research") {
      this.rbiPipeline.stage = "backtest";
      this.rbiPipeline.status = "backtesting";
      this.rbiPipeline.progress = 33;
    } else if (this.rbiPipeline.stage === "backtest") {
      this.rbiPipeline.stage = "implement";
      this.rbiPipeline.status = "implementing";
      this.rbiPipeline.progress = 66;
    } else if (this.rbiPipeline.stage === "implement") {
      this.rbiPipeline.status = "complete";
      this.rbiPipeline.progress = 100;
    }
    this.rbiPipeline.lastOutput = result;
  }

  /** Update portfolio snapshot (called by Risk Manager agent) */
  updatePortfolio(snapshot: Partial<PortfolioSnapshot>): void {
    this.portfolio = { ...this.portfolio, ...snapshot, timestamp: Date.now() };
  }

  /** Get the full orchestrator snapshot for the dashboard */
  getSnapshot(): OrchestratorSnapshot {
    const fleetStatus = this.fleet.getStatus();
    return {
      state: this.state,
      uptime: fleetStatus.uptimeMs,
      agents: Array.from(this.agentStates.values()),
      rbiPipeline: this.rbiPipeline,
      portfolio: this.portfolio,
      fleet: {
        totalNodes: fleetStatus.totalNodes,
        healthyNodes: fleetStatus.healthyNodes,
        totalInferences: fleetStatus.totalInferences,
        nodes: fleetStatus.nodes,
      },
      recentEvents: this.fleet.getEventLog().slice(-50),
      tierStats: { ...this.tierStats },
    };
  }

  /** Get current state */
  getState(): QueenState {
    return this.state;
  }
}
