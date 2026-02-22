#!/usr/bin/env bash
#
# ApexClaw Fleet Setup for Low-End GPUs (GTX 1070 Ti / 8GB VRAM)
#
# Run on each machine with the appropriate NODE_ROLE.
#
# Roles:
#   moe       — The MoE machine (128GB DDR4, Ryzen 5900X, 1070 Ti)
#                vLLM on GPU for custom Qwen3 MoE, Ollama on CPU for 3B fast model.
#                Always handles backtesting. Hosts dashboard until Queen is added.
#
#   coder     — Code gen node. Qwen Coder 7B + DeepSeek R1 7B on GPU via Ollama.
#                Handles RBI research and implementation code gen.
#
#   sentinel  — Fast classification node. Qwen 3B on GPU via Ollama.
#                Handles stream observation, signal classification, liquidation detection.
#
#   queen     — Dedicated orchestration node (only needed at 4-node scale).
#                Runs dashboard, risk manager (API), polymarket analyst (API).
#                Light GPU usage — mostly coordinates API calls.
#
# Usage:
#   NODE_ROLE=moe CUSTOM_QWEN_MODEL_PATH=/path/to/qwen3-moe ./setup-fleet.sh
#   NODE_ROLE=coder ./setup-fleet.sh
#   NODE_ROLE=sentinel ./setup-fleet.sh
#   NODE_ROLE=queen ./setup-fleet.sh
#
# Prerequisites:
#   - NVIDIA driver 470+ installed
#   - Docker installed (for vLLM on MoE machine)
#   - At least 8GB GPU VRAM
#   - MoE machine: 64GB+ system RAM recommended (128GB ideal for backtesting)

set -euo pipefail

NODE_ROLE="${NODE_ROLE:-moe}"
OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
VLLM_PORT="${VLLM_PORT:-8000}"
CUSTOM_QWEN_MODEL_PATH="${CUSTOM_QWEN_MODEL_PATH:-}"

echo "============================================"
echo " ApexClaw Fleet Node Setup"
echo " Role: ${NODE_ROLE}"
echo " GPU VRAM: Optimized for 8GB (1070 Ti)"
echo "============================================"
echo ""

# --- 1. Install Ollama ---
echo "[1/5] Installing Ollama..."
if command -v ollama &>/dev/null; then
  echo "  Ollama already installed: $(ollama --version 2>/dev/null || echo 'unknown')"
else
  curl -fsSL https://ollama.ai/install.sh | sh
  echo "  Ollama installed."
fi

# Configure Ollama to listen on all interfaces (for fleet communication)
if [ -f /etc/systemd/system/ollama.service ]; then
  echo "  Configuring Ollama for role: ${NODE_ROLE}..."
  sudo mkdir -p /etc/systemd/system/ollama.service.d

  if [ "${NODE_ROLE}" = "moe" ]; then
    # MoE machine: Ollama runs on CPU only (vLLM owns the GPU)
    # With 128GB RAM, running 3B on CPU is fast enough for classification
    sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null << EOF
[Service]
Environment="OLLAMA_HOST=${OLLAMA_HOST}:${OLLAMA_PORT}"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=2"
Environment="OLLAMA_FLASH_ATTENTION=1"
Environment="CUDA_VISIBLE_DEVICES="
EOF
    echo "  Ollama set to CPU-only mode (vLLM owns the GPU on this machine)."
    echo "  With 128GB RAM and Ryzen 5900X, Qwen 3B runs fine on CPU."
  else
    # Other nodes: Ollama uses the GPU normally
    sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null << EOF
[Service]
Environment="OLLAMA_HOST=${OLLAMA_HOST}:${OLLAMA_PORT}"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_FLASH_ATTENTION=1"
EOF
  fi

  sudo systemctl daemon-reload
  sudo systemctl restart ollama
  echo "  Ollama configured and restarted."
fi

# --- 2. Pull models based on node role ---
echo ""
echo "[2/5] Pulling models for role: ${NODE_ROLE}..."

