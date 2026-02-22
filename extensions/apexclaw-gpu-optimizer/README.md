# ApexClaw GPU Optimizer

GPU-optimized trading agent framework for OpenClaw, designed to run on low-end GPUs (8GB VRAM, e.g. GTX 1070 Ti) with a multi-tier inference strategy and a real-time monitoring dashboard.

## Architecture: MoE Machine + Scale as You Go

The **MoE machine** (128GB DDR4, Ryzen 5900X, GTX 1070 Ti) is always the anchor. It runs your custom Qwen3 MoE on GPU via vLLM, handles backtesting (best CPU + most RAM), and hosts the dashboard. Free/paid APIs fill in the gaps — no GPU needed for risk assessment, research, or polymarket analysis.

Start with what you have. Add GPU machines as they become available.

### 1-Node: Just the MoE Machine

Everything runs on one box. vLLM owns the GPU for your MoE model, Ollama runs Qwen 3B on CPU (128GB RAM makes this viable). APIs handle research, risk, and overflow.

```
  ┌────────────────────────────────────────────────────┐
  │              MOE MACHINE (128GB / 5900X)            │
  │                                                    │
  │  GPU (1070 Ti)         CPU (5900X 12c/24t)         │
  │  ┌──────────────┐     ┌────────────────────────┐   │
  │  │ vLLM         │     │ Ollama (CPU mode)      │   │
  │  │ Custom Qwen3 │     │ Qwen 3B classification │   │
  │  │ MoE Trading  │     ├────────────────────────┤   │
  │  │              │     │ Backtesting engine     │   │
  │  │ Sentiment    │     │ (128GB RAM for data)   │   │
  │  │ Anomaly Det. │     ├────────────────────────┤   │
  │  │ Order Gen    │     │ Dashboard :3939        │   │
  │  └──────────────┘     └────────────────────────┘   │
  │                                                    │
  │  APIs: Risk (Claude) · Research (NVIDIA) · Grok    │
  └────────────────────────────────────────────────────┘
```

### 2-Node: MoE + Coder (Recommended Starter)

Add a second GPU machine for code generation. The MoE machine sheds RBI research/implement work and focuses on trading inference + backtesting.

```
  ┌──────────────────────────────┐    ┌──────────────────────────────┐
  │  MOE MACHINE (128GB / 5900X) │    │  CODER MACHINE               │
  │                              │    │                              │
  │  GPU: Custom Qwen3 MoE      │    │  GPU: Qwen Coder 7B         │
  │  CPU: Qwen 3B (classifier)  │    │       DeepSeek R1 7B        │
  │  CPU: Backtesting (128GB)   │    │                              │
  │  Dashboard :3939            │    │  RBI Research                │
  │                              │    │  RBI Implementation         │
  │  Sentiment · Anomaly         │    │                              │
  │  Stream · Signal · Liquidation│    │                              │
  │                              │    │                              │
  │  APIs: Risk (Claude)         │    │  APIs: NVIDIA NIM (overflow) │
  │        Polymarket (NVIDIA)   │    │                              │
  └──────────────────────────────┘    └──────────────────────────────┘
```

### 3-Node: MoE + Coder + Sentinel

Offload fast 3B classification to a dedicated GPU. The MoE machine no longer runs Ollama — pure vLLM trading inference + CPU backtesting.

```
  ┌───────────────────────┐  ┌──────────────────┐  ┌──────────────────┐
  │  MOE (128GB / 5900X)  │  │  CODER            │  │  SENTINEL         │
  │                       │  │                  │  │                  │
  │  GPU: Qwen3 MoE only │  │  GPU: Coder 7B   │  │  GPU: Qwen 3B    │
  │  CPU: Backtesting     │  │       R1 7B      │  │       (fast)     │
  │  Dashboard :3939     │  │                  │  │                  │
  │                       │  │  RBI Research    │  │  Stream Observer │
  │  Sentiment            │  │  RBI Implement   │  │  Signal Classify │
  │  Anomaly Hunter       │  │                  │  │  Liquidation Det │
  └───────────────────────┘  └──────────────────┘  └──────────────────┘
```

### 4-Node: Full Fleet

Add a dedicated Queen for orchestration. MoE machine is 100% focused on trading inference + backtesting.

