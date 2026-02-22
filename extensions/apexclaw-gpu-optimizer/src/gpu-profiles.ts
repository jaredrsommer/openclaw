/**
 * GPU VRAM profiles and model recommendations for low-end GPUs.
 *
 * Maps GPU VRAM tiers to quantized models that fit within memory,
 * with specific configs for the GTX 1070 Ti (8GB) target.
 */

export type QuantLevel = "q2_K" | "q3_K_M" | "q4_K_M" | "q5_K_M" | "q6_K" | "q8_0" | "fp16";

export type ModelRecommendation = {
  /** Ollama model tag (e.g., "qwen2.5:7b-instruct-q4_K_M") */
  ollamaTag: string;
  /** Human-readable name */
  name: string;
  /** Approximate VRAM usage in MB */
  vramMb: number;
  /** Quantization level */
  quant: QuantLevel;
  /** Parameter count in billions */
  paramB: number;
  /** What this model is good for */
  role: "general" | "code" | "reasoning" | "trading" | "embedding" | "vision";
  /** Context window size */
  contextWindow: number;
  /** Whether this supports tool/function calling */
  toolUse: boolean;
  /** Relative speed tier on 8GB GPU: 1=fast, 2=medium, 3=slow */
  speedTier: 1 | 2 | 3;
};

/**
 * Models that fit in 8GB VRAM (GTX 1070 Ti).
 * Sorted by role priority for trading workloads.
 */
export const MODELS_8GB: ModelRecommendation[] = [
  // -- Primary trading workhorse: Qwen 2.5 7B (great tool use + reasoning) --
  {
    ollamaTag: "qwen2.5:7b-instruct-q4_K_M",
    name: "Qwen 2.5 7B Instruct (Q4_K_M)",
    vramMb: 5200,
    quant: "q4_K_M",
    paramB: 7,
    role: "general",
    contextWindow: 32768,
    toolUse: true,
    speedTier: 1,
  },
  // -- Code generation and analysis --
  {
    ollamaTag: "qwen2.5-coder:7b-instruct-q4_K_M",
    name: "Qwen 2.5 Coder 7B (Q4_K_M)",
    vramMb: 5200,
    quant: "q4_K_M",
    paramB: 7,
    role: "code",
    contextWindow: 32768,
    toolUse: true,
    speedTier: 1,
  },
  // -- Small fast model for quick classifications and routing --
  {
    ollamaTag: "qwen2.5:3b-instruct-q5_K_M",
    name: "Qwen 2.5 3B Instruct (Q5_K_M)",
    vramMb: 2500,
    quant: "q5_K_M",
    paramB: 3,
    role: "general",
    contextWindow: 32768,
    toolUse: true,
    speedTier: 1,
  },
  // -- Reasoning model for complex analysis --
  {
    ollamaTag: "deepseek-r1:7b-q4_K_M",
    name: "DeepSeek R1 7B (Q4_K_M)",
    vramMb: 5400,
    quant: "q4_K_M",
    paramB: 7,
    role: "reasoning",
    contextWindow: 16384,
    toolUse: false,
    speedTier: 2,
  },
  // -- Embeddings for market data similarity --
  {
    ollamaTag: "nomic-embed-text:v1.5",
    name: "Nomic Embed Text v1.5",
    vramMb: 600,
    quant: "fp16",
    paramB: 0.137,
    role: "embedding",
    contextWindow: 8192,
    toolUse: false,
    speedTier: 1,
  },
  // -- Phi-3 mini for ultra-fast lightweight tasks --
  {
    ollamaTag: "phi3:3.8b-mini-instruct-4k-q4_K_M",
    name: "Phi-3 Mini 3.8B (Q4_K_M)",
    vramMb: 2800,
    quant: "q4_K_M",
    paramB: 3.8,
    role: "general",
    contextWindow: 4096,
    toolUse: false,
    speedTier: 1,
  },
  // -- Llama 3.2 3B for fast classification --
  {
    ollamaTag: "llama3.2:3b-instruct-q5_K_M",
    name: "Llama 3.2 3B Instruct (Q5_K_M)",
    vramMb: 2600,
    quant: "q5_K_M",
    paramB: 3,
    role: "general",
    contextWindow: 131072,
    toolUse: true,
    speedTier: 1,
  },
];

