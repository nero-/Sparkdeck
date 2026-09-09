"""Real-server mock smoke: launches sparkdeck serve (mock world) on a random
port, then verifies REST + WebSocket behavior with actual network I/O.

Run:  ./.venv/bin/python tests/mock_server_smoke.py
Exit 0 on success; prints a compact report.
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

import httpx  # noqa: E402
import websockets  # noqa: E402  (installed in the venv)

PORT = 8939
BASE = f"http://127.0.0.1:{PORT}"


def _free_port(base: int) -> int:
    for p in range(base, base + 40):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", p))
                return p
            except OSError:
                continue
    return base


async def wait_server(client: httpx.AsyncClient, tries: int = 80) -> None:
    for _ in range(tries):
        try:
            r = await client.get(f"{BASE}/api/healthz", timeout=2)
            if r.status_code == 200:
                return
        except Exception:
            pass
        await asyncio.sleep(0.3)
    raise AssertionError("server did not come up")


async def test_rest(client: httpx.AsyncClient) -> list[str]:
    notes: list[str] = []
    info = (await client.get(f"{BASE}/api/system/info")).json()
    assert info["mock"] is True, info
    notes.append(f"system/info: {info['name']} {info['version']} mock={info['mock']}")
    clusters = (await client.get(f"{BASE}/api/clusters")).json()
    assert len(clusters) == 1 and clusters[0]["nodes"], clusters
    assert clusters[0]["control"]["launcher"] == "sparkring.sh"
    assert len(clusters[0]["nodes"]) == 4
    notes.append("clusters: " + ", ".join(f"{c['name']} ({len(c['nodes'])} nodes, {len(c['profiles'])} profiles)" for c in clusters))
    # wait for flow
    for _ in range(40):
        r = (await client.get(f"{BASE}/api/metrics/history?node_id=c1-n0&names=gpu.util,mem.used_gib&window=10m")).json()
        if r["series"].get("gpu.util") and len(r["series"]["gpu.util"]["t"]) >= 4:
            break
        await asyncio.sleep(0.5)
    assert r["series"].get("gpu.util"), f"no series flowed: {r}"
    notes.append(f"metrics history: {len(r['series']['gpu.util']['t'])} pts gpu.util, mem {r['series'].get('mem.used_gib', {}).get('v', [None])[-1]}")
    # start/stop lifecycle through the op engine
    r = await client.post(f"{BASE}/api/clusters/c1/actions/start",
                          json={"profile_key": "tp4-mtp3"})
    assert r.status_code == 200, r.text
    op_id = r.json()["op_id"]
    state = None
    for _ in range(160):
        op = (await client.get(f"{BASE}/api/ops/{op_id}")).json()
        state = op["state"]
        if state in ("ok", "error", "cancelled"):
            break
        await asyncio.sleep(0.5)
    assert state == "ok", (await client.get(f"{BASE}/api/ops/{op_id}")).json()["log_tail"][-6:]
    notes.append(f"cluster.start op ok; steps={len((await client.get(f'{BASE}/api/ops/{op_id}')).json()['steps'])}")
    for _ in range(30):
        svc = (await client.get(f"{BASE}/api/llm/c1/state")).json()
        if svc.get("profile_key") == "tp4-mtp3" and svc.get("health") == "up" and svc.get("kv_tokens"):
            break
        await asyncio.sleep(0.5)
    assert svc.get("health") == "up" and svc.get("kv_tokens"), svc
    notes.append(f"service: {svc['model']} {svc['image']} kv={svc['kv_tokens']}")
    r = await client.post(f"{BASE}/api/clusters/c1/actions/stop", json={})
    op_stop = r.json()["op_id"]
    for _ in range(60):
        op = (await client.get(f"{BASE}/api/ops/{op_stop}")).json()
        if op["state"] in ("ok", "error"):
            break
        await asyncio.sleep(0.4)
    assert op["state"] == "ok", op
    notes.append("cluster.stop ok")
    # bench (mock world simulates the tool)
    r = await client.post(f"{BASE}/api/bench/jobs", json={
        "cluster_id": "c1", "profile_key": "tp4-mtp3", "label": "smoke",
        "args": {"concurrency": "1,2", "contexts": "0", "max_tokens": 128,
                 "duration": 8, "prefill_contexts": "8k"}})
    assert r.status_code == 200, r.text
    bj = (await client.get(f"{BASE}/api/bench/jobs/{r.json()['job_id']}")).json()
    t0 = time.time()
    while time.time() - t0 < 30:
        bj = (await client.get(f"{BASE}/api/bench/jobs/{bj['id']}")).json()
        if bj["state"] in ("ok", "error", "cancelled"):
            break
        await asyncio.sleep(0.5)
    assert bj["state"] == "ok", bj
    grid = (bj.get("summary") or {}).get("grid")
    assert grid, bj
    notes.append(f"bench job ok: {bj['summary'].get('cells')} cells, best={(bj['summary'].get('best') or {}).get('tps')}")
    # chat SSE (mock head serves OpenAI-compatible? mock has no HTTP server — expect graceful error frame)
    r = await client.post(f"{BASE}/api/llm/c1/chat", json={"messages": [{"role": "user", "content": "hi"}]}, timeout=20)
    notes.append(f"chat SSE status={r.status_code} (non-crash required)")
    envs = (await client.get(f"{BASE}/api/images/envs/c1")).json()
    assert isinstance(envs.get("envs"), list)  # ring has no env files; empty is valid
    notes.append(f"images/envs ring: {len(envs.get('envs', []))} rows (env-file free by design)")
    imgs = (await client.get(f"{BASE}/api/images/c1-n0")).json()
    assert len(imgs["images"]) >= 2, imgs
    notes.append(f"images list: {len(imgs['images'])} local/vllm rows")
    probe = (await client.post(f"{BASE}/api/nodes/c1-n1/test")).json()
    notes.append(f"node test: ok={probe['ok']} via={probe.get('used_addr')}")
    return notes


async def test_ws() -> list[str]:
    notes: list[str] = []
    uri = f"ws://127.0.0.1:{PORT}/api/ws"
    async with websockets.connect(uri) as ws:
        hello = json.loads(await ws.recv())
        assert hello["topic"] == "hello", hello
        await ws.send(json.dumps({"op": "sub", "topics": ["nodes", "samples", "service", "ops", "events"]}))
        topics_seen: dict[str, int] = {}
        deadline = time.time() + 14
        while time.time() < deadline:
            try:
                msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
            except TimeoutError:
                break
            topics_seen[msg["topic"]] = topics_seen.get(msg["topic"], 0) + 1
            if topics_seen.get("samples", 0) >= 4 and topics_seen.get("service", 0) >= 1:
                break
        assert topics_seen.get("samples", 0) >= 2, topics_seen
        assert topics_seen.get("service", 0) >= 1, topics_seen
        notes.append(f"ws topics: {topics_seen}")
    return notes


async def run() -> int:
    port = _free_port(PORT)
    base_env = dict(os.environ)
    base_env.update({
        "SPARKDECK_MOCK": "1",
        "SPARKDECK_DATA_DIR": str(ROOT / ".smoketmp"),
        "SPARKDECK_PORT": str(port),
    })
    proc = subprocess.Popen(
        [sys.executable, "-m", "sparkdeck", "serve", "--port", str(port)],
        env=base_env, cwd=str(ROOT / "backend"), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    ok = False
    try:
        async with httpx.AsyncClient() as client:
            await wait_server(client)
            notes = await test_rest(client)
            notes += await test_ws()
            ok = True
    finally:
        try:
            os.killpg(proc.pid, signal.SIGINT)
            proc.wait(10)
            os.killpg(proc.pid, signal.SIGKILL)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass
        import shutil

        shutil.rmtree(ROOT / ".smoketmp", ignore_errors=True)
    for n in notes:
        print("  ✓", n)
    return 0 if ok else 1


def main() -> int:
    import asyncio

    return asyncio.run(run())


if __name__ == "__main__":
    raise SystemExit(main())
