"""Threshold alerts → events (+ optional webhook). Cooldown per (key, node)
prevents duplicates; state transitions edge-trigger.
"""

from __future__ import annotations

import asyncio as _asyncio
import time
from typing import Callable

from ..db import DB, jdumps, now_ms
from ..models import EventRec

_COOLDOWN_S = 180


class AlertEngine:
    def __init__(self, db: DB, settings_ref, emit_event: Callable[[EventRec], None]) -> None:
        self.db = db
        self.settings_ref = settings_ref
        self._emit_event = emit_event
        self._last_fired: dict[str, float] = {}

    def _cooldown_ok(self, key: str) -> bool:
        t = self._last_fired.get(key, 0.0)
        if time.time() - t < _COOLDOWN_S:
            return False
        return True

    async def evaluate_sample(self, node_id: str, cluster_id: str, series: dict) -> None:
        s = self.settings_ref.settings
        alerts = s.alerts
        checks: list[tuple[str, str, float, float]] = []  # (level, kind, value, threshold)
        used = series.get("mem.used_gib")
        total = series.get("mem.total_gib")
        if used is not None and total is not None and total > 0:
            warn_v = total * alerts.mem_warn_pct / 100.0
            crit_v = total * alerts.mem_crit_pct / 100.0
            pct = used / total * 100.0
            if used >= crit_v:
                checks.append(("error", "mem.crit", pct, alerts.mem_crit_pct))
            elif used >= warn_v:
                checks.append(("warn", "mem.warn", pct, alerts.mem_warn_pct))
        gpu_temp = series.get("gpu.temp")
        if gpu_temp is not None:
            if gpu_temp >= alerts.gpu_temp_crit_c:
                checks.append(("error", "temp.gpu.crit", gpu_temp, alerts.gpu_temp_crit_c))
            elif gpu_temp >= alerts.gpu_temp_warn_c:
                checks.append(("warn", "temp.gpu.warn", gpu_temp, alerts.gpu_temp_warn_c))
        # SparkRing nodes sustain 2–4 GiB of swap while the model is resident
        # (page-cache pacing); 0.5 GiB cried wolf constantly
        swap = series.get("mem.swap_used_gib")
        if swap is not None and swap >= 4.0:
            checks.append(("warn", "mem.swap_used", swap, 4.0))
        throttle = series.get("gpu.throttle_thermal")
        if throttle is not None and throttle > 0:
            checks.append(("warn", "gpu.thermal_throttle", 1.0, 0.5))
        for level, kind, val, thr in checks:
            key = f"{node_id}:{kind}"
            if not self._cooldown_ok(key):
                continue
            self._last_fired[key] = time.time()
            await self.record(node_id, cluster_id, level, kind,
                              f"{kind}: {val:g} (threshold {thr:g})", data={"value": val, "threshold": thr})

    async def record(self, node_id: str | None, cluster_id: str | None, level: str,
                     kind: str, message: str, data: dict | None = None,
                     dedupe_key: str | None = None) -> EventRec:
        ev = EventRec(
            id=f"e{int(time.time() * 1000):x}-{kind[:12]}",
            ts=now_ms(), level=level, kind=kind,  # type: ignore[arg-type]
            cluster_id=cluster_id, node_id=node_id, message=message,
            data=data, acked=False,
        )
        await self.db.execute(
            "INSERT INTO events(id,ts,level,kind,cluster_id,node_id,message,data,acked)"
            " VALUES(?,?,?,?,?,?,?,?,0)",
            (ev.id, ev.ts, ev.level, ev.kind, ev.cluster_id, ev.node_id, ev.message,
             jdumps(ev.data) if ev.data else None),
        )
        self._emit_event(ev)
        self._maybe_webhook(ev)
        if level == "error":
            self._last_fired[f"k:{kind}"] = time.time()
        return ev

    def _maybe_webhook(self, ev: EventRec) -> None:
        url = self.settings_ref.settings.alerts.webhook_url
        if not url:
            return

        async def _post() -> None:
            try:
                import httpx

                async with httpx.AsyncClient(timeout=5) as client:
                    await client.post(url, json=ev.model_dump())
            except Exception:
                pass  # webhooks are best-effort; the local store is the record

        try:
            _asyncio.get_running_loop().create_task(_post())
        except RuntimeError:
            pass

    async def history(self, limit: int = 200, level: str | None = None,
                      cluster_id: str | None = None, kind: str | None = None,
                      since: int = 0, unacked_only: bool = False) -> list[EventRec]:
        q = "SELECT * FROM events WHERE ts>=?"
        params: list = [since]
        if level:
            q += " AND level=?"
            params.append(level)
        if cluster_id:
            q += " AND cluster_id=?"
            params.append(cluster_id)
        if kind:
            q += " AND kind=?"
            params.append(kind)
        if unacked_only:
            q += " AND acked=0"
        q += " ORDER BY ts DESC LIMIT ?"
        params.append(limit)
        rows = await self.db.fetch_all(q, tuple(params))

        def mk(r) -> EventRec:
            import json

            return EventRec(
                id=r["id"], ts=r["ts"], level=r["level"], kind=r["kind"],
                cluster_id=r["cluster_id"], node_id=r["node_id"],
                message=r["message"],
                data=json.loads(r["data"]) if r["data"] else None,
                acked=bool(r["acked"]),
            )

        return [mk(r) for r in rows]
