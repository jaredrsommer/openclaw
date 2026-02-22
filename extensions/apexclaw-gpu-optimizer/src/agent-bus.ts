/**
 * Agent Message Bus — the nervous system of the trading fleet.
 *
 * Enables structured communication between agents across all nodes.
 * Runs in-memory on the MoE machine (128GB RAM = massive message history).
 *
 * Features:
 *   - Pub/sub topics: agents publish results, others subscribe
 *   - Direct messaging: agent-to-agent with delivery confirmation
 *   - Shared context store: typed key-value store for passing structured data
 *   - Chain-of-thought: messages carry conversation chains across agents
 *   - File attachments: large payloads (code, datasets) via reference
 *   - Message TTL: auto-expire old messages to bound memory usage
 *
 * Message flow in the RBI pipeline:
 *   1. Queen → rbi-researcher:  "Research BTC liquidation cascades"
 *   2. rbi-researcher → bus:     Publishes research report to "rbi.research" topic
 *   3. rbi-backtester reads:     Subscribes to "rbi.research", gets the report
 *   4. rbi-backtester → bus:     Publishes backtest results to "rbi.backtest" topic
 *   5. rbi-implementer reads:    Subscribes to "rbi.backtest", gets results
 *   6. rbi-implementer → bus:    Publishes implementation to "rbi.implement" topic
 *   7. Queen reads all topics:   Monitors pipeline progress, makes go/no-go decisions
 *
 * Signal flow:
 *   1. stream-observer → "signals.raw":        Raw market observations
 *   2. signal-classifier → "signals.classified": BUY/SELL/HOLD with confidence
 *   3. risk-manager reads "signals.classified":  Validates against portfolio risk
 *   4. Queen reads risk output:                  Final trade decision
 */

/** Agent IDs in the fleet */
export type AgentId =
  | "stream-observer"
  | "signal-classifier"
  | "liquidation-detector"
  | "sentiment-analyzer"
  | "anomaly-hunter"
  | "rbi-researcher"
  | "rbi-backtester"
  | "rbi-implementer"
  | "risk-manager"
  | "polymarket-analyst"
  | "queen";

/** Standard message topics */
export const TOPICS = {
  // Signal pipeline
  SIGNALS_RAW: "signals.raw",
  SIGNALS_CLASSIFIED: "signals.classified",
  SIGNALS_VALIDATED: "signals.validated",
  LIQUIDATIONS: "signals.liquidations",

  // Analysis
  SENTIMENT: "analysis.sentiment",
  ANOMALIES: "analysis.anomalies",
  POLYMARKET: "analysis.polymarket",

  // RBI pipeline
  RBI_RESEARCH: "rbi.research",
  RBI_BACKTEST: "rbi.backtest",
  RBI_IMPLEMENT: "rbi.implement",
  RBI_STATUS: "rbi.status",

  // Risk & portfolio
  RISK_ASSESSMENT: "risk.assessment",
  PORTFOLIO_UPDATE: "risk.portfolio",

  // System
  QUEEN_DIRECTIVES: "system.queen",
  AGENT_STATUS: "system.agents",
  ERRORS: "system.errors",
} as const;

export type Topic = (typeof TOPICS)[keyof typeof TOPICS];

/** A message on the bus */
export type AgentMessage = {
  /** Unique message ID */
  id: string;
  /** Source agent */
  from: AgentId;
  /** Topic this message is published to */
  topic: Topic | string;
  /** Optional target agent (for direct messages) */
  to?: AgentId;
  /** Message type for structured handling */
  type: "data" | "request" | "response" | "error" | "directive";
  /** Structured payload (JSON-serializable) */
  payload: unknown;
  /** Human-readable summary for logging */
  summary: string;
  /** Timestamp (ms since epoch) */
  timestamp: number;
  /** Optional: ID of the message this is responding to */
  inReplyTo?: string;
  /** Optional: chain of message IDs forming a conversation */
  chain?: string[];
  /** Optional: reference to a large file/dataset in the shared store */
  attachmentKey?: string;
  /** TTL in ms (default 3600000 = 1 hour) */
  ttlMs: number;
};

/** Subscription callback */
export type MessageHandler = (message: AgentMessage) => void | Promise<void>;

type Subscription = {
  agentId: AgentId;
  topic: string;
  handler: MessageHandler;
  /** Only receive messages matching this filter */
  filter?: (msg: AgentMessage) => boolean;
};

/** Shared context store entry */
export type ContextEntry = {
  key: string;
  value: unknown;
  setBy: AgentId;
  setAt: number;
  expiresAt: number;
};

