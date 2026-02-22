/**
 * Tiered model router for ApexClaw.
 *
 * Routes inference requests across four tiers based on task complexity,
 * cost sensitivity, and latency requirements:
 *
 *   Tier 1 (Local Fast)  → Ollama/vLLM on 1070 Ti — free, ~2-10 tok/s, 3B-7B models
 *   Tier 2 (Local Large) → AirLLM on 1070 Ti — free, ~1-3 tok/s, 70B+ models
 *   Tier 3 (Free APIs)   → Qwen OAuth, NVIDIA NIM, Grok free — free, ~30-80 tok/s
 *   Tier 4 (Paid APIs)   → Claude Max, Grok Pro — paid, ~60-120 tok/s
 *
 * AirLLM (github.com/jaredrsommer/airllm) enables 70B+ models on 8GB VRAM
 * by loading one transformer layer at a time. With 128GB RAM on the MoE
 * machine, layers prefetch from RAM (no disk bottleneck).
 *
 * Routing priority for background complex tasks:
 *   airllm 70B local (free, best quality) > free APIs > paid APIs
 *
 * Routing priority for realtime/urgent tasks:
 *   local fast (Ollama 3B) > free APIs > airllm (too slow)
 *
 * Qwen OAuth (qwen3-coder-plus) is preferred for code gen tasks in the
 * free-api tier — 1,000-2,000 free requests/day from your Qwen account.
 */

export type InferenceTier = "local" | "local-large" | "free-api" | "paid-api";

export type TaskComplexity = "trivial" | "simple" | "moderate" | "complex" | "critical";

export type TaskUrgency = "background" | "normal" | "urgent" | "realtime";

export type TradingTaskType =
  | "signal-classification"
  | "sentiment-analysis"
  | "market-summary"
  | "risk-assessment"
  | "order-generation"
  | "liquidation-detection"
  | "rbi-research"
  | "rbi-backtest"
  | "rbi-implement"
  | "stream-observation"
  | "anomaly-detection"
  | "polymarket-analysis"
  | "general";

export type RouteDecision = {
  tier: InferenceTier;
  provider: string;
  model: string;
  reason: string;
  estimatedCostUsd: number;
  estimatedLatencyMs: number;
};

export type RouterConfig = {
  gpuVramMb: number;
  localOllamaUrl: string;
  localVllmUrl: string;
  hasNvidiaApi: boolean;
  hasGrokApi: boolean;
  hasClaudeApi: boolean;
  /** Qwen OAuth authenticated (qwen3-coder-plus, 1000-2000 free/day) */
  hasQwenOAuth: boolean;
  /** AirLLM server running (70B+ models via layer-by-layer inference) */
  hasAirLLM: boolean;
  /** URL of the airllm-server.py process */
  airllmUrl: string;
  forceTier?: InferenceTier;
  maxLocalConcurrency: number;
  currentLocalLoad: number;
  customQwenAvailable: boolean;
};

/**
 * Provider definitions for each tier.
 * These map to OpenClaw's provider system.
 */
