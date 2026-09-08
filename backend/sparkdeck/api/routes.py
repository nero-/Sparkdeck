"""All HTTP + WS routes, attached with closures over the Application object.

Errors: every failure returns {error: {code, message, detail}} via SparkdeckError
and a global exception handler (in app.py).
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from ..bench.runner import BenchArgs, BenchJob
from ..db import now_ms
from ..control.engine import OpContext
from ..models import ChatMsg, ChatRequest, NodeConfig, ProfileDef, ClusterConfig, ClusterControl
from ..ssh.sudo import SUDO
from ..service.vllm import probe_endpoint
from ..telemetry.series import default_catalog
from .hub import Hub


class SparkdeckError(HTTPException):
    def __init__(self, code: str, message: str, status_code: int = 400, detail: dict | None = None) -> None:
        super().__init__(status_code=status_code, detail={"code": code, "message": message,
                                                          "detail": detail or {}})


def attach(app, a) -> None:
    """Register every route onto the FastAPI app with Application `a` bound."""
    r = APIRouter(prefix="/api")

    # ---------------- system ----------------
    @r.get("/system/info")
    async def system_info():
        return a.info()

    @r.get("/system/status")
    async def system_status():
        return a.status()

    @r.post("/system/sudo")
    async def set_sudo(body: dict):
        pw = str(body.get("password") or "")
        if not pw:
            SUDO.clear()
            return {"ok": True, "source": "cleared"}
        SUDO.set_session(pw)
        return {"ok": True, "source": "session"}

    @r.delete("/system/sudo")
    async def clear_sudo():
        SUDO.clear()
        return {"ok": True}

    @r.get("/system/sudo")
    async def sudo_state():
        return {"available": SUDO.available(), "source": SUDO.source()}

    # ---------------- topology (clusters/nodes/profiles) ----------------
    @r.get("/clusters")
    async def clusters():
        return await get_topology_or_mock(a)

    @r.post("/clusters")
    async def create_cluster(body: dict):
        cl = ClusterConfig.model_validate(body)
        import uuid

        cl.id = cl.id or uuid.uuid4().hex[:10] or f"cl-{int(time.time())}"
        data = cl.model_dump()
        await upsert_cluster_db(a, data)
        await a.reload_topology()
        return data

    @r.patch("/clusters/{cluster_id}")
    async def update_cluster(cluster_id: str, body: dict):
        cur = await a.cluster(cluster_id) or {}
        if not cur:
            raise HTTPException(404, "cluster not found")
        merged = apply_patch(cur, body, exclude=("id", "profiles", "nodes"))
        await upsert_cluster_db(a, merged)
        await a.reload_topology()
        return merged

    @r.delete("/clusters/{cluster_id}")
    async def delete_cluster(cluster_id: str):
        from ..settings_store import delete_cluster as del_c

        await del_c(a.db, cluster_id)
        await a.reload_topology()
        return {"ok": True}

    @r.get("/clusters/{cluster_id}/live")
    async def cluster_live(cluster_id: str):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        nodes = []
        for n in cl["nodes"]:
            rt = a.runtime_of(n["id"])
            nodes.append(rt.snapshot() if rt else {"node_id": n["id"], "state": "offline", "collector": "unprobed"})
        service = a.service.get(cluster_id, {})
        rows = await a.db.fetch_all(
            "SELECT * FROM ops WHERE cluster_id=? ORDER BY created DESC LIMIT 8", (cluster_id,))
        ops = [_op_from_row(r) for r in rows]
        return {"cluster_id": cluster_id, "nodes": nodes, "service": service, "recent_ops": ops}

    @r.get("/clusters/{cluster_id}/envfiles")
    async def cluster_envfiles(cluster_id: str, profile_key: str | None = None):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        out = []
        key = profile_key or default_profile_key(cl)
        for n in cl["nodes"]:
            rt = a.runtime_of(n["id"])
            if rt is None or getattr(rt, "state", "offline") != "online":
                out.append({"node_id": n["id"], "node_name": n["name"], "state": "offline", "content": None})
                continue
            v = _verbs(a, cl, n)
            f = v.control["serve_dir"] + "/" + v.env_file(key)
            try:
                res = await rt.exec(f"cat {f}", timeout=15)
                content = res.stdout
            except Exception as exc:
                content = f"!! cat failed: {exc!r}"
            out.append({"node_id": n["id"], "node_name": n["name"], "state": rt.state, "file": f, "content": content})
        return {"profile_key": key, "files": out}

    # ---------------- nodes ----------------
    @r.post("/nodes/{node_id}/test")
    async def node_test(node_id: str):
        n = a.node(node_id)
        if not n:
            raise HTTPException(404, "node not found")
        rt = a.runtime_of(node_id)
        if rt is None:
            return {"ok": False, "used_addr": None, "error": "runtime not running (node disabled?)"}
        snap = rt.probe_summary()
        versions = {}
        if snap.get("state") == "online":
            try:
                from ..control.tp2 import Tp2Verbs

                v = Tp2Verbs({}, n)
                res = await rt.exec(v.systemd_collector_probe(), timeout=15)
                versions = {
                    "python": next((l for l in res.stdout.splitlines() if "Python" in l), None),
                    "docker": "ok" if "docker-ok" in res.stdout else "missing",
                    "nvidia": "ok" if "nvidia-ok" in res.stdout else "missing",
                }
            except Exception as exc:
                versions = {"error": repr(exc)}
        addr_lan = next((ad["host"] for ad in n.get("addresses", []) if ad["kind"] == "lan"), None)
        return {"ok": snap.get("state") == "online", "used_addr": snap.get("addr_used"),
                "attempts": snap.get("attempts", []), "collector": runtime_state_collector(rt),
                "versions": versions, "lan_addr": addr_lan, "unverified": snap.get("unverified", False)}

    @r.patch("/nodes/{node_id}")
    async def node_patch(node_id: str, body: dict):
        from ..settings_store import upsert_node

        cur = a.node(node_id)
        if not cur:
            raise HTTPException(404, "node not found")
        merged = apply_patch(cur, body, exclude=("id", "cluster_id"))
        await upsert_node(a.db, merged)
        await a.reload_topology()
        return merged

    @r.post("/nodes/{node_id}/actions/drop-caches")
    async def node_drop_caches(node_id: str):
        return await _node_op(a, "node.drop_caches", node_id)

    @r.post("/nodes/{node_id}/actions/fix-swappiness")
    async def node_fix_swappiness(node_id: str):
        return await _node_op(a, "node.fix_swappiness", node_id)

    @r.post("/nodes/{node_id}/actions/show-gids")
    async def node_show_gids(node_id: str):
        return await _node_op(a, "node.show_gids", node_id)

    @r.post("/nodes/{node_id}/actions/ping-fabric")
    async def node_ping_fabric(node_id: str, body: dict):
        return await _node_op(a, "node.ping_fabric", node_id, params=body)

    @r.post("/nodes/{node_id}/actions/collector")
    async def node_collector_deploy(node_id: str):
        return await _node_op(a, "collector.deploy", node_id)

    # ---------------- metrics ----------------
    @r.get("/metrics/catalog")
    async def metrics_catalog():
        static_list = default_catalog()
        # dynamic series observed in live rings (net ifaces, docker ctrs, temp zones, per-core)
        seen: set[str] = set()
        for node_rings in a.series.rings.values():
            seen.update(node_rings.keys())
        dynamic: list[dict] = []
        for name in sorted(seen):
            if not any(name.startswith(p) for p in ("net.", "docker.", "temp.zone.", "cpu.core.")):
                continue
            if any(s.id == name for s in static_list):
                continue
            group = name.split(".")[0]
            if name.endswith("rx_kbps") or name.endswith("tx_kbps"):
                unit = "kbit/s"
            elif group == "cpu":
                unit = "%"
            elif name.endswith("mem_gib"):
                unit = "GiB"
            elif group == "temp":
                unit = "C"
            else:
                unit = "?"
            dynamic.append({"id": name, "unit": unit, "kind": "gauge",
                            "label": name.replace(".", " · "), "group": group,
                            "cluster_scoped": False})
        return {"series": [s.model_dump() for s in static_list] + dynamic}

    @r.get("/metrics/history")
    async def metrics_history(node_id: str | None = None, cluster_id: str | None = None,
                              names: str = "gpu.util,mem.used_gib", window: str = "10m",
                              from_ms: int | None = None, to_ms: int | None = None,
                              max_points: int = 700):
        ids = _resolve_nodes(a, node_id, cluster_id)
        if not ids:
            return {"from": 0, "to": 0, "series": {}}
        name_list = [n_ for n_ in names.split(",") if n_]
        w = _window_s(window)
        res = await a.series.query(ids, name_list, window_s=w,
                                   from_ms=from_ms or 0, to_ms=to_ms or 0,
                                   max_points=int(max_points), reduce="avg")
        res["resolution_note"] = u"raw" if w <= 3600 else u"mixed" if w <= 6 * 3600 * 12 else u"rollup"
        res["window"] = window
        return res

    # ---------------- ops / events ----------------
    @r.get("/ops")
    async def ops(limit: int = 30, kind: str | None = None, cluster_id: str | None = None):
        q = "SELECT * FROM ops WHERE 1=1"
        args: list = []
        if kind:
            q += " AND kind=?"
            args.append(kind)
        if cluster_id:
            q += " AND cluster_id=?"
            args.append(cluster_id)
        q += " ORDER BY created DESC LIMIT ?"
        args.append(int(limit))
        rows = await a.db.fetch_all(q, tuple(args))
        return [_op_from_row(r) for r in rows]

    @r.get("/ops/{op_id}")
    async def op_by_id(op_id: str):
        for op in a.engine._ops.values() if a.engine else []:
            if op.id == op_id:
                return op.model_dump()
        row = await a.db.fetch_one("SELECT * FROM ops WHERE id=?", (op_id,))
        if not row:
            raise HTTPException(404, "op not found")
        return _op_from_row(row)

    @r.post("/ops/{op_id}/cancel")
    async def op_cancel(op_id: str):
        ok = await (a.engine.cancel(op_id) if a.engine else asyncio.sleep(0, result=False))
        return {"ok": bool(ok)}

    @r.get("/events")
    async def events(limit: int = 200, level: str | None = None, kind: str | None = None,
                     cluster_id: str | None = None, since: int = 0, unacked_only: bool = False):
        return await a.alerts.history(limit=limit, level=level, kind=kind,
                                      cluster_id=cluster_id, since=int(since), unacked_only=unacked_only)

    @r.post("/events/ack")
    async def events_ack(body: dict):
        ids = body.get("ids")
        all_flag = body.get("all")
        if all_flag:
            await a.db.execute("UPDATE events SET acked=1 WHERE acked=0")
            ids_acked: object = "all"
            rows = await a.db.fetch_all("SELECT COUNT(*) AS n FROM events WHERE acked=1")
            count = int(rows[0]["n"]) if rows else 0
        else:
            for i in ids or []:
                await a.db.execute("UPDATE events SET acked=1 WHERE id=?", (i,))
            ids_acked = list(ids or [])
            count = len(ids_acked)
        # cross-tab sync: every subscriber to `events` learns the ack state
        await a.hub.publish("events", {"__ack": ids_acked})
        return {"ok": True, "count": count}

    # ---------------- cluster control actions ----------------
    @r.post("/clusters/{cluster_id}/actions/start")
    async def cluster_start(cluster_id: str, body: dict):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        ctx = a.make_ctx(cl)
        profile_key = body.get("profile_key") or ""
        if not profile_key_valid(cl, profile_key):
            raise HTTPException(400, f"unknown profile {profile_key}")
        params = {
            "health_timeout_s": body.get("health_timeout_s"),
            "skip_preflight": body.get("skip_preflight", False),
            "extra": body.get("extra"),
        }
        op = a.engine.submit("cluster.start", ctx, profile_key=profile_key, params=params)
        return {"op_id": op.id}

    @r.post("/clusters/{cluster_id}/actions/stop")
    async def cluster_stop(cluster_id: str, body: dict):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        ctx = a.make_ctx(cl)
        op = a.engine.submit("cluster.stop", ctx, params={"force": body.get("force")})
        return {"op_id": op.id}

    @r.post("/clusters/{cluster_id}/actions/preflight")
    async def cluster_preflight(cluster_id: str):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        return {"op_id": a.engine.submit("cluster.preflight", a.make_ctx(cl)).id}

    @r.post("/clusters/{cluster_id}/actions/check")
    async def cluster_check(cluster_id: str, body: dict):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        return {"op_id": a.engine.submit("cluster.check", a.make_ctx(cl),
                                         profile_key=body.get("profile_key")).id}

    @r.post("/clusters/{cluster_id}/actions/verify")
    async def cluster_verify(cluster_id: str, body: dict):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        key = body.get("profile_key") or default_profile_key(cl)
        return {"op_id": a.engine.submit("cluster.verify", a.make_ctx(cl), profile_key=key).id}

    # ---------------- llm ----------------
    @r.get("/llm/{cluster_id}/state")
    async def llm_state(cluster_id: str):
        st = a.service.get(cluster_id) or {"cluster_id": cluster_id, "health": "down"}
        return st

    @r.get("/llm/{cluster_id}/requests")
    async def llm_requests(cluster_id: str, limit: int = 50):
        return a.chat.history_list(cluster_id, limit)

    @r.post("/llm/{cluster_id}/chat")
    async def llm_chat(cluster_id: str, body: ChatRequest):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        head = next((n for n in cl["nodes"] if n["id"] == cl["control"]["head_node_id"]), None)
        addr = _head_addr(a, cl) or (head and head.get("addresses", [{}])[0].get("host")) or "127.0.0.1"
        async def gen():
            async for piece in a.chat.stream_chat(cl, {n["id"]: n for n in cl["nodes"]}, addr, body):
                if "choice" in piece:
                    yield f"data: {json.dumps(piece['choice'], separators=(',',':'))}\n\n"
                elif "stats" in piece:
                    yield f"data: {json.dumps(piece['stats'], separators=(',',':'))}\n\n"
                elif "error" in piece:
                    yield f"data: {json.dumps({'__error': piece['error']}, separators=(',',':'))}\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(gen(), media_type="text/event-stream")

    # ---------------- logs ----------------
    @r.get("/logs/containers/{node_id}")
    async def log_containers(node_id: str):
        n = a.node(node_id)
        if not n:
            raise HTTPException(404, "node not found")
        rt = a.runtime_of(node_id)
        if rt is None or getattr(rt, "state", "offline") != "online":
            return {"containers": [], "state": "offline"}
        res = await rt.exec("docker ps -a --format '{{json .}}' --filter name=glm53 2>&1", timeout=15)
        rows = []
        for line in res.stdout.splitlines():
            line = line.strip()
            if line.startswith("{"):
                try:
                    js = json.loads(line)
                    rows.append({"id": js.get("ID") or js.get("Id") or "", "name": js.get("Names") or js.get("Name") or "",
                                 "image": js.get("Image"), "state": js.get("State"), "status": js.get("Status"),
                                 "created": js.get("CreatedAt")})
                except Exception:
                    pass
        return {"containers": rows, "state": rt.state}

    @r.get("/logs/stream")
    async def logs_stream(node_id: str, container: str, lines: int = 200):
        n = a.node(node_id)
        rt = a.runtime_of(node_id)
        if not n or rt is None:
            raise HTTPException(404, "node/runtime missing")
        cmd = f"docker logs -f --tail {int(lines)} {container} 2>&1"
        lines_q: list[str] = []

        def on_line(l: str) -> None:
            if len(lines_q) < 500:
                lines_q.append(l)

        async def gen():
            try:
                task = asyncio.create_task(rt.stream_exec(cmd, timeout=14400, on_line=on_line))
            except Exception as exc:
                yield "data: " + json.dumps({"key": f"{node_id}:{container}", "node_id": node_id,
                                             "container": container, "lines": [f"!! stream unavailable: {exc!r}"],
                                             "eof": True}) + "\n\n"
                return
            try:
                while True:
                    if lines_q:
                        l = lines_q.pop(0)
                        yield "data: " + json.dumps({"key": f"{node_id}:{container}", "node_id": node_id,
                                                     "container": container, "lines": [l]}) + "\n\n"
                    else:
                        await asyncio.sleep(0.15)
            except (asyncio.CancelledError, GeneratorExit):
                task.cancel()
                raise
        return StreamingResponse(gen(), media_type="text/event-stream")

    # ---------------- images ----------------
    @r.get("/images/{node_id}")
    async def images_for(node_id: str):
        n = a.node(node_id)
        rt = a.runtime_of(node_id)
        if not n or rt is None or getattr(rt, "state", "offline") != "online":
            return {"images": [], "state": "offline"}
        from ..settings_store import get_app_settings

        glob = (await get_app_settings(a.db)).images.filter_glob
        res = await rt.exec(f"docker images --format '{{{{json .}}}}' --filter reference={glob!r} 2>&1", timeout=20)
        rows = []
        for line in res.stdout.splitlines():
            if line.strip().startswith("{"):
                try:
                    js = json.loads(line)
                    rows.append({"node_id": node_id, "repo_tag": f"{js.get('Repository')}:{js.get('Tag')}",
                                 "image_id": js.get("ID"), "created_label": js.get("CreatedSince"),
                                 "size_mb": _size_mb(js.get("Size"))})
                except Exception:
                    pass
        return {"images": rows, "state": rt.state}

    @r.get("/images/envs/{cluster_id}")
    async def images_env(cluster_id: str):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        rows = []
        for p in cl["profiles"]:
            per_cluster = []
            for n in cl["nodes"]:
                rt = a.runtime_of(n["id"])
                if rt is None or getattr(rt, "state", "offline") != "online":
                    per_cluster.append({"node_id": n["id"], "node_name": n["name"], "file": None, "image": None})
                    continue
                v = _verbs(a, cl, n)
                res = await rt.exec(v.env_grep_image(p["key"]), timeout=15)
                per_cluster.append({"node_id": n["id"], "node_name": n["name"],
                                    "file": v.env_file(p["key"]), "image": res.stdout.strip() or None})
            rows.append({"profile_key": p["key"], "clusters": per_cluster})
        return {"envs": rows}

    @r.get("/images/deploys/preview")
    async def image_set_preview(cluster_id: str, profile_key: str, image: str):
        cl = a.cluster(cluster_id)
        if not cl:
            raise HTTPException(404, "cluster not found")
        out = []
        for n in cl["nodes"]:
            v = _verbs(a, cl, n)
            f = v.control["serve_dir"] + "/" + v.env_file(profile_key)
            rt = a.runtime_of(n["id"])
            old = None
            if rt is not None and getattr(rt, "state", "offline") == "online":
                res = await rt.exec(f"grep -E '^SERVING_IMAGE=' {f} | cut -d= -f2- || true", timeout=15)
                old = res.stdout.strip() or None
            out.append({"node_id": n["id"], "node_name": n["name"], "file": f, "old": old, "new": image})
        return {"rows": out}

    @r.post("/images/deploys")
    async def image_set(body: dict):
        cl = a.cluster(body["cluster_id"])
        if not cl:
            raise HTTPException(404, "cluster not found")
        ctx = a.make_ctx(cl)
        op = a.engine.submit("image.set_serving", ctx, profile_key=body.get("profile_key"),
                             params={"image": body.get("image")})
        return {"op_id": op.id}

    @r.post("/images/copies")
    async def image_copy(body: dict):
        cl = a.cluster(body["cluster_id"])
        if not cl:
            raise HTTPException(404, "cluster not found")
        ctx = a.make_ctx(cl)
        op = a.engine.submit("image.copy", ctx, node_id=body.get("src_node_id"),
                             params={"dst_node_id": body.get("dst_node_id"), "image": body.get("image")})
        return {"op_id": op.id}

    @r.get("/images/builds/{node_id}")
    async def builds_list(node_id: str):
        n = a.node(node_id)
        rt = a.runtime_of(node_id)
        if not n or rt is None or getattr(rt, "state", "offline") != "online":
            return {"files": [], "state": "offline"}
        cl = a.cluster(n["cluster_id"])
        from ..control.engine import v_builder_dir

        res = await rt.exec(f"ls {v_builder_dir(cl)}/*.env 2>/dev/null", timeout=15)
        return {"files": [{"file": Path(p).name, "label": Path(p).stem}
                          for p in res.stdout.strip().splitlines() if p.endswith(".env")], "state": rt.state}

    @r.post("/images/builds")
    async def builds_run(body: dict):
        cl = a.cluster(body["cluster_id"])
        if not cl:
            raise HTTPException(404, "cluster not found")
        ctx = a.make_ctx(cl)
        op = a.engine.submit("image.build", ctx, node_id=body.get("node_id"),
                             params={"file": body.get("file")})
        return {"op_id": op.id}

    # ---------------- bench ----------------
    @r.get("/bench/config")
    async def bench_config():
        st = await a.bench.status()
        s = a.settings_ref.settings
        return {**st, "defaults": s.bench.defaults.model_dump(), "write_repo_runs": s.bench.write_repo_runs}

    @r.patch("/bench/config")
    async def bench_config_patch(body: dict):
        bench_patch = {"bench": body}
        await a.patch_settings(bench_patch)
        st = await a.bench.status()
        s = a.settings_ref.settings
        return {**st, "defaults": s.bench.defaults.model_dump(), "write_repo_runs": s.bench.write_repo_runs}

    @r.post("/bench/bootstrap-venv")
    async def bench_bootstrap():
        return await a.bench.bootstrap_venv()

    @r.post("/bench/jobs")
    async def bench_jobs_post(body: dict):
        cl = a.cluster(body["cluster_id"])
        if not cl:
            raise HTTPException(404, "cluster not found")
        s = a.settings_ref.settings
        defaults = s.bench.defaults
        merged_args = {**defaults.args.model_dump(), **(body.get("args") or {})}
        args = BenchArgs.model_validate(merged_args)
        host = body.get("host") or _head_addr(a, cl) or ""
        if not host:
            raise HTTPException(400, "no reachable host; set an address for the head node first")
        job = BenchJob(
            cluster_id=cl["id"], profile_key=body.get("profile_key"),
            label=body.get("label") or defaults.label or "run",
            host=host, port=int(body.get("port") or 8000),
            model=body.get("model") or (cl["profiles"][0]["served_model_name"] if cl["profiles"] else ""),
            args=args, created=now_ms(),
        )
        if not a.cfg.mock and (not a.bench.tool_path() or not a.bench.venv_python()):
            raise HTTPException(400, "bench tool/venv not configured — check Settings → Bench")
        import uuid

        job.id = uuid.uuid4().hex[:10]
        argv = a.bench._argv(job)
        await a.bench._persist(job)
        asyncio.get_running_loop().create_task(a.bench.submit(job, argv))
        return {"job_id": job.id, "argv": argv}

    @r.get("/bench/jobs")
    async def bench_jobs_list(limit: int = 40):
        return [j.model_dump() for j in await a.bench.list(limit)]

    @r.get("/bench/jobs/{job_id}")
    async def bench_job(job_id: str, tail: int | None = None):
        job = await a.bench.get(job_id)
        if not job:
            raise HTTPException(404, "job not found")
        out = job.model_dump()
        if tail is not None:
            out["log_tail"] = (await a.bench.tail(job_id, tail))[-tail:]
        return out

    @r.post("/bench/jobs/{job_id}/cancel")
    async def bench_cancel(job_id: str):
        ok = await a.bench.cancel(job_id)
        if not ok:
            raise HTTPException(400, "job not running")
        return {"ok": True}

    @r.get("/bench/jobs/{job_id}/result")
    async def bench_result(job_id: str):
        raw = await a.bench.raw_result(job_id)
        return raw or {}

    @r.post("/bench/jobs/{job_id}/report")
    async def bench_report(job_id: str):
        return await a.bench.write_report(job_id)

    @r.get("/bench/history")
    async def bench_history(limit: int = 60):
        mine = [{"job_id": j.id, "source": "sparkdeck", "path": j.result_path,
                 "label": j.label, "ts": j.finished or j.created, "summary": j.summary}
                for j in await a.bench.list(limit) if j.summary]
        repo = await a.bench.repo_history(limit)
        rows = mine + repo
        rows.sort(key=lambda x: (x["ts"] or 0), reverse=True)
        return rows[:limit]

    # app settings
    @r.get("/settings")
    async def settings_get():
        return a.settings_ref.settings.model_dump()

    @r.patch("/settings")
    async def settings_patch(body: dict):
        await a.patch_settings(body)
        return a.settings_ref.settings.model_dump()

    @r.get("/settings/export")
    async def settings_export():
        tops = await get_topology_or_mock(a)
        return {"topology": tops, "settings": a.settings_ref.settings.model_dump()}

    @r.post("/settings/import")
    async def settings_import(body: dict):
        """Bulk restore: upsert clusters/nodes/profiles from an export payload
        and patch app settings. Adds/updates by id; never deletes silently."""
        from ..settings_store import upsert_cluster, upsert_node, upsert_profile

        tops = body.get("topology") or []
        imported = 0
        for cl in tops:
            cl_data = {k: cl[k] for k in ("id", "name", "kind", "accent_color", "notes", "control")}
            await upsert_cluster(a.db, cl_data)
            for node in cl.get("nodes", []):
                await upsert_node(a.db, node)
            for prof in cl.get("profiles", []) + cl.get("_profiles_extra", []):
                await upsert_profile(a.db, prof)
            imported += 1
        if body.get("settings"):
            await a.patch_settings(body["settings"])
        await a.hub.publish("service", {"cluster_id": None, "note": "topology imported", "n": imported})
        return {"ok": True, "clusters": imported}

    app.include_router(r)

    # ---------------- websocket ----------------
    @app.websocket("/api/ws")
    async def ws_endpoint(ws: WebSocket):
        token = a.cfg.token
        if token:
            auth = ws.headers.get("authorization") or ws.query_params.get("token") or ""
            if f"Bearer {token}" != auth and auth != token:
                await ws.close(code=4401)
                return
        await ws.accept()
        await a.hub.attach(ws)
        try:
            while True:
                msg = await ws.receive_text()
                try:
                    data = json.loads(msg)
                except Exception:
                    continue
                op = data.get("op")
                topics = set(data.get("topics") or [])
                if op == "sub" and topics:
                    a.hub.subscribe(ws, topics)
                elif op == "unsub" and topics:
                    a.hub.unsubscribe(ws, topics)
        except WebSocketDisconnect:
            pass
        finally:
            await a.hub.detach(ws)


# ---------------- helpers ---------------------------------------------------

async def get_topology_or_mock(a):
    return list(a.topology)


def apply_patch(cur: dict, patch: dict, exclude: tuple = ()) -> dict:
    out = dict(cur)
    for k, v in patch.items():
        if k in exclude:
            continue
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
        else:
            out[k] = v
    return out


async def upsert_cluster_db(a, data: dict) -> None:
    from ..settings_store import upsert_cluster

    data.setdefault("id", f"cl-{int(time.time())}")
    await upsert_cluster(a.db, data)


def _verbs(a, cl: dict, node: dict):
    from ..control.tp2 import Tp2Verbs

    return Tp2Verbs(cl["control"], node)


def default_profile_key(cl: dict) -> str:
    profiles = cl.get("profiles") or []
    for p in profiles:
        if p.get("key") == "mtp3-spark":
            return p["key"]
    return profiles[0]["key"] if profiles else "mtp3-spark"


def profile_key_valid(cl: dict, key: str) -> bool:
    return any(p["key"] == key for p in (cl.get("profiles") or []))


def runtime_state_collector(rt) -> str:
    return getattr(rt, "collector_state", "unprobed")


def _head_addr(a, cl: dict) -> str | None:
    head = next((n for n in cl["nodes"] if n["id"] == cl["control"]["head_node_id"]), None)
    if not head:
        return None
    addrs = head.get("addresses") or []
    lan = next((x["host"] for x in addrs if x.get("kind") == "lan"), None)
    return lan or (addrs[0].get("host") if addrs else None)


def _size_mb(s: str | None) -> float | None:
    if not s:
        return None
    try:
        num, unit = s.split()
        num = float(num)
        return round(num * {"kB": 1e-3, "KB": 1e-3, "MB": 1.0, "GB": 1e3, "TB": 1e6,
                            "KiB": 1 / 1024, "MiB": 1.0, "GiB": 1024, "TiB": 1024 * 1024}[unit], 1)
    except Exception:
        return None


def _window_s(w: str) -> int:
    try:
        if w.endswith("m"):
            return int(float(w[:-1]) * 60)
        if w.endswith("h"):
            return int(float(w[:-1]) * 3600)
        if w.endswith("d"):
            return int(float(w[:-1]) * 86400)
        return int(w)
    except Exception:
        return 600


def _resolve_nodes(a, node_id: str | None, cluster_id: str | None) -> list[str]:
    if node_id:
        return [node_id]
    if cluster_id:
        return [n["id"] for n in a.nodes_in(cluster_id)]
    return []


async def _node_op(a, kind: str, node_id: str, params: dict | None = None):
    n = a.node(node_id)
    if not n:
        raise HTTPException(404, "node not found")
    cl = a.cluster(n["cluster_id"])
    ctx = a.make_ctx(cl)
    op = a.engine.submit(kind, ctx, node_id=node_id, params=params or {})
    return {"op_id": op.id}


def _op_from_row(r) -> dict:
    import json as _json

    return {
        "id": r["id"], "kind": r["kind"], "cluster_id": r["cluster_id"],
        "profile_key": r["profile_key"], "node_id": r["node_id"], "state": r["state"],
        "created": r["created"], "started": r["started"], "finished": r["finished"],
        "exit": r["exit"], "message": r["message"],
        "steps": _json.loads(r["steps"] or "[]"),
        "log_tail": _json.loads(r["log_tail"] or "[]"),
        "params": _json.loads(r["params"] or "{}"),
    }
