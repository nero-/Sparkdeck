"""Canonical metric series: ids, units, groups, labels.

Static definitions for machine-level gauges; net interfaces and docker
containers are dynamic — generated from observed names with a stable prefix
so the catalog endpoint can merge them.
"""

from __future__ import annotations

from ..models import SeriesDef

STATIC: list[SeriesDef] = [
    # GPU (GB10: nvidia-smi util/temp/power/clocks are valid; mem is NOT)
    SeriesDef(id="gpu.util", unit="%", kind="gauge", label="GPU utilization", group="gpu"),
    SeriesDef(id="gpu.power_w", unit="W", kind="gauge", label="GPU power", group="gpu"),
    SeriesDef(id="gpu.clock_sm_mhz", unit="mhz", kind="gauge", label="SM clock", group="gpu"),
    SeriesDef(id="gpu.apps", unit="ct", kind="gauge", label="Compute apps", group="gpu"),
    SeriesDef(id="gpu.temp", unit="C", kind="gauge", label="GPU temperature", group="gpu"),
    # CPU
    SeriesDef(id="cpu.util_pct", unit="%", kind="gauge", label="CPU utilization", group="cpu"),
    SeriesDef(id="cpu.load1", unit="x", kind="gauge", label="Load 1m", group="cpu"),
    SeriesDef(id="cpu.load5", unit="x", kind="gauge", label="Load 5m", group="cpu"),
    SeriesDef(id="cpu.load15", unit="x", kind="gauge", label="Load 15m", group="cpu"),
    # Unified memory
    SeriesDef(id="mem.used_gib", unit="GiB", kind="gauge", label="Memory used", group="mem"),
    SeriesDef(id="mem.avail_gib", unit="GiB", kind="gauge", label="Memory available", group="mem"),
    SeriesDef(id="mem.pagecache_gib", unit="GiB", kind="gauge", label="Page cache", group="mem"),
    SeriesDef(id="mem.swap_used_gib", unit="GiB", kind="gauge", label="Swap used", group="mem"),
    SeriesDef(id="mem.psi_mem_some_avg10", unit="%", kind="gauge", label="Mem pressure (PSI)", group="mem"),
    SeriesDef(id="mem.psi_cpu_some_avg10", unit="%", kind="gauge", label="CPU pressure (PSI)", group="cpu"),
    # Disk
    SeriesDef(id="disk.root_used_pct", unit="%", kind="gauge", label="Root fs used", group="disk"),
    SeriesDef(id="disk.r_mbps", unit="MB/s", kind="gauge", label="Disk read", group="disk"),
    SeriesDef(id="disk.w_mbps", unit="MB/s", kind="gauge", label="Disk write", group="disk"),
    # Temps (dynamic zones generate temp.zone.<label>)
    SeriesDef(id="temp.gpu", unit="C", kind="gauge", label="GPU temp", group="temp"),
    # vLLM (curated; parsed from /metrics on the node)
    SeriesDef(id="vllm.decode_tok_s", unit="tok/s", kind="gauge", label="Decode throughput", group="vllm"),
    SeriesDef(id="vllm.prompt_tok_s", unit="tok/s", kind="gauge", label="Prefill throughput", group="vllm"),
    SeriesDef(id="vllm.num_running", unit="ct", kind="gauge", label="Requests running", group="vllm"),
    SeriesDef(id="vllm.num_waiting", unit="ct", kind="gauge", label="Requests waiting", group="vllm"),
    SeriesDef(id="vllm.kv_usage_perc", unit="%", kind="gauge", label="KV cache usage", group="vllm"),
    SeriesDef(id="vllm.prefix_hit_perc", unit="%", kind="gauge", label="Prefix cache hit", group="vllm"),
    SeriesDef(id="vllm.ttft_ms_avg", unit="ms", kind="gauge", label="TTFT (avg)", group="vllm"),
    SeriesDef(id="vllm.ttft_ms_p95", unit="ms", kind="gauge", label="TTFT p95", group="vllm"),
    SeriesDef(id="vllm.tpot_ms_avg", unit="ms", kind="gauge", label="TPOT (avg)", group="vllm"),
    SeriesDef(id="vllm.spec_accept_avg", unit="x", kind="gauge", label="Spec-decode accept len", group="vllm"),
    SeriesDef(id="vllm.preemptions", unit="ct", kind="gauge", label="Preemptions total", group="vllm"),
]

CHART_PALETTE = [
    "#5EB1FF", "#4ADE80", "#FBBF24", "#F87171", "#A78BFA",
    "#22D3EE", "#FB923C", "#E879F9", "#34D399", "#F472B6",
    "#93C5FD", "#86EFAC",
]


def net_series(iface: str) -> list[SeriesDef]:
    return [
        SeriesDef(id=f"net.{iface}.rx_kbps", unit="kbit/s", kind="gauge", label=f"RX {iface}", group="net"),
        SeriesDef(id=f"net.{iface}.tx_kbps", unit="kbit/s", kind="gauge", label=f"TX {iface}", group="net"),
    ]


def temp_zone_series(zones: list[str]) -> list[SeriesDef]:
    return [
        SeriesDef(id=f"temp.zone.{z}", unit="C", kind="gauge", label=f"Temp {z}", group="temp")
        for z in zones
    ]


def docker_series(ctr: str) -> list[SeriesDef]:
    return [
        SeriesDef(id=f"docker.{ctr}.cpu_pct", unit="%", kind="gauge", label=f"{ctr} CPU", group="docker"),
        SeriesDef(id=f"docker.{ctr}.mem_gib", unit="GiB", kind="gauge", label=f"{ctr} mem", group="docker"),
        SeriesDef(id=f"docker.{ctr}.rx_kbps", unit="kbit/s", kind="gauge", label=f"{ctr} net rx", group="docker"),
        SeriesDef(id=f"docker.{ctr}.tx_kbps", unit="kbit/s", kind="gauge", label=f"{ctr} net tx", group="docker"),
    ]


def per_core_series(cores: int) -> list[SeriesDef]:
    keep = [i for i in range(cores) if cores <= 24 or i % 2 == 0]
    return [
        SeriesDef(id=f"cpu.core.{i}", unit="%", kind="gauge", label=f"CPU {i}", group="cpu-sibling")
        for i in keep
    ]


def default_catalog(cores: int = 20) -> list[SeriesDef]:
    return STATIC + per_core_series(cores)
