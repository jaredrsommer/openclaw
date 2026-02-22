/**
 * AirLLM Provider — local 70B+ model inference on 8GB VRAM.
 *
 * Connects to the airllm-server.py process which runs on the MoE machine.
 * Uses jaredrsommer/airllm for layer-by-layer inference:
 *   - Loads one transformer layer at a time into GPU memory
 *   - 128GB RAM = layers prefetch from RAM (no disk I/O bottleneck)
 *   - 4bit compression = 3x speedup over fp16
 *
 * This replaces the free API tier for complex tasks:
 *   - RBI Research: Llama-3.1-70B-Instruct instead of NVIDIA NIM
 *   - RBI Implement: Qwen2.5-72B-Instruct instead of Qwen OAuth
 *   - Risk Assessment: 70B reasoning locally instead of Claude paid
 *   - Polymarket Analysis: deep analysis without API limits
 *
 * Tradeoff: ~1-3 tok/s (4bit) vs ~30-80 tok/s (API)
 * Best for: background analysis where quality > speed, and cost = $0
 *
 * Models that fit on 1070 Ti (8GB VRAM) via airllm:
 *   - meta-llama/Llama-3.1-70B-Instruct (4bit compressed)
 *   - Qwen/Qwen2.5-72B-Instruct (4bit compressed)
 *   - mistralai/Mixtral-8x7B-Instruct-v0.1 (MoE, fast)
 *   - meta-llama/Llama-3.1-405B-Instruct (4bit, ~15min first token)
 */

export type AirLLMConfig = {
  /** URL of the airllm-server.py process (default http://localhost:8787) */
  serverUrl: string;
  /** Default model to load */
  defaultModel: string;
  /** Compression level (4bit recommended for 1070 Ti) */
  compression: "4bit" | "8bit";
  /** Max tokens to generate per request */
  defaultMaxTokens: number;
  /** Request timeout in ms (layer-by-layer is slow, needs long timeout) */
  timeoutMs: number;
  /** HuggingFace token for gated models */
  hfToken?: string;
  /** Path to cache split layers (on MoE machine) */
  layerCachePath: string;
};

const DEFAULT_CONFIG: AirLLMConfig = {
  serverUrl: "http://localhost:8787",
  defaultModel: "meta-llama/Llama-3.1-70B-Instruct",
  compression: "4bit",
  defaultMaxTokens: 512,
  timeoutMs: 300_000, // 5 min — layer-by-layer inference is slow
  layerCachePath: "/tmp/airllm-layers",
};

/** Available 70B+ models for airllm inference */
export const AIRLLM_MODELS = {
  /** Best general-purpose reasoning model */
  llama70b: "meta-llama/Llama-3.1-70B-Instruct",
  /** Best for code generation */
  qwen72b: "Qwen/Qwen2.5-72B-Instruct",
  /** Fast MoE model — only 2 of 8 experts active per token */
  mixtral: "mistralai/Mixtral-8x7B-Instruct-v0.1",
  /** Nuclear option — 405B params, extremely slow but smartest open model */
  llama405b: "meta-llama/Llama-3.1-405B-Instruct",
} as const;

export type AirLLMModel = (typeof AIRLLM_MODELS)[keyof typeof AIRLLM_MODELS];

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type AirLLMResponse = {
  text: string;
  model: string;
  tokensGenerated: number;
  tokensPerSecond: number;
  latencyMs: number;
};

type AirLLMHealth = {
  model: string | null;
  compression: string | null;
  loaded: boolean;
  uptimeS: number;
  totalRequests: number;
  totalTokensGenerated: number;
  layerCachePath: string;
  layerCacheRamdisk: boolean;
  gpu: {
    allocatedMb: number;
    reservedMb: number;
    maxAllocatedMb: number;
    computeCapability?: string;
    deviceName?: string;
  };
  ram: { totalGb: number; usedGb: number; availableGb: number };
};

export class AirLLMProvider {
  private config: AirLLMConfig;
  private ready = false;
  private stats = {
    totalRequests: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    errors: 0,
    modelSwitches: 0,
  };

