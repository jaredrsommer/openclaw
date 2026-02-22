/**
 * API call optimizer for the ApexClaw fleet.
 *
 * Addresses the main API inefficiencies:
 *   1. Request deduplication — concurrent identical prompts share one call
 *   2. Response caching — identical requests within a TTL window hit cache
 *   3. Request queue with concurrency limits per provider
 *   4. Automatic retry with exponential backoff + jitter
 *
 * This wraps around the tiered router's API calls so every agent benefits
 * without needing to change agent code.
 */

export type ApiProvider = "ollama" | "vllm" | "nvidia" | "grok" | "anthropic";

export type ApiRequest = {
  provider: ApiProvider;
  model: string;
  prompt: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Max tokens to generate */
  maxTokens?: number;
  /** Temperature (default 0.1 for trading) */
  temperature?: number;
  /** Request timeout in ms */
  timeoutMs?: number;
};

export type ApiResponse = {
  text: string;
  provider: ApiProvider;
  model: string;
  cached: boolean;
  deduped: boolean;
  latencyMs: number;
  tokensUsed: number;
};

type CachedResponse = {
  response: ApiResponse;
  expiresAt: number;
};

type InflightCall = {
  promise: Promise<ApiResponse>;
  refCount: number;
};

type QueuedRequest = {
  request: ApiRequest;
  resolve: (response: ApiResponse) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
};

export type ApiOptimizerConfig = {
  /** Max cached responses per provider (default 10000) */
  maxCachePerProvider: number;
  /** Cache TTL in ms (default 60000 = 1 min for trading data) */
  cacheTtlMs: number;
  /** Max concurrent requests per provider */
  concurrencyLimits: Record<ApiProvider, number>;
  /** Base retry delay in ms (default 500) */
  retryBaseMs: number;
  /** Max retries (default 3) */
  maxRetries: number;
  /** Provider endpoints */
  endpoints: Partial<Record<ApiProvider, string>>;
};

const DEFAULT_CONFIG: ApiOptimizerConfig = {
  maxCachePerProvider: 10_000,
  cacheTtlMs: 60_000,
  concurrencyLimits: {
    ollama: 2,
    vllm: 1,
    nvidia: 5,
    grok: 3,
    anthropic: 3,
  },
  retryBaseMs: 500,
  maxRetries: 3,
  endpoints: {
    ollama: "http://127.0.0.1:11434",
    vllm: "http://127.0.0.1:8000/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    grok: "https://api.x.ai/v1",
    anthropic: "https://api.anthropic.com/v1",
  },
};

export class ApiOptimizer {
  private config: ApiOptimizerConfig;
  private cache: Map<string, CachedResponse> = new Map();
  private inflight: Map<string, InflightCall> = new Map();
  private queues: Map<ApiProvider, QueuedRequest[]> = new Map();
  private activeRequests: Map<ApiProvider, number> = new Map();
  private stats = {
    cacheHits: 0,
    cacheMisses: 0,
    deduped: 0,
    queued: 0,
    retries: 0,
    errors: 0,
    totalRequests: 0,
    totalLatencyMs: 0,
    byProvider: new Map<ApiProvider, { calls: number; totalMs: number; errors: number }>(),
  };

  constructor(config?: Partial<ApiOptimizerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    for (const provider of ["ollama", "vllm", "nvidia", "grok", "anthropic"] as ApiProvider[]) {
      this.queues.set(provider, []);
      this.activeRequests.set(provider, 0);
      this.stats.byProvider.set(provider, { calls: 0, totalMs: 0, errors: 0 });
    }
  }

  /** Make an optimized API call with caching, dedup, and queuing */
  async call(request: ApiRequest): Promise<ApiResponse> {
    const key = this.requestKey(request);

    // 1. Check response cache
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.stats.cacheHits++;
      return { ...cached.response, cached: true };
    }

    // 2. Check if this exact request is in-flight (dedup)
    const existing = this.inflight.get(key);
    if (existing) {
      existing.refCount++;
      this.stats.deduped++;
      return existing.promise.then((r) => ({ ...r, deduped: true }));
    }