export type AgentBusConfig = {
  /** Max messages to retain in history (default 10000) */
  maxHistory: number;
  /** Default message TTL in ms (default 3600000 = 1 hour) */
  defaultTtlMs: number;
  /** Max context store entries (default 50000) */
  maxContextEntries: number;
  /** Default context entry TTL in ms (default 86400000 = 24 hours) */
  defaultContextTtlMs: number;
  /** How often to run garbage collection in ms (default 60000) */
  gcIntervalMs: number;
};

const DEFAULT_CONFIG: AgentBusConfig = {
  maxHistory: 10_000,
  defaultTtlMs: 3_600_000,
  maxContextEntries: 50_000,
  defaultContextTtlMs: 86_400_000,
  gcIntervalMs: 60_000,
};

let messageCounter = 0;

export class AgentBus {
  private config: AgentBusConfig;
  private subscriptions: Subscription[] = [];
  private history: AgentMessage[] = [];
  private context: Map<string, ContextEntry> = new Map();
  private gcTimer: ReturnType<typeof setInterval> | null = null;
  private stats = {
    totalPublished: 0,
    totalDelivered: 0,
    totalDropped: 0,
    byTopic: new Map<string, number>(),
    byAgent: new Map<AgentId, { sent: number; received: number }>(),
  };

