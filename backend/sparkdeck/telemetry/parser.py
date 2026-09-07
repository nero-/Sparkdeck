"""Frame → canonical series mapping.

The collector emits structured blocks; this layer flattens them into the
canonical series ids (see docs/ARCHITECTURE.md) and extracts the service
facts (vLLM health/model/port + kv tokens) that feed the live service state.
Also owns the dynamic catalog growth (net ifaces, docker containers, temp
zones discovered at runtime via creation of series entries on first sight).
"""

from __future__ import annotations

import re
import time

from ..models import SampleFrame, ServiceState
from .series import docker_series, net_series, temp_zone_series

_SERIES_DYNAMIC_CACHE: dict[str, list[str]] = {}


def check_structure(frame: dict) -> bool:
    """Reject foreign/garbage frames early (defensive, policy-light)."""
    if not isinstance(frame, dict):
        return False
    return isinstance(frame.get("ts"), int) and "v" in frame and "host" in frame and "mem" in frame


def frame_to_series(frame: dict) -> SampleFrame:
    ts = int(frame.get("ts") or (time.time() * 1000))
    out: dict[str, float | None] = {}

    gpu = frame.get("gpu") or {}
    out["gpu.util"] = gpu.get("util")
    out["gpu.temp"] = gpu.get("temp")
    out["gpu.power_w"] = gpu.get("power_w")
    out["gpu.clock_sm_mhz"] = gpu.get("clock_sm")
    out["gpu.throttle_thermal"] = gpu.get("throttle_thermal")
    out["gpu.throttle_powercap"] = gpu.get("throttle_power_cap")
    out["gpu.apps"] = gpu.get("apps")

    cpu = frame.get("cpu") or {}
    out["cpu.util_pct"] = cpu.get("util")
    out["cpu.load1"] = cpu.get("load1")
    out["cpu.load5"] = cpu.get("load5")
    out["cpu.load15"] = cpu.get("load15")
    out["mem.psi_cpu_avg10"] = cpu.get("psi_cpu")
    per_core = cpu.get("per_core") or []
    for i, v in enumerate(per_core):
        out[f"cpu.core.{i}"] = v if isinstance(v, (int, float)) else None

    mem = frame.get("mem") or {}
    out["mem.used_gib"] = mem.get("used_gib")
    out["mem.avail_gib"] = mem.get("avail_gib")
    out["mem.alloc_est_gib"] = mem.get("alloc_est_gib")
    out["mem.pagecache_gib"] = mem.get("pagecache_gib")
    out["mem.swap_used_gib"] = mem.get("swap_used_gib")
    out["mem.psi_mem_avg10"] = mem.get("psi_mem")

    for iface, stats in (frame.get("net") or {}).items():
        if not isinstance(stats, dict):
            continue
        out[f"net.{iface}.rx_kbps"] = stats.get("rx_kbps")
        out[f"net.{iface}.tx_kbps"] = stats.get("tx_kbps")

    disk = frame.get("disk") or {}
    out["disk.root_used_pct"] = disk.get("root_used_pct")
    out["disk.r_mbps"] = disk.get("r_mbps")
    out["disk.w_mbps"] = disk.get("w_mbps")

    temp = frame.get("temp") or {}
    out["temp.gpu"] = out.get("gpu.temp")
    for zlabel, zval in (temp.get("zones") or {}).items():
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", zlabel)
        out[f"temp.zone.{safe}"] = zval
    out["temp.zones_max"] = temp.get("max")

    for ctr, cc in ((frame.get("docker") or {}).get("containers") or {}).items():
        safe = re.sub(r"[^a-zA-Z0-9_.-]+", "_", ctr)
        out[f"docker.{safe}.cpu_pct"] = cc.get("cpu_pct")
        out[f"docker.{safe}.mem_gib"] = cc.get("mem_gib")
        out[f"docker.{safe}.rx_kbps"] = cc.get("rx_kbps")
        out[f"docker.{safe}.tx_kbps"] = cc.get("tx_kbps")

    v = frame.get("vllm") or {}
    g = v.get("g") or {}
    out["vllm.decode_tok_s"] = g.get("decode_tok_s")
    out["vllm.prompt_tok_s"] = g.get("prompt_tok_s")
    out["vllm.num_running"] = g.get("num_running")
    out["vllm.num_waiting"] = g.get("num_waiting")
    out["vllm.kv_usage_perc"] = g.get("kv_usage")
    out["vllm.prefix_hit_perc"] = g.get("prefix_hit_rate")
    out["vllm.ttft_ms_avg"] = g.get("ttft_ms_avg")
    out["vllm.ttft_ms_p50"] = g.get("ttft_ms_p50")
    out["vllm.ttft_ms_p95"] = g.get("ttft_ms_p95")
    out["vllm.tpot_ms_avg"] = g.get("tpot_ms_avg")
    out["vllm.spec_accept"] = g.get("spec_accept")
    out["vllm.preemptions_total"] = g.get("preemptions")

    return SampleFrame(node_id="", ts=ts, series=out)


def service_state_from(frame: dict, cluster_id: str, prev: ServiceState | None) -> ServiceState | None:
    v = frame.get("vllm") or {}
    if not v:
        return None
    ts = int(frame.get("ts") or (time.time() * 1000))
    g = v.get("g") or {}
    st = ServiceState(cluster_id=cluster_id)
    st.health = "up" if v.get("health") == "up" else "down"
    st.port = v.get("port")
    st.model = v.get("model") or (prev.model if prev else None)
    st.served_models = v.get("models") or (prev.served_models if prev else [])
    metrics: dict[str, float] = {}
    for k, val in (g or {}).items():
        if isinstance(val, (int, float)):
            metrics[k] = float(val)
    st.metrics = metrics
    return st
