"""Mock world: virtual GX10 cluster simulating collector output, vLLM service
state, container lifecycle and bench jobs — the full UI/API verification
surface without touching the real pair.

The real OpEngine drives MockRuntime exactly like SSHRuntime, so every op
path (including sudo fallback semantics) is exercised in tests.
"""

from __future__ import annotations

import asyncio
import json
import re
import math
import random
import time
from typing import Any

from ..ssh.pool import ExecResult

MOCK_SPEED = 12.0  # boot 200s → ~17s
MODEL = "glm-5.3-flash-spark"          # SparkRing TP4 served model id
RING_IMAGE = "ghcr.io/fujitsupolycom/sparkring@sha256:35db0557e1b2c4d9"
LEGACY_IMAGE = "local/vllm:glm53-flash-nvfp4-head0906-managed"
API_PORT = 8015
LIVE_PORT = 8016
CONTAINER = "glm-tp4-r{rank}"
NODE_TOTAL_GIB = 127.9


def now_ms() -> int:
    return int(time.time() * 1000)


class ClusterLifecycle:
    """Simulated state of the 4-rank ring: two independently tracked layers —
    mesh supervisors (up/down) and the model (none/booting/serving)."""

    def __init__(self, cluster_id: str, kv_tokens: int = 2_278_454) -> None:
        self.cluster_id = cluster_id
        self.profile: str | None = None
        self.boot_at: float = 0.0
        self.healthy_at: float = 0.0
        self.kv_tokens = kv_tokens
        self.image = RING_IMAGE
        self.mesh: str = "down"          # down | up
        self.cpu_load_bias = 0.0
        self.seed = random.Random(cluster_id)

    def boot(self, profile: str) -> None:
        self.profile = profile
        self.boot_at = time.time()
        self.healthy_at = 0.0
        self.mesh = "up"

    def stop(self, model_only: bool = False) -> None:
        self.profile = None
        self.boot_at = 0.0
        self.healthy_at = 0.0
        if not model_only:
            self.mesh = "down"

    @property
    def boot_elapsed(self) -> float:
        """Simulated engine-seconds since boot (time × MOCK_SPEED)."""
        return (time.time() - self.boot_at) * MOCK_SPEED if self.boot_at else 0.0

    def healthy(self) -> bool:
        if not self.boot_at:
            return False
        if self.healthy_at:
            return True
        if self.boot_elapsed > 160:
            self.healthy_at = time.time()
        return False

    @property
    def uptime_s(self) -> float | None:
        return round((time.time() - self.healthy_at), 1) if self.healthy_at else None


