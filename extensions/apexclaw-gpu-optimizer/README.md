# ApexClaw GPU Optimizer

GPU-optimized trading agent framework for OpenClaw, designed to run on low-end GPUs (8GB VRAM, e.g. GTX 1070 Ti) with a multi-tier inference strategy.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │           Tiered Model Router            │
                    │                                         │
                    │  Task → Classify → Route → Execute      │
                    └────────┬──────────┬──────────┬──────────┘
                             │          │          │
                    ┌────────▼──┐ ┌─────▼─────┐ ┌─▼──────────┐
                    │  Tier 1   │ │  Tier 2   │ │   Tier 3   │
                    │ Local GPU │ │ Free APIs │ │  Paid APIs  │
                    │           │ │           │ │             │
                    │ Ollama    │ │ NVIDIA    │ │ Claude Max  │
                    │ vLLM      │ │ NIM       │ │ ($100/mo)  │
                    │           │ │ Grok Free │ │ Grok Pro   │
                    │ $0/mo     │ │ $0/mo     │ │ ~$5-20/mo  │
                    └───────────┘ └───────────┘ └────────────┘
```

## Tier Routing Strategy

| Task Type | Tier | Model | Why |
|-----------|------|-------|-----|
| Signal classification | Local | Qwen 3B | Speed-critical, simple pattern matching |
| Sentiment analysis | Local | Custom Qwen3 MoE | Trained specifically for trading |
| Liquidation detection | Local | Qwen 3B | Ultra-low latency required |
| Stream observation | Local | Qwen 3B | Continuous, high-volume |
| Anomaly detection | Local | Custom Qwen3 MoE | Trading-specific patterns |
| Order generation | Local | Custom Qwen3 MoE | Structured output, trading formats |
| Market summary | Free API | NVIDIA Nemotron 70B | Large context, free |
| RBI research | Free API | NVIDIA Nemotron 70B | Deep analysis, free |
| RBI implementation | Free API | NVIDIA 70B | Robust code gen, free |
| Polymarket analysis | Free API | NVIDIA 70B | Complex reasoning, free |
| RBI backtest | Local | Qwen Coder 7B | Code generation, local |
| Risk assessment | Paid API | Claude Sonnet | Critical decisions need best reasoning |

## 8GB VRAM Model Recommendations

Models quantized to fit in 8GB VRAM (GTX 1070 Ti):

| Model | VRAM | Speed | Role |
|-------|------|-------|------|
| Qwen 2.5 3B Q5_K_M | ~2.5 GB | Fast | Classification, routing |
| Qwen 2.5 7B Q4_K_M | ~5.2 GB | Medium | General inference |
| Qwen 2.5 Coder 7B Q4_K_M | ~5.2 GB | Medium | Code generation |
| DeepSeek R1 7B Q4_K_M | ~5.4 GB | Slow | Reasoning tasks |
| Nomic Embed v1.5 | ~0.6 GB | Fast | Embeddings |
| Custom Qwen3 MoE | ~6-7 GB | Medium | Trading-specific (via vLLM) |

**Important**: Only ONE 7B model can be loaded at a time on 8GB VRAM. The router handles model swapping automatically via Ollama's model management.

## Fleet Setup (Multiple 1070 Ti Machines)

### Quick Start

On each machine:

```bash
# Node 1: Fast classification node
NODE_ROLE=fast ./setup-fleet.sh

# Node 2: General + custom Qwen3 MoE
NODE_ROLE=general CUSTOM_QWEN_MODEL_PATH=/path/to/qwen3-moe ./setup-fleet.sh

# Node 3: Reasoning node
NODE_ROLE=reasoning ./setup-fleet.sh
```

### Custom Qwen3 MoE Setup

Your custom Qwen3 MoE trained on trading techniques runs via vLLM:

```bash
# Via Docker (recommended for 8GB VRAM)
docker run -d --gpus all \
  -v /path/to/model:/model \
  -p 8000:8000 \
  vllm/vllm-openai:latest \
  --model /model \
  --gpu-memory-utilization 0.85 \
  --max-model-len 8192 \
  --dtype half \
  --enforce-eager \
  --max-num-seqs 1

