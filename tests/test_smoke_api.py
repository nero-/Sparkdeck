import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import pytest  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

from sparkdeck.app import Application  # noqa: E402
from sparkdeck.config import RuntimeConfig  # noqa: E402
from sparkdeck.server import create_app  # noqa: E402


@pytest.fixture()
def app_ctx(tmp_path):
    cfg = RuntimeConfig(data_dir=tmp_path / "data")
    cfg.mock = True
    a = Application(cfg)
    app = create_app(a)
    with TestClient(app) as tc:
        # wait for the mock world to actually produce samples
        for _ in range(60):
            ring = (a.series.rings.get("c1-n0") or {}).get("gpu.util")
            if ring is not None and len(ring.ts) >= 3:
                break
            time.sleep(0.3)
        yield tc, a


import time  # noqa: E402


def test_clusters_seeded(app_ctx):
    tc, a = app_ctx
    data = tc.get("/api/clusters").json()
    ids = [c["id"] for c in data]
    assert ids == ["c1", "c2"]
    c1 = data[0]
    assert [p["key"] for p in c1["profiles"]] == [
        "mtp3-nvfp4", "df-nvfp4", "mtp3-spark", "df-spark"] or set(
        p["key"] for p in c1["profiles"]) == {"mtp3-spark", "mtp3-nvfp4", "df-spark", "df-nvfp4"}
    assert [n["name"] for n in c1["nodes"]] == ["gx10-r0", "gx10-r1"]
    assert c1["nodes"][0]["addresses"][0]["host"] == "192.168.50.23"


def test_system_and_metrics(app_ctx):
    tc, a = app_ctx
    info = tc.get("/api/system/info").json()
    assert info["mock"] is True and info["name"] == "Sparkdeck"
    cat = tc.get("/api/metrics/catalog").json()
    ids = {s["id"] for s in cat["series"]}
    assert "gpu.util" in ids and "mem.used_gib" in ids and "vllm.decode_tok_s" in ids
    hist = tc.get("/api/metrics/history?node_id=c1-n0&names=gpu.util&window=5m").json()
    assert "gpu.util" in hist["series"]
    series = hist["series"]["gpu.util"]
    assert len(series["t"]) == len(series["v"]) and len(series["t"]) > 0


def test_service_state_and_events(app_ctx):
    tc, a = app_ctx
    st = tc.get("/api/llm/c1/state").json()
    assert st.get("health") in ("up", "down", "degraded", "unknown")
    ev = tc.get("/api/events").json()
    assert isinstance(ev, list)


def test_start_stop_lifecycle(app_ctx):
    tc, a = app_ctx
    r = tc.post("/api/clusters/c1/actions/start", json={"profile_key": "df-nvfp4"})
    assert r.status_code == 200, r.text
    op_id = r.json()["op_id"]
    ok = False
    for _ in range(120):
        op = tc.get(f"/api/ops/{op_id}").json()
        if op["state"] in ("ok", "error", "cancelled"):
            ok = op["state"] == "ok"
            break
        time.sleep(0.5)
    assert ok, tc.get(f"/api/ops/{op_id}").json()
    for _ in range(40):  # service loop publishes every 10s; frames every 2s
        svc = tc.get("/api/llm/c1/state").json()
        if svc.get("profile_key") == "df-nvfp4" and svc.get("health") == "up" and svc.get("kv_tokens"):
            break
        time.sleep(0.5)
    svc = tc.get("/api/llm/c1/state").json()
    assert svc["profile_key"] == "df-nvfp4" and svc["health"] == "up"
    assert svc["kv_tokens"] and svc["kv_tokens"] > 100000
    # stop
    r = tc.post("/api/clusters/c1/actions/stop", json={})
    op_id = r.json()["op_id"]
    for _ in range(60):
        op = tc.get(f"/api/ops/{op_id}").json()
        if op["state"] in ("ok", "error"):
            break
        time.sleep(0.4)
    op = tc.get(f"/api/ops/{op_id}").json()
    assert op["state"] == "ok", op


def test_envfiles_image_and_node_probes(app_ctx):
    tc, a = app_ctx
    envs = tc.get("/api/images/envs/c1").json()
    assert envs["envs"][0]["profile_key"] in ("mtp3-spark", "df-nvfp4", "df-spark", "mtp3-nvfp4")
    imgs = tc.get("/api/images/c1-n0").json()
    assert any("head0906" in i["repo_tag"] for i in imgs["images"])
    probes = tc.post("/api/nodes/c1-n0/test").json()
    assert probes["ok"] is True
    gids = tc.post("/api/nodes/c1-n0/actions/show-gids").json()
    op = tc.get(f"/api/ops/{gids['op_id']}").json()
    for _ in range(30):
        op = tc.get(f"/api/ops/{gids['op_id']}").json()
        if op["state"] in ("ok", "error"):
            break
        time.sleep(0.2)
    assert op["state"] == "ok"
    assert op["params"].get("gid_table")


def test_bench_config_and_reject(app_ctx):
    tc, a = app_ctx
    cfg = tc.get("/api/bench/config").json()
    assert "defaults" in cfg
    # mock world has no bench tool configured in tmp data dir… seeded settings point at the REAL bench dir
    # (present on this machine) — jobs would really run; reject via bad cluster to keep the test hermetic.
    r = tc.post("/api/bench/jobs", json={"cluster_id": "nonexistent"})
    assert r.status_code == 404


def test_settings_patch_roundtrip(app_ctx):
    tc, a = app_ctx
    cur = tc.get("/api/settings").json()
    cur["alerts"]["mem_warn_gib"] = 117.0
    r = tc.patch("/api/settings", json={"alerts": {"mem_warn_gib": 117.0}})
    assert r.status_code == 200
    after = tc.get("/api/settings").json()
    assert after["alerts"]["mem_warn_gib"] == 117.0
    assert a.settings_ref.settings.alerts.mem_warn_gib == 117.0


def test_websocket_stream(app_ctx):
    """WS is exercised against a REAL uvicorn server in tests/mock_server_smoke.py
    (TestClient's portal adds flaky cross-loop timing for push feeds)."""
    pytest.skip("covered by tests/mock_server_smoke.py against a real server")


import json  # noqa: E402