```
  ┌───────────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
  │  MOE (Strategist) │  │  CODER        │  │  SENTINEL     │  │  QUEEN        │
  │                   │  │              │  │              │  │              │
  │  GPU: Qwen3 MoE  │  │  GPU: Coder  │  │  GPU: 3B     │  │  Dashboard   │
  │  CPU: Backtesting │  │       R1     │  │  (fast)      │  │  :3939       │
  │                   │  │              │  │              │  │              │
  │  Sentiment        │  │  RBI Research│  │  Stream Obs  │  │  Risk Mgr    │
  │  Anomaly          │  │  RBI Impl   │  │  Signal Cls  │  │  (Claude API)│
  │  RBI Backtest     │  │              │  │  Liq Detect  │  │  Polymarket  │
  └───────────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

## Why Backtesting Lives on the MoE Machine

The RBI Backtester always runs on the MoE machine regardless of fleet size:

- **128GB DDR4** — Hold years of tick data in memory (vectorbt, backtrader)
- **Ryzen 5900X** (12c/24t) — Parallel strategy evaluation, Monte Carlo sims
- **CPU-bound task** — Backtesting doesn't need GPU, so it doesn't compete with vLLM
- Other machines have 16-32GB RAM and slower CPUs — they'd bottleneck on data loading

## Dashboard

Real-time monitoring at `http://<dashboard-host>:3939`:

- **Fleet overview** — node cards with health, GPU load, loaded models
- **Agent status** — running/idle/error state for all 10 agents
- **RBI Pipeline** — visual R→B→I progress tracker
- **Event log** — live stream of routing decisions, completions, alerts
- **Tier cost tracker** — local (free) vs free API vs paid API spend
- **Controls** — pause, resume, emergency stop from the browser

## Tier Routing Strategy

| Task Type | Tier | Model | Why |
|-----------|------|-------|-----|
| Signal classification | Local | Qwen 3B (CPU or GPU) | Speed-critical, simple pattern matching |
| Sentiment analysis | Local | Custom Qwen3 MoE (GPU) | Trained specifically for trading |
| Liquidation detection | Local | Qwen 3B (CPU or GPU) | Ultra-low latency required |
| Stream observation | Local | Qwen 3B (CPU or GPU) | Continuous, high-volume |
| Anomaly detection | Local | Custom Qwen3 MoE (GPU) | Trading-specific patterns |
| Order generation | Local | Custom Qwen3 MoE (GPU) | Structured output, trading formats |
| RBI backtest | Local | CPU (128GB MoE machine) | RAM + CPU intensive, not GPU |
| RBI research | Free API | NVIDIA Nemotron 70B | Deep analysis, free |
| RBI implementation | Free API | NVIDIA 70B | Robust code gen, free |
| Polymarket analysis | Free API | NVIDIA 70B | Complex reasoning, free |
| Market summary | Free API | NVIDIA Nemotron 70B | Large context, free |
| Risk assessment | Paid API | Claude Sonnet | Critical decisions need best reasoning |

## 8GB VRAM Model Recommendations

Models quantized to fit in 8GB VRAM (GTX 1070 Ti):

| Model | VRAM | Speed | Node |
|-------|------|-------|------|
| Custom Qwen3 MoE | ~6-7 GB | Medium | MoE (vLLM, GPU) |
| Qwen 2.5 3B Q5_K_M | ~2.5 GB | Fast | MoE (Ollama, CPU) or Sentinel (GPU) |
| Qwen 2.5 Coder 7B Q4_K_M | ~5.2 GB | Medium | Coder (GPU) |
| DeepSeek R1 7B Q4_K_M | ~5.4 GB | Slow | Coder (GPU) |
| Qwen 2.5 7B Q4_K_M | ~5.2 GB | Medium | Queen (GPU) |
| Nomic Embed v1.5 | ~0.6 GB | Fast | Any (embeddings) |

## Quick Start

### Step 1: Set Up the MoE Machine (Always First)

This is your anchor node — 128GB DDR4, Ryzen 5900X, GTX 1070 Ti.

```bash
# On the MoE machine
NODE_ROLE=moe CUSTOM_QWEN_MODEL_PATH=/path/to/qwen3-moe ./setup-fleet.sh
```

This will:
- Install Ollama in **CPU-only** mode (vLLM gets the GPU)
- Pull Qwen 3B for fast classification (runs on CPU, fast enough with 128GB RAM)
- Start vLLM with your custom Qwen3 MoE on GPU
- Print a config snippet for `openclaw.json`

**You can stop here.** With 1 node, the system works — APIs handle research, risk, and polymarket.

