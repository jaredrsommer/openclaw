/**
 * Queen Orchestrator — the supervisor agent that coordinates the fleet.
 *
 * Modeled after MoonDev's "queen" agent concept: a central coordinator that
 * monitors all worker nodes, manages the RBI pipeline flow, enforces risk
 * limits, and can issue fleet-wide directives (pause trading, rebalance, etc).
 *
 * Runs on the MoE machine (1-3 node setups) or a dedicated Queen node (4-node).
 * Integrates the local embedding service for signal deduplication and the API
 * optimizer for efficient request handling across all agents.
 */

import { FleetManager, type FleetEvent, type FleetNodeStatus } from "./fleet-manager.js";
import { ALL_AGENTS, getContinuousAgents, getScheduledAgents, type AgentTemplate } from "./trading-agents.js";
import type { TradingTaskType } from "./tiered-router.js";
import { LocalEmbeddingService, type EmbeddingServiceConfig } from "./local-embeddings.js";
import { ApiOptimizer, type ApiOptimizerConfig } from "./api-optimizer.js";
import { AgentBus, TOPICS, type AgentBusConfig, type AgentMessage } from "./agent-bus.js";

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
  /** Local embedding service stats (nomic-embed-text on CPU) */
  embeddings: ReturnType<LocalEmbeddingService["getStats"]> | null;
  /** API optimizer stats (caching, dedup, queuing) */
  apiOptimizer: ReturnType<ApiOptimizer["getStats"]> | null;
  /** Agent message bus stats */
  messageBus: ReturnType<AgentBus["getStats"]> | null;
  /** Recent signal dedup results */
  signalDedup: {
    totalChecked: number;
    duplicatesBlocked: number;
    dedupRate: string;
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

  /** Local embedding service — nomic-embed-text on CPU (MoE machine) */
  readonly embeddings: LocalEmbeddingService;
  /** API optimizer — caching, dedup, queuing for all providers */
  readonly apiOptimizer: ApiOptimizer;
  /** Agent message bus — inter-agent communication */
  readonly bus: AgentBus;
  /** Recent signals for dedup checking (rolling window) */
  private recentSignals: string[] = [];
  private readonly maxRecentSignals = 200;
  private signalDedupStats = { totalChecked: 0, duplicatesBlocked: 0 };

  constructor(
    private fleet: FleetManager,
    embeddingConfig?: Partial<EmbeddingServiceConfig>,
    apiConfig?: Partial<ApiOptimizerConfig>,
    busConfig?: Partial<AgentBusConfig>,
  ) {
    // Initialize optimization services
    this.embeddings = new LocalEmbeddingService(embeddingConfig);
    this.apiOptimizer = new ApiOptimizer(apiConfig);
    this.bus = new AgentBus(busConfig);

    // Wire up Queen's subscriptions to the bus
    this.setupBusSubscriptions();
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

  /** Set up Queen's subscriptions to the message bus */
  private setupBusSubscriptions(): void {
    // Queen monitors all classified signals for risk gating
    this.bus.subscribe("queen", TOPICS.SIGNALS_CLASSIFIED, async (msg) => {
      // Check for duplicate signals before allowing trade execution
      const signalJson = JSON.stringify(msg.payload);
      const dedup = await this.checkSignalDuplicate(signalJson);
      if (!dedup.isDuplicate) {
        // Forward validated signal to risk manager
        await this.bus.publish("queen", TOPICS.SIGNALS_VALIDATED, msg.payload, {
          summary: `Queen validated signal from ${msg.from}`,
          inReplyTo: msg.id,
          chain: [...(msg.chain ?? []), msg.id],
        });
      }
    });

    // Queen monitors RBI pipeline progression
    this.bus.subscribe("queen", TOPICS.RBI_RESEARCH, (msg) => {
      this.rbiPipeline.stage = "backtest";
      this.rbiPipeline.status = "backtesting";
      this.rbiPipeline.progress = 33;
      this.rbiPipeline.lastOutput = msg.summary;
    });

    this.bus.subscribe("queen", TOPICS.RBI_BACKTEST, (msg) => {
      this.rbiPipeline.stage = "implement";
      this.rbiPipeline.status = "implementing";
      this.rbiPipeline.progress = 66;
      this.rbiPipeline.lastOutput = msg.summary;
    });

    this.bus.subscribe("queen", TOPICS.RBI_IMPLEMENT, (msg) => {
      this.rbiPipeline.status = "complete";
      this.rbiPipeline.progress = 100;
      this.rbiPipeline.lastOutput = msg.summary;
    });

    // Queen monitors risk assessments
    this.bus.subscribe("queen", TOPICS.RISK_ASSESSMENT, (msg) => {
      const risk = msg.payload as { portfolioRisk?: string } | undefined;
      if (risk?.portfolioRisk === "CRITICAL") {
        this.emergencyStop(`Risk Manager: ${msg.summary}`);
      }
    });

    // Queen monitors errors
    this.bus.subscribe("queen", TOPICS.ERRORS, (msg) => {
      const agentState = this.agentStates.get(msg.from);
      if (agentState) {
        agentState.errorCount++;
        agentState.lastResult = `Error: ${msg.summary}`;
      }
    });
  }

  /** Start the orchestrator: assign agents to nodes and begin scheduling */
  async start(): Promise<void> {
    this.state = "starting";
    this.bus.start();
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

    // Announce startup on the bus
    await this.bus.publish("queen", TOPICS.QUEEN_DIRECTIVES, {
      action: "START",
      nodes: this.fleet.getStatus().totalNodes,
    }, { summary: "Queen orchestrator started" });

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
    this.bus.stop();

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

  /** Trigger an RBI pipeline run — publishes to the bus for agent coordination */
  async startRbiPipeline(hypothesis: string): Promise<void> {
    const strategyId = `rbi-${Date.now()}`;
    this.rbiPipeline = {
      status: "researching",
      currentStrategyId: strategyId,
      stage: "research",
      progress: 0,
      lastOutput: `Starting research on: ${hypothesis}`,
    };

    // Store hypothesis in shared context for all RBI agents to read
    this.bus.setContext(`rbi:${strategyId}:hypothesis`, hypothesis, "queen");

    // Publish research request to the bus — rbi-researcher picks it up
    await this.bus.publish("queen", TOPICS.RBI_STATUS, {
      strategyId,
      stage: "research",
      hypothesis,
    }, {
      summary: `RBI pipeline started: ${hypothesis}`,
      type: "directive",
    });
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

  /**
   * Check if a trading signal is a duplicate of a recently seen signal.
   * Uses local embeddings (nomic-embed-text on CPU) for semantic similarity.
   * Prevents the same signal from triggering multiple trades.
   */
  async checkSignalDuplicate(
    signalJson: string,
    threshold = 0.92,
  ): Promise<{ isDuplicate: boolean; bestMatch: number; matchIndex: number }> {
    this.signalDedupStats.totalChecked++;

    const result = await this.embeddings.isDuplicateSignal(
      signalJson,
      this.recentSignals,
      threshold,
    );

    if (result.isDuplicate) {
      this.signalDedupStats.duplicatesBlocked++;
    } else {
      // Not a duplicate — add to recent signals window
      this.recentSignals.push(signalJson);
      if (this.recentSignals.length > this.maxRecentSignals) {
        this.recentSignals.shift();
      }
    }

    return result;
  }

  /**
   * Find strategies similar to a given hypothesis using embeddings.
   * Useful for the RBI pipeline to avoid re-researching similar ideas.
   */
  async findSimilarStrategies(
    hypothesis: string,
    pastStrategies: string[],
    topK = 3,
  ): Promise<Array<{ text: string; score: number; index: number }>> {
    return this.embeddings.findMostSimilar(hypothesis, pastStrategies, topK);
  }

  /** Get the full orchestrator snapshot for the dashboard */
  getSnapshot(): OrchestratorSnapshot {
    const fleetStatus = this.fleet.getStatus();
    const total = this.signalDedupStats.totalChecked;
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
      embeddings: this.embeddings.getStats(),
      apiOptimizer: this.apiOptimizer.getStats(),
      messageBus: this.bus.getStats(),
      signalDedup: {
        ...this.signalDedupStats,
        dedupRate: total > 0
          ? `${((this.signalDedupStats.duplicatesBlocked / total) * 100).toFixed(1)}%`
          : "0%",
      },
    };
  }

  /** Get current state */
  getState(): QueenState {
    return this.state;
  }
}
