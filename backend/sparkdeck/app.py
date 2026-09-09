"""Application: wires store, settings ref, runtime (SSH/mock) registry,
telemetry series store, alerts, op engine, chat proxy and bench runner.
"""

from __future__ import annotations

import logging

MODEL_SPARK = "glm-5.3-flash-spark"

import asyncio
import hashlib
import json
import time
from pathlib import Path
from typing import Any, AsyncIterator

from .api.hub import Hub
from .bench.runner import BenchRunner
from .config import RuntimeConfig
from .db import DB, jdumps, jloads, now_ms
from .models import AppSettings, EventRec, OpRecord
from .mock.world import MockWorld
from .service.chat import ChatProxy
from .settings_store import (
    ensure_topology,
    get_app_settings,
    get_topologies,
    patch_app_settings,
    seed_if_empty,
)
from .ssh.pool import SSHRuntime
from .telemetry.alerts import AlertEngine
from .telemetry.parser import check_structure, frame_to_series, service_state_from
from .telemetry.store import SeriesStore


class SettingsRef:
    """Live settings holder; app patches in place (charts read .settings)."""

    def __init__(self, initial: AppSettings) -> None:
        self.settings = initial


COLLECTOR_PATH = Path(__file__).resolve().parent / "telemetry" / "collector.py"


def collector_source() -> tuple[str, str]:
    """The deployable collector source + sha (from the package asset)."""
    src = COLLECTOR_PATH.read_text()
    sha = hashlib.sha256(src.encode()).hexdigest()[:32]
    return src, sha


