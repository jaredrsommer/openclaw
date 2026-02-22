#!/usr/bin/env python3
"""
AirLLM Inference Server — runs 70B+ models on 8GB VRAM.

Layer-by-layer inference using jaredrsommer/airllm:
  - Loads one transformer layer at a time into GPU memory
  - 128GB RAM on MoE machine = layers prefetch from RAM (no disk bottleneck)
  - Supports 4bit/8bit compression for 3x speedup
  - OpenAI-compatible HTTP API for integration with the TypeScript fleet

Usage:
  python airllm-server.py --model meta-llama/Llama-3.1-70B-Instruct --port 8787
  python airllm-server.py --model Qwen/Qwen2.5-72B-Instruct --compression 4bit --port 8787

The server exposes:
  POST /v1/chat/completions  — OpenAI-compatible chat completion
  GET  /v1/models            — List loaded model
  GET  /health               — Health check with GPU/RAM stats
  POST /load                 — Load a different model at runtime
"""

import argparse
import json
import time
import os
import sys
import uuid
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

# GPU memory management
os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")

try:
    import torch
    from airllm import AutoModel
except ImportError:
    print("ERROR: airllm not installed. Run: pip install airllm torch", file=sys.stderr)
    sys.exit(1)


class AirLLMEngine:
    """Manages a single airllm model with thread-safe inference."""

    def __init__(self):
        self.model = None
        self.model_id: str = ""
        self.compression: Optional[str] = None
        self.lock = threading.Lock()
        self.total_requests = 0
        self.total_tokens_generated = 0
        self.loaded_at: float = 0
        self.layer_cache_path = "/tmp/airllm-layers"

    def load(
        self,
        model_id: str,
        compression: Optional[str] = None,
        hf_token: Optional[str] = None,
        layer_path: Optional[str] = None,
    ) -> dict:
        """Load a model (or switch to a different one)."""
        with self.lock:
            if self.model is not None and self.model_id == model_id:
                return {"status": "already_loaded", "model": model_id}

            # Free existing model
            if self.model is not None:
                del self.model
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

            cache_path = layer_path or self.layer_cache_path
            os.makedirs(cache_path, exist_ok=True)

            print(f"Loading {model_id} (compression={compression})...")
            start = time.time()

            kwargs = {
                "layer_shards_saving_path": cache_path,
                "profiling_mode": False,
                "prefetching": True,
            }
            if compression:
                kwargs["compression"] = compression
            if hf_token:
                kwargs["hf_token"] = hf_token
            # delete_original=False to preserve original model files
            kwargs["delete_original"] = False

            self.model = AutoModel.from_pretrained(model_id, **kwargs)
            self.model_id = model_id
            self.compression = compression
            self.loaded_at = time.time()

            elapsed = time.time() - start
            print(f"Model loaded in {elapsed:.1f}s")

            return {
                "status": "loaded",
                "model": model_id,
                "compression": compression,
                "load_time_s": round(elapsed, 1),
            }

    def generate(
        self,
        messages: list[dict],
        max_tokens: int = 512,
        temperature: float = 0.7,
    ) -> dict:
        """Generate a chat completion from messages."""
        if self.model is None:
            raise RuntimeError("No model loaded")

        with self.lock:
            start = time.time()
            self.total_requests += 1

            # Format messages into a prompt
            prompt = self._format_chat(messages)

            # Tokenize
            input_tokens = self.model.tokenizer(
                prompt,
                return_tensors="pt",
                return_attention_mask=False,
                truncation=True,
                max_length=4096,
            )

            # Generate
            output = self.model.generate(
                input_tokens["input_ids"].cuda(),
                max_new_tokens=max_tokens,
                do_sample=temperature > 0,
                temperature=max(temperature, 0.01),
                return_dict_in_generate=True,
            )

            # Decode
            generated_ids = output.sequences[0]
            input_length = input_tokens["input_ids"].shape[1]
            new_tokens = generated_ids[input_length:]
            text = self.model.tokenizer.decode(new_tokens, skip_special_tokens=True)

            tokens_generated = len(new_tokens)
            self.total_tokens_generated += tokens_generated
            elapsed = time.time() - start
            tok_per_sec = tokens_generated / elapsed if elapsed > 0 else 0

            return {
                "text": text.strip(),
                "tokens_generated": tokens_generated,
                "tokens_per_second": round(tok_per_sec, 2),
                "latency_ms": round(elapsed * 1000),
                "model": self.model_id,
            }

    def _format_chat(self, messages: list[dict]) -> str:
        """Format chat messages into a prompt string."""
        # Try to use the model's chat template if available
        try:
            if hasattr(self.model, "tokenizer") and hasattr(
                self.model.tokenizer, "apply_chat_template"
            ):
                return self.model.tokenizer.apply_chat_template(
                    messages, tokenize=False, add_generation_prompt=True
                )
        except Exception:
            pass

        # Fallback: simple format
        parts = []
        for msg in messages:
            role = msg.get("role", "user")
            content = msg.get("content", "")
            if role == "system":
                parts.append(f"System: {content}")
            elif role == "assistant":
                parts.append(f"Assistant: {content}")
            else:
                parts.append(f"User: {content}")
        parts.append("Assistant:")
        return "\n\n".join(parts)

    def get_stats(self) -> dict:
        gpu_mem = {}
        if torch.cuda.is_available():
            gpu_mem = {
                "allocated_mb": round(torch.cuda.memory_allocated() / 1024 / 1024),
                "reserved_mb": round(torch.cuda.memory_reserved() / 1024 / 1024),
                "max_allocated_mb": round(
                    torch.cuda.max_memory_allocated() / 1024 / 1024
                ),
            }

        import psutil

        ram = psutil.virtual_memory()

        return {
            "model": self.model_id or None,
            "compression": self.compression,
            "loaded": self.model is not None,
            "uptime_s": round(time.time() - self.loaded_at)
            if self.loaded_at
            else 0,
            "total_requests": self.total_requests,
            "total_tokens_generated": self.total_tokens_generated,
            "gpu": gpu_mem,
            "ram": {
                "total_gb": round(ram.total / 1024 / 1024 / 1024, 1),
                "used_gb": round(ram.used / 1024 / 1024 / 1024, 1),
                "available_gb": round(ram.available / 1024 / 1024 / 1024, 1),
            },
        }


