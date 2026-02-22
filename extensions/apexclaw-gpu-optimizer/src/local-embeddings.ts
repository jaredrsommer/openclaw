/**
 * Local embedding service for the ApexClaw fleet.
 *
 * Runs nomic-embed-text on CPU via Ollama (on the MoE machine, Ollama is
 * CPU-only because vLLM owns the GPU). With 128GB RAM this is fast enough
 * for all embedding needs — no API calls required for embeddings.
 *
 * Features:
 *   - LRU in-memory cache (128GB RAM = room for millions of cached vectors)
 *   - Request deduplication (concurrent identical requests share one inference)
 *   - Batch embedding (group multiple texts into one Ollama call)
 *   - Cosine similarity for signal dedup and strategy matching
 */

/** A single cached embedding entry */
type CacheEntry = {
  vector: number[];
  accessedAt: number;
};

/** Embedding request that's currently in-flight */
type InflightRequest = {
  promise: Promise<number[]>;
  refCount: number;
};

export type EmbeddingServiceConfig = {
  /** Ollama base URL (default http://127.0.0.1:11434) */
  ollamaUrl: string;
  /** Model tag for embeddings (default nomic-embed-text:v1.5) */
  model: string;
  /** Max entries in the in-memory LRU cache (default 500000) */
  maxCacheEntries: number;
  /** Request timeout in ms (default 10000) */
  timeoutMs: number;
  /** Max texts per batch request (default 32) */
  batchSize: number;
};

const DEFAULT_CONFIG: EmbeddingServiceConfig = {
  ollamaUrl: "http://127.0.0.1:11434",
  model: "nomic-embed-text:v1.5",
  maxCacheEntries: 500_000,
  timeoutMs: 10_000,
  batchSize: 32,
};

export class LocalEmbeddingService {
  private config: EmbeddingServiceConfig;
  private cache: Map<string, CacheEntry> = new Map();
  private inflight: Map<string, InflightRequest> = new Map();
  private stats = {
    hits: 0,
    misses: 0,
    deduped: 0,
    totalEmbeddings: 0,
    errors: 0,
  };

  constructor(config?: Partial<EmbeddingServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Embed a single text, using cache and dedup */
  async embed(text: string): Promise<number[]> {
    const key = this.cacheKey(text);

    // 1. Check in-memory cache
    const cached = this.cache.get(key);
    if (cached) {
      cached.accessedAt = Date.now();
      this.stats.hits++;
      return cached.vector;
    }

    // 2. Check if this exact request is already in-flight (dedup)
    const existing = this.inflight.get(key);
    if (existing) {
      existing.refCount++;
      this.stats.deduped++;
      return existing.promise;
    }

    // 3. Make the actual request
    this.stats.misses++;
    const promise = this.fetchEmbedding(text).then((vector) => {
      // Cache the result
      this.putCache(key, vector);
      this.inflight.delete(key);
      return vector;
    }).catch((err) => {
      this.inflight.delete(key);
      this.stats.errors++;
      throw err;
    });

    this.inflight.set(key, { promise, refCount: 1 });
    return promise;
  }

  /** Embed multiple texts in a batch. Returns vectors in same order as input. */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const results: (number[] | null)[] = new Array(texts.length).fill(null);
    const uncached: { index: number; text: string }[] = [];

    // Check cache first
    for (let i = 0; i < texts.length; i++) {
      const key = this.cacheKey(texts[i]!);
      const cached = this.cache.get(key);
      if (cached) {
        cached.accessedAt = Date.now();
        results[i] = cached.vector;
        this.stats.hits++;
      } else {
        uncached.push({ index: i, text: texts[i]! });
        this.stats.misses++;
      }
    }

    // Batch fetch uncached embeddings
    if (uncached.length > 0) {
      const batchSize = this.config.batchSize;
      for (let start = 0; start < uncached.length; start += batchSize) {
        const batch = uncached.slice(start, start + batchSize);
        const vectors = await Promise.all(
          batch.map((item) => this.fetchEmbeddingDeduped(item.text)),
        );
        for (let j = 0; j < batch.length; j++) {
          results[batch[j]!.index] = vectors[j]!;
        }
      }
    }

    return results as number[][];
  }

  /** Cosine similarity between two texts (cached) */
  async similarity(textA: string, textB: string): Promise<number> {
    const [vecA, vecB] = await Promise.all([this.embed(textA), this.embed(textB)]);
    return cosineSimilarity(vecA, vecB);
  }

