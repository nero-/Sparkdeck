"""Store continuity: rings → raw/1m rollups → fresh instance (restart) → merge."""

import asyncio
import sys
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from sparkdeck.db import DB  # noqa: E402
from sparkdeck.models import AppSettings, SampleFrame  # noqa: E402
from sparkdeck.telemetry.store import SeriesStore  # noqa: E402


class Ref:
    settings = AppSettings()


async def _populate(store: SeriesStore, node_id: str, minutes_ago: int, step_s: int = 2, count: int = 70):
    now_ms = int(time.time() * 1000)
    base = now_ms - minutes_ago * 60_000
    for i in range(count):
        ts = base + i * step_s * 1000
        await store.on_sample(node_id, SampleFrame(node_id=node_id, ts=ts,
                                                   series={"gpu.util": float((ts // 1000) % 40) + 10.0}))
    await store._flush()


async def test_restart_continuity(tmp_path):
    db = DB(tmp_path / "t.sqlite3")
    await db.connect()
    ref = Ref()
    store = SeriesStore(db, ref)
    await _populate(store, "n1", minutes_ago=40)
    # raw decimated table has data for the whole window
    rows = await db.fetch_all("SELECT COUNT(*) AS n FROM samples_raw WHERE name='gpu.util' AND node_id='n1'")
    assert rows[0]["n"] > 2
    rows = await db.fetch_all("SELECT COUNT(*) AS n FROM samples_1m WHERE name='gpu.util'")
    assert rows[0]["n"] >= 1

    fresh = SeriesStore(db, ref)  # post-restart: empty rings
    res = await fresh.query(["n1"], ["gpu.util"], window_s=1200, max_points=400)
    series = res["series"]["gpu.util"]
    assert len(series["t"]) >= 30, f"continuity lost: {len(series['t'])}"
    # values monotone-ish check: mixed raw + rollup continuity has no giant holes
    deltas = [series["t"][i + 1] - series["t"][i] for i in range(len(series["t"]) - 1)]
    assert max(deltas) <= 65_000, max(deltas)  # ≤ ~1 min gap tolerance
    await db.close()
