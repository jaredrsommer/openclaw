# ApexClaw GPU Optimizer

GPU-optimized trading agent framework for OpenClaw, designed to run on low-end GPUs (8GB VRAM, e.g. GTX 1070 Ti) with a multi-tier inference strategy and a real-time monitoring dashboard.

## Architecture: 4-Node Fleet

Inspired by MoonDev's multi-OpenClaw setup, but purpose-built for 4x GTX 1070 Ti machines with dedicated roles:

```
  ┌─────────────────────────────────────────────────────────────────┐
  │                     QUEEN ORCHESTRATOR                          │
  │            (Node 4 — coordinates everything)                    │
  │                                                                 │
  │  ┌─────────┐  ┌─────────────┐  ┌──────────┐  ┌─────────────┐  │
  │  │Dashboard │  │Risk Manager │  │Polymarket│  │ API Gateway  │  │
  │  │ :3939    │  │(Claude Max) │  │ Analyst  │  │Claude/Grok/NV│  │
  │  └─────────┘  └─────────────┘  └──────────┘  └─────────────┘  │
  └───────────────────────┬─────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
  ┌─────▼─────┐   ┌──────▼──────┐   ┌──────▼──────┐
  │  SENTINEL  │   │ STRATEGIST  │   │   CODER     │
  │  (Node 1)  │   │  (Node 2)   │   │  (Node 3)   │
  │            │   │             │   │             │
  │ Stream     │   │ Qwen3 MoE   │   │ Qwen Coder  │
  │ Observer   │   │ (trading)   │   │ 7B          │
  │ Signal     │   │             │   │             │
  │ Classifier │   │ Sentiment   │   │ RBI         │
  │ Liquidation│   │ Anomaly     │   │ Research    │
  │ Detector   │   │ Hunter      │   │ Backtest    │
  │            │   │             │   │ Implement   │
  │ Qwen 3B   │   │ Custom MoE  │   │ DeepSeek R1 │
  │ (fast)     │   │ via vLLM    │   │ 7B          │
  └────────────┘   └─────────────┘   └─────────────┘
```

### Scale as you go: 2-node starter

**Don't have all 4 machines yet?** Start with 2 — the system adapts:

```
  ┌──────────────────┐    ┌──────────────────┐
  │ Node 1: Sentinel │    │ Node 2: Queen    │
  │ + Strategist     │    │ + Coder          │
  │                  │    │                  │
  │ Stream Observer  │    │ Risk Manager     │
  │ Signal Classifier│    │ Polymarket       │
  │ Liquidation Det. │    │ RBI Pipeline     │
  │ Sentiment        │    │ Dashboard :3939  │
  │ Anomaly Hunter   │    │                  │
  │                  │    │ Qwen 7B / Coder  │
  │ Qwen 3B + MoE   │    │ + API calls      │
  └──────────────────┘    └──────────────────┘
```

Agents from missing nodes get reassigned to available ones. The free API tier (NVIDIA NIM, Grok) absorbs overflow from busy local GPUs.

## Dashboard

Real-time monitoring at `http://<queen-node>:3939`:

- **Fleet overview** — 4 node cards with health, GPU load, loaded models
- **Agent status** — running/idle/error state for all 10 agents
- **RBI Pipeline** — visual R→B→I progress tracker
- **Event log** — live stream of routing decisions, completions, alerts
- **Tier cost tracker** — local (free) vs free API vs paid API spend
- **Controls** — pause, resume, emergency stop from the browser

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

**With 4 nodes**, each keeps its model loaded permanently — no swapping needed.

## Quick Start

### 2-Node Starter Setup

```bash
# Machine 1: Sentinel + Strategist (your Qwen3 MoE machine)
NODE_ROLE=general CUSTOM_QWEN_MODEL_PATH=/path/to/qwen3-moe ./setup-fleet.sh

# Machine 2: Queen + Coder (hosts the dashboard)
NODE_ROLE=reasoning ./setup-fleet.sh
```

### 4-Node Full Setup

```bash
# Machine 1: Sentinel — fast 3B models for real-time feeds
NODE_ROLE=fast ./setup-fleet.sh

# Machine 2: Strategist — custom Qwen3 MoE for trading
NODE_ROLE=general CUSTOM_QWEN_MODEL_PATH=/path/to/qwen3-moe ./setup-fleet.sh

# Machine 3: Coder — Qwen Coder + DeepSeek R1 for RBI pipeline
NODE_ROLE=reasoning ./setup-fleet.sh

# Machine 4: Queen — dashboard + risk management + API gateway
NODE_ROLE=reasoning ./setup-fleet.sh
```

### Starting the System

```
apexclaw-trade action:start    → starts orchestrator + dashboard
apexclaw-trade action:status   → full fleet + agent snapshot
apexclaw-trade action:dashboard → dashboard URL
apexclaw-trade action:stop     → graceful shutdown
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

### Grok (xAI)

1. Get API access from your Grok subscription
2. Set `XAI_API_KEY` in your environment

### Claude Max ($100/mo Subscription)

Used only for critical risk assessment and complex reasoning.
Set `ANTHROPIC_API_KEY` in your environment.

## Configuration

See `apexclaw.config.example.json` for both 2-node and 4-node configs.

## Trading Agents (RBI Pipeline)

10 specialized agents across the fleet:

| Agent | Node | Mode | Default Tier |
|-------|------|------|-------------|
| Stream Observer | Sentinel | Continuous | Local (3B) |
| Signal Classifier | Sentinel | Continuous | Local (3B) |
| Liquidation Detector | Sentinel | Continuous | Local (3B) |
| Sentiment Analyzer | Strategist | Every 15min | Local (Qwen3 MoE) |
| Anomaly Hunter | Strategist | Every 4h | Local (Qwen3 MoE) |
| RBI Researcher | Coder | On-demand | Free API (NVIDIA 70B) |
| RBI Backtester | Coder | On-demand | Local (Coder 7B) |
| RBI Implementer | Coder | On-demand | Free API (NVIDIA 70B) |
| Risk Manager | Queen | Every 5min | Paid API (Claude) |
| Polymarket Analyst | Queen | Every 30min | Free API (NVIDIA 70B) |

## Cost Estimate

For a moderate trading setup (~7,000 inference calls/day):

| Tier | Monthly Cost | Tasks |
|------|-------------|-------|
| Local GPU (4x 1070 Ti) | $0 | ~5,500 calls |
| Free APIs (NVIDIA/Grok) | $0 | ~1,200 calls |
| Paid APIs (Claude/Grok Pro) | ~$5-20 | ~300 calls (risk only) |

**Total: ~$5-20/month** (electricity not included)

## Risk Warning

Autonomous trading can lose 100% of capital. Always:
1. Start with paper trading
2. Use small position sizes (<= $1,000 initial live capital)
3. Never disable the Risk Manager agent
4. Monitor the EMERGENCY_STOP conditions
5. This is educational — not financial advice