  constructor(config?: Partial<AirLLMConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Check if the airllm server is running and healthy.
   * Returns false if the server isn't reachable.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetch("/health", { method: "GET" });
      const health = (await res.json()) as { loaded: boolean };
      this.ready = health.loaded;
      return true;
    } catch {
      this.ready = false;
      return false;
    }
  }

  /**
   * Load a model on the airllm server.
   * First load splits layers to disk (slow), subsequent loads from cache (fast).
   */
  async loadModel(
    model: AirLLMModel | string = this.config.defaultModel,
    compression?: "4bit" | "8bit",
  ): Promise<{ status: string; loadTimeS: number }> {
    const body = {
      model,
      compression: compression ?? this.config.compression,
      hf_token: this.config.hfToken,
      layer_path: this.config.layerCachePath,
    };

    const res = await this.fetch("/load", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const result = (await res.json()) as {
      status: string;
      load_time_s?: number;
    };
    this.stats.modelSwitches++;
    this.ready = result.status === "loaded" || result.status === "already_loaded";

    return {
      status: result.status,
      loadTimeS: result.load_time_s ?? 0,
    };
  }

  /**
   * Generate a chat completion using the loaded 70B+ model.
   * WARNING: This is slow (1-5 tok/s). Use for background tasks only.
   */
  async chat(
    messages: ChatMessage[],
    options?: {
      maxTokens?: number;
      temperature?: number;
    },
  ): Promise<AirLLMResponse> {
    if (!this.ready) {
      throw new Error("AirLLM server not ready. Call loadModel() first.");
    }

    this.stats.totalRequests++;

    const body = {
      model: this.config.defaultModel,
      messages,
      max_tokens: options?.maxTokens ?? this.config.defaultMaxTokens,
      temperature: options?.temperature ?? 0.7,
    };

    const res = await this.fetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      this.stats.errors++;
      const err = (await res.json()) as { error: string };
      throw new Error(`AirLLM error: ${err.error}`);
    }

    const data = (await res.json()) as {
      choices: Array<{ message: { content: string } }>;
      model: string;
      usage: { completion_tokens: number };
      _airllm: { tokens_per_second: number; latency_ms: number };
    };

    const text = data.choices[0]?.message.content ?? "";
    const tokensGenerated = data.usage.completion_tokens;
    const latencyMs = data._airllm.latency_ms;

    this.stats.totalTokens += tokensGenerated;
    this.stats.totalLatencyMs += latencyMs;

    return {
      text,
      model: data.model,
      tokensGenerated,
      tokensPerSecond: data._airllm.tokens_per_second,
      latencyMs,
    };
  }

  /** Get health info from the airllm server */
  async getHealth(): Promise<AirLLMHealth | null> {
    try {
      const res = await this.fetch("/health", { method: "GET" });
      const h = (await res.json()) as any;
      return {
        model: h.model,
        compression: h.compression,
        loaded: h.loaded,
        uptimeS: h.uptime_s,
        totalRequests: h.total_requests,
        totalTokensGenerated: h.total_tokens_generated,
        layerCachePath: h.layer_cache_path ?? "",
        layerCacheRamdisk: h.layer_cache_ramdisk ?? false,
        gpu: {
          allocatedMb: h.gpu?.allocated_mb ?? 0,
          reservedMb: h.gpu?.reserved_mb ?? 0,
          maxAllocatedMb: h.gpu?.max_allocated_mb ?? 0,
          computeCapability: h.gpu?.compute_capability,
          deviceName: h.gpu?.device_name,
        },
        ram: {
          totalGb: h.ram?.total_gb ?? 0,
          usedGb: h.ram?.used_gb ?? 0,
          availableGb: h.ram?.available_gb ?? 0,
        },
      };
    } catch {
      return null;
    }
  }

  /** Get local stats */
  getStats(): {
    ready: boolean;
    totalRequests: number;
    totalTokens: number;
    avgLatencyMs: number;
    avgTokPerSec: number;
    errors: number;
    modelSwitches: number;
  } {
    const avgLatency = this.stats.totalRequests > 0
      ? Math.round(this.stats.totalLatencyMs / this.stats.totalRequests)
      : 0;
    const avgTokPerSec = this.stats.totalLatencyMs > 0
      ? Number(((this.stats.totalTokens / this.stats.totalLatencyMs) * 1000).toFixed(2))
      : 0;

    return {
      ready: this.ready,
      totalRequests: this.stats.totalRequests,
      totalTokens: this.stats.totalTokens,
      avgLatencyMs: avgLatency,
      avgTokPerSec,
      errors: this.stats.errors,
      modelSwitches: this.stats.modelSwitches,
    };
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      return await fetch(`${this.config.serverUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(init.headers as Record<string, string>),
        },
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