case "${NODE_ROLE}" in
  moe)
    # MoE machine: only needs 3B fast model (runs on CPU)
    # The custom Qwen3 MoE runs via vLLM (set up in step 3)
    echo "  Pulling Qwen 2.5 3B (fast classification, runs on CPU)..."
    ollama pull qwen2.5:3b-instruct-q5_K_M 2>/dev/null || ollama pull qwen2.5:3b 2>/dev/null || true
    echo "  Pulling Nomic Embed (embedding model)..."
    ollama pull nomic-embed-text:v1.5 2>/dev/null || ollama pull nomic-embed-text 2>/dev/null || true
    ;;
  coder)
    # Coder node: code gen + reasoning models on GPU
    echo "  Pulling Qwen 2.5 Coder 7B (code generation)..."
    ollama pull qwen2.5-coder:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5-coder:7b 2>/dev/null || true
    echo "  Pulling DeepSeek R1 7B (reasoning)..."
    ollama pull deepseek-r1:7b-q4_K_M 2>/dev/null || ollama pull deepseek-r1:7b 2>/dev/null || true
    echo "  Pulling Qwen 2.5 3B (fast fallback)..."
    ollama pull qwen2.5:3b-instruct-q5_K_M 2>/dev/null || ollama pull qwen2.5:3b 2>/dev/null || true
    ;;
  sentinel)
    # Sentinel node: fast 3B models only, on GPU for max speed
    echo "  Pulling Qwen 2.5 3B (fast classification, GPU-accelerated)..."
    ollama pull qwen2.5:3b-instruct-q5_K_M 2>/dev/null || ollama pull qwen2.5:3b 2>/dev/null || true
    echo "  Pulling Llama 3.2 3B (secondary fast model)..."
    ollama pull llama3.2:3b-instruct-q5_K_M 2>/dev/null || ollama pull llama3.2:3b 2>/dev/null || true
    echo "  Pulling Nomic Embed (embedding model)..."
    ollama pull nomic-embed-text:v1.5 2>/dev/null || ollama pull nomic-embed-text 2>/dev/null || true
    ;;
  queen)
    # Queen node: light models, mostly API gateway
    echo "  Pulling Qwen 2.5 7B (general inference)..."
    ollama pull qwen2.5:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5:7b 2>/dev/null || true
    echo "  Pulling Qwen 2.5 3B (fast fallback)..."
    ollama pull qwen2.5:3b-instruct-q5_K_M 2>/dev/null || ollama pull qwen2.5:3b 2>/dev/null || true
    ;;
  *)
    echo "  Unknown role '${NODE_ROLE}'. Valid roles: moe, coder, sentinel, queen"
    echo "  Pulling general models as fallback..."
    ollama pull qwen2.5:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5:7b 2>/dev/null || true
    ;;
esac

# --- 3. Set up vLLM for custom Qwen3 MoE (MoE machine only) ---
echo ""
echo "[3/5] Setting up vLLM for custom Qwen3 MoE..."

if [ "${NODE_ROLE}" = "moe" ]; then
  if [ -z "${CUSTOM_QWEN_MODEL_PATH}" ]; then
    echo "  WARNING: CUSTOM_QWEN_MODEL_PATH not set."
    echo "  Set this to the path of your custom Qwen3 MoE model weights."
    echo "  Example: CUSTOM_QWEN_MODEL_PATH=/home/user/models/qwen3-moe-trading ./setup-fleet.sh"
  elif command -v docker &>/dev/null; then
    echo "  Custom Qwen3 MoE model path: ${CUSTOM_QWEN_MODEL_PATH}"
    echo "  Starting vLLM container..."

    # Stop existing container if running
    docker stop apexclaw-vllm 2>/dev/null || true
    docker rm apexclaw-vllm 2>/dev/null || true

    # Run vLLM with GPU memory constraints for 8GB VRAM
    docker run -d \
      --name apexclaw-vllm \
      --gpus all \
      --restart unless-stopped \
      -v "${CUSTOM_QWEN_MODEL_PATH}:/model" \
      -p "${VLLM_PORT}:8000" \
      vllm/vllm-openai:latest \
      --model /model \
      --gpu-memory-utilization 0.85 \
      --max-model-len 8192 \
      --dtype half \
      --enforce-eager \
      --max-num-seqs 1 \
      --trust-remote-code

    echo "  vLLM container started on port ${VLLM_PORT}."
    echo "  Monitor: docker logs -f apexclaw-vllm"
  else
    echo "  Docker not found. Install Docker to run custom Qwen3 MoE via vLLM."
    echo "  Alternative (pip):"
    echo "    pip install vllm"
    echo "    vllm serve ${CUSTOM_QWEN_MODEL_PATH} --gpu-memory-utilization 0.85 --max-model-len 8192 --dtype half --port ${VLLM_PORT}"
  fi
else
  echo "  Skipping vLLM — only needed on the MoE machine (NODE_ROLE=moe)."
fi

# --- 4. Verify GPU and models ---
echo ""
echo "[4/5] Verifying setup..."

echo "  GPU Info:"
if command -v nvidia-smi &>/dev/null; then
  nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version --format=csv,noheader 2>/dev/null || echo "  nvidia-smi query failed"
else
  echo "  nvidia-smi not found. Ensure NVIDIA drivers are installed."
fi

if [ "${NODE_ROLE}" = "moe" ]; then
  echo ""
  echo "  System RAM (important for CPU inference + backtesting):"
  free -h 2>/dev/null | head -2 || echo "  Could not read system memory"
  echo ""
  echo "  CPU:"
  grep -m1 'model name' /proc/cpuinfo 2>/dev/null || echo "  Could not read CPU info"
  echo "  Cores: $(nproc 2>/dev/null || echo 'unknown')"
