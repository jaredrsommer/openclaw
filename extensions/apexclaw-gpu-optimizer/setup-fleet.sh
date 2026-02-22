#!/usr/bin/env bash
#
# ApexClaw Fleet Setup for Low-End GPUs (GTX 1070 Ti / 8GB VRAM)
#
# This script sets up a single node in the fleet. Run on each machine.
#
# Usage:
#   NODE_ROLE=fast ./setup-fleet.sh              # Fast node (3B models)
#   NODE_ROLE=general ./setup-fleet.sh           # General node + custom Qwen3 MoE
#   NODE_ROLE=reasoning ./setup-fleet.sh         # Reasoning-focused node
#
# Prerequisites:
#   - NVIDIA driver 470+ installed
#   - Docker installed (for vLLM)
#   - At least 8GB GPU VRAM
#   - 16GB+ system RAM recommended

set -euo pipefail

NODE_ROLE="${NODE_ROLE:-general}"
OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0}"
OLLAMA_PORT="${OLLAMA_PORT:-11434}"
VLLM_PORT="${VLLM_PORT:-8000}"
CUSTOM_QWEN_MODEL_PATH="${CUSTOM_QWEN_MODEL_PATH:-}"

echo "============================================"
echo " ApexClaw Fleet Node Setup"
echo " Role: ${NODE_ROLE}"
echo " GPU VRAM: Optimized for 8GB"
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
  echo "  Configuring Ollama to listen on ${OLLAMA_HOST}:${OLLAMA_PORT}..."
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  sudo tee /etc/systemd/system/ollama.service.d/override.conf > /dev/null << EOF
[Service]
Environment="OLLAMA_HOST=${OLLAMA_HOST}:${OLLAMA_PORT}"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Environment="OLLAMA_FLASH_ATTENTION=1"
EOF
  sudo systemctl daemon-reload
  sudo systemctl restart ollama
  echo "  Ollama configured and restarted."
fi

# --- 2. Pull models based on node role ---
echo ""
echo "[2/5] Pulling models for role: ${NODE_ROLE}..."

# All nodes get the small fast model for routing/classification
echo "  Pulling Qwen 2.5 3B (fast classification model)..."
ollama pull qwen2.5:3b-instruct-q5_K_M 2>/dev/null || ollama pull qwen2.5:3b 2>/dev/null || true

# Embeddings model (tiny, fits everywhere)
echo "  Pulling Nomic Embed (embedding model)..."
ollama pull nomic-embed-text:v1.5 2>/dev/null || ollama pull nomic-embed-text 2>/dev/null || true

case "${NODE_ROLE}" in
  fast)
    echo "  Fast node: Using 3B models only for maximum speed."
    echo "  Pulling Llama 3.2 3B..."
    ollama pull llama3.2:3b-instruct-q5_K_M 2>/dev/null || ollama pull llama3.2:3b 2>/dev/null || true
    ;;
  general)
    echo "  General node: Pulling 7B general + code models..."
    echo "  Pulling Qwen 2.5 7B..."
    ollama pull qwen2.5:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5:7b 2>/dev/null || true
    echo "  Pulling Qwen 2.5 Coder 7B..."
    ollama pull qwen2.5-coder:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5-coder:7b 2>/dev/null || true
    ;;
  reasoning)
    echo "  Reasoning node: Pulling 7B reasoning + general models..."
    echo "  Pulling DeepSeek R1 7B..."
    ollama pull deepseek-r1:7b-q4_K_M 2>/dev/null || ollama pull deepseek-r1:7b 2>/dev/null || true
    echo "  Pulling Qwen 2.5 7B..."
    ollama pull qwen2.5:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5:7b 2>/dev/null || true
    ;;
  *)
    echo "  Unknown role '${NODE_ROLE}'. Pulling general models..."
    ollama pull qwen2.5:7b-instruct-q4_K_M 2>/dev/null || ollama pull qwen2.5:7b 2>/dev/null || true
    ;;
esac

# --- 3. Set up vLLM for custom Qwen3 MoE (general nodes only) ---
echo ""
echo "[3/5] Setting up vLLM for custom Qwen3 MoE..."

if [ "${NODE_ROLE}" = "general" ] && [ -n "${CUSTOM_QWEN_MODEL_PATH}" ]; then
  echo "  Custom Qwen3 MoE model path: ${CUSTOM_QWEN_MODEL_PATH}"

  if command -v docker &>/dev/null; then
    echo "  Starting vLLM container for custom Qwen3 MoE..."

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
    echo "  WARNING: Docker not found. Install Docker to run custom Qwen3 MoE via vLLM."
    echo "  Alternative: Install vLLM directly with pip:"
    echo "    pip install vllm"
    echo "    vllm serve ${CUSTOM_QWEN_MODEL_PATH} --gpu-memory-utilization 0.85 --max-model-len 8192 --dtype half --port ${VLLM_PORT}"
  fi
else
  echo "  Skipping vLLM setup (role=${NODE_ROLE} or no CUSTOM_QWEN_MODEL_PATH set)."
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

echo ""
echo "  Ollama models:"
ollama list 2>/dev/null || echo "  Failed to list Ollama models"

echo ""
echo "  Ollama endpoint: http://${OLLAMA_HOST}:${OLLAMA_PORT}"
curl -s "http://127.0.0.1:${OLLAMA_PORT}/api/tags" > /dev/null 2>&1 && echo "  Ollama API: OK" || echo "  Ollama API: NOT RESPONDING"

if [ "${NODE_ROLE}" = "general" ] && [ -n "${CUSTOM_QWEN_MODEL_PATH}" ]; then
  echo "  vLLM endpoint: http://127.0.0.1:${VLLM_PORT}"
  sleep 5
  curl -s "http://127.0.0.1:${VLLM_PORT}/v1/models" > /dev/null 2>&1 && echo "  vLLM API: OK" || echo "  vLLM API: NOT RESPONDING (may still be loading model)"
fi

# --- 5. Print configuration for openclaw.json ---
echo ""
echo "[5/5] Configuration snippet for openclaw.json:"
echo ""

LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || echo "127.0.0.1")

cat << JSONEOF
Add this to your openclaw.json "plugins" section:

{
  "apexclaw-gpu-optimizer": {
    "gpuVramMb": 8192,
    "localOllamaUrl": "http://${LOCAL_IP}:${OLLAMA_PORT}",
    "localVllmUrl": "http://${LOCAL_IP}:${VLLM_PORT}/v1",
    "tradingMode": true,
    "maxLocalConcurrency": 1,
    "fleetNodes": [
      {
        "host": "${LOCAL_IP}",
        "ollamaPort": ${OLLAMA_PORT},
        "vllmPort": ${VLLM_PORT},
        "gpuVramMb": 8192,
        "role": "${NODE_ROLE}",
        "hasCustomQwen": $([ -n "${CUSTOM_QWEN_MODEL_PATH}" ] && echo "true" || echo "false"),
        "maxConcurrency": 1
      }
    ]
  }
}
JSONEOF

echo ""
echo "============================================"
echo " Setup complete!"
echo " Node Role: ${NODE_ROLE}"
echo " Ollama: http://${LOCAL_IP}:${OLLAMA_PORT}"
if [ "${NODE_ROLE}" = "general" ] && [ -n "${CUSTOM_QWEN_MODEL_PATH}" ]; then
  echo " vLLM:   http://${LOCAL_IP}:${VLLM_PORT}"
fi
echo "============================================"