export const TIER_PROVIDERS = {
  local: {
    ollama: {
      // Fast local models for simple tasks
      models: {
        fast: "qwen2.5:3b-instruct-q5_K_M",
        general: "qwen2.5:7b-instruct-q4_K_M",
        code: "qwen2.5-coder:7b-instruct-q4_K_M",
        reasoning: "deepseek-r1:7b-q4_K_M",
        embedding: "nomic-embed-text:v1.5",
      },
    },
    vllm: {
      // Custom Qwen3 MoE trained on trading
      models: {
        trading: "custom-qwen3-moe-trading",
      },
    },
  },
  "local-large": {
    airllm: {
      // AirLLM: 70B+ models on 8GB VRAM via layer-by-layer inference
      // Slow (~1-3 tok/s with 4bit) but free and highest quality locally
      // 128GB RAM on MoE machine = fast layer prefetch from RAM
      models: {
        reasoning: "meta-llama/Llama-3.1-70B-Instruct",
        code: "Qwen/Qwen2.5-72B-Instruct",
        moe: "mistralai/Mixtral-8x7B-Instruct-v0.1",
        nuclear: "meta-llama/Llama-3.1-405B-Instruct",
      },
    },
  },
  "free-api": {
    qwen: {
      // Qwen OAuth free tier (1,000-2,000 req/day via qwen.ai account)
      // Preferred for code gen tasks — best free coding model available
      models: {
        code: "qwen3-coder-plus",
        codeFast: "qwen3-coder-flash",
        general: "qwen3-max",
        latest: "qwen-plus-latest",
      },
    },
    nvidia: {
      // NVIDIA NIM free tier
      models: {
        general: "nvidia/llama-3.1-nemotron-70b-instruct",
        fast: "nvidia/mistral-nemo-minitron-8b-8k-instruct",
        large: "meta/llama-3.3-70b-instruct",
      },
    },
    grok: {
      // Grok free tier (if available)
      models: {
        general: "grok-2",
        fast: "grok-2-mini",
      },
    },
  },
  "paid-api": {
    anthropic: {
      // Claude Max ($100/mo sub)
      models: {
        reasoning: "claude-sonnet-4-20250514",
        fast: "claude-haiku-4-20250514",
      },
    },
    grok: {
      // Grok paid tier
      models: {
        reasoning: "grok-3",
        general: "grok-2",
      },
    },
  },
} as const;

/**
 * Trading task routing rules.
 * Maps task types to their optimal tier/model combination.
 */
const TRADING_ROUTES: Record<TradingTaskType, {
  complexity: TaskComplexity;
  urgency: TaskUrgency;
  preferredTier: InferenceTier;
  reason: string;
}> = {
  "signal-classification": {
    complexity: "simple",
    urgency: "realtime",
    preferredTier: "local",
    reason: "Low latency classification on local 3B model",
  },
  "sentiment-analysis": {
    complexity: "moderate",
    urgency: "normal",
    preferredTier: "local",
    reason: "Batch sentiment with custom Qwen3 MoE trading model",
  },
  "market-summary": {
    complexity: "moderate",
    urgency: "background",
    preferredTier: "local-large",
    reason: "70B model for deep market summaries (airllm local, or free API fallback)",
  },
  "risk-assessment": {
    complexity: "complex",
    urgency: "urgent",
    preferredTier: "paid-api",
    reason: "Critical risk decisions need highest-quality reasoning (Claude)",
  },
  "order-generation": {
    complexity: "moderate",
    urgency: "urgent",
    preferredTier: "local",
    reason: "Structured JSON output, custom Qwen3 MoE handles trading formats",
  },
  "liquidation-detection": {
    complexity: "simple",
    urgency: "realtime",
    preferredTier: "local",
    reason: "Speed-critical: pattern match on local fast model",
  },
  "rbi-research": {
    complexity: "complex",
    urgency: "background",
    preferredTier: "local-large",
    reason: "Research phase uses 70B model locally via airllm (free, highest quality)",
  },
  "rbi-backtest": {
    complexity: "moderate",
    urgency: "background",
    preferredTier: "local",
    reason: "Backtest code generation on local code model",
  },
  "rbi-implement": {
    complexity: "complex",
    urgency: "normal",
    preferredTier: "local-large",
    reason: "Implementation with Qwen 72B locally via airllm (free, best code quality)",
  },
  "stream-observation": {
    complexity: "simple",
    urgency: "realtime",
    preferredTier: "local",
    reason: "Continuous stream processing on local fast model",
  },
  "anomaly-detection": {
    complexity: "moderate",
    urgency: "urgent",
    preferredTier: "local",
    reason: "Custom Qwen3 MoE trained specifically for trading anomalies",
  },
  "polymarket-analysis": {
    complexity: "complex",
    urgency: "normal",
    preferredTier: "local-large",
    reason: "Deep information arbitrage analysis on local 70B via airllm",
  },
  general: {
    complexity: "simple",
    urgency: "normal",
    preferredTier: "local",
    reason: "Default routing to local model to minimize cost",
  },
};