fi

echo ""
echo "  Ollama models:"
ollama list 2>/dev/null || echo "  Failed to list Ollama models"

echo ""
echo "  Ollama endpoint: http://${OLLAMA_HOST}:${OLLAMA_PORT}"
if [ "${NODE_ROLE}" = "moe" ]; then
  echo "  (CPU-only mode — vLLM owns the GPU)"
fi
curl -s "http://127.0.0.1:${OLLAMA_PORT}/api/tags" > /dev/null 2>&1 && echo "  Ollama API: OK" || echo "  Ollama API: NOT RESPONDING"

if [ "${NODE_ROLE}" = "moe" ] && [ -n "${CUSTOM_QWEN_MODEL_PATH}" ]; then
  echo ""
  echo "  vLLM endpoint: http://127.0.0.1:${VLLM_PORT}"
  sleep 5
  curl -s "http://127.0.0.1:${VLLM_PORT}/v1/models" > /dev/null 2>&1 && echo "  vLLM API: OK" || echo "  vLLM API: NOT RESPONDING (may still be loading model)"
fi

# --- 5. Print configuration snippet ---
echo ""
echo "[5/5] Configuration for openclaw.json:"
echo ""

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

case "${NODE_ROLE}" in
  moe)
    cat << JSONEOF
Add this node to your fleetNodes array in openclaw.json:

{
  "id": "node-1-moe",
  "name": "MoE (Strategist+Queen)",
  "host": "${LOCAL_IP}",
  "ollamaPort": ${OLLAMA_PORT},
  "vllmPort": ${VLLM_PORT},
  "gpuVramMb": 8192,
  "role": "strategist",
  "hasCustomQwen": true,
  "maxConcurrency": 2,
  "assignedAgents": [
    "sentiment-analyzer", "anomaly-hunter",
    "stream-observer", "signal-classifier", "liquidation-detector",
    "rbi-backtester",
    "risk-manager", "polymarket-analyst"
  ],
  "isDashboardHost": true
}
JSONEOF
    ;;
  coder)
    cat << JSONEOF
Add this node to your fleetNodes array in openclaw.json:

{
  "id": "node-2-coder",
  "name": "Coder",
  "host": "${LOCAL_IP}",
  "ollamaPort": ${OLLAMA_PORT},
  "vllmPort": ${VLLM_PORT},
  "gpuVramMb": 8192,
  "role": "coder",
  "hasCustomQwen": false,
  "maxConcurrency": 1,
  "assignedAgents": ["rbi-researcher", "rbi-implementer"],
  "isDashboardHost": false
}
JSONEOF
    ;;
  sentinel)
    cat << JSONEOF
Add this node to your fleetNodes array in openclaw.json:

{
  "id": "node-3-sentinel",
  "name": "Sentinel",
  "host": "${LOCAL_IP}",
  "ollamaPort": ${OLLAMA_PORT},
  "vllmPort": ${VLLM_PORT},
  "gpuVramMb": 8192,
  "role": "sentinel",
  "hasCustomQwen": false,
  "maxConcurrency": 2,
  "assignedAgents": ["stream-observer", "signal-classifier", "liquidation-detector"],
  "isDashboardHost": false
}

When adding a Sentinel node, remove these agents from the MoE node's assignedAgents:
  "stream-observer", "signal-classifier", "liquidation-detector"
JSONEOF
    ;;
  queen)
    cat << JSONEOF
Add this node to your fleetNodes array in openclaw.json:

{
  "id": "node-4-queen",
  "name": "Queen",
  "host": "${LOCAL_IP}",
  "ollamaPort": ${OLLAMA_PORT},
  "vllmPort": ${VLLM_PORT},
  "gpuVramMb": 8192,
  "role": "queen",
  "hasCustomQwen": false,
  "maxConcurrency": 1,
  "assignedAgents": ["risk-manager", "polymarket-analyst"],
  "isDashboardHost": true
}

When adding a dedicated Queen, update the MoE node:
  - Set "isDashboardHost": false
  - Remove "risk-manager" and "polymarket-analyst" from assignedAgents
JSONEOF
    ;;
esac

echo ""
echo "============================================"
echo " Setup complete!"
echo " Node Role: ${NODE_ROLE}"
echo " Ollama: http://${LOCAL_IP}:${OLLAMA_PORT}"
if [ "${NODE_ROLE}" = "moe" ]; then
  echo " Ollama mode: CPU-only (vLLM owns GPU)"
  if [ -n "${CUSTOM_QWEN_MODEL_PATH}" ]; then
    echo " vLLM:   http://${LOCAL_IP}:${VLLM_PORT}"
  fi
  echo ""
  echo " This machine handles backtesting (128GB RAM + fast CPU)"
  echo " Dashboard: http://${LOCAL_IP}:3939 (after starting orchestrator)"
fi
echo "============================================"
