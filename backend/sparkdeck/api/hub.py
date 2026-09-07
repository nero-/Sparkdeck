"""WebSocket hub: one socket per browser client, topics fanout, throttled
per-job tails, plus small caches for kv tokens captured by op runs.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from ..db import now_ms
from ..models import BenchJob, EventRec, OpRecord

_THROTTLE_S = 0.12


class Hub:
    def __init__(self) -> None:
        self._clients: dict[Any, set[str]] = {}
        self._lock = asyncio.Lock()
        self._last_bench: dict[str, float] = {}
        self._last_sample: dict[str, float] = {}
        self.kv_tokens: dict[str, int] = {}          # "cluster:profile" -> tokens
        self._last_ops_state: dict[str, bool] = {}   # op id -> state changed; coalesce

    async def attach(self, ws, topics: set[str] | None = None) -> None:
        async with self._lock:
            self._clients[ws] = topics or set()
        await self.send(ws, "hello", {"t": now_ms(), "topics": sorted(self._clients[ws] or {"*"})})

    async def detach(self, ws) -> None:
        async with self._lock:
            self._clients.pop(ws, None)

    def subscribe(self, ws, topics: set[str]) -> None:
        cur = self._clients.get(ws)
        if cur is None:
            self._clients[ws] = set(topics)
        else:
            cur |= topics

    def unsubscribe(self, ws, topics: set[str]) -> None:
        cur = self._clients.get(ws)
        if cur is not None:
            cur -= topics

    async def send(self, ws, topic: str, data: Any) -> None:
        try:
            await ws.send_text(json.dumps({"topic": topic, "data": data, "ts": now_ms()},
                                          separators=(",", ":")))
        except Exception:
            await self.detach(ws)

    async def publish(self, topic: str, data: Any) -> None:
        for ws in list(self._clients.keys()):
            subs = self._clients.get(ws)
            if subs and "*" not in subs and topic not in subs:
                continue
            await self.send(ws, topic, data)

    # ------------- themed publishers -------------
    async def publish_nodes(self, snap: dict) -> None:
        await self.publish("nodes", snap)

    async def publish_sample(self, node_id: str, sframe) -> None:
        now = time.time()
        if now - self._last_sample.get(node_id, 0) < 0.85:
            return  # thin the tick to ~1Hz per node
        self._last_sample[node_id] = now
        d = sframe.model_dump()
        d["node_id"] = node_id
        await self.publish("samples", d)

    async def publish_service(self, state_dict: dict) -> None:
        await self.publish("service", state_dict)

    def publish_ops(self, op: OpRecord) -> None:
        try:
            loop = asyncio.get_running_loop()
            loop.create_task(self.publish("ops", op.model_dump()))
        except RuntimeError:
            pass

    async def publish_bench_progress(self, job: BenchJob, tail_line: str | None = None) -> None:
        nowq = time.time()
        if tail_line is not None:
            if nowq - self._last_bench.get(job.id, 0) < _THROTTLE_S:
                payload = {"job": job.model_dump(), "tail": None}
            else:
                self._last_bench[job.id] = nowq
                payload = {"job": job.model_dump(), "tail": tail_line}
        else:
            payload = {"job": job.model_dump(), "tail": None}
        await self.publish("bench", payload)

    async def publish_event(self, ev: EventRec) -> None:
        await self.publish("events", ev.model_dump())

    def note_kv_tokens(self, cluster_id: str, profile_key: str, tokens: int) -> None:
        self.kv_tokens[f"{cluster_id}:{profile_key}"] = tokens

    def kv_for(self, cluster_id: str, profile_key: str | None) -> int | None:
        if profile_key:
            return self.kv_tokens.get(f"{cluster_id}:{profile_key}")
        for key in (f"{cluster_id}:",) or ():
            if key in self.kv_tokens:
                return self.kv_tokens[key]
        for k, v in self.kv_tokens.items():
            if k.startswith(cluster_id + ":"):
                return v
        return None