class MockWorld:
    def __init__(self) -> None:
        self.clusters: dict[str, ClusterLifecycle] = {
            "c1": ClusterLifecycle("c1"),
        }
        self.runtimes: dict[str, "MockRuntime"] = {}
        self.on_state: Any = None
        self.on_sample: Any = None
        self._frames_tasks: list[asyncio.Task] = []

    async def console_verb(self, verb: str, on_line=None) -> int:
        """sparkring.sh <verb>: plan/apply/receipt-shaped output + state changes.
        Matches the console's flow: plan → apply → receipt echo."""
        def says(*lines):
            if on_line:
                for ln in lines:
                    on_line(ln)

        stamp = time.strftime("%Y%m%d-%H%M%S")
        lc = self.clusters.get("c1")
        if verb in ("up", "start", "ready", "stop", "down", "recover", "native-check"):
            says(f"==> planning: {verb}")
            says(f"==> applying:  {verb} (sha256 a1b2c3d4e5f6...)")
            receipt = f".private/glm-tp4-deployment/{verb}-{stamp}.json-receipt.json"
        else:
            receipt = None
        if verb == "up":
            if lc is not None and lc.profile is None and not lc.healthy():
                lc.mesh = "up"
            says("**→ mesh supervisors up** - see /opt/sparkring/managed-mesh")
            says("complete=True actions_ok=True")
            says(f"  complete=True actions_ok=True")
            for i in range(4):
                says(f"  [status:glm-tp4-r{i}] state=succeeded rc=0 (0.4s)")
            if receipt:
                says(receipt)
            return 0
        if verb == "start":
            self.boot_cluster("c1", "tp4-mtp3")
            says("==> waiting for readiness (all 4 containers + API/liveness)...")
            return 0
        if verb == "ready":
            lc = self.clusters.get("c1")
            if lc is None:
                says("error: no cluster")
                return 1
            wait_s = 0.0
            while not lc.healthy() and wait_s < 40:
                if on_line:
                    on_line(f"waiting: model booting ({int(lc.boot_elapsed)}s engine-time)…")
                await asyncio.sleep(0.9)
                wait_s += 0.9
            healthy = lc.healthy()
            rc = 0 if healthy else 1
            says("complete=True actions_ok=True" if healthy else
                 "complete=False actions_ok=False (model not ready — ./sparkring.sh logs)")
            for i in range(4):
                says(f"  [ready:glm-tp4-r{i}] state=succeeded rc=0 (0.3s)")
            if healthy:
                says("==> model ready: http://192.168.50.23:8015/v1/models")
                says(json.dumps({"object": "list", "data": [{"id": MODEL}]}))
            if receipt:
                says(receipt)
            return rc
        if verb in ("stop", "down"):
            if lc is not None:
                lc.stop(model_only=(verb == "stop"))
            says("Model stopped (mesh supervisors still running)." if verb == "stop"
                 else "Model and mesh stopped; supervisors not restarted.")
            says("complete=True actions_ok=True")
            for i in range(4):
                says(f"  [{verb}:glm-tp4-r{i}] state=succeeded rc=0 (0.5s)")
            if receipt:
                says(receipt)
            return 0
        if verb == "recover":
            if lc is not None:
                lc.mesh = "up"
            says("Mesh reset and supervisors restarted; model NOT started. Run: start")
            says("complete=True actions_ok=True")
            if receipt:
                says(receipt)
            return 0
        if verb == "status":
            if lc is not None:
                for i in range(4):
                    if lc.profile or lc.healthy():
                        says(f"  status:glm-tp4-r{i}: running health=healthy oom=False "
                             f"restarts_policy=unless-stopped")
                    else:
                        says(f"  status:glm-tp4-r{i}: exited rc=0")
            if receipt:
                says(receipt)
            return 0
        if verb == "logs":
            for i in range(4):
                says(f"===== status:glm-tp4-r{i} =====")
                for ln in list(vllm_log_lines(i))[-6:]:
                    says(ln)
            return 0
        if verb == "native-check":
            for i in range(4):
                says(f"PASS rank{i} fabric p0/p1 GID3 MTU4096 latency 0.10-0.14 ms")
            says("4-rank native communication checks: ALL PASS")
            return 0
        if verb == "liveness":
            import urllib.request as _ur  # mock never hits the network
            says("==> api health: http://192.168.50.23:8015/health")
            healthy = bool(lc and lc.healthy())
            says(f"   HTTP {'200' if healthy else '000'}")
            says(f"==> liveness: {{'healthy': {'true' if healthy else 'false'}, "
                 f"'running_requests': {lc.seed.randint(0, 6) if healthy else 0}}}")
            return 0
        if receipt:
            says(receipt)
        return 0

    def attach_runtime(self, node_id: str, rt: "MockRuntime") -> None:
        self.runtimes[node_id] = rt

    def cluster_of(self, cluster_id: str) -> ClusterLifecycle:
        return self.clusters[cluster_id]

    def boot_cluster(self, cluster_id: str, profile: str) -> None:
        self.clusters[cluster_id].boot(profile)

    def stop_cluster(self, cluster_id: str) -> None:
        self.clusters[cluster_id].stop()

    async def start_frames(self, nodes: list[dict], interval: float, on_sample) -> None:
        self.on_sample = on_sample
        for node in nodes:
            if not node.get("enabled", True):
                continue
            rt = self.runtimes.get(node["id"])
            if rt is None:
                rt = MockRuntime(world=self, node_id=node["id"], cluster_id=node["cluster_id"])
                self.attach_runtime(node["id"], rt)
                rt.state = "online"
                rt.addr_used = (node.get("addresses") or [{}])[0].get("host", "mock")
                rt.conn_since = now_ms()
                rt.collector_state = "healthy"
                if self.on_state:
                    self.on_state(rt.node_id, rt.snapshot())
            t = asyncio.create_task(self._frames_loop(node, rt, interval))
            self._frames_tasks.append(t)

    async def stop_frames(self) -> None:
        for t in self._frames_tasks:
            t.cancel()
        self._frames_tasks.clear()

    async def _frames_loop(self, node: dict, rt: "MockRuntime", interval: float) -> None:
        env_rank = int(node.get("env_rank") or 0)
        head = node.get("role") == "head"
        while True:
            await asyncio.sleep(max(0.5, interval))
            frame = build_frame(self, node, env_rank, head)
            if self.on_sample:
                self.on_sample(rt.node_id, frame)

    def snapshot_states(self) -> list[dict]:
        return [rt.snapshot() for rt in self.runtimes.values()]


def _sine(t: float, period: float, amp: float, base: float = 0.0, phase: float = 0.0) -> float:
    return base + amp * math.sin((t / period) * 2 * math.pi + phase)


_VLLM_CURVES = [
    # (tok_rate base, ramp) driven by time; injects waves of load
]