  constructor(config?: Partial<AgentBusConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Start the bus (begins garbage collection) */
  start(): void {
    this.gcTimer = setInterval(() => this.gc(), this.config.gcIntervalMs);
  }

  /** Stop the bus */
  stop(): void {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
  }

  // --- Pub/Sub ---

  /** Publish a message to a topic */
  async publish(
    from: AgentId,
    topic: Topic | string,
    payload: unknown,
    options?: {
      summary?: string;
      to?: AgentId;
      type?: AgentMessage["type"];
      inReplyTo?: string;
      chain?: string[];
      attachmentKey?: string;
      ttlMs?: number;
    },
  ): Promise<string> {
    const message: AgentMessage = {
      id: `msg-${++messageCounter}-${Date.now().toString(36)}`,
      from,
      topic,
      to: options?.to,
      type: options?.type ?? "data",
      payload,
      summary: options?.summary ?? `${from} → ${topic}`,
      timestamp: Date.now(),
      inReplyTo: options?.inReplyTo,
      chain: options?.chain,
      attachmentKey: options?.attachmentKey,
      ttlMs: options?.ttlMs ?? this.config.defaultTtlMs,
    };

    // Store in history
    this.history.push(message);
    if (this.history.length > this.config.maxHistory) {
      this.history.shift();
    }

    // Update stats
    this.stats.totalPublished++;
    this.stats.byTopic.set(topic, (this.stats.byTopic.get(topic) ?? 0) + 1);
    const agentStats = this.stats.byAgent.get(from) ?? { sent: 0, received: 0 };
    agentStats.sent++;
    this.stats.byAgent.set(from, agentStats);

    // Deliver to subscribers
    const matching = this.subscriptions.filter((sub) => {
      if (sub.topic !== topic && sub.topic !== "*") return false;
      if (message.to && message.to !== sub.agentId) return false;
      if (sub.filter && !sub.filter(message)) return false;
      return true;
    });

    let delivered = 0;
    for (const sub of matching) {
      try {
        await sub.handler(message);
        delivered++;
        const recvStats = this.stats.byAgent.get(sub.agentId) ?? { sent: 0, received: 0 };
        recvStats.received++;
        this.stats.byAgent.set(sub.agentId, recvStats);
      } catch {
        // Don't let one subscriber's error affect others
      }
    }

    this.stats.totalDelivered += delivered;
    if (delivered === 0 && !message.to) {
      this.stats.totalDropped++;
    }

    return message.id;
  }

  /** Subscribe to a topic */
  subscribe(
    agentId: AgentId,
    topic: Topic | string,
    handler: MessageHandler,
    filter?: (msg: AgentMessage) => boolean,
  ): () => void {
    const sub: Subscription = { agentId, topic, handler, filter };
    this.subscriptions.push(sub);
    return () => {
      this.subscriptions = this.subscriptions.filter((s) => s !== sub);
    };
  }

  /** Send a direct message to a specific agent */
  async send(
    from: AgentId,
    to: AgentId,
    payload: unknown,
    options?: {
      summary?: string;
      type?: AgentMessage["type"];
      inReplyTo?: string;
      chain?: string[];
      attachmentKey?: string;
    },
  ): Promise<string> {
    return this.publish(from, `direct.${to}`, payload, { ...options, to });
  }

  /** Request-response pattern: send a request and wait for a reply */
  async request(
    from: AgentId,
    to: AgentId,
    payload: unknown,
    timeoutMs = 30_000,
  ): Promise<AgentMessage> {
    const requestId = await this.send(from, to, payload, {
      type: "request",
      summary: `${from} → ${to} (request)`,
    });

    return new Promise<AgentMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Request to ${to} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const unsubscribe = this.subscribe(from, `direct.${from}`, (msg) => {
        if (msg.inReplyTo === requestId) {
          clearTimeout(timer);
          unsubscribe();
          resolve(msg);
        }
      });
    });
  }

  // --- Shared Context Store ---

  /** Set a value in the shared context store */
  setContext(
    key: string,
    value: unknown,
    setBy: AgentId,
    ttlMs?: number,
  ): void {
    // Evict if over limit
    if (this.context.size >= this.config.maxContextEntries) {
      this.evictOldestContext(Math.floor(this.config.maxContextEntries * 0.1));
    }

    this.context.set(key, {
      key,
      value,
      setBy,
      setAt: Date.now(),
      expiresAt: Date.now() + (ttlMs ?? this.config.defaultContextTtlMs),
    });
  }

  /** Get a value from the shared context store */
  getContext(key: string): ContextEntry | undefined {
    const entry = this.context.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.context.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Get all context entries matching a key prefix */
  getContextByPrefix(prefix: string): ContextEntry[] {
    const now = Date.now();
    const results: ContextEntry[] = [];
    for (const [key, entry] of this.context) {
      if (key.startsWith(prefix) && now <= entry.expiresAt) {
        results.push(entry);
      }
    }
    return results;
  }

  /** Store a large payload (code, dataset) and get a reference key */
  storeAttachment(
    data: unknown,
    storedBy: AgentId,
    label: string,
    ttlMs?: number,
  ): string {
    const key = `attachment:${label}:${Date.now().toString(36)}`;
    this.setContext(key, data, storedBy, ttlMs);
    return key;
  }

  /** Retrieve an attachment by key */
  getAttachment(key: string): unknown | undefined {
    return this.getContext(key)?.value;
  }

  // --- History & Query ---

  /** Get recent messages for a topic */
  getTopicHistory(topic: string, limit = 50): AgentMessage[] {
    return this.history
      .filter((m) => m.topic === topic)
      .slice(-limit);
  }

  /** Get all messages in a conversation chain */
  getChain(messageId: string): AgentMessage[] {
    const chain: AgentMessage[] = [];
    const seen = new Set<string>();

    const collect = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const msg = this.history.find((m) => m.id === id);
      if (msg) {
        chain.push(msg);
        if (msg.inReplyTo) collect(msg.inReplyTo);
        for (const chainId of msg.chain ?? []) collect(chainId);
      }
    };

    collect(messageId);
    // Also find replies to this message
    for (const msg of this.history) {
      if (msg.inReplyTo === messageId && !seen.has(msg.id)) {
        chain.push(msg);
        seen.add(msg.id);
      }
    }

    return chain.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Get messages from a specific agent */
  getAgentHistory(agentId: AgentId, limit = 50): AgentMessage[] {
    return this.history
      .filter((m) => m.from === agentId || m.to === agentId)
      .slice(-limit);
  }

  // --- Stats & Dashboard ---

  /** Get bus stats for the dashboard */
  getStats(): {
    totalPublished: number;
    totalDelivered: number;
    totalDropped: number;
    activeSubscriptions: number;
    historySize: number;
    contextSize: number;
    topicCounts: Record<string, number>;
    agentActivity: Record<string, { sent: number; received: number }>;
  } {
    const topicCounts: Record<string, number> = {};
    for (const [topic, count] of this.stats.byTopic) {
      topicCounts[topic] = count;
    }

    const agentActivity: Record<string, { sent: number; received: number }> = {};
    for (const [agent, stats] of this.stats.byAgent) {
      agentActivity[agent] = stats;
    }

    return {
      totalPublished: this.stats.totalPublished,
      totalDelivered: this.stats.totalDelivered,
      totalDropped: this.stats.totalDropped,
      activeSubscriptions: this.subscriptions.length,
      historySize: this.history.length,
      contextSize: this.context.size,
      topicCounts,
      agentActivity,
    };
  }

  // --- Internal ---

  private gc(): void {
    const now = Date.now();

    // Expire old messages
    this.history = this.history.filter(
      (m) => now - m.timestamp < m.ttlMs,
    );

    // Expire old context entries
    for (const [key, entry] of this.context) {
      if (now > entry.expiresAt) {
        this.context.delete(key);
      }
    }
  }

  private evictOldestContext(count: number): void {
    const entries = Array.from(this.context.entries())
      .sort((a, b) => a[1].setAt - b[1].setAt);
    for (let i = 0; i < Math.min(count, entries.length); i++) {
      this.context.delete(entries[i]![0]);
    }
  }
}
