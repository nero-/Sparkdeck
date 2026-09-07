"""OpenAI-compatible streaming chat passthrough with TTFT/TPS measurement.

Requests go to the serving head over the operator machine's network (the API
is LAN-reachable by design and no-auth; fallback ordering uses the node's
declared addresses). The backend transparently relays SSE deltas and appends
a terminal `{"stats": …}` frame. Per-request results are kept in a bounded
in-memory ring (history endpoint).
"""

from __future__ import annotations

import json
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..db import DB, now_ms
from ..models import ChatRequest


@dataclass
class RequestStat:
    ts: int
    cluster_id: str
    host: str
    port: int
    model: str
    ttft_ms: float | None = None
    tps: float | None = None
    output_tokens: int = 0   # estimated delta-piece count (fallback), usage wins
    prompt_tokens: int | None = None
    error: str | None = None
    total_ms: int = 0


class ChatProxy:
    MAX_HISTORY = 200

    def __init__(self, db: DB) -> None:
        self.db = db
        self.history: deque[RequestStat] = deque(maxlen=self.MAX_HISTORY)
        self._mock_stream = None  # async gen factory (cluster, target) → pieces

    def bind_mock(self, factory) -> None:
        self._mock_stream = factory

    def resolve_target(self, cluster: dict, nodes_by_id: dict, head_addr: str) -> tuple[str, int, str]:
        control = cluster["control"]
        head = nodes_by_id.get(control["head_node_id"]) or {}
        port = int(head.get("api_port") or 8000)
        model = None
        for p in cluster.get("profiles", []):
            model = model or p.get("served_model_name")
        return head_addr, port, model or ""

    async def stream_chat(self, cluster: dict, nodes_by_id: dict, head_addr: str, req: ChatRequest):
        host, port, default_model = self.resolve_target(cluster, nodes_by_id, head_addr)
        if not host:
            yield {"error": "no head address known (cluster not online)"}
            return
        model = req.model or default_model or ""
        stat = RequestStat(ts=now_ms(), cluster_id=cluster["id"], host=host, port=int(port),
                           model=model or "default")
        self.history.appendleft(stat)
        if self._mock_stream is not None:
            t0 = time.time()
            out_tokens = 0
            saw = False
            async for text in self._mock_stream():
                if not saw:
                    saw = True
                    stat.ttft_ms = round((time.time() - t0) * 1000, 1)
                    yield {"choice": {"delta": {"content": text}}}
                else:
                    out_tokens += 1
                    yield {"choice": {"delta": {"content": text}}}
            dt = (time.time() - t0) * 1000
            stat.total_ms = int(dt)
            stat.output_tokens = out_tokens or 17
            stat.tps = round(stat.output_tokens / max(0.001, dt / 1000), 1)
            yield {"stats": {"ttft_ms": stat.ttft_ms, "tps": stat.tps,
                             "output_tokens": stat.output_tokens, "prompt_tokens": 12,
                             "total_ms": stat.total_ms}}
            return
        url = f"http://{host}:{port}/v1/chat/completions"
        body: dict[str, Any] = {
            "messages": [m.model_dump() for m in req.messages],
            "model": model or "default",
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if req.max_tokens:
            body["max_tokens"] = int(req.max_tokens)
        if req.temperature is not None:
            body["temperature"] = req.temperature
        if req.top_p is not None:
            body["top_p"] = req.top_p

        t0 = time.time()
        out_tokens = 0
        prompt_tokens = None
        try:
            timeout = httpx.Timeout(120.0, connect=10.0, read=None)
            async with httpx.AsyncClient(timeout=timeout) as client:
                try:
                    resp = await client.send(client.build_request("POST", url, json=body), stream=True)
                except httpx.HTTPStatusError:
                    raise
                except Exception:
                    # server may not support stream_options — retry without it
                    body.pop("stream_options", None)
                    resp = await client.send(client.build_request("POST", url, json=body), stream=True)
                if resp.status_code >= 400:
                    err_text = (await resp.aread()).decode(errors="replace")[:400]
                    stat.error = f"http_{resp.status_code}: {err_text}"
                    yield {"error": stat.error}
                    return
                saw_first = False
                async with resp:
                    async for raw in resp.aiter_lines():
                        if not raw or not raw.startswith("data:"):
                            continue
                        payload = raw[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except Exception:
                            continue
                        usage = chunk.get("usage")
                        if usage:
                            pt = usage.get("prompt_tokens")
                            if pt:
                                prompt_tokens = int(pt)
                            ot = usage.get("completion_tokens")
                            if ot:
                                out_tokens = int(ot)  # usage is authoritative when present
                        for choice in chunk.get("choices") or []:
                            delta = choice.get("delta") or {}
                            text = delta.get("content")
                            if not text:
                                continue
                            if not saw_first:
                                saw_first = True
                                stat.ttft_ms = round((time.time() - t0) * 1000, 1)
                            if not usage:
                                out_tokens += 1  # vLLM streams ~ 1 delta piece per token
                            yield {"choice": {"delta": {"content": text}}}
                dt = (time.time() - t0) * 1000
                stat.total_ms = int(dt)
                if out_tokens and dt > 0:
                    stat.output_tokens = out_tokens
                    stat.tps = round(out_tokens / (dt / 1000.0), 1)
                stat.prompt_tokens = prompt_tokens
                if saw_first or out_tokens:
                    yield {
                        "stats": {
                            "ttft_ms": stat.ttft_ms,
                            "tps": stat.tps,
                            "output_tokens": out_tokens,
                            "prompt_tokens": prompt_tokens,
                            "total_ms": stat.total_ms,
                        }
                    }
        except Exception as exc:  # noqa: BLE001
            stat.error = repr(exc)[:200]
            yield {"error": stat.error}

    def history_list(self, cluster_id: str | None = None, limit: int = 50) -> list[dict]:
        out = []
        for st in self.history:
            if cluster_id and st.cluster_id != cluster_id:
                continue
            d = st.__dict__.copy()
            d["ts"] = st.ts
            out.append(d)
        return out[:limit]