  /** Find the most similar text from candidates */
  async findMostSimilar(
    query: string,
    candidates: string[],
    topK = 3,
  ): Promise<Array<{ text: string; score: number; index: number }>> {
    const [queryVec, candidateVecs] = await Promise.all([
      this.embed(query),
      this.embedBatch(candidates),
    ]);

    const scored = candidateVecs.map((vec, i) => ({
      text: candidates[i]!,
      score: cosineSimilarity(queryVec, vec),
      index: i,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** Check if a signal is a duplicate of recently seen signals */
  async isDuplicateSignal(
    signal: string,
    recentSignals: string[],
    threshold = 0.92,
  ): Promise<{ isDuplicate: boolean; bestMatch: number; matchIndex: number }> {
    if (recentSignals.length === 0) {
      return { isDuplicate: false, bestMatch: 0, matchIndex: -1 };
    }

    const [signalVec, recentVecs] = await Promise.all([
      this.embed(signal),
      this.embedBatch(recentSignals),
    ]);

    let bestMatch = 0;
    let matchIndex = -1;

    for (let i = 0; i < recentVecs.length; i++) {
      const sim = cosineSimilarity(signalVec, recentVecs[i]!);
      if (sim > bestMatch) {
        bestMatch = sim;
        matchIndex = i;
      }
    }

    return {
      isDuplicate: bestMatch >= threshold,
      bestMatch,
      matchIndex,
    };
  }

  /** Get cache and performance stats */
  getStats(): {
    cacheSize: number;
    maxCacheSize: number;
    inflightRequests: number;
    hits: number;
    misses: number;
    deduped: number;
    hitRate: string;
    totalEmbeddings: number;
    errors: number;
  } {
    const total = this.stats.hits + this.stats.misses;
    return {
      cacheSize: this.cache.size,
      maxCacheSize: this.config.maxCacheEntries,
      inflightRequests: this.inflight.size,
      ...this.stats,
      hitRate: total > 0 ? `${((this.stats.hits / total) * 100).toFixed(1)}%` : "0%",
    };
  }

  /** Clear the in-memory cache */
  clearCache(): void {
    this.cache.clear();
  }

  // --- Internal ---

  private async fetchEmbeddingDeduped(text: string): Promise<number[]> {
    const key = this.cacheKey(text);

    // Check cache again (might have been populated by concurrent batch)
    const cached = this.cache.get(key);
    if (cached) {
      cached.accessedAt = Date.now();
      return cached.vector;
    }

    // Check inflight
    const existing = this.inflight.get(key);
    if (existing) {
      existing.refCount++;
      this.stats.deduped++;
      return existing.promise;
    }

    const promise = this.fetchEmbedding(text).then((vector) => {
      this.putCache(key, vector);
      this.inflight.delete(key);
      return vector;
    }).catch((err) => {
      this.inflight.delete(key);
      throw err;
    });

    this.inflight.set(key, { promise, refCount: 1 });
    return promise;
  }

  private async fetchEmbedding(text: string): Promise<number[]> {
    const response = await fetch(`${this.config.ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.model, input: text }),
      signal: AbortSignal.timeout(this.config.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Embedding request failed: HTTP ${response.status}`);
    }

    const data = await response.json() as { embeddings?: number[][] };
    const vector = data.embeddings?.[0];
    if (!vector || vector.length === 0) {
      throw new Error("Empty embedding response from Ollama");
    }

    this.stats.totalEmbeddings++;
    return vector;
  }

  private cacheKey(text: string): string {
    // Simple hash — FNV-1a style for speed
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    // Include length to reduce collisions on short strings
    return `${(hash >>> 0).toString(36)}_${text.length}`;
  }

  private putCache(key: string, vector: number[]): void {
    // LRU eviction when cache is full
    if (this.cache.size >= this.config.maxCacheEntries) {
      this.evictOldest(Math.floor(this.config.maxCacheEntries * 0.1));
    }
    this.cache.set(key, { vector, accessedAt: Date.now() });
  }

  private evictOldest(count: number): void {
    // Find the oldest entries by accessedAt
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].accessedAt - b[1].accessedAt);

    for (let i = 0; i < Math.min(count, entries.length); i++) {
      this.cache.delete(entries[i]![0]);
    }
  }
}

/** Cosine similarity between two vectors */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}
