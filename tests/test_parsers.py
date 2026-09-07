"""Unit tests: prometheus parsing (both vLLM naming generations), quantiles,
frame→series mapping, LTTB decimation, and bench summarize on a real artifact
shape."""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from sparkdeck.telemetry.collector import (  # noqa: E402
    hist_avg_delta, hist_quantile, parse_prom, parse_size_gib,
)
from sparkdeck.telemetry.parser import check_structure, frame_to_series  # noqa: E402
from sparkdeck.telemetry.store import _lttb  # noqa: E402
from sparkdeck.bench.runner import summarize  # noqa: E402

PROM = """
# HELP vllm:num_requests_running Number.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{model_name="zai-org/GLM-5.3-Flash",engine="0"} 3.0
# TYPE vllm:GPU_cache_usage_perc gauge
vllm:GPU_cache_usage_perc{model_name="zai-org/GLM-5.3-Flash"} 0.62
# TYPE vllm:kv_cache_usage_perc gauge
vllm:kv_cache_usage_perc{model_name="zai-org/GLM-5.3-Flash"} 0.42
vllm:generation_tokens_total 86000.0
vllm:prompt_tokens_total 41000.0
vllm:num_preemptions_total 1.0
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le="0.05"} 12
vllm:time_to_first_token_seconds_bucket{le="0.5"} 118
vllm:time_to_first_token_seconds_bucket{le="1.0"} 190
vllm:time_to_first_token_seconds_bucket{le="inf"} 240
vllm:time_to_first_token_seconds_sum 187.4
vllm:time_to_first_token_seconds_count 240
# TYPE vllm:inter_token_latency_seconds histogram
vllm:inter_token_latency_seconds_bucket{le="0.02"} 100000
vllm:inter_token_latency_seconds_bucket{le="inf"} 210000
vllm:inter_token_latency_seconds_sum 21000.2
vllm:inter_token_latency_seconds_count 210000
"""


def test_parse_prom_both_generations():
    flat, hist = parse_prom(PROM)
    assert flat["vllm:num_requests_running"][0][1] == 3.0
    assert flat["vllm:generation_tokens_total"][0][1] == 86000.0
    assert "vllm:GPU_cache_usage_perc" in flat and "vllm:kv_cache_usage_perc" in flat
    ttft = hist["vllm:time_to_first_token_seconds"]
    assert ttft["count"] == 240.0 and ttft["sum"] == 187.4
    assert len(ttft["buckets"]) == 4


def test_quantile_and_avg():
    _, hist = parse_prom(PROM)
    ttft = hist["vllm:time_to_first_token_seconds"]
    p50 = hist_quantile(ttft, 0.5)
    assert p50 is not None and 0.0 < p50 < 1000.0
    # avg over delta: prev half counts
    prev = {"sum": 87.4, "count": 40}
    avg = hist_avg_delta(ttft, prev, 5.0)
    # (187.4-87.4)/(240-40) = 0.5 s → 500 ms
    assert avg is not None and abs(avg - 500.0) < 1e-6


def test_frame_to_series_and_structure():
    frame = {
        "v": 1, "ts": 1000, "host": "x", "iv": 2.0,
        "gpu": {"util": 12.0, "temp": 50.0, "power_w": 10.0, "clock_sm": 1700,
                "throttle_thermal": 0.0, "throttle_power_cap": 0.0, "apps": 1},
        "cpu": {"util": 8.0, "load1": 1.0, "load5": 1.0, "load15": 1.0,
                "psi_cpu": 0.1, "per_core": [1.0, 2.0]},
        "mem": {"total_gib": 121.7, "used_gib": 118.0, "avail_gib": 3.7,
                "alloc_est_gib": 4.7, "pagecache_gib": 5.0, "swap_used_gib": 0.0},
        "net": {"enp1s0f1np1": {"rx_kbps": 10.0, "tx_kbps": 5.0}},
        "disk": {"root_used_pct": 60.0, "r_mbps": 2.0, "w_mbps": 1.0},
        "temp": {"zones": {"tz0": 48.0}, "max": 50.0},
        "docker": {"ts": 1000, "docker_ok": True,
                   "containers": {"glm53-flash-r0": {"cpu_pct": 320.0, "mem_gib": 99.0,
                                                     "rx_kbps": 10.0, "tx_kbps": 9.0}}},
        "vllm": {"ts": 1000, "health": "up", "port": 8000, "models": ["zai-org/GLM-5.3-Flash"],
                 "g": {"decode_tok_s": 30.0, "kv_usage": 44.0, "num_running": 2.0}},
        "errors": [],
    }
    assert check_structure(frame)
    sf = frame_to_series(frame)
    s = sf.series
    assert s["gpu.util"] == 12.0
    assert s["cpu.core.0"] == 1.0 and s["cpu.core.1"] == 2.0
    assert s["mem.used_gib"] == 118.0
    assert s["net.enp1s0f1np1.rx_kbps"] == 10.0
    assert s["docker.glm53-flash-r0.cpu_pct"] == 320.0
    assert s["vllm.kv_usage_perc"] == 44.0
    assert s["temp.zone.tz0"] == 48.0


def test_lttb_shrinks_and_keeps():
    data = [(i * 10, float(i % 7) + 0.1) for i in range(1000)]
    out = _lttb(data, 100)
    assert 40 <= len(out) <= 160
    assert out[0][0] == data[0][0] and abs(out[-1][1] - data[-1][1]) < 1e-9


def test_bench_summarize_real_shape():
    js = {
        "metadata": {"engine": "vllm", "model": "zai-org/GLM-5.3-Flash",
                     "concurrency_levels": [1, 2, 4], "context_lengths": [0, 8192],
                     "kv_budget": None},
        "startup_diagnostics": {"server_url": "http://192.168.50.90:8000"},
        "summary_table": {"0": {"1": 29.15}, "8192": {"1": 30.0, "2": None}},
        "prefill": {"8192": {"ttft_seconds": 4.85, "tok_per_sec": 1690.0,
                             "prompt_tokens": 8198, "samples": 1,
                             "method": "integrated_scout"}},
        "results": [
            {"concurrency": 1, "context_tokens": 0, "aggregate_tps": 29.15,
             "server_spec_accept_length": 2.45, "ttft_p50": 0.31},
            {"concurrency": 1, "context_tokens": 8192, "aggregate_tps": 30.0,
             "server_spec_accept_length": 2.44},
        ],
        "coding_peak": {"summary": {"mean_generation_tok_s": 88.4}},
    }
    s = summarize(js)
    assert s["engine"] == "vllm"
    assert s["best"]["tps"] == 30.0 and s["best"]["ctx"] == 8192
    assert s["c1"]["tps"] == 30.0  # best C=1 across contexts
    assert s["spec_accept_avg"] == 2.445
    assert s["prefill"][0]["tok_per_sec"] == 1690.0
    assert s["cells"] == 2
    # sentinels excluded
    js2 = json.loads(json.dumps(js))
    js2["summary_table"]["8192"]["2"] = -3.0
    assert summarize(js2)["best"]["tps"] == 30.0


def test_parse_size_gib():
    assert parse_size_gib("24.1GiB / 120GiB") == 24.1
    assert parse_size_gib("512MiB / 1GiB") == 0.5
    assert parse_size_gib("garbage") is None
