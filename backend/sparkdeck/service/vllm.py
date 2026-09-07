"""vLLM service probing — health, model catalog, version, images — via the
connected runtime (node-local curl), plus helpers to assemble ServiceState.
"""

from __future__ import annotations

import json
import re
import time


async def probe_endpoint(rt, port: int) -> dict:
    """Node-local probes of /health /v1/models /version /load."""
    out: dict = {"port": int(port)}
    for name, path, parser in (
        ("health", "/health", _plain),
        ("models", "/v1/models", _json),
        ("version", "/version", _json),
        ("load", "/load", _json),
    ):
        res = await rt.exec(f"curl -fsS -m 5 http://127.0.0.1:{int(port)}{path} 2>/dev/null", timeout=12)
        try:
            out[name] = parser(res.stdout)
        except Exception:
            out[name] = None
    ok = out.get("health") is not None
    out["ok"] = bool(ok)
    if not out.get("models"):
        out["models"] = out.get("models") or []
    models = out.get("models") or []
    if isinstance(models, dict) and isinstance(models.get("data"), list):
        out["models"] = [m.get("id") for m in models["data"] if m.get("id")]
    return out


def _plain(s: str):
    return "ok" if s and "ok" in s.lower() else (s.strip()[:80] or None)


def _json(s: str):
    js = json.loads(s or "null")
    return js


def model_catalog_ok(state: dict, expected: tuple = ("glm",)) -> bool:
    models = state.get("models") or []
    text = " ".join(models).lower()
    return any(e in text for e in expected)


IMAGE_RE = re.compile(r"^local/[a-z0-9._/-]+:[a-zA-Z0-9._-]+$")


def image_from_env_text(env_text: str) -> str | None:
    for line in env_text.splitlines():
        if line.startswith("SERVING_IMAGE="):
            return line.split("=", 1)[1].strip()
    return None


def env_kv_pin(env_text: str) -> int | None:
    for line in env_text.splitlines():
        if line.startswith("KV_CACHE_MEMORY_BYTES="):
            try:
                return int(line.split("=", 1)[1].strip())
            except Exception:
                return None
    return None


def parse_kv_marker(text: str) -> int | None:
    m = re.search(r"GPU KV cache size:\s*([\d,]+)", text or "")
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except Exception:
            return None
    return None


def boot_age_from_marker(seen_ts_ms: int) -> float | None:
    if not seen_ts_ms:
        return None
    return round((time.time() * 1000 - seen_ts_ms) / 1000.0, 1)


def curated_from_metrics(metrics: dict) -> dict:
    """Pick display-first numeric gauges for the Inference page."""
    keys = ("decode_tok_s", "prompt_tok_s", "num_running", "num_waiting",
            "kv_usage", "prefix_hit_rate", "ttft_ms_avg", "ttft_ms_p95",
            "tpot_ms_avg", "spec_accept", "preemptions")
    return {k: metrics[k] for k in keys if k in metrics}