/**
 * Models for 6GB VRAM (tighter budgets).
 */
export const MODELS_6GB: ModelRecommendation[] = [
  {
    ollamaTag: "qwen2.5:7b-instruct-q3_K_M",
    name: "Qwen 2.5 7B Instruct (Q3_K_M)",
    vramMb: 4400,
    quant: "q3_K_M",
    paramB: 7,
    role: "general",
    contextWindow: 32768,
    toolUse: true,
    speedTier: 2,
  },
  {
    ollamaTag: "qwen2.5:3b-instruct-q4_K_M",
    name: "Qwen 2.5 3B Instruct (Q4_K_M)",
    vramMb: 2200,
    quant: "q4_K_M",
    paramB: 3,
    role: "general",
    contextWindow: 32768,
    toolUse: true,
    speedTier: 1,
  },
  {
    ollamaTag: "phi3:3.8b-mini-instruct-4k-q4_K_M",
    name: "Phi-3 Mini 3.8B (Q4_K_M)",
    vramMb: 2800,
    quant: "q4_K_M",
    paramB: 3.8,
    role: "general",
    contextWindow: 4096,
    toolUse: false,
    speedTier: 1,
  },
];

export type GpuProfile = {
  name: string;
  vramMb: number;
  models: ModelRecommendation[];
  maxConcurrentModels: number;
  recommendedBatchSize: number;
};

export const GPU_PROFILES: Record<string, GpuProfile> = {
  "gtx-1070-ti": {
    name: "NVIDIA GTX 1070 Ti",
    vramMb: 8192,
    models: MODELS_8GB,
    maxConcurrentModels: 1,
    recommendedBatchSize: 1,
  },
  "gtx-1080": {
    name: "NVIDIA GTX 1080",
    vramMb: 8192,
    models: MODELS_8GB,
    maxConcurrentModels: 1,
    recommendedBatchSize: 1,
  },
  "rtx-3060-12gb": {
    name: "NVIDIA RTX 3060 12GB",
    vramMb: 12288,
    models: MODELS_8GB,
    maxConcurrentModels: 2,
    recommendedBatchSize: 2,
  },
  "generic-8gb": {
    name: "Generic 8GB GPU",
    vramMb: 8192,
    models: MODELS_8GB,
    maxConcurrentModels: 1,
    recommendedBatchSize: 1,
  },
  "generic-6gb": {
    name: "Generic 6GB GPU",
    vramMb: 6144,
    models: MODELS_6GB,
    maxConcurrentModels: 1,
    recommendedBatchSize: 1,
  },
};

/** Resolve the best GPU profile for a given VRAM size. */
export function resolveGpuProfile(vramMb: number): GpuProfile {
  if (vramMb >= 12000) return GPU_PROFILES["rtx-3060-12gb"]!;
  if (vramMb >= 8000) return GPU_PROFILES["generic-8gb"]!;
  return GPU_PROFILES["generic-6gb"]!;
}

/** Filter models that fit within a VRAM budget, leaving headroom for OS. */
export function modelsForVram(
  vramMb: number,
  osReserveMb = 512,
): ModelRecommendation[] {
  const available = vramMb - osReserveMb;
  return MODELS_8GB.filter((m) => m.vramMb <= available);
}

/** Get the best model for a given role within VRAM budget. */
export function bestModelForRole(
  role: ModelRecommendation["role"],
  vramMb: number,
): ModelRecommendation | undefined {
  const candidates = modelsForVram(vramMb).filter((m) => m.role === role);
  // Prefer higher quant (better quality) then larger param count
  return candidates.sort((a, b) => b.paramB - a.paramB)[0];
}
