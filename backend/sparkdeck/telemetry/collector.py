#!/usr/bin/env python3
"""sparkdeck node collector — one NDJSON snapshot per tick on stdout.

Deployed to nodes at ~/.sparkdeck/collector.py by the controller. Stdlib
only; runs as the operator's user. stdout carries ONLY JSON lines — all
diagnostics go to stderr. Lazy blocks (docker, vllm) refresh less often and
carry their own `ts` so the server can carry values forward.

GB10 notes encoded here (verified against DGX Spark docs + production use):
  * nvidia-smi exposes utilization/temp/power/sm-clock but NOT memory
    ("Not Supported") — the real unified-memory pool is /proc/meminfo
    (MemAvailable + SwapFree is the official allocatable estimate).
  * thermal_zone 0/2 (acpitz) track the SoC/GPU hotspot and run hotter than
    nvidia-smi's GPU temp.
  * vLLM /metrics naming changed across v0/v1 (GPU_cache_usage_perc →
    gpu_cache_usage_perc → kv_cache_usage_perc; inter_token_latency_seconds
    replaced time_per_output_token_seconds) — the parser accepts all.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

RUNNING = True


def _sig(*_a) -> None:  # noqa: ANN002
    global RUNNING
    RUNNING = False


signal.signal(signal.SIGTERM, _sig)
signal.signal(signal.SIGINT, _sig)

RE_TRAILING_NUM = "(-?\\d+(?:\\.\\d+)?)"
SIMPLE_NUM = re.compile(r"^\s*[-0-9.eE+]+\s*$")


def now_ms() -> int:
    return int(time.time() * 1000)


def to_float(text, default=None):
    t = str(text or "").strip()
    t = t.strip("[]").strip()
    if t in ("", "N/A", "Not Supported", "Unknown", "[N/A]", "N PA"):
        return default
    if not SIMPLE_NUM.match(t):
        return default
    try:
        return float(t)
    except Exception:
        return default


def gib(kib: float) -> float:
    return kib / (1024 * 1024)


# ---------------------------------------------------------------------------
# shell helpers


class Sh:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.norm: dict[str, str] = {}

    def note(self, msg: str) -> None:
        self.errors.append(msg)
        if len(self.errors) > 4:
            self.errors = self.errors[-4:]

    def run(self, cmd, timeout=8.0):
        try:
            out = subprocess.run(cmd, shell=not isinstance(cmd, list), capture_output=True, text=True, timeout=timeout)
            if out.returncode != 0 and out.stderr and len(out.stderr.strip()) < 200:
                self.note(f"$ {str(cmd)[:60]} -> rc={out.returncode}: {out.stderr.strip()[:120]}")
            return out.stdout or ""
        except Exception as exc:  # noqa: BLE001
            self.note(f"$ {str(cmd)[:48]} error: {exc}")
            return ""


# ---------------------------------------------------------------------------
# Delta tracker: (value of a monotonically increasing counter) -> rate

class Delta:
    def __init__(self, now_ms):
        self.at = now_ms
        self.val = 0.0

    def reset(self, now_ms, val):
        self.val = val
        self.at = now_ms

    def rate(self, now_ms, new_val, scale=1.0):
        """Return scaled rate (units per second) for this tick, or None."""
        if new_val is None:
            return None
        if new_val < self.val:       # counter reset (restart)
            self.reset(now_ms, new_val)
            return None
        dt = (now_ms - self.at) / 1000.0
        if dt <= 0:
            return None
        if dt < self._min_dt():
            return None
        r = (new_val - self.val) / dt * scale
        self.val = new_val
        self.at = now_ms
        return r

    def _min_dt(self):
        return 0.0


# ---------------------------------------------------------------------------
# Prometheus text parser

_METRIC_LINE = re.compile(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})?\s+(.+)$")


def parse_prom(text: str):
    """-> (flat: {name: [(labels, value)]}, hists: {family: {sum,count,buckets}})"""
    flat: dict[str, list[tuple[dict, float]]] = {}
    hist: dict[str, dict] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _METRIC_LINE.match(line)
        if not m:
            continue
        name, labels_s, val_s = m.group(1), m.group(3) or "", m.group(4)
        val = to_float(val_s.split(" ")[0])
        if val is None:
            continue
        labels: dict[str, str] = {}
        if labels_s:
            for part in re.findall(r'(\w+)="([^"]*)"', labels_s):
                labels[part[0]] = part[1]
        base = name
        if base.endswith("_bucket"):
            fam, kind = base[: -len("_bucket")], "bucket"
        elif base.endswith("_sum"):
            fam, kind = base[: -len("_sum")], "sum"
        elif base.endswith("_count"):
            fam, kind = base[: -len("_count")], "count"
        else:
            # keep the exact (possibly _total-suffixed) name — callers alias anyway
            fam, kind = base, "counter"
        if kind == "bucket":
            h = hist.setdefault(fam, {"sum": 0.0, "count": 0.0, "buckets": []})
            try:
                le = float(labels.pop("le", "inf"))
            except Exception:
                le = float("inf")
            h["buckets"].append((le, val))
            h.setdefault("labels", labels)
        elif kind in ("sum", "count"):
            h = hist.setdefault(fam, {"sum": 0.0, "count": 0.0, "buckets": []})
            h[kind] = val
            h.setdefault("labels", labels)
        else:
            flat.setdefault(fam, []).append((labels, val))
    for fam, h in hist.items():
        h["buckets"].sort(key=lambda b: (b[0] == float("inf"), b[0]))
    return flat, hist


def hist_quantile(h, q) -> float | None:
    buckets = h.get("buckets") or []
    count = h.get("count") or 0.0
    if not buckets or count <= 0:
        return None
    target = q * count
    prev_le, prev_val = 0.0, 0.0
    for le, val in buckets:
        if val >= target and le > prev_le:
            frac = (target - prev_val) / max(val - prev_val, 1e-9)
            return (prev_le + (le - prev_le) * min(max(frac, 0.0), 1.0)) * 1000.0  # ms
        prev_le, prev_val = le, val
    return None


def hist_avg_delta(h, prev, dt_s) -> float | None:
    if not h:
        return None
    cur_sum, cur_cnt = h.get("sum", 0.0), h.get("count", 0.0)
    if prev is not None:
        psum, pcnt = prev.get("sum", 0.0), prev.get("count", 0.0)
        dsum, dcnt = cur_sum - psum, cur_cnt - pcnt
        if dcnt > 0 and dsum >= 0 and dt_s > 0:
            return (dsum / dcnt) * 1000.0
        if dcnt < 0:  # reset
            pass
        else:
            return None
    return None


# ---------------------------------------------------------------------------
# blocks

def probe_gpu(sh: Sh) -> dict:
    out: dict = {}
    txt = sh.run(
        "nvidia-smi --query-gpu=utilization.gpu,temperature.gpu,power.draw,"
        "clocks.current.sm,clocks_event_reasons.hw_thermal_slowdown,"
        "clocks_event_reasons.sw_power_cap --format=csv,noheader,nounits"
    )
    lines = [l for l in txt.strip().splitlines() if l.strip()]
    if lines:
        parts = [p.strip() for p in lines[0].split(",")]
        out = {
            "util": to_float(parts[0] if parts else None),
            "temp": to_float(parts[1] if len(parts) > 1 else None),
            "power_w": to_float(parts[2] if len(parts) > 2 else None),
            "clock_sm": to_float(parts[3] if len(parts) > 3 else None),
            "throttle_thermal": (to_float(parts[4]) or 0.0) if len(parts) > 4 else 0.0,
            "throttle_power_cap": (to_float(parts[5]) or 0.0) if len(parts) > 5 else 0.0,
        }
    apps = sh.run("nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits", 4)
    pids = [p for p in apps.split() if p.strip().isdigit()]
    out["apps"] = len(pids)
    return out


def probe_mem() -> dict:
    info: dict[str, float] = {}
    try:
        with open("/proc/meminfo", "rb") as f:
            for line in f.read().decode().splitlines():
                k, _, rest = line.partition(":")
                parts = rest.split()
                if parts:
                    info[k.strip()] = float(parts[0])  # kB
    except Exception:
        return {}
    total = info.get("MemTotal", 0.0)
    avail = info.get("MemAvailable", info.get("MemFree", 0.0))
    cached = info.get("Cached", 0.0)
    shmem = info.get("Shmem", 0.0)
    reclaim = info.get("SReclaimable", 0.0)
    stot = info.get("SwapTotal", 0.0)
    sfree = info.get("SwapFree", 0.0)
    pagecache = max(cached - shmem, 0.0) + reclaim
    return {
        "total_gib": round(gib(total), 2),
        "avail_gib": round(gib(avail), 2),
        "alloc_est_gib": round(gib(avail + sfree), 2),  # official UMA allocatable estimate
        "used_gib": round(gib(total - avail), 2),
        "pagecache_gib": round(gib(pagecache), 2),
        "swap_used_gib": round(gib(stot - sfree), 2),
    }


def probe_load() -> dict:
    try:
        parts = Path("/proc/loadavg").read_text().split()[:3]
        return {
            "load1": to_float(parts[0]),
            "load5": to_float(parts[1]),
            "load15": to_float(parts[2]),
        }
    except Exception:
        return {}


def probe_psi() -> dict:
    def one(path, kind="some"):
        try:
            for line in Path(path).read_text().splitlines():
                if line.startswith(kind + " "):
                    d = dict(p.split("=") for p in line.split()[1:])
                    return to_float(d.get("avg10"))
        except Exception:
            pass
        return None
    return {"cpu": one("/proc/pressure/cpu"), "memory": one("/proc/pressure/memory"), "io": one("/proc/pressure/io")}


def probe_cpu_util(state: dict) -> dict:
    out: dict = {}
    try:
        with open("/proc/stat", "rb") as f:
            lines = f.read().decode().splitlines()
        agg, cores = None, []
        for ln in lines:
            parts = ln.split()
            if not parts or not parts[0].startswith("cpu"):
                continue
            vals = [int(x) for x in parts[1:] if x.strip().lstrip("-").isdigit()]
            if not vals:
                continue
            if parts[0] == "cpu":
                agg = vals
            elif len(parts[0]) <= 6:
                idx = int(parts[0][3:])
                if idx < 64:
                    cores.append((idx, vals))
        def util(cur, prev):
            if not cur or not prev or len(cur) < 5 or len(prev) < 5:
                return None
            d_all = sum(cur[:8]) - sum(prev[:8])
            d_idle = (cur[3] + cur[4]) - (prev[3] + prev[4])
            if d_all <= 0:
                return None
            return round(100.0 * (d_all - d_idle) / d_all, 2)
        if agg is not None:
            prev = state.get("cpu.agg")
            if prev:
                u = util(agg, prev)
                if u is not None:
                    out["util"] = u
            state["cpu.agg"] = agg
        if cores:
            prev_cores = state.get("cpu.cores") or {}
            per = []
            for idx, vals in sorted(cores):
                pv = prev_cores.get(idx)
                if pv:
                    u = util(vals, pv)
                    if u is not None:
                        per.append(u)
            if len(per) == len(cores):
                out["per_core"] = per
            state["cpu.cores"] = {idx: vals for idx, vals in cores}
    except Exception:
        pass
    return out


_EXCLUDED_IFACES = ("lo", "docker", "br-", "veth", "virbr", "tun", "docker_gwbridge")


def probe_net(state: dict, ts: int) -> dict:
    out: dict = {}
    try:
        with open("/proc/net/dev", "rb") as f:
            lines = f.read().decode().splitlines()[2:]
        for ln in lines:
            if ":" not in ln:
                continue
            name, rest = ln.split(":", 1)
            name = name.strip().lower()
            if any(name == e or name.startswith(e) for e in _EXCLUDED_IFACES):
                continue
            cols = rest.split()
            if len(cols) < 9:
                continue
            rx, tx = to_float(cols[0], 0) or 0, to_float(cols[8], 0) or 0
            key = (name, "rx")
            prev = state.get(key)
            if prev:
                d = (rx - prev[1]) / ((ts - prev[0]) / 1000.0) * 8 / 1000
                if d >= 0:
                    out[name] = {"rx_kbps": round(d, 1)}
            state[key] = (ts, rx)
            prev = state.get((name, "tx"))
            if prev:
                d = (tx - prev[1]) / ((ts - prev[0]) / 1000.0) * 8 / 1000
                if d >= 0:
                    out.setdefault(name, {})["tx_kbps"] = round(d, 1)
            state[(name, "tx")] = (ts, tx)
    except Exception:
        pass
    return out


def probe_disk(state: dict, ts: int) -> dict:
    import shutil

    out: dict = {}
    try:
        du = shutil.disk_usage("/")
        out["root_used_pct"] = round(100.0 * du.used / du.total, 1) if du.total else None
    except Exception:
        pass
    # nvme sector deltas -> MB/s aggregate across nvme* devices
    try:
        with open("/proc/diskstats", "rb") as f:
            for ln in f.read().decode().splitlines():
                parts = ln.split()
                if len(parts) < 13:
                    continue
                name = parts[2]
                if not (name.startswith("nvme") and not name[4:5].isdigit()):
                    continue  # prefer whole devices (nvme0n1) over partitions
                r_bytes = int(parts[5]) * 512
                w_bytes = int(parts[9]) * 512
                for which in ("r", "w"):
                    key = (name, which)
                    prev = state.get(key)
                    val = r_bytes if which == "r" else w_bytes
                    if prev:
                        d = (val - prev[1]) / ((ts - prev[0]) / 1000.0) / (1024 * 1024)
                        if d >= 0:
                            out[f"{which}_mbps"] = round(out.get(f"{which}_mbps", 0) + d, 1)
                    state[key] = (ts, val)
    except Exception:
        pass
    return out


def probe_temp(sh: Sh, zone_map: dict, now: int) -> dict:
    if now - sh.norm.get("_zones_ts", 0) > 60000:  # re-enumerate every minute
        zone_map.clear()
        tz = Path("/sys/class/thermal")
        try:
            for z in sorted(tz.glob("thermal_zone*")):
                typ = ""
                try:
                    typ = (z / "type").read_text().strip()
                except Exception:
                    pass
                label = z.name.replace("thermal_zone", "tz") + (f"-{typ}" if typ else "")
                zone_map[z.name] = label
            sh.norm["_zones_labels"] = ",".join(f"{k}={v}" for k, v in sorted(zone_map.items()))
        except Exception:
            pass
        sh.norm["_zones_ts"] = str(now)
    zones: dict[str, float] = {}
    maxv = None
    try:
        for zid, label in zone_map.items():
            val = read_milli(f"/sys/class/thermal/{zid}/temp")
            if val is not None:
                zones[label] = val
                maxv = val if maxv is None else max(maxv, val)
    except Exception:
        pass
    if not zones:  # hwmon fallback
        try:
            for hw in sorted(Path("/sys/class/hwmon").glob("hwmon*")):
                name = ""
                try:
                    name = (hw / "name").read_text().strip()
                except Exception:
                    pass
                for fin in sorted(hw.glob("temp*_input")):
                    val = read_milli(str(fin))
                    if val is not None:
                        key = f"hwmon-{name}-{fin.name}"
                        zones[key] = val
                        maxv = val if maxv is None else max(maxv, val)
        except Exception:
            pass
    return {"zones": zones, "max": maxv}


def read_milli(path: str):
    try:
        raw = Path(path).read_text().strip()
        val = to_float(raw)
        return round(val / 1000.0, 1) if val is not None else None
    except Exception:
        return None


_DIM_FACT = {"KiB": 1024**2, "MiB": 1024.0, "GiB": 1.0, "kib": 1024**2, "mib": 1024.0, "gib": 1.0}


def parse_size_gib(s: str):
    """docker MemUsage '24.1GiB / 120GiB' → 24.1 (GiB)."""
    m = re.match(r"^([\d.]+)\s*(KiB|MiB|GiB|kB|B)\b", (s or "").strip())
    if not m:
        return None
    if m.group(2) == "kB":
        return round(float(m.group(1)) / (1024 * 1024), 2)
    if m.group(2) == "B":
        return round(float(m.group(1)) / (1024**3), 2)
    return round(float(m.group(1)) / _DIM_FACT[m.group(2)], 2)


def probe_docker(sh: Sh, names_re: re.Pattern, cache: dict, now: int, refresh_every_s: float) -> dict:
    if cache["data"] and (now - cache["ts"]) < refresh_every_s * 1000:
        return cache["data"]
    data: dict = {"ts": now, "containers": {}}
    ps = sh.run("docker ps --format '{{.Names}}'", 6)
    names = [n.strip() for n in ps.splitlines() if n.strip() and names_re.search(n)]
    if not names:
        # distinguish "nothing running" (ok) from docker broken (error noted)
        rc_probe = sh.run("docker version --format '{{.Server.Version}}'", 5)
        if rc_probe.strip() == "":
            data["docker_ok"] = False
        cache["data"] = data
        cache["ts"] = now
        return data
    data["docker_ok"] = True
    stats = sh.run(
        "docker stats --no-stream --format '{{json .}}' " + " ".join(names), 15
    )
    for line in stats.splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            js = json.loads(line)
        except Exception:
            continue
        name = js.get("Name") or js.get("Container") or ""
        if not name:
            continue
        cpu = to_float((js.get("CPUPerc") or "0%").replace("%", ""))
        mem = parse_size_gib((js.get("MemUsage") or "0").split("/")[0])
        nets = (js.get("NetIO") or "0B / 0B").split("/")
        rx = parse_mib(nets[0]) if nets else None
        tx = parse_mib(nets[1]) if len(nets) > 1 else None
        c = cache["data"].get("containers", {}).get(name, {})
        prevrx = c.get("_rx"), c.get("_rx_ts")
        rx_kbps = None
        if rx is not None and c.get("_rx") is not None and c.get("_rx_ts"):
            dt = (now - c["_rx_ts"]) / 1000.0
            if dt > 0 and rx >= c["_rx"]:
                rx_kbps = round((rx - c["_rx"]) * 1024 * 8 / dt / 1000, 1)
        tx_kbps = None
        if tx is not None and c.get("_tx") is not None and c.get("_tx_ts"):
            dt = (now - c["_tx_ts"]) / 1000.0
            if dt > 0 and tx >= c["_tx"]:
                tx_kbps = round((tx - c["_tx"]) * 1024 * 8 / dt / 1000, 1)
        data["containers"][name] = {
            "cpu_pct": cpu,
            "mem_gib": mem,
            "rx_kbps": rx_kbps if rx_kbps is not None else c.get("rx_kbps"),
            "tx_kbps": tx_kbps if tx_kbps is not None else c.get("tx_kbps"),
            "_rx": rx, "_tx": tx, "_rx_ts": now, "_tx_ts": now,
        }
    cache["data"] = data
    cache["ts"] = now
    return data


def parse_mib(s: str):
    m = re.match(r"^([\d.]+)\s*(B|kB|MB|GB|KiB|MiB|GiB|TB)$", (s or "").strip())
    if not m:
        return None
    factor = {"B": 1.0, "kB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12,
              "KiB": 1024.0, "MiB": 1024**2, "GiB": 1024**3}
    return float(m.group(1)) * factor.get(m.group(2), 1.0)


# ---------------------------------------------------------------------------
# vLLM block

_PRINTF = dict()  # alias map families


def probe_vllm(delta: dict, cache: dict, api_port: int, candidates: list, now: int, refresh_every_s: float) -> dict:
    if cache["data"].get("g") and (now - cache["ts"]) < refresh_every_s * 1000:
        return cache["data"]
    out: dict = {"ts": now}
    base, port_used = f"http://127.0.0.1:{api_port}", api_port
    port = http_get(base + "/health", timeout=3)
    ok = port is not None
    if not ok and candidates:
        for cand in candidates:
            if cand == api_port:
                continue
            alt = http_get(f"http://127.0.0.1:{cand}/health", 2)
            if alt is not None:
                base, port_used, ok = f"http://127.0.0.1:{cand}", cand, True
                break
    out["health"] = "up" if ok else "down"
    out["port"] = port_used
    g: dict[str, float] = {}
    models: list[str] = []
    if ok:
        raw = http_get(base + "/metrics", 4) or ""
        models_raw = http_get(base + "/v1/models", 4) or ""
        if models_raw:
            try:
                js = json.loads(models_raw)
                data = js.get("data") or []
                if isinstance(data, list):
                    models = [m.get("id") for m in data if isinstance(m, dict) and m.get("id")]
                else:
                    models = []
            except Exception:
                models = parse_models_regex(models_raw)
            if not models:
                models = parse_models_regex(models_raw)
        flat, hist = parse_prom(raw)
        def gv(*names):  # first present value
            for n in names:
                if n in flat and flat[n]:
                    return flat[n][0][1]
            return None
        def hn(*names):  # first present histogram
            for n in names:
                if n in hist:
                    return hist[n]
            return None
        gen_c = gv("vllm:generation_tokens_total", "vllm:generation_tokens")
        pr_c = gv("vllm:prompt_tokens_total", "vllm:prompt_tokens")
        dt_s = _delta_dt(delta, now)
        if gen_c is not None:
            r = tr(delta, "gen", now, gen_c, 1.0, dt_s)
            if r is not None:
                g["decode_tok_s"] = round(r, 1)
        if pr_c is not None:
            r = tr(delta, "prompt", now, pr_c, 1.0, dt_s)
            if r is not None:
                g["prompt_tok_s"] = round(r, 1)
        running = gv("vllm:num_requests_running")
        waiting = gv("vllm:num_requests_waiting")
        if running is not None:
            g["num_running"] = running
        if waiting is not None:
            g["num_waiting"] = waiting
        kv = gv("vllm:kv_cache_usage_perc", "vllm:gpu_cache_usage_perc", "vllm:GPU_cache_usage_perc")
        if kv is not None:
            g["kv_usage"] = round(kv * 100.0, 1)
        pq = gv("vllm:prefix_cache_queries_total", "vllm:prefix_cache_queries",
                "vllm:gpu_prefix_cache_queries_total", "vllm:gpu_prefix_cache_queries")
        ph = gv("vllm:prefix_cache_hits_total", "vllm:prefix_cache_hits",
                "vllm:gpu_prefix_cache_hits_total", "vllm:gpu_prefix_cache_hits")
        if pq:
            hpq = tr(delta, "prefix_q", now, pq, 1.0, dt_s)
            hph = tr(delta, "prefix_h", now, ph, 1.0, dt_s) if ph else None
            if hpq and hph is not None and hpq > 0:
                g["prefix_hit_rate"] = round(100.0 * hph / hpq, 1)
        preem = gv("vllm:num_preemptions_total", "vllm:num_preemptions")
        if preem is not None:
            g["preemptions"] = preem
        ttft = hn("vllm:time_to_first_token_seconds")
        if ttft:
            prev_hist = cache["data"].get("h", {}).get("ttft")
            avg = hist_avg_delta(ttft, prev_hist, dt_s)
            if avg is not None:
                g["ttft_ms_avg"] = round(avg, 1)
            p50 = hist_quantile(ttft, 0.5)
            p95 = hist_quantile(ttft, 0.95)
            if p50 is not None:
                g["ttft_ms_p50"] = round(p50, 1)
            if p95 is not None:
                g["ttft_ms_p95"] = round(p95, 1)
            store_hist(cache, "ttft", ttft)
        itl = hn("vllm:inter_token_latency_seconds", "vllm:time_per_output_token_seconds")
        if itl:
            prev_itl = cache["data"].get("h", {}).get("itl")
            avg = hist_avg_delta(itl, prev_itl, dt_s)
            if avg is not None:
                g["tpot_ms_avg"] = round(avg, 1)
            store_hist(cache, "itl", itl)
        # spec decode acceptance (family names vary by era; ratio is what matters)
        acc = sum_aliases(flat, ("vllm:spec_decode_num_accepted_tokens",))
        prop = sum_aliases(flat, ("vllm:spec_decode_num_proposed_tokens",
                                  "vllm:spec_decode_num_drafted_tokens"))
        if acc and prop:
            acc_r = tr(delta, "spec_acc", now, acc, 1.0, dt_s)
            prop_r = tr(delta, "spec_prop", now, prop, 1.0, dt_s)
            if acc_r is not None and prop_r and prop_r > 0:
                g["spec_accept"] = round(acc_r / prop_r, 3)
        mn = None
        for pref in ("num_requests_running", "kv_cache_usage_perc", "gpu_cache_usage_perc"):
            for lbl, _v in flat.get(f"vllm:{pref}", []):
                if lbl.get("model_name"):
                    mn = lbl["model_name"]
                    break
            if mn:
                break
        if mn:
            out["model"] = mn
    out["g"] = g
    out["models"] = models
    cache["data"] = {"ts": now, "g": g, "h": cache["data"].get("h", {}), "ok": ok,
                     "port": port_used, "model": out.get("model")}
    return out


def store_hist(cache: dict, key: str, h: dict) -> None:
    hh = cache["data"].setdefault("h", {})
    hh[key] = {"sum": h.get("sum", 0.0), "count": h.get("count", 0.0)}


def tr(delta: dict, key: str, now: int, val: float, scale: float, dt_s: float):
    """bounded delta rate; requires dt>=1s to avoid division noise"""
    prev = delta.get(key)
    if prev is not None:
        p_ts, p_val = prev
        if val < p_val:  # reset
            delta[key] = (now, val)
            return None
        t = int(now - p_ts)
        if t < 900:
            return None
        r = (val - p_val) / (t / 1000.0) * scale
        delta[key] = (now, val)
        return r
    delta[key] = (now, val)
    return None


def _delta_dt(delta: dict, now: int) -> float:
    prev = delta.get("__dt")
    if prev:
        return (now - prev) / 1000.0
    return 1.0


def sum_aliases(flat: dict, prefixes: tuple) -> float | None:
    acc = 0.0
    seen = False
    for name, samples in flat.items():
        for p in prefixes:
            if name.startswith(p):
                try:
                    acc += samples[0][1]
                    seen = True
                except Exception:
                    pass
                break
    return acc if seen else None


def parse_models_regex(text: str):
    ids = re.findall(r'"id"\s*:\s*"([^"]+)"', text or "")
    out = []
    for i in ids:
        if i not in out:
            out.append(i)
    return out


def http_get(url: str, timeout: float):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            return r.read().decode(errors="replace")
    except Exception:
        return None


# ---------------------------------------------------------------------------

def collect_once(c: "Collector", sh: Sh, now: int) -> dict:
    frame: dict = {
        "v": 1,
        "ts": now,
        "iv": c.interval,
        "errors": sh.errors[-4:],
    }
    sh.errors = []  # per-frame error notes, capped
    gpu = {}
    try:
        gpu = probe_gpu(sh)
    except Exception as exc:
        sh.note(f"gpu: {exc}")
    mem = probe_mem()
    cpu = {}
    try:
        cpu = probe_cpu_util(c.state)
    except Exception as exc:
        sh.note(f"cpu: {exc}")
    cpu.update(probe_load())
    psi = probe_psi()
    cpu["psi"] = psi
    net = probe_net(c.state, now)
    disk = probe_disk(c.state, now)
    try:
        temp = probe_temp(sh, c.zone_map, now)
    except Exception as exc:
        temp = {"zones": {}, "max": None}
        sh.note(f"temp: {exc}")
    host = os.uname().nodename
    frame.update(
        gpu=gpu,
        cpu={"util": cpu.get("util"), "load1": cpu.get("load1"), "load5": cpu.get("load5"),
             "load15": cpu.get("load15"), "psi_cpu": psi.get("cpu"), "per_core": cpu.get("per_core", [])},
        mem={"psi_mem": psi.get("memory"), **mem},
        net=net,
        disk=disk,
        temp=temp,
        host=host,
    )
    # lazy blocks
    docker_every = max(3, refresh_ticks(c.interval, 10.0))
    vllm_every = max(2, refresh_ticks(c.interval, 4.0))
    if c.tick % docker_every == 0:
        try:
            probe_docker(sh, c.ctr_re, c.docker_cache, now, 0)
        except Exception as exc:
            sh.note(f"docker: {exc}")
    if c.tick % vllm_every == 0:
        try:
            new = probe_vllm(c.delta, c.vllm_cache, c.api_port, c.candidate_ports, now, 0)
            c.vllm_cache["ts"] = now
            merged = dict(new)
            merged["ts"] = now
            if new.get("g"):
                c.vllm_cache["data"].update(merged)
            else:
                c.vllm_cache["data"] = merged
        except Exception as exc:
            sh.note(f"vllm: {exc}")
    frame["docker"] = {"ts": c.docker_cache.get("ts"), "containers": {
        k: {kk: vv for kk, vv in v.items() if not kk.startswith("_")}
        for k, v in (c.docker_cache.get("data") or {}).get("containers", {}).items()}}
    frame["docker"]["docker_ok"] = (c.docker_cache.get("data") or {}).get("docker_ok", True)
    vc = c.vllm_cache.get("data") or {}
    frame["vllm"] = {"ts": vc.get("ts", now - 999999), "health": vc.get("health", "down"),
                     "g": vc.get("g", {}), "models": vc.get("models", []), "port": vc.get("port")}
    if vc.get("model"):
        frame["vllm"]["model"] = vc["model"]
    c.tick += 1
    return frame


def refresh_ticks(interval: float, seconds: float) -> int:
    return max(1, int(round(seconds / interval)))


class Collector:
    def __init__(self, interval, api_port, containers, interest, candidate_ports):
        self.interval = max(0.5, float(interval))
        self.api_port = int(api_port or 8000)
        self.ctr_re = re.compile(containers or "glm53")
        self.candidate_ports = [int(p) for p in (candidate_ports or "").split(",") if p.strip()]
        self.interest = set(x.strip() for x in (interest or "").split(",") if x.strip())
        self.tick = 0
        self.state: dict = {}
        self.delta: dict = {}
        self.zone_map: dict = {}
        self.docker_cache: dict = {"ts": 0, "data": {}}
        self.vllm_cache: dict = {"ts": 0, "data": {}}


def main() -> int:
    ap = argparse.ArgumentParser(description="sparkdeck node collector")
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--api-port", type=int, default=8000)
    ap.add_argument("--containers", default="glm53")
    ap.add_argument("--interest-ifaces", default="")
    ap.add_argument("--candidate-ports", default="8000")
    ap.add_argument("--selftest", action="store_true", help="read one NDJSON frame from /tmp/fakeframe and exit")
    args = ap.parse_args()

    c = Collector(args.interval, args.api_port, args.containers, args.interest_ifaces, args.candidate_ports)
    sh = Sh()
    if args.selftest:
        # selftest mode: emit exactly one frame without any sleep
        frame = collect_once(c, sh, now_ms())
        sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
        return 0
    interval = args.interval
    next_at = time.time()
    while RUNNING:
        try:
            frame = collect_once(c, sh, now_ms())
            sys.stdout.write(json.dumps(frame, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        except Exception as exc:  # never die — emit an error frame
            try:
                sys.stdout.write(json.dumps({"v": 1, "ts": now_ms(), "errors": [f"fatal: {exc}"]}) + "\n")
                sys.stdout.flush()
            except Exception:
                return 1
        next_at += interval
        delay = next_at - time.time()
        if delay < -interval * 3:
            next_at = time.time()  # clock jumped; resync
            delay = 0
        # sleep in small slices so signals still land promptly
        end = time.time() + max(0.0, delay)
        while RUNNING and time.time() < end:
            time.sleep(min(0.25, max(0.0, end - time.time())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
