"""Series storage: in-memory rings for the live view + SQLite rollups for
history across restarts and long windows.

Layering per series & window (newest → oldest):
  ring          ~2s cadence, Ramsey 45 min, in-memory only
  samples_raw   10s decimated cadence, `retentions.raw_hours`, for continuity
                across restarts within the raw window
  samples_1m    1m avg/max/min, minute_days
  samples_10m   10m avg/max/min, decaminute_days

Query resolution picks the layers that cover the requested window, stitches
them (biasing toward the highest resolution available for the newest data),
then LTTB-downsamples to max_points for the chart.
"""

from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Any

from ..db import DB
from ..models import SampleFrame

RAW_HOLD_S = 45 * 60   # ring holds this much (2s cadence)
RAW_DECIMATE_S = 10    # raw table cadence
FLUSH_EVERY_S = 30
PRUNE_EVERY_S = 300


class Ring:
    __slots__ = ("ts", "v")

    def __init__(self, maxlen: int) -> None:
        self.ts: deque[int] = deque(maxlen=maxlen)
        self.v: deque[float | None] = deque(maxlen=maxlen)

    def push(self, ts: int, v: float | None) -> None:
        self.ts.append(ts)
        self.v.append(v)

    def span(self) -> tuple[int, int]:
        if not self.ts:
            return (0, 0)
        return (self.ts[0], self.ts[-1])