# Or directly with pip
pip install vllm
vllm serve /path/to/model \
  --gpu-memory-utilization 0.85 \
  --max-model-len 8192 \
  --dtype half \
  --enforce-eager \
  --port 8000
```

Key vLLM flags for 8GB VRAM:
- `--gpu-memory-utilization 0.85` — Leave headroom for OS
- `--max-model-len 8192` — Limit context to save VRAM
- `--dtype half` — FP16 inference
- `--enforce-eager` — Disable CUDA graphs (saves VRAM)
- `--max-num-seqs 1` — Single request at a time

## Free API Setup

### NVIDIA NIM (Free Tier)

1. Sign up at https://build.nvidia.com
2. Get an API key (free tier includes generous rate limits)
3. Set `NVIDIA_API_KEY` in your environment

Available free models:
- `nvidia/llama-3.1-nemotron-70b-instruct` — Best general model
- `meta/llama-3.3-70b-instruct` — Alternative 70B
- `nvidia/mistral-nemo-minitron-8b-8k-instruct` — Fast 8B model

### Grok (xAI)

1. Get API access from your Grok subscription
2. Set `XAI_API_KEY` in your environment

### Claude Max ($100/mo Subscription)

Used only for critical risk assessment and complex reasoning.
Set `ANTHROPIC_API_KEY` in your environment.

## Configuration

Copy `apexclaw.config.example.json` and merge into your `openclaw.json`:

```json
{
  "plugins": {
    "apexclaw-gpu-optimizer": {
      "gpuVramMb": 8192,
      "localOllamaUrl": "http://127.0.0.1:11434",
      "localVllmUrl": "http://127.0.0.1:8000/v1",
      "tradingMode": true,
      "maxLocalConcurrency": 1,
      "tier": "auto"
    }
  }
}
```

## Trading Agents (RBI Pipeline)

10 specialized agents, each optimized for 8GB GPU inference:

| Agent | Mode | Task | Default Tier |
|-------|------|------|-------------|
| Stream Observer | Continuous | Market data monitoring | Local (3B) |
| Signal Classifier | Continuous | Trade signal classification | Local (3B) |
| Liquidation Detector | Continuous | Hyperliquid liquidation sniping | Local (3B) |
| Sentiment Analyzer | Every 15min | Social/news sentiment | Local (Qwen3 MoE) |
| Anomaly Hunter | Every 4h | Statistical anomaly detection | Local (Qwen3 MoE) |
| RBI Researcher | On-demand | Strategy research | Free API (NVIDIA 70B) |
| RBI Backtester | On-demand | Strategy backtesting | Local (Coder 7B) |
| RBI Implementer | On-demand | Strategy implementation | Free API (NVIDIA 70B) |
| Risk Manager | Every 5min | Portfolio risk assessment | Paid API (Claude) |
| Polymarket Analyst | Every 30min | Prediction market arbitrage | Free API (NVIDIA 70B) |

## Cost Estimate

For a moderate trading setup (~7,000 inference calls/day):

| Tier | Monthly Cost | Tasks |
|------|-------------|-------|
| Local GPU (Ollama/vLLM) | $0 | ~5,500 calls (signals, liquidations, streams) |
| Free APIs (NVIDIA/Grok) | $0 | ~1,200 calls (research, summaries, implementation) |
| Paid APIs (Claude/Grok Pro) | ~$5-20 | ~300 calls (risk assessment only) |

**Total: ~$5-20/month** (electricity not included)

## Risk Warning

Autonomous trading can lose 100% of capital. Always:
1. Start with paper trading
2. Use small position sizes (<= $1,000 initial live capital)
3. Never disable the Risk Manager agent
4. Monitor the EMERGENCY_STOP conditions
5. This is educational — not financial advice
