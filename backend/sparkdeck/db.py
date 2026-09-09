"""SQLite persistence: topology, settings, ops, events, metrics rollups.

Boring and deliberate: a single WAL sqlite file executed with a dedicated
connection guarded by one asyncio lock. Volumes are small (rollups are the
heavy tables, retention is enforced); a full ORM is deliberately absent —
schema is versioned here and migrated explicitly.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
from pathlib import Path

SCHEMA = [
    """
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY, value TEXT
    )""",
    """
    CREATE TABLE IF NOT EXISTS clusters (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'tp2',
      accent_color TEXT NOT NULL DEFAULT '#22D3EE', notes TEXT,
      control TEXT NOT NULL DEFAULT '{}',
      ord INTEGER NOT NULL DEFAULT 0
    )""",
    """
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
      name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'worker',
      ssh_user TEXT NOT NULL DEFAULT 'nero', ssh_port INTEGER NOT NULL DEFAULT 22,
      ssh_alias TEXT, env_rank INTEGER NOT NULL DEFAULT 0,
      addresses TEXT NOT NULL DEFAULT '[]', api_port INTEGER NOT NULL DEFAULT 8000,
      interest_ifaces TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1,
      ord INTEGER NOT NULL DEFAULT 0
    )""",
    """
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
      key TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
      served_model_name TEXT NOT NULL DEFAULT 'zai-org/GLM-5.3-Flash',
      model_dir_hint TEXT, kv_pin_gib REAL, context INTEGER, speculator TEXT,
      quant TEXT, mm_images INTEGER, mm_videos INTEGER, notes TEXT,
      ord INTEGER NOT NULL DEFAULT 0
    )""",
    """
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT NOT NULL
    )""",
    # operations audit
    """
    CREATE TABLE IF NOT EXISTS ops (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, cluster_id TEXT, profile_key TEXT,
      node_id TEXT, state TEXT NOT NULL, created INTEGER NOT NULL,
      started INTEGER, finished INTEGER, exit INTEGER, message TEXT,
      steps TEXT NOT NULL DEFAULT '[]', log_tail TEXT NOT NULL DEFAULT '[]',
      params TEXT NOT NULL DEFAULT '{}'
    )""",
    """
    CREATE INDEX IF NOT EXISTS idx_ops_created ON ops(created DESC)""",
    # events + alerts
    """
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, ts INTEGER NOT NULL, level TEXT NOT NULL, kind TEXT NOT NULL,
      cluster_id TEXT, node_id TEXT, message TEXT NOT NULL, data TEXT, acked INTEGER NOT NULL DEFAULT 0
    )""",
    """
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC)""",
    # bench jobs
    """
    CREATE TABLE IF NOT EXISTS bench_jobs (
      id TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, profile_key TEXT, label TEXT NOT NULL,
      host TEXT NOT NULL, port INTEGER NOT NULL, model TEXT NOT NULL,
      args TEXT NOT NULL, state TEXT NOT NULL, created INTEGER NOT NULL,
      started INTEGER, finished INTEGER, exit INTEGER,
      result_path TEXT, log_path TEXT, summary TEXT
    )""",
    # raw decimated samples (firehose continuity across restarts; 10s cadence)
    """
    CREATE TABLE IF NOT EXISTS samples_raw (
      ts INTEGER NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL, value REAL,
      PRIMARY KEY (ts, node_id, name)
    )""",
    # 1m rollups: mean / max / min per metric per node per minute
    """
    CREATE TABLE IF NOT EXISTS samples_1m (
      ts INTEGER NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL,
      avg REAL, max REAL, min REAL,
      PRIMARY KEY (ts, node_id, name)
    )""",
    # 10m rollups for long windows
    """
    CREATE TABLE IF NOT EXISTS samples_10m (
      ts INTEGER NOT NULL, node_id TEXT NOT NULL, name TEXT NOT NULL,
      avg REAL, max REAL, min REAL,
      PRIMARY KEY (ts, node_id, name)
    )""",
    """
    CREATE INDEX IF NOT EXISTS idx_samples_raw_ts ON samples_raw(ts)""",
]

_TAIR = 30.0


class DB:
    """Async-safety: every method runs sync sqlite calls in a thread."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: sqlite3.Connection | None = None
        self._lock = asyncio.Lock()

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(self.path, timeout=15, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        async with self._lock:
            with conn:
                for stmt in SCHEMA:
                    conn.execute(stmt)
                # legacy DBs: add columns that post-date the original schema
                cols = {r["name"] for r in conn.execute("PRAGMA table_info(profiles)")}
                try:
                    if "kv_tokens" not in cols:
                        conn.execute("ALTER TABLE profiles ADD COLUMN kv_tokens INTEGER")
                except sqlite3.OperationalError:
                    pass  # readonly/migrated DB — additive column is optional
                conn.execute(
                    "INSERT OR IGNORE INTO meta(key,value) VALUES ('schema','1')"
                )
        self._conn = conn

    async def close(self) -> None:
        if self._conn:
            await asyncio.to_thread(self._conn.close)
            self._conn = None

    # --- generic helpers -------------------------------------------------
    async def execute(self, sql: str, params: tuple = ()) -> None:
        assert self._conn is not None
        async with self._lock:
            await asyncio.to_thread(self._exec, sql, params)

    async def executemany(self, sql: str, rows: list[tuple]) -> None:
        assert self._conn is not None
        async with self._lock:
            await asyncio.to_thread(self._exec_many, sql, rows)

    def _exec_many(self, sql: str, rows: list[tuple]) -> None:
        assert self._conn is not None
        with self._conn:
            self._conn.executemany(sql, rows)

    def _exec(self, sql: str, params: tuple) -> None:
        assert self._conn is not None
        with self._conn:
            self._conn.execute(sql, params)

    async def fetch_all(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        assert self._conn is not None
        async with self._lock:
            return await asyncio.to_thread(self._conn.execute(sql, params).fetchall)

    async def fetch_one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        rows = await self.fetch_all(sql, params)
        return rows[0] if rows else None


def now_ms() -> int:
    return int(time.time() * 1000)


def jloads(s: str | None, default: Any) -> Any:
    if not s:
        return default
    try:
        return json.loads(s)
    except Exception:
        return default


def jdumps(v: Any) -> str:
    return json.dumps(v, separators=(",", ":"), sort_keys=False)