### Step 2: Add a Coder Machine (Recommended)

When you have a second GPU machine:

```bash
# On the Coder machine
NODE_ROLE=coder ./setup-fleet.sh
```

This pulls Qwen Coder 7B + DeepSeek R1 7B onto the GPU. Update your `openclaw.json` fleetNodes to include both machines.

### Step 3: Add a Sentinel Machine (Optional)

Offload fast 3B classification from MoE CPU to a dedicated GPU:

```bash
# On the Sentinel machine
NODE_ROLE=sentinel ./setup-fleet.sh
```

Frees the MoE machine's CPU for backtesting. Remove the sentinel agents from the MoE node's config.

### Step 4: Add a Dedicated Queen (Optional)

At 4 nodes, you can give the orchestrator its own machine:

```bash
# On the Queen machine
NODE_ROLE=queen ./setup-fleet.sh
```

Move the dashboard and API-backed agents (risk, polymarket) off the MoE machine.

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

## Laptop Remote Control

Control your fleet from a laptop without any GPU. The laptop connects to the dashboard host over your LAN.

```
  ┌──────────────┐         ┌──────────────────────────────┐
  │   LAPTOP     │  HTTP   │  MOE MACHINE (128GB / 5900X)  │
  │  (no GPU)    │────────▶│  Dashboard :3939              │
  │              │         │                              │
  │ OpenClaw CLI │         │  Controls the entire fleet   │
  │ or Browser   │         └──────────────────────────────┘
  └──────────────┘
```

### Laptop Setup

1. Install OpenClaw on your laptop (no GPU or Ollama needed)
2. Copy `laptop.config.example.json` to your OpenClaw config:

```bash
cp laptop.config.example.json ~/.openclaw/config.json
```

3. Edit `remoteQueenHost` to match your MoE machine's IP:

```json
{
  "plugins": {
    "apexclaw-gpu-optimizer": {
      "mode": "remote",
      "remoteQueenHost": "192.168.1.101",
      "dashboardPort": 3939
    }
  }
}
```

4. Control from your laptop:

```bash
apexclaw-trade action:status        # fleet + agent snapshot
apexclaw-trade action:dashboard     # get dashboard URL to open in browser
apexclaw-trade action:pause         # pause all trading
apexclaw-trade action:resume        # resume trading
apexclaw-trade action:emergency-stop reason:"market crash"
apexclaw-trade action:rbi-start hypothesis:"BTC liquidation cascade"
```

5. Or just open `http://<moe-machine-ip>:3939` in your browser for the full dashboard.

### Auto-Discovery

If you don't know the dashboard host's IP, set `remoteQueenHost` to `"auto"`. The client will scan `192.168.1.100-110` for a responding dashboard server.

## Configuration

See `apexclaw.config.example.json` for 1/2/3/4-node configs. The active config uses the `fleetNodes` field — copy the appropriate `_Xnode_fleetNodes` array into it when scaling up.

## Trading Agents (RBI Pipeline)

10 specialized agents across the fleet:

| Agent | Where It Runs | Mode | Default Tier |
|-------|--------------|------|-------------|
| Stream Observer | MoE CPU → Sentinel GPU | Continuous | Local (3B) |
| Signal Classifier | MoE CPU → Sentinel GPU | Continuous | Local (3B) |
| Liquidation Detector | MoE CPU → Sentinel GPU | Continuous | Local (3B) |
| Sentiment Analyzer | MoE GPU (always) | Every 15min | Local (Qwen3 MoE) |
| Anomaly Hunter | MoE GPU (always) | Every 4h | Local (Qwen3 MoE) |
| RBI Researcher | APIs → Coder GPU | On-demand | Free API (NVIDIA 70B) |
| RBI Backtester | MoE CPU (always) | On-demand | Local (128GB RAM) |
| RBI Implementer | APIs → Coder GPU | On-demand | Free API (NVIDIA 70B) |
| Risk Manager | APIs (always) | Every 5min | Paid API (Claude) |
| Polymarket Analyst | APIs (always) | Every 30min | Free API (NVIDIA 70B) |

**"→" means**: starts on the left (fewer nodes), moves to the right when that machine is added.

## Cost Estimate

For a moderate trading setup (~7,000 inference calls/day):

| Tier | Monthly Cost | Tasks |
|------|-------------|-------|
| Local GPU + CPU | $0 | ~5,500 calls |
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