def build_frame(world: "MockWorld", node: dict, env_rank: int, head: bool) -> dict:
    lc = world.cluster_of(node["cluster_id"])
    t = time.time()
    ts = now_ms()
    serving = bool(lc.healthy())
    booting = bool(lc.profile) and not lc.healthy()

    # ---- GPU + memory envelope (unified memory from meminfo semantics) ----
    load_wave = _sine(t, 80, 38, phase=env_rank * 0.7) + _sine(t, 17, 9, phase=env_rank)
    gpu_util = max(0.0, min(99.0, 6 + load_wave * (bool(lc.profile) and 1 or 0) + random.uniform(-2, 2))) if (lc.profile or serving) else 0.0
    if not serving:
        gpu_util = gpu_util * 0.15
    gpu_temp = 52 + (gpu_util / 99.0) * 22 + random.uniform(-0.4, 0.4)
    power = 4.5 + (gpu_util / 99.0) * 30 + random.uniform(-0.2, 0.2)
    clock_sm = 1725 if gpu_util > 15 else 1450

    mem_total = NODE_TOTAL_GIB  # 128 GiB unified per GB10 (SparkRing TP4)
    if serving:
        # ~40 GiB weights + 24 GiB KV/fp8 + graphs/JIT + pagecache drift;
        # drifts toward ~112 GiB, never into the 95 % alert line
        mem_used = 68.0 + min(24.0, lc.uptime_s / 240) + random.uniform(-0.6, 0.6)
    elif booting:
        progress = min(1.0, lc.boot_elapsed / 160)
        mem_used = 12.0 + progress * (78.0 - 12.0) + random.uniform(-0.8, 0.8)
    else:
        mem_used = 9.5 + _sine(t, 300, 1.2) + random.uniform(-0.3, 0.3)
    gpu_frame = {
        "util": round(gpu_util, 1),
        "temp": round(gpu_temp, 1),
        "power_w": round(power, 2),
        "clock_sm": clock_sm,
        "throttle_thermal": 0.0,
        "throttle_power_cap": 1.0 if (serving and gpu_util > 80) else 0.0,
        "apps": 1 if serving else 0,
    }
    mem_frame = {
        "total_gib": mem_total,
        "avail_gib": round(max(0.4, mem_total - mem_used), 2),
        "alloc_est_gib": round(max(0.4, mem_total - mem_used), 2),
        "used_gib": round(mem_used, 2),
        "pagecache_gib": round(max(0.2, mem_total - mem_used - 4.0), 2) if not booting else 1.4,
        "swap_used_gib": 0.0,
    }
    cpu_frame = {
        "util": round(max(1.0, (25 + load_wave * 1.8 if (lc.profile or booting) else 4.0) + random.uniform(-3, 3)), 1),
        "load1": round(1.6 + (load_wave * 0.05 if lc.profile else 0.02), 2),
        "load5": round(1.4 - env_rank * 0.1, 2),
        "load15": round(1.2, 2),
        "per_core": [round(max(0.0, 4 + load_wave * 1.4 + random.uniform(-6, 6)), 1) for _ in range(10)],
        "psi_cpu": round(max(0.0, 0.004 + (load_wave / 26000.0 if lc.profile else 0.0)), 4),
    }
    rx = 30 + (abs(load_wave) * 140 if (serving or booting) else 2) + random.uniform(0, 9)
    net_frame = {
        "enp1s0f1np1": {"rx_kbps": round(rx, 1), "tx_kbps": round(rx * 0.92, 1)},
        "enp3s0": {"rx_kbps": round(9 + abs(load_wave) * 3, 1), "tx_kbps": round(7 + abs(load_wave) * 2, 1)},
        "tailscale0": {"rx_kbps": round(0.6, 1), "tx_kbps": round(0.4, 1)},
    }
    disk_frame = {"root_used_pct": 61.2 + env_rank * 0.3, "r_mbps": round(abs(load_wave) * 0.9, 1),
                  "w_mbps": round(abs(load_wave) * 0.4, 1)}
    zones = {
        "tz0-acpitz": round(gpu_temp - 8, 1),
        "tz2-SEN1": round(gpu_temp + 9.0 * (gpu_util / 99.0) + 2, 1),
        "tz7-TCPU": round(48 + load_wave * 0.05, 1),
        "tz11-nvme": round(39 + _sine(t, 400, 3), 1),
        "tz12-mlx5": round(44 + _sine(t, 300, 2, phase=1), 1),
    }
    temp_frame = {"zones": zones, "max": max(zones.values()) if zones else None}
    psi_frame = {"memory": round(max(0.0, 0.002 + (0.02 if mem_used > 0.97 * mem_total else 0.0)), 4),
                 "io": round(0.001 + abs(load_wave) * 0.0001, 4)}

    containers: dict[str, dict] = {}
    if lc.profile or serving:
        name = CONTAINER.format(rank=env_rank)  # glm-tp4-rN — one per node
        containers[name] = {
            "cpu_pct": round(120 + gpu_util * (1 + env_rank * 0.04) * 3.4 + random.uniform(-8, 8), 1),
            "mem_gib": round(mem_used - 8.0, 2),
            "rx_kbps": round(rx * 0.9, 1),
            "tx_kbps": round(rx * 0.86, 1),
        }

    # The API + liveness live on the head rank only (r0, :8015 / :8016);
    # member ranks carry no vllm block at all (parser ignores them)
    if env_rank != 0:
        vllm_frame: dict = {}
    else:
        vllm_frame: dict = {"ts": ts, "health": "up" if serving else ("booting" if booting else "down"),
                            "port": API_PORT, "models": [MODEL] if serving else [], "g": {}}
    if serving and env_rank == 0:
        burst = (_sine(t, 95, 0.75, base=0.25) > 0.75) or (lc.seed.random() < 0.06)
        tokens_out = (52 + load_wave * 1.9 + random.uniform(-3, 4)) if burst else 0.4 + random.uniform(0, 1.5)
        decode = round(max(0.0, tokens_out), 1)
        kv_usage = min(92.0, 18 + abs(load_wave) * 1.4 + (16 if burst else 0))
        g = {
            "decode_tok_s": decode,
            "prompt_tok_s": round(3400 + (2600 if burst else 0) + random.uniform(-80, 80), 1) if burst else round(random.uniform(0, 700), 1),
            "num_running": (2 + random.randint(0, 5)) if burst else random.randint(0, 1),
            "num_waiting": random.randint(0, 6) if burst else 0,
            "kv_usage": round(kv_usage, 1),
            "prefix_hit_rate": round(38 + abs(load_wave) * 0.5, 1),
            "ttft_ms_avg": round(240 + (1500 if burst else 0) + random.uniform(-40, 60), 1),
            "ttft_ms_p50": round(210 + (1400 if burst else 0), 1),
            "ttft_ms_p95": round(640 + (4300 if burst else 0), 1),
            "tpot_ms_avg": round(17 - min(3, tokens_out / 60) + random.uniform(-1.2, 1.2), 1),
            "spec_accept": round(2.38 + _sine(t, 140, 0.2) + random.uniform(-0.08, 0.08), 3),
            "preemptions": float(1 + int((t // 1200) % 3)),
            "blocked_seconds": round(random.uniform(0.0, 3.0) if burst else 0.0, 2),
            "output_stalled_seconds": 0.0,
        }
        vllm_frame["g"] = g
        vllm_frame["model"] = MODEL

    return {
        "v": 1,
        "ts": ts,
        "iv": 2.0,
        "host": node["name"],
        "gpu": gpu_frame,
        "cpu": cpu_frame,
        "mem": mem_frame,
        "net": net_frame,
        "disk": disk_frame,
        "temp": temp_frame,
        "psi": psi_frame,
        "docker": {"ts": ts, "docker_ok": True, "containers": containers},
        "vllm": vllm_frame,
        "errors": [],
    }


class MockRuntime:
    """Implements the SSHRuntime surface against the MockWorld."""

    def __init__(self, world: MockWorld, node_id: str, cluster_id: str) -> None:
        self.node_id = node_id
        self.cluster_id = cluster_id
        self.state = "online"
        self.addr_used = "mock"
        self.conn_since = now_ms()
        self.collector_state = "healthy"
        self.last_sample_ts = None
        self.unverified = False
        self.attempts_log: list = []
        self.collector_probe = {"python": "Python 3.11.7", "sha": None}
        self.world = world

    # --- lifecycle ---
    async def start(self) -> None:
        pass

    async def stop(self) -> None:
        self.state = "disabled"

    def conn(self):  # compatibility for sudo helpers
        return None

    def snapshot(self) -> dict:
        return {
            "node_id": self.node_id, "cluster_id": self.cluster_id,
            "state": self.state, "addr_used": self.addr_used,
            "conn_since": self.conn_since, "collector": self.collector_state,
            "last_sample_ts": self.last_sample_ts,
            "attempts": [{"addr": "mock", "ok": True, "error": ""}],
            "unverified": False,
        }

    def probe_summary(self) -> dict:
        return {"state": self.state, "addr_used": self.addr_used,
                "attempts": [], "collector_state": self.collector_state,
                "unverified": False, "collector_probe": self.collector_probe}

    # --- exec ---
    async def exec(self, cmd: str, timeout: float = 30.0, stdin_data: str | None = None) -> ExecResult:
        return _dispatch_exec(self, cmd)

    async def sudo_exec(self, cmd: str, timeout: float = 60.0) -> ExecResult:
        return ExecResult(0, f"mock-sudo: {cmd[:60]} ok", "")

    async def stream_exec(self, cmd: str, timeout: float, on_line=None, stop_hints: tuple = (),
                          cancelled=None) -> int:
        if "--run" in cmd and "glm53_pair_serve.sh" in cmd:
            env = _env_of(cmd)
            key = _key_of(env)
            cid = self.cluster_id
            self.world.boot_cluster(cid, key)
            if on_line:
                await _drain(on_line, [f"docker: pulling image layers cached; starting glm53-flash-r{self._rank()} ({key})",
                                       f"warning: MEM_PREFLIGHT ok — free 122.8 GiB",
                                       f"started container glm53-flash-r{self._rank()}"], 0.15)
            return 0
        if "--down" in cmd and "glm53_pair_serve.sh" in cmd:
            self.world.stop_cluster(self.cluster_id)
            if on_line:
                await _drain(on_line, [f"removed container glm53-flash-r{self._rank()}"], 0.05)
            return 0
        if "--status" in cmd or "--check" in cmd or "--verify" in cmd:
            lc = self.world.cluster_of(self.cluster_id)
            rank = self._rank()
            if "--status" in cmd:
                if lc.profile:
                    lines = [f"container glm53-flash-r{rank} UP (image {lc.image})"]
                else:
                    lines = [f"container glm53-flash-r{rank} not running"]
            elif "--check" in cmd:
                lines = ["check: env KV_CACHE_MEMORY_BYTES ok", "check: /dev/infiniband ok",
                         "check: ports free", "check: VLLM_HOST_IP local ok",
                         "check: GID index 3 ok", "check: model dir + uncommitted weights ok",
                         "command: docker run --network host --ipc host ..."]
            else:
                if lc.healthy():
                    lines = [f"verify: GPU KV cache size: {lc.kv_tokens:,} tokens",
                             "verify: Application startup complete",
                             "verify: health OK",
                             f"verify: speculative_config mtp3 adaptive",
                             f"verify: split GLM-5.3 cache pages 2048/256"]
                elif lc.profile:
                    lines = [f"verify: booting ({int(lc.boot_elapsed * MOCK_SPEED)}s engine-time)"]
                else:
                    lines = ["verify: no container running"]
            for ln in lines:
                if on_line:
                    on_line(ln)
            return 0
        if "--logs" in cmd:
            rank = self._rank()
            n = 0
            while (cancelled is None or not cancelled()):
                for ln in vllm_log_lines(rank):
                    if on_line:
                        on_line(ln)
                n += 1
                await asyncio.sleep(1.0)
            return 0
        if "tail -n +1 -f" in cmd:
            n = 0
            while (cancelled is None or not cancelled()):
                if on_line:
                    on_line(f"[builder] step {n}/14 compiling (mock)")
                n += 1
                await asyncio.sleep(1.2)
            return 0
        for ln in ("mock exec: no stream handler",):
            if on_line:
                on_line(ln)
        return 0

    async def stream(self, cmd: str, key: str, on_line) -> None:
        await self.stream_exec(cmd, timeout=600, on_line=on_line)

    def _rank(self) -> int:
        if self.node_id.endswith("n0"):
            return 0
        if self.node_id.endswith("n1"):
            return 1
        if self.node_id.endswith("n2"):
            return 2
        return 3

def _env_of(cmd: str) -> str:
    import re

    m = re.search(r"rank-\d+-([a-z0-9._-]+\.env)", cmd)
    return m.group(1) if m else ""


def _key_of(env: str) -> str:
    e = env.lower()
    if "df" in e or "dflash" in e:
        return "df-spark" if "spark" in e else "df-nvfp4"
    return "tp4-mtp3"  # ring mock boot key (tp2 legacy verbs keep theirs)


def _drain(on_line, lines, delay_s) -> None:
    import asyncio

    async def go():
        for ln in lines:
            on_line(ln)
            await asyncio.sleep(delay_s)
    return asyncio.ensure_future(go())


def vllm_log_lines(rank: int):
    serving_lines = [
        f"INFO: kv_cache_usage {random.randint(18, 74)}%",
        "INFO: GLM_MHC_ENQUEUE ok (mesh 9975)",
        f"INFO: scheduler budget 8192 coalesce=4 decode={random.randint(48, 66)} tok/s",
        f"INFO: ring: roce p0/p1 ok (rank {rank} peers 3, GID3)",
        "INFO: speculative: accept_rates=[0.86,0.61,0.24]",
    ]
    boot_lines = [
        f"INFO: booting rank {rank} — checkpoint ~175 GiB (nvfp4-spark) 37%…",
        "INFO: mesh supervisor attach: /opt/sparkring/managed-mesh (9975)",
        "INFO: graph capture 74% — JIT warmup",
        "INFO: engine hold — waiting for peer rank",
    ]
    return [templates_ok(l) for l in (serving_lines if random.random() < 0.6 else boot_lines)]


def templates_ok(lines):
    return lines


async def format_mock_bench(job, out_dir, pub) -> None:
    """Stage a mock bench job: 6 cells over ~15s + artifact JSON."""
    import json as _json

    stages = [
        "startup_diagnostics: connecting to server",
        "engine detection: vllm (prometheus ok)",
        "prefill scout: ctx 8k → 1690 tok/s (mock)",
    ]
    for s in stages:
        pub(job, s)
        await asyncio.sleep(0.8)
    ctxs = [0, 8192, 32768]
    conc = [1, 2, 4]
    results = []
    for i, cx in enumerate(ctxs):
        for cn in conc:
            await asyncio.sleep(0.55)
            tps = round((96.0 - cx / 600.0) * (1 - 0.15 * math.log2(cn)) * (1 + 0.05 * lc_dummy()), 2)
            cell = {
                "concurrency": cn, "context_tokens": cx, "aggregate_tps": tps,
                "ttft_avg": 0.31 + 0.08 * cn, "ttft_p50": tps and 1.0, "ttft_p90": 2.0, "ttft_p99": 3.0,
                "output_tps_per_user_avg": tps / cn, "completed_request_count": 4,
                "measurement_seconds": 8.0, "request_count": 4, "num_errors": 0,
                "server_spec_accept_length": 2.45, "capacity_limited": False, "loop_detected": False,
                "num_completed": 4, "num_errors_total": 0,
            }
            ttft_keys = ("ttft_avg", "ttft_p50", "ttft_p90", "ttft_p99")
            for j, k in enumerate(ttft_keys):
                cell[k] = round(cell[ttft_keys[0]] + j * 0.12 * cn, 3)
            results.append(cell)
            job.summary = {"grid": [{"ctx": r["context_tokens"], "conc": r["concurrency"], "tps": r["aggregate_tps"]} for r in results],
                           "cells": len(results), "partial": True, "best": max(results, key=lambda r: r["aggregate_tps"]) and {"ctx": max(results, key=lambda r: r["aggregate_tps"])["context_tokens"], "conc": max(results, key=lambda r: r["aggregate_tps"])["concurrency"], "tps": max(results, key=lambda r: r["aggregate_tps"])["aggregate_tps"]}}
            pub(job, f"cell ctx={cx} C={cn}: {tps} tok/s")
    summary = {
        "0": {str(c): round(29.15 / c, 1) for c in conc},
        "8192": {str(c): round(30.0 * (1 - 0.02 * c), 1) for c in conc},
        "32768": {str(c): round(31.0 * (1 - 0.02 * c), 1) for c in conc},
    }
    artifact = {
        "metadata": {"engine": "vllm", "model": job.model, "version": "0.6.2",
                     "concurrency_levels": conc, "context_lengths": ctxs,
                     "kv_budget": job.args.kv_budget},
        "startup_diagnostics": {"server_url": f"http://{job.host}:{job.port}"},
        "summary_table": summary,
        "prefill": {"8192": {"ttft_seconds": 4.85, "tok_per_sec": 1690.0, "prompt_tokens": 8198,
                             "samples": 1, "method": "integrated_scout"}},
        "results": results,
        "coding_peak": {"summary": {"mean_generation_tok_s": 88.4, "max_generation_tok_s": 92.7, "runs_ok": 3}},
    }
    (out_dir / "artifact.json").write_text(_json.dumps(artifact, indent=2))
    # point the job's result_path at the artifact (load_result parses it)
    job.result_path = str(out_dir / "artifact.json")


def lc_dummy() -> float:
    return random.random()


def _dispatch_exec(rt: MockRuntime, cmd: str) -> ExecResult:
    rank = rt._rank()
    cid = rt.cluster_id
    lc = rt.world.cluster_of(cid)
    c = cmd.strip()
    # container lifecycle (engine start/stop call exec, not stream)
    if "glm53_pair_serve.sh" in c and "--run" in c:
        key = _key_of(_env_of(c))
        rt.world.boot_cluster(cid, key)
        return ExecResult(0, f"started container glm53-flash-r{rank} ({key})", "")
    if "glm53_pair_serve.sh" in c and "--down" in c:
        rt.world.stop_cluster(cid)
        return ExecResult(0, f"removed container glm53-flash-r{rank}", "")
    # node identity probe
    if c.startswith("python3 -V"):
        return ExecResult(0, "Python 3.11.7\ndocker-ok\nnvidia-ok", "")
    if c == "cat /proc/sys/vm/swappiness 2>/dev/null || echo 60":
        return ExecResult(0, "0", "")   # mock: preflight always satisfied
    if "drop_caches" in c or "swappiness" in c:
        return ExecResult(0, "", "")
    if "show_gids" in c:
        rows = [
            "    hca  dev     port   rdma IslMap        GUID           GID-Index  v  IPv4",
            "rocep1s0f1 (0) 3 3 0000:000a:000b:000c 0000:0000:0000:0000:0000:24bd:1834:3300 3 v2 198.18.0.10",
            "rocep1s0f1 (0) 1 1 0000:000a:000b:000c 0000:0000:0000:0000:0000:24bd:1834:3300 3 v2 198.18.3.10",
            "SPARKDECK-GID: OK index=3",
        ]
        return ExecResult(0, "\n".join(rows), "")
    if "ping" in c:
        return ExecResult(0, "rtt min/avg/max/mdev = 0.110/0.172/0.240/0.020 ms, 100% ok", "")
    if "tailscale status" in c:
        js = {"Self": {"HostName": f"gx10-r{rank}", "TailscaleIPs": [f"100.101.10.{rank+2}"]},
              "Peer": {f"node{r}": {"HostName": f"gx10-r{r}", "Online": True} for r in range(4) if r != rank}}
        return ExecResult(0, "```json" + json.dumps(js), "")
    if "/liveness" in c:
        healthy = lc.healthy()
        if not healthy:
            return ExecResult(0, json.dumps({"healthy": False, "running_requests": 0,
                                             "kv_cache_usage": 0.0,
                                             "blocked_seconds": 0.0,
                                             "output_stalled_seconds": 0.0}), "")
        return ExecResult(0, json.dumps({
            "healthy": True, "running_requests": lc.seed.randint(1, 8),
            "kv_cache_usage": round(0.18 + 0.42 * lc.seed.random(), 3),
            "blocked_seconds": round(lc.seed.random() * 2.0, 2),
            "output_stalled_seconds": 0.0,
            "model": MODEL, "version": "0.26.1rc0+glm53.flash.tp4.dcp1",
        }), "")
    if "sparkring.sh" in c:
        verb = _sparkring_verb_of(c)
        lines: list[str] = []
        try:
            rc = asyncio.get_event_loop().time()  # placeholder to keep sync ctx simple
        except Exception:
            pass
        # exec-context verbs are answered synchronously with a canned receipt
        canned: dict[str, str] = {
            "status": "  status:glm-tp4-r0: running" if (lc.profile or lc.healthy()) else "  status:glm-tp4-r0: exited",
            "liveness": "",
            "help": "sparkring.sh help (mock)",
        }
        if verb == "liveness":
            return ExecResult(0, canned["liveness"] or "HTTP 200\n{'healthy': true}", "")
        return ExecResult(0, canned.get(verb, f"complete=True actions_ok=True ({verb})"), "")
    if "curl -fsS -m 4" in c and "echo $?" in c:
        healthy = lc.healthy()
        return ExecResult(0 if healthy else 1, "0" if healthy else "8", "")
    if "http://127.0.0.1" in c and "/health" in c:
        out = "ok" if lc.healthy() else ""
        return ExecResult(0 if lc.healthy() else 22, out, "")
    if "/v1/models" in c:
        data = [{"object": "model", "id": MODEL, "max_model_len": 524288}] if lc.healthy() else []
        return ExecResult(0, json.dumps({"object": "list", "data": data}), "")
    if "/metrics" in c:
        if not lc.healthy():
            return ExecResult(22, "", "unreachable cached")
        rows = _fake_metrics(lc)
        return ExecResult(0, rows, "")
    if "/version" in c or "/load" in c:
        return ExecResult(0, json.dumps({"version": "0.26.1rc0+glm53.flash.nvfp4.head0906", "number_of_gpu": 1}) if False else json.dumps({"version": "0.26.1rc0"}), "")
    if "GPU KV cache size" in c or ("docker logs" in c and "KV" in c):
        return ExecResult(0, f"{lc.kv_tokens}", "") if lc.profile else ExecResult(0, "", "")
    if "glm-tp4-r0 --format" in c and "inspect" in c:
        return ExecResult(0, lc.image if (lc.profile or lc.healthy()) else "", "")
    if "docker ps" in c or "container_list" in c:
        if lc.profile or lc.healthy():
            js = {"ID": "deadbeef", "Names": f"glm-tp4-r{rank}", "Image": lc.image,
                  "State": "running", "Status": f"Up {int(lc.uptime_s or 4)} seconds", "CreatedAt": "…"}
            return ExecResult(0, json.dumps(js), "")
        return ExecResult(0, "", "")
    if "docker stats" in c:
        frames = build_frame(rt.world, {"name": f"r{rank}", "cluster_id": cid, "role": "head" if rank in (0, 2) else "worker",
                                        "env_rank": rank}, rank, rank in (0, 2))
        lines = []
        for name, cinfo in frames["docker"]["containers"].items():
            lines.append(json.dumps({"Name": name, "CPUPerc": f"{cinfo['cpu_pct']}%",
                                     "MemUsage": f"{cinfo['mem_gib']}GiB / 128.0GiB",
                                     "NetIO": f"{cinfo['rx_kbps']}kB / {cinfo['tx_kbps']}kB",
                                     "BlockIO": "0B / 13.3kB", "ID": "x", "Container": name,
                                     "MemPerc": "94%", "PIDs": "61"}))
        return ExecResult(0, "\n".join(lines), "")
    if "docker images" in c:
        imgs = [RING_IMAGE.replace("@", ":tags-fix@"), RING_IMAGE,
                "ghcr.io/fujitsupolycom/sparkring@sha256:0f11a2b3c4d5",
                "local/vllm:glm53-flash-nvfp4-devspark2-managed",
                "local/tools:base-system:cu132"]
        lines = [json.dumps({"Repository": i.split(":")[0], "Tag": i.split(":")[1],
                             "ID": f"sha256:{abs(hash(i)) % 999999:06d}", "CreatedSince": "2 days ago",
                             "Size": "24.9GB", "CreatedAt": "2026-09-06 21:47:00"}) for i in imgs]
        return ExecResult(0, "\n".join(lines), "")
    if "grep" in c and "SERVING_IMAGE" in c:
        return ExecResult(0, f"SERVING_IMAGE={lc.image}", "")
    if "cat " in c and ".env" in c:
        text = _env_cat_text(rank, cid, lc)
        return ExecResult(0, text, "")
    if "build-spark-cu132.sh" in c:
        return ExecResult(0, "4242", "")
    if "docker save" in c:
        return ExecResult(0, "loaded nodeId mock peer", "")
    if "systemctl" in c:
        return ExecResult(0, "active (running)", "")
    return ExecResult(0, "", "")


def _fake_metrics(lc: ClusterLifecycle) -> str:
    serving = lc.healthy()
    if not serving:
        return ""
    load = lc.seed.random()
    vals = {
        "num_requests_running": int(1 + 8 * load),
        "num_requests_waiting": int(2 * load),
        "kv_cache_usage_perc": 0.2 + 0.5 * load,
        "generation_tokens": int(50000 + 900 * (time.time() % 10000)),
        "prompt_tokens": int(20000 + 300 * (time.time() % 10000)),
    }
    lines = [
        '# HELP vllm:num_requests_running Number of requests currently processing.',
        "# TYPE vllm:num_requests_running gauge",
        f'vllm:num_requests_running{{model_name="{MODEL}",engine="0"}} {vals["num_requests_running"]}',
        f'vllm:num_requests_waiting{{model_name="{MODEL}",engine="0"}} {vals["num_requests_waiting"]}',
        f'vllm:kv_cache_usage_perc{{model_name="{MODEL}",engine="0"}} {vals["kv_cache_usage_perc"]}',
        f'vllm:gpu_cache_usage_perc{{model_name="{MODEL}",engine="0"}} {vals["kv_cache_usage_perc"]}',
        f'vllm:generation_tokens_total{{model_name="{MODEL}",engine="0"}} {vals["generation_tokens"]}',
        f'vllm:prompt_tokens_total{{model_name="{MODEL}",engine="0"}} {vals["prompt_tokens"]}',
        'vllm:num_preemptions_total 3',
        'vllm:request_prompt_tokens{model_name="glm-5.3-flash-spark",engine="0"} 8192',
        "# TYPE vllm:time_to_first_token_seconds histogram",
        'vllm:time_to_first_token_seconds_bucket{le="0.05"} 61',
        'vllm:time_to_first_token_seconds_bucket{le="0.25"} 190',
        'vllm:time_to_first_token_seconds_bucket{le="0.5"} 220',
        'vllm:time_to_first_token_seconds_bucket{le="1.0"} 238',
        'vllm:time_to_first_token_seconds_bucket{le="5.0"} 240',
        'vllm:time_to_first_token_seconds_bucket{le="inf"} 240',
        'vllm:time_to_first_token_seconds_sum 41.7',
        'vllm:time_to_first_token_seconds_count 240',
        "# TYPE vllm:inter_token_latency_seconds histogram",
        'vllm:inter_token_latency_seconds_bucket{le="0.02"} 186000',
        'vllm:inter_token_latency_seconds_bucket{le="0.05"} 204000',
        'vllm:inter_token_latency_seconds_bucket{le="0.1"} 209000',
        'vllm:inter_token_latency_seconds_bucket{le="0.25"} 210000',
        'vllm:inter_token_latency_seconds_bucket{le="inf"} 210000',
        'vllm:inter_token_latency_seconds_sum 3350.3',
        'vllm:inter_token_latency_seconds_count 210000',
        "# spec decode — native MTP depth 3 (~2.38 accepted of 3)",
        'vllm:spec_decode_num_accepted_tokens_total 12800',
        'vllm:spec_decode_num_proposed_tokens_total 5380',
    ]
    return "\n".join(lines)


def _env_cat_text(rank: int, cid: str, lc: ClusterLifecycle) -> str:
    fabric = "10.100.80.2" if cid == "c1" else "10.100.120.2"
    if cid == "c1" and rank == 1:
        fabric = "10.100.80.1"
    if cid == "c2" and rank == 3:
        fabric = "10.100.120.1"
    return f"""
NODE_RANK={rank}
MASTER_ADDR={fabric}
VLLM_HOST_IP={fabric}
MODEL_HOST_PATH=/home/nero/builds/glm53-flash-dgx-spark-tp2/models/glm53-flash-nvfp4-spark
CACHE_HOST_PATH=/home/nero/builds/glm53-flash-dgx-spark-tp2/cache
SERVING_IMAGE={lc.image}
API_PORT=8000
MASTER_PORT=29500
SERVED_MODEL_NAME=zai-org/GLM-5.3-Flash
MAX_MODEL_LEN=524288
KV_CACHE_MEMORY_BYTES=11274289152
NCCL_IB_HCA=rocep1s0f1
NCCL_IB_GID_INDEX=3
""".strip() + "\n"


class MockConsoleRuntime:
    """Console runtime used by the op engine in mock mode: answers
    sparkring.sh verb invocations (and plain curls) without any real host."""

    kind = "local"

    def __init__(self, world: MockWorld) -> None:
        self.name = "sparkring-console-mock"
        self.world = world
        self.state = "online"
        self.collector = "none"

    async def stop(self) -> None:
        return None

    def snapshot(self) -> dict:
        return {"node_id": self.name, "cluster_id": "", "state": "online",
                "addr_used": "127.0.0.1", "conn_since": now_ms(),
                "collector": "none", "last_sample_ts": None, "attempts": [],
                "unverified": False}

    async def exec(self, cmd: str, timeout: float = 30.0, stdin_data: str | None = None) -> ExecResult:
        verb = _sparkring_verb_of(cmd)
        if verb:
            lines: list[str] = []
            rc = await self.world.console_verb(verb, on_line=lines.append)
            return ExecResult(rc, "\n".join(lines), "")
        if "doctor --verify" in cmd:
            lines2 = [
                "sparkring doctor --verify",
                "PASS r0 p0 198.18.0.10/24  MTU 9000/4096 GID3",
                "PASS r1 p1 198.18.0.11/24  MTU 9000/4096 GID3",
                "PASS r2 p1 198.18.1.11/24  MTU 9000/4096 GID3",
                "PASS r3 p1 198.18.2.11/24  MTU 9000/4096 GID3",
                "matrix: 16/16 RDMA functions PASS",
            ]
            return ExecResult(0, "\n".join(lines2), "")
        return ExecResult(0, "", "")

    async def sudo_exec(self, cmd: str, timeout: float = 60.0) -> tuple:
        return (0, "", "")  # noqa: UP006 - parity tuple

    async def stream_exec(self, cmd: str, timeout: float, on_line=None,
                          stop_hints: tuple = (), cancelled=None) -> int:
        verb = _sparkring_verb_of(cmd)
        if verb:
            return await self.world.console_verb(verb, on_line=on_line)
        if on_line:
            on_line("mock console: no handler for this stream")
        return 0


def _sparkring_verb_of(cmd: str) -> str | None:
    c = cmd.strip()
    m = re.search(r"sparkring\.sh\s+([a-z-]+)", c)
    return m.group(1) if m else None