/**
 * Route a task to the optimal tier and model.
 */
export function routeTask(
  taskType: TradingTaskType,
  config: RouterConfig,
  overrides?: { forceTier?: InferenceTier },
): RouteDecision {
  const route = TRADING_ROUTES[taskType];
  const forcedTier = overrides?.forceTier ?? config.forceTier;

  // If a tier is forced, use it directly
  const targetTier = forcedTier ?? selectTier(route, config);

  return resolveProviderForTier(targetTier, taskType, route, config);
}

function selectTier(
  route: (typeof TRADING_ROUTES)[TradingTaskType],
  config: RouterConfig,
): InferenceTier {
  const preferred = route.preferredTier;

  // Check if local GPU is available (not overloaded)
  if (preferred === "local") {
    if (config.currentLocalLoad >= config.maxLocalConcurrency) {
      // Local GPU busy — fall back to free API
      return "free-api";
    }
    return "local";
  }

  // AirLLM: 70B+ models locally — best for background complex tasks
  if (preferred === "local-large") {
    if (config.hasAirLLM) {
      return "local-large";
    }
    // AirLLM not available — fall through to free API, then local
    if (config.hasNvidiaApi || config.hasGrokApi || config.hasQwenOAuth) {
      return "free-api";
    }
    if (config.currentLocalLoad < config.maxLocalConcurrency) {
      return "local";
    }
    return config.hasClaudeApi ? "paid-api" : "local";
  }

  if (preferred === "free-api") {
    if (!config.hasNvidiaApi && !config.hasGrokApi && !config.hasQwenOAuth) {
      // No free APIs — try airllm for complex tasks, then local
      if (config.hasAirLLM && route.complexity === "complex") {
        return "local-large";
      }
      if (config.currentLocalLoad < config.maxLocalConcurrency) {
        return "local";
      }
      return config.hasClaudeApi ? "paid-api" : "local";
    }
    return "free-api";
  }

  // paid-api: only if configured
  if (preferred === "paid-api") {
    if (!config.hasClaudeApi && !config.hasGrokApi) {
      // No paid APIs — try airllm for complex tasks, then free, then local
      if (config.hasAirLLM && route.complexity === "complex") {
        return "local-large";
      }
      return config.hasNvidiaApi ? "free-api" : "local";
    }
    return "paid-api";
  }

  return "local";
}

function resolveProviderForTier(
  tier: InferenceTier,
  taskType: TradingTaskType,
  route: (typeof TRADING_ROUTES)[TradingTaskType],
  config: RouterConfig,
): RouteDecision {
  switch (tier) {
    case "local":
      return resolveLocalProvider(taskType, route, config);
    case "local-large":
      return resolveAirLLMProvider(taskType, route, config);
    case "free-api":
      return resolveFreeApiProvider(taskType, route, config);
    case "paid-api":
      return resolvePaidApiProvider(taskType, route, config);
  }
}

function resolveLocalProvider(
  taskType: TradingTaskType,
  route: (typeof TRADING_ROUTES)[TradingTaskType],
  config: RouterConfig,
): RouteDecision {
  // Use custom Qwen3 MoE for trading-specific tasks if available
  if (
    config.customQwenAvailable &&
    ["sentiment-analysis", "order-generation", "anomaly-detection", "signal-classification"].includes(taskType)
  ) {
    return {
      tier: "local",
      provider: "vllm",
      model: TIER_PROVIDERS.local.vllm.models.trading,
      reason: `Custom Qwen3 MoE trading model for ${taskType}`,
      estimatedCostUsd: 0,
      estimatedLatencyMs: route.urgency === "realtime" ? 500 : 2000,
    };
  }

  // Map complexity/urgency to local model size
  const isRealtime = route.urgency === "realtime";
  const needsReasoning = route.complexity === "complex";
  const needsCode = taskType === "rbi-backtest" || taskType === "rbi-implement";

  let model: string;
  let provider = "ollama";

  if (isRealtime) {
    model = TIER_PROVIDERS.local.ollama.models.fast;
  } else if (needsCode) {
    model = TIER_PROVIDERS.local.ollama.models.code;
  } else if (needsReasoning) {
    model = TIER_PROVIDERS.local.ollama.models.reasoning;
  } else {
    model = TIER_PROVIDERS.local.ollama.models.general;
  }

  return {
    tier: "local",
    provider,
    model,
    reason: route.reason,
    estimatedCostUsd: 0,
    estimatedLatencyMs: isRealtime ? 300 : 3000,
  };
}