class Application:
    def __init__(self, cfg: RuntimeConfig) -> None:
        self.cfg = cfg
        self.db = DB(cfg.db_path)
        self.hub = Hub()
        self.settings_ref = SettingsRef(AppSettings())
        self.mock_world = MockWorld() if cfg.mock else None
        self.series = SeriesStore(self.db, self.settings_ref)
        self.alerts: AlertEngine | None = None
        self.engine: OpEngine | None = None
        self.chat = ChatProxy(self.db)
        self.bench = BenchRunner(self.db, self.hub, cfg.runtime_dir)
        self.bench.bind_settings(self.settings_ref)
        if cfg.mock:
            self.chat.bind_mock(self._mock_chat_stream)   # console works in mock too
            self.bench.bind_mock(True)                    # mocked bench artifacts
        self.runtimes: dict[str, Any] = {}
        self.service: dict[str, dict] = {}   # cluster_id -> ServiceState dict
        self.started_monotonic = time.monotonic()
        self._tasks: list[asyncio.Task] = []
        self._stopping = False
        self.topology: list[dict] = []
        self.topology_lock = asyncio.Lock()
        self.console_rt = None  # set in startup (Local / mock)

    @staticmethod
    async def _mock_chat_stream() -> AsyncIterator[str]:
        words = ("Answering from the mock world — "
                 "GLM-5.3-Flash TP2 is serving on cluster 1. "
                 "Try the bench page: C=1 decodes at ~29 tok/s in this sim, "
                 "and prefill scouts ride ~1.7k tok/s at 8k context. ")
        for w in words.split(" "):
            await asyncio.sleep(0.06)
            yield w + " "

    # ---------------- lifecycle ----------------
    async def startup(self) -> None:
        from .control.engine import OpEngine  # late import avoids cycle

        await self.db.connect()
        if self.cfg.mock:
            self.console_rt = self._mock_console()
        else:
            from .control.localrt import LocalRuntime

            self.console_rt = LocalRuntime(name="sparkring-console")
        topo_action = await ensure_topology(self.db)
        if topo_action["action"] == "migrated":
            logging.getLogger("sparkdeck").info("topology migrated to the SparkRing TP4 seed (rev %s)", topo_action["rev"])
        self.settings_ref.settings = await get_app_settings(self.db)
        self.alerts = AlertEngine(self.db, self.settings_ref, self._emit_event)
        self.engine = OpEngine(self.db, self.hub)
        await self.reload_topology()
        self._tasks.append(asyncio.create_task(self.series.run_loop()))
        self._tasks.append(asyncio.create_task(self._service_loop()))
        if self.cfg.mock:
            await self._start_mock()
        else:
            await self.start_runtimes()

    async def shutdown(self) -> None:
        self._stopping = True
        for t in self._tasks:
            t.cancel()
        if self.mock_world:
            await self.mock_world.stop_frames()
        for rt in self.runtimes.values():
            await rt.stop()
        await self.db.close()

    def _emit_event(self, ev: EventRec) -> None:
        try:
            asyncio.get_running_loop().create_task(self.hub.publish_event(ev))
        except RuntimeError:
            pass

    # ---------------- topology / runtimes ----------------
    async def reload_topology(self) -> None:
        async with self.topology_lock:
            self.topology = await get_topologies(self.db)
        nodes = [n for c in self.topology for n in c["nodes"]]
        if self.cfg.mock:
            if self.mock_world and self.mock_world.on_sample:
                await self.mock_world.stop_frames()
                await self._start_mock()
            return
        enabled = {n["id"] for n in nodes if n.get("enabled", True)}
        # stop runtimes not present / disabled / changed
        for nid in list(self.runtimes.keys()):
            if nid not in enabled:
                rt = self.runtimes.pop(nid)
                await rt.stop()
        src, sha = collector_source()
        for n in nodes:
            if not n.get("enabled", True) or n["id"] in self.runtimes:
                continue
            rt = SSHRuntime(n["id"], n["cluster_id"], n, self._on_state, self._on_sample,
                            src, sha, interval_s=self.settings_ref.settings.sampling_interval_s)
            self.runtimes[n["id"]] = rt
            await rt.start()

    async def start_runtimes(self) -> None:
        nodes = [n for c in self.topology for n in c["nodes"]]
        src, sha = collector_source()
        for n in nodes:
            if not n.get("enabled", True) or n["id"] in self.runtimes:
                continue
            rt = SSHRuntime(n["id"], n["cluster_id"], n, self._on_state, self._on_sample,
                            src, sha, interval_s=self.settings_ref.settings.sampling_interval_s)
            self.runtimes[n["id"]] = rt
            await rt.start()

    def _mock_console(self):
        """Console runtime for mock mode: answers sparkring.sh verb
        invocations with in-world lifecycle simulation."""
        if self.mock_world is not None:
            from .mock.world import MockConsoleRuntime

            return MockConsoleRuntime(self.mock_world)
        return None

    async def _start_mock(self) -> None:
        nodes = [n for c in self.topology for n in c["nodes"] if n.get("enabled", True)]
        if self.mock_world.on_state is None:
            self.mock_world.on_state = self._on_state
        # pre-serve cluster 1 so the console has a live world
        self.mock_world.boot_cluster("c1", "tp4-mtp3")
        lc = self.mock_world.cluster_of("c1")
        lc.healthy_at = time.time() - 240.0
        first_profile = next((c["profiles"][0] for c in self.topology if c["profiles"]), None)
        head = None
        for c in self.topology:
            head = next((n for n in c["nodes"] if n.get("role") == "head"), None)
            port = int((head or {}).get("api_port") or 8015)
            self.service[c["id"]] = {
                "cluster_id": c["id"], "health": "up" if c["id"] == "c1" else "down",
                "host": next((a["host"] for a in ((head or {}).get("addresses") or [])
                              if a.get("kind") == "lan"), None),
                "port": port, "model": MODEL_SPARK,
                "served_models": [MODEL_SPARK],
                "image": lc.image, "profile_key": (first_profile or {}).get("key", "tp4-mtp3"),
                "age_s": lc.uptime_s, "kv_tokens": (first_profile or {}).get("kv_tokens"),
                "metrics": {}, "errors": [],
            }
        await self.mock_world.start_frames(nodes, self.settings_ref.settings.sampling_interval_s,
                                           self._on_sample)

    def node(self, node_id: str) -> dict | None:
        for c in self.topology:
            for n in c["nodes"]:
                if n["id"] == node_id:
                    return n
        return None

    def cluster(self, cluster_id: str) -> dict | None:
        for c in self.topology:
            if c["id"] == cluster_id:
                return c
        return None

    def nodes_in(self, cluster_id: str) -> list[dict]:
        c = self.cluster(cluster_id) or {}
        return c.get("nodes", [])

    def runtime_of(self, node_id: str):
        if self.mock_world:
            return self.mock_world.runtimes.get(node_id)
        return self.runtimes.get(node_id)

    # ---------------- sample state machine ----------------
    def _on_state(self, node_id: str, snap: dict) -> None:
        try:
            asyncio.get_running_loop().create_task(self.hub.publish_nodes(snap))
        except RuntimeError:
            pass

    def _on_sample(self, node_id: str, frame: dict) -> None:
        if not check_structure(frame):
            return
        node = self.node(node_id)
        if not node:
            return
        sframe = frame_to_series(frame)
        sframe.node_id = node_id
        sframe.series = {k: v for k, v in sframe.series.items() if v is not None}
        try:
            asyncio.get_running_loop().create_task(self._handle_sample(sframe, frame, node))
        except RuntimeError:
            pass

    async def _handle_sample(self, sframe, raw_frame: dict, node: dict) -> None:
        await self.series.on_sample(node["id"], sframe)
        await self.hub.publish_sample(node["id"], sframe)
        if self.alerts:
            try:
                await self.alerts.evaluate_sample(node["id"], node["cluster_id"], sframe.series)
            except Exception:
                pass
        if node.get("role") == "head":
            st = service_state_from(raw_frame, node["cluster_id"], None)
            if st is not None:
                d = st.model_dump()
                addrs = node.get("addresses") or []
                d["host"] = next((a.get("host") for a in addrs if a.get("kind") == "lan"),
                                 (addrs[0].get("host") if addrs else None))
                d["kv_tokens"] = self.hub.kv_for(node["cluster_id"], self._current_profile(node["cluster_id"]))
                prev = self.service.get(node["cluster_id"]) or {}
                d["age_s"] = prev.get("age_s")
                d["image"] = prev.get("image")
                d["profile_key"] = prev.get("profile_key") or self._current_profile(node["cluster_id"])
                self.service[node["cluster_id"]] = d
                await self.hub.publish_service(d)

    def _current_profile(self, cluster_id: str) -> str | None:
        st = self.service.get(cluster_id) or {}
        return st.get("profile_key")

    async def _service_loop(self) -> None:
        """Keeps the per-cluster ServiceState fresh: mock walks the sim; real
        mode probes node-local endpoints + env files via the head runtime."""
        first = True
        while not self._stopping:
            if self.mock_world:
                for cid, lc in self.mock_world.clusters.items():
                    if lc.profile and lc.healthy():
                        node_head = next((n for n in self.nodes_in(cid) if n.get("role") == "head"), None)
                        host = self._best_lan_addr(node_head) if node_head else None
                        st = self.service.get(cid) or {"cluster_id": cid, "health": "down"}
                        st.update({
                            "health": "up", "host": host, "port": 8000,
                            "model": "zai-org/GLM-5.3-Flash",
                            "served_models": ["zai-org/GLM-5.3-Flash"],
                            "image": lc.image, "profile_key": lc.profile,
                            "age_s": lc.uptime_s, "kv_tokens": lc.kv_tokens,
                        })
                        self.service[cid] = st
                        await self.hub.publish_service(st)
                    else:
                        st = self.service.get(cid) or {"cluster_id": cid, "health": "down"}
                        st["health"] = "down"
                        self.service[cid] = st
            else:
                try:
                    await self._service_refresh_real()
                except Exception:
                    pass
            if first:
                first = False
            await asyncio.sleep(10)

    def _best_lan_addr(self, node: dict) -> str | None:
        addrs = node.get("addresses") or []
        for a in addrs:
            if a.get("kind") == "lan":
                return a.get("host")
        return addrs[0].get("host") if addrs else None

    async def _service_refresh_real(self) -> None:
        from .service.vllm import probe_endpoint, image_from_env_text

        for cid in [c["id"] for c in self.topology]:
            cl = self.cluster(cid)
            head = next((n for n in (cl.get("nodes") or []) if n.get("role") == "head"), None)
            if not head:
                continue
            rt = self.runtime_of(head["id"])
            st = self.service.get(cid) or {"cluster_id": cid, "health": "down", "metrics": {}}
            if rt is None or getattr(rt, "state", "offline") != "online":
                st["health"] = "down"
                continue
            probe = await probe_endpoint(rt, int(head.get("api_port", 8000)))
            st["health"] = "up" if probe.get("ok") else "down"
            st["host"] = self._best_lan_addr(head)
            st["port"] = int(head.get("api_port", 8000))
            models = probe.get("models") or []
            if isinstance(models, list):
                st["served_models"] = [m if isinstance(m, str) else m.get("id") for m in models]
            if st["served_models"]:
                st["model"] = st["served_models"][0]
            # profile + image from last successful start op (ops are the audit)
            rows = await self.db.fetch_all(
                "SELECT profile_key, created FROM ops WHERE cluster_id=? AND kind='cluster.start'"
                " AND state='ok' ORDER BY created DESC LIMIT 1", (cid,))
            is_ring = "sparkring" in (cl["control"].get("launcher") or "").lower()
            if rows and st["health"] == "up":
                st["profile_key"] = rows[0]["profile_key"]
                key = rows[0]["profile_key"]
                if key and not is_ring:
                    # TP2 flow: SERVING_IMAGE lives in the rank env files
                    for node in cl["nodes"]:
                        try:
                            from .control.tp2 import Tp2Verbs

                            v = Tp2Verbs(cl["control"], node)
                            res = await rt.exec(
                                "grep -E '^SERVING_IMAGE=' " +
                                f"{v.control['serve_dir']}/{v.env_file(key)} 2>/dev/null | cut -d= -f2-",
                                timeout=10)
                            img = res.stdout.strip()
                            if img:
                                st["image"] = img
                                break
                        except Exception:
                            pass
                elif key:
                    # SparkRing flow: image comes from the live container (read-only)
                    try:
                        res = await rt.exec(
                            "docker inspect glm-tp4-r0 --format '{{.Config.Image}}' 2>/dev/null",
                            timeout=10)
                        img = res.stdout.strip()
                        if img:
                            st["image"] = img
                    except Exception:
                        pass
            kv = self.hub.kv_for(cid, st.get("profile_key"))
            if kv:
                st["kv_tokens"] = kv
            lv = probe.get("liveness")
            if lv:
                st["liveness"] = lv
            self.service[cid] = st
            await self.hub.publish_service(st)

    # ---------------- op convenience ----------------
    def make_ctx(self, cluster: dict):
        from .control.engine import OpContext

        nodes_by_id = {n["id"]: n for n in cluster.get("nodes", [])}
        return OpContext(cluster=cluster, nodes=nodes_by_id, runtime_of=self.runtime_of,
                         alert_engine=self.alerts, hub=self.hub,
                         console_runtime=self.console_rt)

    async def patch_settings(self, patch: dict) -> bool:
        old_interval = self.settings_ref.settings.sampling_interval_s
        s = await patch_app_settings(self.db, patch)
        self.settings_ref.settings = s
        if abs(s.sampling_interval_s - old_interval) > 1e-9 and self.cfg.mock is False:
            # the collector's --interval is baked at stream start: bounce streams
            for nid in list(self.runtimes.keys()):
                rt = self.runtimes.pop(nid)
                await rt.stop()
            await self.start_runtimes()
        return True

    def info(self) -> dict:
        from . import APP_NAME, VERSION

        return {
            "name": APP_NAME, "version": VERSION, "mock": self.cfg.mock,
            "uptime_s": round(time.monotonic() - self.started_monotonic, 1),
            "data_dir": str(self.cfg.data_dir),
            "python": "3.11+",
        }

    def web_dist(self) -> Path:
        here = Path(__file__).resolve()
        return here.parents[2] / "web" / "dist"

    def status(self) -> dict:
        from .models import LiveNodeState

        nodes = []
        for c in self.topology:
            for n in c["nodes"]:
                rt = self.runtime_of(n["id"])
                snap = rt.snapshot() if rt else {"node_id": n["id"], "cluster_id": n["cluster_id"],
                                                 "state": "offline", "addr_used": None,
                                                 "conn_since": None, "collector": "unprobed",
                                                 "last_sample_ts": None}
                if not n.get("enabled", True):
                    snap["state"] = "disabled"
                nodes.append(snap)
        return {
            "nodes": nodes,
            "ws_clients": len(self.hub._clients),
            "ops_running": sum(1 for t in (self.engine._running.values() if self.engine else []) if not t.done()),
            "sampler_running": True,
        }