# Global engine
engine = AirLLMEngine()


class RequestHandler(BaseHTTPRequestHandler):
    """HTTP handler implementing OpenAI-compatible API."""

    def do_GET(self):
        if self.path == "/health":
            self._json_response(engine.get_stats())
        elif self.path == "/v1/models":
            models = []
            if engine.model_id:
                models.append(
                    {
                        "id": engine.model_id,
                        "object": "model",
                        "owned_by": "airllm-local",
                    }
                )
            self._json_response({"object": "list", "data": models})
        else:
            self._json_response({"error": "Not found"}, 404)

    def do_POST(self):
        body = self._read_body()

        if self.path == "/v1/chat/completions":
            self._handle_chat(body)
        elif self.path == "/load":
            self._handle_load(body)
        else:
            self._json_response({"error": "Not found"}, 404)

    def _handle_chat(self, body: dict):
        try:
            messages = body.get("messages", [])
            if not messages:
                self._json_response({"error": "messages required"}, 400)
                return

            max_tokens = body.get("max_tokens", 512)
            temperature = body.get("temperature", 0.7)

            result = engine.generate(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
            )

            # OpenAI-compatible response format
            response = {
                "id": f"chatcmpl-{uuid.uuid4().hex[:8]}",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": result["model"],
                "choices": [
                    {
                        "index": 0,
                        "message": {
                            "role": "assistant",
                            "content": result["text"],
                        },
                        "finish_reason": "stop",
                    }
                ],
                "usage": {
                    "completion_tokens": result["tokens_generated"],
                    "total_tokens": result["tokens_generated"],
                },
                "_airllm": {
                    "tokens_per_second": result["tokens_per_second"],
                    "latency_ms": result["latency_ms"],
                },
            }
            self._json_response(response)

        except RuntimeError as e:
            self._json_response({"error": str(e)}, 503)
        except Exception as e:
            self._json_response({"error": f"Generation failed: {e}"}, 500)

    def _handle_load(self, body: dict):
        try:
            model_id = body.get("model")
            if not model_id:
                self._json_response({"error": "model required"}, 400)
                return

            result = engine.load(
                model_id=model_id,
                compression=body.get("compression"),
                hf_token=body.get("hf_token"),
                layer_path=body.get("layer_path"),
            )
            self._json_response(result)

        except Exception as e:
            self._json_response({"error": f"Load failed: {e}"}, 500)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length))

    def _json_response(self, data: dict, status: int = 200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        # Quieter logging
        if "/health" not in str(args):
            print(f"[airllm] {args[0]}")


def main():
    parser = argparse.ArgumentParser(description="AirLLM Inference Server")
    parser.add_argument(
        "--model",
        type=str,
        default=None,
        help="Model to load on startup (e.g. meta-llama/Llama-3.1-70B-Instruct)",
    )
    parser.add_argument(
        "--compression",
        type=str,
        choices=["4bit", "8bit"],
        default="4bit",
        help="Compression level (default: 4bit for 3x speed)",
    )
    parser.add_argument("--port", type=int, default=8787, help="Server port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Server host")
    parser.add_argument(
        "--hf-token", type=str, default=None, help="HuggingFace token for gated models"
    )
    parser.add_argument(
        "--layer-path",
        type=str,
        default="/tmp/airllm-layers",
        help="Path for split layer cache",
    )
    args = parser.parse_args()

    # Pre-load model if specified
    if args.model:
        engine.load(
            model_id=args.model,
            compression=args.compression,
            hf_token=args.hf_token or os.environ.get("HF_TOKEN"),
            layer_path=args.layer_path,
        )

    server = HTTPServer((args.host, args.port), RequestHandler)
    print(f"AirLLM server: http://{args.host}:{args.port}")
    print(f"  GPU: {torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'CPU'}")
    if torch.cuda.is_available():
        vram = torch.cuda.get_device_properties(0).total_mem / 1024 / 1024 / 1024
        print(f"  VRAM: {vram:.1f}GB")
    print(f"  Compression: {args.compression}")
    print(f"  Layer cache: {args.layer_path}")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