/** Task types that benefit from AirLLM's 70B code model (Qwen 72B) */
const AIRLLM_CODE_TASKS: TradingTaskType[] = [
  "rbi-backtest", "rbi-implement",
];

/** Task types that benefit from AirLLM's 70B reasoning model (Llama 70B) */
const AIRLLM_REASONING_TASKS: TradingTaskType[] = [
  "rbi-research", "risk-assessment", "polymarket-analysis", "market-summary",
];

function resolveAirLLMProvider(
  taskType: TradingTaskType,
  route: (typeof TRADING_ROUTES)[TradingTaskType],
  config: RouterConfig,
): RouteDecision {
  if (!config.hasAirLLM) {
    // AirLLM not available — fall back to free API
    return resolveFreeApiProvider(taskType, route, config);
  }

  // Select model based on task type
  let model: string;
  let reason: string;

  if (AIRLLM_CODE_TASKS.includes(taskType)) {
    model = TIER_PROVIDERS["local-large"].airllm.models.code;
    reason = `AirLLM local: Qwen 72B for ${taskType} (free, layer-by-layer on 8GB VRAM)`;
  } else if (AIRLLM_REASONING_TASKS.includes(taskType)) {
    model = TIER_PROVIDERS["local-large"].airllm.models.reasoning;
    reason = `AirLLM local: Llama 70B for ${taskType} (free, layer-by-layer on 8GB VRAM)`;
  } else {
    // Default to Mixtral MoE for general tasks (faster than dense 70B)
    model = TIER_PROVIDERS["local-large"].airllm.models.moe;
    reason = `AirLLM local: Mixtral MoE for ${taskType} (free, faster sparse model)`;
  }

  return {
    tier: "local-large",
    provider: "airllm",
    model,
    reason,
    estimatedCostUsd: 0,
    // AirLLM is slow: ~1-3 tok/s with 4bit, ~60-180s for 200 token response
    estimatedLatencyMs: 120_000,
  };
}

/** Code-related task types that benefit from Qwen's coding model */
const CODE_TASKS: TradingTaskType[] = [
  "rbi-research", "rbi-backtest", "rbi-implement",
];