class SeriesStore:
    def __init__(self, db: DB, settings_ref) -> None:
        self.db = db
        self.settings_ref = settings_ref  # object with .settings: AppSettings (live)
        self.rings: dict[str, dict[str, Ring]] = {}
        self._raw_buf: dict[str, dict[str, tuple[int, float | None]]] = {}
        self._minute_written: dict[str, dict[str, set]] = {}
        self._tasks: list[asyncio.Task] = []
        self._stopping = asyncio.Event()

    # ---------------- ingest ----------------
    async def on_sample(self, node_id: str, frame: SampleFrame) -> None:
        node_rings = self.rings.setdefault(node_id, {})
        maxlen = max(int(RAW_HOLD_S / self._interval()), 300)
        for name, v in frame.series.items():
            if v is None and name not in node_rings:
                continue  # unknown + null → don't create phantom series
            ring = node_rings.get(name)
            if ring is None:
                ring = node_rings[name] = Ring(maxlen=maxlen)
            ring.push(frame.ts, v)
            if v is None:
                continue
            # raw table decimation (10s): keep the newest sample in each slot
            slot = frame.ts // (RAW_DECIMATE_S * 1000)
            prev = self._raw_buf.get(node_id, {}).get(name)
            if prev is None or prev[0] < slot * (RAW_DECIMATE_S * 1000):
                self._raw_buf.setdefault(node_id, {})[name] = (slot * RAW_DECIMATE_S * 1000, v)

    def _interval(self) -> float:
        try:
            return float(self.settings_ref.settings.sampling_interval_s) or 2.0
        except Exception:
            return 2.0

    # ---------------- queries ----------------
    def latest(self, node_id: str) -> dict[str, float | None]:
        node = self.rings.get(node_id) or {}
        out: dict[str, float | None] = {}
        for name, ring in node.items():
            if ring.v:
                out[name] = ring.v[-1]
        return out

    async def query(
        self,
        node_ids: list[str],
        names: list[str],
        window_s: int = 0,
        from_ms: int = 0,
        to_ms: int = 0,
        max_points: int = 700,
        reduce: str = "avg",  # avg|min|max for rollups
    ) -> dict[str, Any]:
        """Returns {from, to, series: {name: {t:[], v:[]}}} — merged raw+rollups."""
        now = int(time.time() * 1000)
        to = to_ms or now
        frm = from_ms or (to - window_s * 1000 if window_s else to - 5 * 60 * 1000)
        s = self.settings_ref.settings
        raw_from = to - s.retention.raw_hours * 3600 * 1000
        minute_from = to - s.retention.minute_days * 24 * 3600 * 1000
        out: dict[str, dict[str, list]] = {}
        aggregate = len(node_ids) > 1
        for name in names:
            chunks: list[tuple[int, float | None]] = []
            ring_start = None
            if to > now - RAW_HOLD_S * 1000:
                lo = max(frm, now - RAW_HOLD_S * 1000)
                chunks_local = self._ring_range(node_ids, name, lo, to, aggregate)
                if chunks_local:
                    chunks += chunks_local
                    ring_start = chunks_local[0][0]
            if frm < (ring_start or to):
                hi = min(to, ring_start or to)
                if frm < hi:
                    rows = await self._read_roll("raw", node_ids, name, max(frm, raw_from), hi,
                                                 decimate_s=RAW_DECIMATE_S, mode="avg")
                    chunks = rows + chunks
            if frm < raw_from:
                rows = await self._read_roll("1m", node_ids, name, frm, min(raw_from, to),
                                             decimate_s=60, mode=reduce)
                chunks = rows + chunks
            if frm < minute_from:
                rows = await self._read_roll("10m", node_ids, name, frm, min(minute_from, to),
                                             decimate_s=600, mode=reduce)
                chunks = rows + chunks
            chunks = [c for c in chunks if c[1] is not None]
            if chunks:
                chunks.sort(key=lambda tv: tv[0])
                ds = _lttb(chunks, max_points)
                out[name] = {
                    "t": [int(t) for t, _ in ds],
                    "v": [round(v, 6) if isinstance(v, float) else v for _, v in ds],
                }
        return {"from": frm, "to": to, "series": out}

    def _ring_range(self, node_ids: list[str], name: str, lo: int, hi: int, aggregate: bool):
        if not aggregate:
            ring = (self.rings.get(node_ids[0]) or {}).get(name)
            if ring is None:
                return []
            out: list[tuple[int, float | None]] = []
            for t, v in zip(ring.ts, ring.v):
                if lo <= t <= hi:
                    out.append((t, v))
            return out
        # average across nodes per timestamp bucket (renders fleet lines)
        acc: dict[int, tuple[float, int]] = {}
        for nid in node_ids:
            ring = (self.rings.get(nid) or {}).get(name)
            if ring is None:
                continue
            for t, v in zip(ring.ts, ring.v):
                if lo <= t <= hi and v is not None:
                    a, n = acc.get(t, (0.0, 0))
                    acc[t] = (a + v, n + 1)
        return [(t, (a / n) if n else None) for t, (a, n) in sorted(acc.items())]

    async def _read_roll(
        self, layer: str, node_ids: list[str], name: str, frm: int, to: int,
        decimate_s: int, mode: str,
    ) -> list[tuple[int, float | None]]:
        table = f"samples_{layer}"
        if layer == "raw":
            rows = await self.db.fetch_all(
                f"SELECT ts, node_id, value FROM {table} WHERE name=? AND ts>=? AND ts<=? ORDER BY ts",
                (name, frm, to),
            )
            if len(node_ids) == 1:
                return [(r["ts"], r["value"]) for r in rows if r["node_id"] == node_ids[0]]
            acc: dict[int, tuple[float, int]] = {}
            for r in rows:
                if r["node_id"] in node_ids and r["value"] is not None:
                    a, n = acc.get(r["ts"], (0.0, 0))
                    acc[r["ts"]] = (a + r["value"], n + 1)
            return [(t, a / n) for t, (a, n) in sorted(acc.items()) if n]
        col = {"avg": "avg", "min": "min", "max": "max", "mean": "avg"}[mode]
        if len(node_ids) == 1:
            rows = await self.db.fetch_all(
                f"SELECT ts, {col} AS x FROM {table} WHERE name=? AND node_id=? AND ts>=? AND ts<=? ORDER BY ts",
                (name, node_ids[0], frm, to),
            )
            return [(r["ts"], r["x"]) for r in rows if r["x"] is not None]
        rows = await self.db.fetch_all(
            f"SELECT ts, node_id, AVG({col}) AS x FROM {table} WHERE name=? AND ts>=? AND ts<=?"
            " GROUP BY ts ORDER BY ts",
            (name, frm, to),
        )
        return [(r["ts"], r["x"]) for r in rows if r["x"] is not None]

    # ---------------- flush / retention ----------------
    async def run_loop(self) -> None:
        last_flush = 0.0
        last_prune = 0.0
        while not self._stopping.is_set():
            await asyncio.sleep(5)
            now = time.time()
            if now - last_flush >= FLUSH_EVERY_S:
                last_flush = now
                await self._flush()
            if now - last_prune >= PRUNE_EVERY_S:
                last_prune = now
                await self._prune()

    async def _flush(self) -> None:
        raw_rows: list[tuple] = []
        for node_id, names in self._raw_buf.items():
            for name, (ts, v) in list(names.items()):
                raw_rows.append((int(ts), node_id, name, v))
                del names[name]
        if raw_rows:
            await self._bulk_insert(
                "INSERT OR REPLACE INTO samples_raw(ts,node_id,name,value) VALUES(?,?,?,?)",
                raw_rows,
            )
        # close any minute whose data is fully behind us
        now_ms = int(time.time() * 1000)
        closed_min = now_ms // 60000 - 1
        for node_id, node in self.rings.items():
            for name, ring in node.items():
                rows = []
                bucket: dict[int, list[float]] = {}
                for t, v in zip(ring.ts, ring.v):
                    if v is None:
                        continue
                    b = t // 60000
                    if b > closed_min:
                        continue
                    bucket.setdefault(b, []).append(v)
                for b, vals in bucket.items():
                    if b in self._minute_written.get(node_id, {}).get(name, set()):
                        continue
                    self._minute_written.setdefault(node_id, {}).setdefault(name, set()).add(b)
                    ts = b * 60000
                    rows.append((ts, node_id, name, sum(vals) / len(vals), max(vals), min(vals)))
                if rows:
                    await self._bulk_insert(
                        "INSERT OR REPLACE INTO samples_1m(ts,node_id,name,avg,max,min) VALUES(?,?,?,?,?,?)",
                        rows,
                    )

    async def _bulk_insert(self, template: str, rows: list[tuple]) -> None:
        if not rows:
            return
        await self.db.executemany(template, rows)

    async def _prune(self) -> None:
        s = self.settings_ref.settings
        now_ms = int(time.time() * 1000)
        cutoffs = {
            "samples_raw": now_ms - s.retention.raw_hours * 3600 * 1000,
            "samples_1m": now_ms - s.retention.minute_days * 24 * 3600 * 1000,
            "samples_10m": now_ms - s.retention.decaminute_days * 24 * 3600 * 1000,
        }
        for table, cutoff in cutoffs.items():
            await self.db.execute(f"DELETE FROM {table} WHERE ts < ?", (cutoff,))