    // 3. Queue or execute the request
    this.stats.cacheMisses++;
    this.stats.totalRequests++;

    const promise = this.executeWithQueue(request, key);
    this.inflight.set(key, { promise, refCount: 1 });

    return promise.finally(() => {
      this.inflight.delete(key);
    });
  }

  private async executeWithQueue(request: ApiRequest, cacheKey: string): Promise<ApiResponse> {
    const provider = request.provider;
    const limit = this.config.concurrencyLimits[provider] ?? 3;
    const active = this.activeRequests.get(provider) ?? 0;

    // If under the concurrency limit, execute immediately
    if (active < limit) {
      return this.executeRequest(request, cacheKey);
    }

    // Otherwise queue it
    this.stats.queued++;
    return new Promise<ApiResponse>((resolve, reject) => {
      const queue = this.queues.get(provider) ?? [];
      queue.push({ request, resolve, reject, enqueuedAt: Date.now() });
      this.queues.set(provider, queue);
    });
  }

  private async executeRequest(request: ApiRequest, cacheKey: string): Promise<ApiResponse> {
    const provider = request.provider;
    this.activeRequests.set(provider, (this.activeRequests.get(provider) ?? 0) + 1);
    const startTime = Date.now();

    try {
      const response = await this.callWithRetry(request);
      const latencyMs = Date.now() - startTime;

      const result: ApiResponse = {
        text: response,
        provider: request.provider,
        model: request.model,
        cached: false,
        deduped: false,
        latencyMs,
        tokensUsed: Math.ceil(response.length / 4), // rough estimate
      };

      // Cache the response
      this.putCache(cacheKey, result, provider);

      // Update stats
      const providerStats = this.stats.byProvider.get(provider)!;
      providerStats.calls++;
      providerStats.totalMs += latencyMs;
      this.stats.totalLatencyMs += latencyMs;

      return result;
    } catch (err) {
      this.stats.errors++;
      const providerStats = this.stats.byProvider.get(provider)!;
      providerStats.errors++;
      throw err;
    } finally {
      // Release the concurrency slot and drain the queue
      const active = (this.activeRequests.get(provider) ?? 1) - 1;
      this.activeRequests.set(provider, active);
      this.drainQueue(provider);
    }
  }

  private async callWithRetry(request: ApiRequest): Promise<string> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.rawCall(request);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Don't retry on 4xx (except 429)
        if (lastError.message.includes("HTTP 4") && !lastError.message.includes("HTTP 429")) {
          throw lastError;
        }

        if (attempt < this.config.maxRetries) {
          this.stats.retries++;
          const delay = this.config.retryBaseMs * Math.pow(2, attempt);
          const jitter = delay * 0.3 * Math.random();
          await sleep(delay + jitter);
        }
      }
    }

    throw lastError ?? new Error("Request failed after retries");
  }

  private async rawCall(request: ApiRequest): Promise<string> {
    const endpoint = this.config.endpoints[request.provider];
    if (!endpoint) throw new Error(`No endpoint for provider: ${request.provider}`);

    const timeout = request.timeoutMs ?? 30_000;

    if (request.provider === "ollama") {
      return this.callOllama(endpoint, request, timeout);
    } else if (request.provider === "vllm") {
      return this.callOpenAICompat(endpoint, request, timeout);
    } else if (request.provider === "anthropic") {
      return this.callAnthropic(endpoint, request, timeout);
    } else {
      // NVIDIA and Grok both use OpenAI-compatible API
      return this.callOpenAICompat(endpoint, request, timeout);
    }
  }

  private async callOllama(endpoint: string, request: ApiRequest, timeout: number): Promise<string> {
    const response = await fetch(`${endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: request.model,
        prompt: request.prompt,
        system: request.systemPrompt,
        stream: false,
        options: {
          temperature: request.temperature ?? 0.1,
          num_predict: request.maxTokens ?? 2048,
        },
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { response?: string };
    return data.response ?? "";
  }

  private async callOpenAICompat(endpoint: string, request: ApiRequest, timeout: number): Promise<string> {
    const apiKey = this.getApiKey(request.provider);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const messages: Array<{ role: string; content: string }> = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: request.model,
        messages,
        temperature: request.temperature ?? 0.1,
        max_tokens: request.maxTokens ?? 2048,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "";
  }

  private async callAnthropic(endpoint: string, request: ApiRequest, timeout: number): Promise<string> {
    const apiKey = this.getApiKey("anthropic");
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

    const response = await fetch(`${endpoint}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: request.model,
        max_tokens: request.maxTokens ?? 2048,
        system: request.systemPrompt ?? "",
        messages: [{ role: "user", content: request.prompt }],
        temperature: request.temperature ?? 0.1,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as {
      content?: Array<{ type: string; text?: string }>;
    };
    return data.content?.find((c) => c.type === "text")?.text ?? "";
  }

  private getApiKey(provider: ApiProvider): string | undefined {
    switch (provider) {
      case "nvidia": return process.env.NVIDIA_API_KEY;
      case "grok": return process.env.XAI_API_KEY ?? process.env.GROK_API_KEY;
      case "anthropic": return process.env.ANTHROPIC_API_KEY;
      default: return undefined;
    }
  }

  private drainQueue(provider: ApiProvider): void {
    const queue = this.queues.get(provider);
    if (!queue || queue.length === 0) return;

    const limit = this.config.concurrencyLimits[provider] ?? 3;
    const active = this.activeRequests.get(provider) ?? 0;

    if (active < limit) {
      const next = queue.shift()!;
      const key = this.requestKey(next.request);
      this.executeRequest(next.request, key).then(next.resolve).catch(next.reject);
    }
  }

  private requestKey(request: ApiRequest): string {
    return `${request.provider}:${request.model}:${simpleHash(
      (request.systemPrompt ?? "") + "|" + request.prompt,
    )}`;
  }

  private putCache(key: string, response: ApiResponse, provider: ApiProvider): void {
    // Count entries for this provider
    let providerCount = 0;
    for (const [k] of this.cache) {
      if (k.startsWith(`${provider}:`)) providerCount++;
    }

    // Evict oldest if over limit
    if (providerCount >= this.config.maxCachePerProvider) {
      let oldest: { key: string; expiresAt: number } | null = null;
      for (const [k, v] of this.cache) {
        if (k.startsWith(`${provider}:`) && (!oldest || v.expiresAt < oldest.expiresAt)) {
          oldest = { key: k, expiresAt: v.expiresAt };
        }
      }
      if (oldest) this.cache.delete(oldest.key);
    }

    this.cache.set(key, {
      response,
      expiresAt: Date.now() + this.config.cacheTtlMs,
    });
  }

  /** Get performance stats for the dashboard */
  getStats(): {
    cacheHits: number;
    cacheMisses: number;
    hitRate: string;
    deduped: number;
    queued: number;
    retries: number;
    errors: number;
    totalRequests: number;
    avgLatencyMs: number;
    cacheSize: number;
    inflightRequests: number;
    byProvider: Record<string, { calls: number; avgMs: number; errors: number }>;
  } {
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    const byProvider: Record<string, { calls: number; avgMs: number; errors: number }> = {};
    for (const [provider, stats] of this.stats.byProvider) {
      byProvider[provider] = {
        calls: stats.calls,
        avgMs: stats.calls > 0 ? Math.round(stats.totalMs / stats.calls) : 0,
        errors: stats.errors,
      };
    }

    return {
      ...this.stats,
      hitRate: total > 0 ? `${((this.stats.cacheHits / total) * 100).toFixed(1)}%` : "0%",
      avgLatencyMs: this.stats.totalRequests > 0
        ? Math.round(this.stats.totalLatencyMs / this.stats.totalRequests)
        : 0,
      cacheSize: this.cache.size,
      inflightRequests: this.inflight.size,
      byProvider,
    };
  }

  /** Clear all caches */
  clearCache(): void {
    this.cache.clear();
  }
}

function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