function resolveFreeApiProvider(
  taskType: TradingTaskType,
  route: (typeof TRADING_ROUTES)[TradingTaskType],
  config: RouterConfig,
): RouteDecision {
  // Prefer Qwen OAuth for code-related tasks (best free coding model)
  // qwen3-coder-plus: 1,000-2,000 free req/day via OAuth
  if (config.hasQwenOAuth && CODE_TASKS.includes(taskType)) {
    const needsFast = route.urgency === "realtime" || route.urgency === "urgent";
    return {
      tier: "free-api",
      provider: "qwen",
      model: needsFast
        ? TIER_PROVIDERS["free-api"].qwen.models.codeFast
        : TIER_PROVIDERS["free-api"].qwen.models.code,
      reason: `Qwen OAuth free: ${route.reason}`,
      estimatedCostUsd: 0,
      estimatedLatencyMs: needsFast ? 600 : 1500,
    };
  }

  // Qwen OAuth for general tasks when NVIDIA isn't available
  if (config.hasQwenOAuth && !config.hasNvidiaApi) {
    return {
      tier: "free-api",
      provider: "qwen",
      model: TIER_PROVIDERS["free-api"].qwen.models.general,
      reason: `Qwen OAuth free: ${route.reason}`,
      estimatedCostUsd: 0,
      estimatedLatencyMs: 1500,
    };
  }

  // NVIDIA NIM for larger context / general tasks
  if (config.hasNvidiaApi) {
    const needsFast = route.urgency === "realtime" || route.urgency === "urgent";
    const model = needsFast
      ? TIER_PROVIDERS["free-api"].nvidia.models.fast
      : TIER_PROVIDERS["free-api"].nvidia.models.general;

    return {
      tier: "free-api",
      provider: "nvidia",
      model,
      reason: `NVIDIA NIM free tier: ${route.reason}`,
      estimatedCostUsd: 0,
      estimatedLatencyMs: needsFast ? 800 : 2000,
    };
  }

  // Grok free tier
  if (config.hasGrokApi) {
    return {
      tier: "free-api",
      provider: "grok",
      model: TIER_PROVIDERS["free-api"].grok.models.general,
      reason: `Grok free tier: ${route.reason}`,
      estimatedCostUsd: 0,
      estimatedLatencyMs: 1500,
    };
  }

  // Qwen OAuth as last free resort (even for non-code tasks)
  if (config.hasQwenOAuth) {
    return {
      tier: "free-api",
      provider: "qwen",
      model: TIER_PROVIDERS["free-api"].qwen.models.latest,
      reason: `Qwen OAuth free (fallback): ${route.reason}`,
      estimatedCostUsd: 0,
      estimatedLatencyMs: 1500,
    };
  }

  // No free APIs — fall back to local
  return resolveLocalProvider(taskType, route, config);
}

function resolvePaidApiProvider(
  taskType: TradingTaskType,
  route: (typeof TRADING_ROUTES)[TradingTaskType],
  config: RouterConfig,
): RouteDecision {
  // Claude for critical reasoning tasks
  if (config.hasClaudeApi && route.complexity === "complex") {
    const needsFast = route.urgency === "realtime" || route.urgency === "urgent";
    return {
      tier: "paid-api",
      provider: "anthropic",
      model: needsFast
        ? TIER_PROVIDERS["paid-api"].anthropic.models.fast
        : TIER_PROVIDERS["paid-api"].anthropic.models.reasoning,
      reason: `Claude Max: ${route.reason}`,
      estimatedCostUsd: needsFast ? 0.001 : 0.01,
      estimatedLatencyMs: needsFast ? 500 : 3000,
    };
  }

  // Grok paid for general paid tasks
  if (config.hasGrokApi) {
    return {
      tier: "paid-api",
      provider: "grok",
      model: TIER_PROVIDERS["paid-api"].grok.models.reasoning,
      reason: `Grok Pro: ${route.reason}`,
      estimatedCostUsd: 0.005,
      estimatedLatencyMs: 2000,
    };
  }

  // Fall back to free tier
  return resolveFreeApiProvider(taskType, route, config);
}

/**
 * Estimate monthly cost for a given task distribution.
 * Returns $0 for local and free-api tiers.
 */
export function estimateMonthlyCost(
  tasksPerDay: Record<TradingTaskType, number>,
  config: RouterConfig,
): { totalUsd: number; breakdown: Record<InferenceTier, number> } {
  const breakdown: Record<InferenceTier, number> = {
    local: 0,
    "local-large": 0,
    "free-api": 0,
    "paid-api": 0,
  };

  for (const [taskType, count] of Object.entries(tasksPerDay)) {
    const route = routeTask(taskType as TradingTaskType, config);
    const monthlyCost = route.estimatedCostUsd * count * 30;
    breakdown[route.tier] += monthlyCost;
  }

  return {
    totalUsd: breakdown.local + breakdown["local-large"] + breakdown["free-api"] + breakdown["paid-api"],
    breakdown,
  };
}