def _lttb(data: list[tuple[int, float | None]], target_points: int) -> list[tuple[int, float]]:
    """Largest-Triangle-Three-Buckets downsample (gaps preserved as None→skips)."""
    if len(data) <= target_points or len(data) < 4:
        return [(t, v) for t, v in data if v is not None]
    every = len(data) / max(1, target_points)
    out: list[tuple[int, float]] = []
    a_index, a_val = None, None
    last_kept = None
    for i in range(len(data)):
        if last_kept is not None and (i - last_kept) < every and i != len(data) - 1:
            continue
        if data[i][1] is None:
            continue
        t, v = data[i]
        if a_val is not None and a_index is not None and i > a_index + 1:
            avg_r = _mean_range(data, a_index + 1, i)
            best, best_idx = -1.0, a_index + 1
            for j in range(a_index + 1, i):
                if data[j][1] is None:
                    continue
                area = abs((data[a_index][0] - avg_r[0]) * (data[j][1] - a_val)) + abs(
                    (data[j][0] - data[a_index][0]) * (avg_r[1] - a_val)
                )
                if area > best:
                    best, best_idx = area, j
            tk, vk = data[best_idx]
            out.append((tk, vk))
            last_kept = best_idx
        else:
            out.append((t, v))
            last_kept = i
        a_index, a_val = last_kept, data[last_kept][1]
    if last_kept != len(data) - 1 and data[-1][1] is not None:
        out.append((data[-1][0], data[-1][1]))
    return out


def _mean_range(data, i0: int, i1: int):
    vals = [v for _, v in data[i0:i1] if v is not None]
    ts = [t for t, v in data[i0:i1] if v is not None]
    if not vals:
        return (0.0, 0.0)
    return (sum(ts) / len(ts), sum(vals) / len(vals))
