"""Operation engine: every state-changing act is a persisted, streamed,
cancellable OpRecord with step-by-step progress.

Op kinds implemented here (tp2 semantics — the pairctl port):
  cluster.start    preflight → GID check/fix → teardown → worker-first start
                   → health wait → verify markers → kv marker capture
  cluster.stop     head then worker `--down` + container-state confirmation
  cluster.preflight / cluster.check / cluster.verify
  node.drop_caches / node.fix_swappiness / node.show_gids / node.ping_fabric /
  node.tailscale_status / node.test / collector.deploy
  image.set_serving / image.copy / image.build

The engine is transport-agnostic: runtimes implement exec/stream (+sudo).
"""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable, Callable

from ..db import DB, jdumps, jloads, now_ms
from ..models import OpRecord, OpStep
from ..ssh.pool import ExecResult, NodeUnreachable
from ..ssh.sudo import NoSudo, SUDO, sudo_run
from .sparkring import SparkringVerbs, extract_receipt_path, parse_liveness
from .tp2 import Tp2Verbs, gid_check_script

Notify = Callable[[OpRecord, list[tuple[str, str]]], None]  # (record, appended log lines)


class OpContext:
    """Everything a verb needs: settings, runtimes, events, kv capture."""

    def __init__(self, *, cluster: dict, nodes: dict[str, dict],
                 runtime_of: Callable[[str], Any], alert_engine, hub,
                 console_runtime: Any | None = None) -> None:
        self.cluster = cluster
        self.nodes = nodes  # id → node dict
        self.runtime_of = runtime_of
        self.alerts = alert_engine
        self.hub = hub
        self.console_runtime = console_runtime  # LocalRuntime / mock console


class OperationError(Exception):
    def __init__(self, message: str, fatal: bool = True) -> None:
        super().__init__(message)
        self.fatal = fatal


class OpEngine:
    MAX_TAIL = 500

    def __init__(self, db: DB, hub) -> None:
        self.db = db
        self.hub = hub
        self._running: dict[str, asyncio.Task] = {}
        self._ops: dict[str, OpRecord] = {}
        self._coalesce: dict[str, list[tuple[str, str]]] = {}
        self._last_push: float = 0.0

    # ---------------- lookups ----------------
    def head_node(self, ctx: OpContext) -> dict:
        nid = ctx.cluster["control"].get("head_node_id")
        n = ctx.nodes.get(nid or "")
        if not n:
            raise OperationError("cluster has no head node configured")
        return n

    def worker_node(self, ctx: OpContext) -> dict:
        nid = ctx.cluster["control"].get("worker_node_id")
        n = ctx.nodes.get(nid or "") or next((v for v in ctx.nodes.values() if v["role"] == "worker"), None)
        if not n:
            raise OperationError("cluster has no worker node configured")
        return n

    def runtime(self, ctx: OpContext, node: dict):
        rt = ctx.runtime_of(node["id"])
        if rt is None or getattr(rt, "state", "offline") != "online":
            raise OperationError(f"node {node['name']} is not connected")
        return rt

    def verbs_for(self, ctx: OpContext, node: dict) -> Tp2Verbs:
        return Tp2Verbs(ctx.cluster["control"], node)

    def ring(self, ctx: OpContext) -> SparkringVerbs | None:
        launcher = (ctx.cluster.get("control") or {}).get("launcher") or ""
        return SparkringVerbs(ctx.cluster["control"]) if "sparkring" in launcher.lower() else None

    def console_rt(self, ctx: OpContext):
        rt = getattr(ctx, "console_runtime", None)
        if rt is None:
            raise OperationError("cluster console runtime is not available")
        return rt

    def profile(self, ctx: OpContext, profile_key: str | None) -> dict | None:
        if not profile_key:
            return None
        for p in ctx.cluster["profiles"]:
            if p["key"] == profile_key:
                return p
        raise OperationError(f"unknown profile {profile_key!r}")

    # ---------------- submit / persist ----------------
    def submit(self, kind: str, ctx: OpContext, profile_key: str | None = None,
               node_id: str | None = None, params: dict | None = None) -> OpRecord:
        op = OpRecord(kind=kind, cluster_id=ctx.cluster["id"], profile_key=profile_key,
                      node_id=node_id, state="queued", created=now_ms(),
                      params=params or {})
        self._ops[op.id] = op
        asyncio.get_running_loop().create_task(self._persist(op))
        task = asyncio.get_running_loop().create_task(self._run(op, ctx))
        self._running[op.id] = task
        task.add_done_callback(lambda _t: self._running.pop(op.id, None))
        self.hub.publish_ops(op)
        return op

    def get(self, op_id: str) -> OpRecord | None:
        return self._ops.get(op_id) or self._load(op_id)

    def _load(self, op_id: str) -> OpRecord | None:
        return None  # loaded lazily by api (query in api file)

    async def _persist(self, op: OpRecord) -> None:
        await self.db.execute(
            "INSERT OR REPLACE INTO ops(id,kind,cluster_id,profile_key,node_id,state,created,"
            "started,finished,exit,message,steps,log_tail,params)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (op.id, op.kind, op.cluster_id, op.profile_key, op.node_id, op.state, op.created,
             op.started, op.finished, op.exit, op.message, jdumps([s.model_dump() for s in op.steps]),
             jdumps(op.log_tail[-self.MAX_TAIL:]), jdumps(op.params)),
        )

    # ---------------- streaming helpers ----------------
    def livestep_line(self, op: OpRecord, line: str) -> None:
        if not line:
            return
        if len(op.log_tail) >= self.MAX_TAIL:
            op.log_tail = op.log_tail[-(self.MAX_TAIL - 50):]
        op.log_tail.append(line)
        t = time.time()
        if t - self._last_push > 0.20:
            self._last_push = t
            self.hub.publish_ops(op)

    async def stream_into(self, op: OpRecord, runtime, cmd: str, timeout: float = 600) -> int:
        proc_holder = {}

        async def reader():
            pass

        # runtime-level streaming with a lock to keep ordering
        return await runtime.stream_exec(cmd, timeout=timeout, on_line=lambda l: self.livestep_line(op, l))

    def step(self, op: OpRecord, idx: int, state: str, detail: str | None = None) -> None:
        if 0 <= idx < len(op.steps):
            op.steps[idx].state = state  # type: ignore[assignment]
            op.steps[idx].detail = detail
        self.hub.publish_ops(op)

    # ---------------- runner ----------------
    async def _run(self, op: OpRecord, ctx: OpContext | None) -> None:
        try:
            op.state = "running"
            op.started = now_ms()
            handler = getattr(self, f"_op_{op.kind.replace('.', '_')}", None)
            if handler is None:
                raise OperationError(f"no handler for op kind {op.kind}")
            await handler(op, ctx or self.empty_ctx(op))
            op.state = "ok" if op.state == "running" else op.state
            op.exit = 0 if op.state == "ok" else op.exit
        except OperationError as exc:
            op.state = "error"
            op.message = str(exc)
        except NoSudo as exc:
            op.state = "error"
            op.message = f"sudo password required for: {exc}"
        except asyncio.CancelledError:
            op.state = "cancelled"
            raise
        except NodeUnreachable as exc:
            op.state = "error"
            op.message = f"node unreachable: {exc}"
        except Exception as exc:  # noqa: BLE001
            op.state = "error"
            op.message = f"{type(exc).__name__}: {exc}"
        finally:
            op.finished = now_ms()
            self.hub.publish_ops(op)
            await self._persist(op)
            # prune the in-memory registry (DB keeps the history)
            if len(self._ops) > 60:
                by_age = sorted(self._ops.values(), key=lambda o: o.created, reverse=True)
                for old in by_age[60:]:
                    self._ops.pop(old.id, None)
                self._ops = {o.id: o for o in by_age[:60]}
            if ctx is not None and ctx.alerts is not None:
                level = "error" if op.state == "error" else "info"
                if op.state in ("ok", "error"):
                    await ctx.alerts.record(
                        None, op.cluster_id, level, f"op.{op.state}",
                        f"{op.kind} {op.state}" + (f": {op.message}" if op.message else ""))

    def empty_ctx(self, op: OpRecord) -> OpContext:
        raise OperationError("missing context")

    async def cancel(self, op_id: str) -> bool:
        task = self._running.get(op_id)
        if task and not task.done():
            task.cancel()
            return True
        return False

    # ================== verbs ==================
    async def _sudo_exec(self, op: OpRecord, runtime, node: dict, cmd: str, timeout=60) -> ExecResult:
        rt = runtime
        if hasattr(rt, "sudo_exec"):  # mock runtimes too
            return await rt.sudo_exec(cmd, timeout=timeout)
        pw = SUDO.current()
        if pw is None and not SUDO.available():
            pw = None
        try:
            return await sudo_run(rt.conn, cmd, password=SUDO.current(), timeout=timeout)
        except NoSudo:
            self.livestep_line(op, f"!! sudo password needed for: {cmd[:80]}")
            raise OperationError("sudo password required (set it in the app top bar)", fatal=True)

    async def _run_on(self, op: OpRecord, runtime, cmd: str, timeout: float = 120) -> ExecResult:
        return await runtime.exec(cmd, timeout=timeout)

    # -- cluster.start --
    async def _op_cluster_start(self, op: OpRecord, ctx: OpContext) -> None:
        ring = self.ring(ctx)
        if ring is not None:
            await self._op_cluster_start_ring(op, ctx, ring)
            return
        params = op.params
        profile_key = op.profile_key or ""
        self.profile(ctx, profile_key)
        control = ctx.cluster["control"]
        head, worker = self.head_node(ctx), self.worker_node(ctx)
        extra = params.get("extra") or control.get("start_extra") or ""
        timeout_s = int(params.get("health_timeout_s") or control.get("health_timeout_s") or 720)
        skip_preflight = bool(params.get("skip_preflight"))
        op.steps = [OpStep(name=n) for n in ("probe nodes", "preflight worker", "preflight head",
                                             "GID check", "teardown stale", "start worker",
                                             "start head", "health wait", "verify", "capture KV")]
        rt_w = self.runtime(ctx, worker)
        rt_h = self.runtime(ctx, head)
        vw, vh = self.verbs_for(ctx, worker), self.verbs_for(ctx, head)
        self.livestep_line(op, f"start profile={profile_key} worker={worker['name']} head={head['name']} extra={extra!r}")

        # 1 probe
        self.step(op, 0, "running")
        for rt, node in ((rt_w, worker), (rt_h, head)):
            res = await self._run_on(op, rt, vw.systemd_collector_probe())
            if "nvidia-missing" in res.stdout:
                self.livestep_line(op, f"!! {node['name']}: nvidia-smi missing")
        self.step(op, 0, "ok")

        # 2-3 preflight (worker first, then head — parity with pairctl)
        if not skip_preflight:
            for idx, rt, node, v in ((1, rt_w, worker, vw), (2, rt_h, head, vh)):
                self.step(op, idx, "running")
                sw = await self._run_on(op, rt, v.preflight_swappiness_check())
                sw_val = (sw.stdout.strip() or "60")
                self.livestep_line(op, f"{node['name']}: swappiness={sw_val}")
                if sw_val not in ("0",):
                    try:
                        res = await self._sudo_exec(op, rt, node, v.preflight_swappiness_fix())
                        if res.exit != 0:
                            self.livestep_line(op, f"!! swappiness fix failed on {node['name']}: {res.stderr.strip()[:120]}")
                        else:
                            self.livestep_line(op, f"{node['name']}: swappiness -> 0")
                    except NoSudo:
                        self.step(op, idx, "error", detail="sudo needed")
                        continue
                try:
                    res = await self._sudo_exec(op, rt, node, v.preflight_drop_caches())
                    self.livestep_line(op, f"{node['name']}: page cache dropped" if res.exit == 0
                                       else f"!! drop_caches failed on {node['name']}")
                except NoSudo:
                    self.livestep_line(op, f"!! no sudo: drop_caches skipped on {node['name']}")
                self.step(op, idx, "ok")
        else:
            self.step(op, 1, "skipped", detail="skip_preflight")
            self.step(op, 2, "skipped", detail="skip_preflight")

        # 4 gid check + autofix
        self.step(op, 3, "running")
        for rt, node in ((rt_w, worker), (rt_h, head)):
            v = self.verbs_for(ctx, node)
            script = gid_check_script(control["serve_dir"], v.env_file(profile_key))
            try:
                res = await self._run_on(op, rt, script, timeout=30)
            except Exception as exc:
                self.step(op, 3, "error", detail=str(exc)[:120])
                raise OperationError(f"GID check failed on {node['name']}: {exc}")
            self.livestep_line(op, f"{node['name']}: {res.stdout.strip()}")
            if "SPARKDECK-GID: ERROR" in res.stdout:
                self.step(op, 3, "error", detail=res.stdout.strip())
                raise OperationError(f"GID check failed on {node['name']} (see log)")
        self.step(op, 3, "ok")

        # 5 teardown stale
        self.step(op, 4, "running")
        for rt, node in ((rt_w, worker), (rt_h, head)):
            res = await self._run_on(op, rt, self.verbs_for(ctx, node).down(None), timeout=90)
            self.livestep_line(op, f"{node['name']} teardown: rc={res.exit}")
        self.step(op, 4, "ok")

        # 6/7 start sandbox order: worker then head
        started = None
        for idx, rt, node, v in ((5, rt_w, worker, vw), (6, rt_h, head, vh)):
            self.step(op, idx, "running")
            self.livestep_line(op, f"starting {node['name']} ({node['role']} rank {node.get('env_rank')})")
            res = await self._run_on(op, rt, v.run_worker(profile_key, extra) if node["role"] == "worker"
                                     else v.run_head(profile_key, extra), timeout=240)
            self.livestep_line(op, f"{node['name']} launch rc={res.exit}")
            for ln in res.stdout.strip().splitlines()[-6:]:
                self.livestep_line(op, ln)
            if res.exit != 0:
                self.step(op, idx, "error", detail=res.stderr.strip()[:200] or res.stdout[-200:])
                raise OperationError(f"{node['name']} failed to start (rc={res.exit}); see log")
            self.step(op, idx, "ok")
            if node["role"] == "worker":
                started = True
                await asyncio.sleep(5)

        # 8 health wait
        self.step(op, 7, "running")
        t0 = time.time()
        deadline = t0 + timeout_s
        self.livestep_line(op, f"waiting for API health (up to {timeout_s}s)…")
        while time.time() < deadline:
            if op.state == "cancelled":
                raise OperationError("cancelled", fatal=False)
            code = await self._run_on(op, rt_h, vh.health_poll(), timeout=15)
            if code.stdout.strip() == "0":
                self.livestep_line(op, f"API healthy after {int(time.time()-t0)}s")
                break
            await asyncio.sleep(5)
        else:
            self.step(op, 7, "error", detail=f"timeout after {timeout_s}s")
            raise OperationError(f"API did not become healthy within {timeout_s}s; check logs 0/1")
        self.step(op, 7, "ok")

        # 9 verify
        self.step(op, 8, "running")
        ver = await self._run_on(op, rt_h, vh.verify(profile_key), timeout=60)
        self.livestep_line(op, ver.stdout.strip()[:400])
        self.step(op, 8, "ok" if ver.exit in (0, None) else "error")

        # 10 kv marker capture
        self.step(op, 9, "running")
        kv = await self._run_on(op, rt_h, vh.kv_marker(), timeout=20)
        kv_tokens = None
        try:
            kv_tokens = int(kv.stdout.strip().replace(",", ""))
        except Exception:
            pass
        if kv_tokens:
            self.livestep_line(op, f"KV cache pool: {kv_tokens:,} tokens")
            if ctx.hub is not None:
                ctx.hub.note_kv_tokens(ctx.cluster["id"], profile_key, kv_tokens)
        self.step(op, 9, "ok" if kv_tokens else "skipped", detail=f"{kv_tokens}" if kv_tokens else None)

    # -- cluster.stop --
    async def _op_cluster_stop(self, op: OpRecord, ctx: OpContext) -> None:
        ring = self.ring(ctx)
        if ring is not None:
            await self._op_cluster_stop_ring(op, ctx, ring)
            return
        head, worker = self.head_node(ctx), self.worker_node(ctx)
        rt_h, rt_w = self.runtime(ctx, head), self.runtime(ctx, worker)
        profile_key = op.profile_key or None
        op.steps = [OpStep(name=n) for n in ("stop head", "stop worker", "confirm teardown")]
        self.step(op, 0, "running")
        vh, vw = self.verbs_for(ctx, head), self.verbs_for(ctx, worker)
        res = await self._run_on(op, rt_h, vh.down(profile_key), timeout=120)
        self.livestep_line(op, f"head down rc={res.exit}")
        self.step(op, 0, "ok")
        self.step(op, 1, "running")
        res = await self._run_on(op, rt_w, vw.down(profile_key), timeout=120)
        self.livestep_line(op, f"worker down rc={res.exit}")
        self.step(op, 1, "ok")
        self.step(op, 2, "running")
        await asyncio.sleep(2)
        ps_h = await self._run_on(op, rt_h, vh.container_list(), timeout=30)
        ps_w = await self._run_on(op, rt_w, vw.container_list(), timeout=30)
        leftovers = [j for j in (ps_h.stdout.strip().splitlines() + ps_w.stdout.strip().splitlines()) if j.strip().startswith("{")]
        self.livestep_line(op, f"remaining glm53 containers: {len(leftovers)}")
        self.step(op, 2, "ok" if not leftovers else "error",
                  detail=f"{len(leftovers)} container(s) still registered" if leftovers else None)
        if leftovers:
            raise OperationError("containers still registered after stop; inspect in Logs page")

    # -- cluster.preflight --
    async def _op_cluster_preflight(self, op: OpRecord, ctx: OpContext) -> None:
        ring = self.ring(ctx)
        if ring is not None:
            await self._op_cluster_preflight_ring(op, ctx, ring)
            return
        head, worker = self.head_node(ctx), self.worker_node(ctx)
        op.steps = [OpStep(name=n) for n in ("preflight worker", "preflight head")]
        for idx, node in ((0, worker), (1, head)):
            self.step(op, idx, "running")
            rt = self.runtime(ctx, node)
            v = self.verbs_for(ctx, node)
            sw = await self._run_on(op, rt, v.preflight_swappiness_check())
            self.livestep_line(op, f"{node['name']}: swappiness={sw.stdout.strip() or '60'}")
            if (sw.stdout.strip() or "60") != "0":
                await self._sudo_exec(op, rt, node, v.preflight_swappiness_fix())
                self.livestep_line(op, f"{node['name']}: swappiness -> 0")
            res = await self._sudo_exec(op, rt, node, v.preflight_drop_caches())
            self.livestep_line(op, f"{node['name']}: page cache dropped (rc={res.exit})")
            self.step(op, idx, "ok")

    # -- cluster.check / cluster.verify --
    async def _op_cluster_check(self, op: OpRecord, ctx: OpContext) -> None:
        ring = self.ring(ctx)
        if ring is not None:
            await self._op_cluster_check_ring(op, ctx, ring)
            return
        profile_key = op.profile_key or (ctx.cluster["profiles"][0]["key"] if ctx.cluster["profiles"] else (ctx.cluster["profiles"][0]["key"] if ctx.cluster["profiles"] else "tp4-mtp3"))
        self.profile(ctx, profile_key)
        for node in (self.head_node(ctx), self.worker_node(ctx)):
            rt = self.runtime(ctx, node)
            res = await self._run_on(op, rt, self.verbs_for(ctx, node).check(profile_key), timeout=120)
            self.livestep_line(op, f"== {node['name']} ==")
            for ln in res.stdout.strip().splitlines()[-80:]:
                self.livestep_line(op, ln)
            if res.exit != 0 and res.exit is not None:
                op.message = f"check reported exit {res.exit} on {node['name']} (see log)"

    async def _op_cluster_verify(self, op: OpRecord, ctx: OpContext) -> None:
        ring = self.ring(ctx)
        if ring is not None:
            await self._op_cluster_verify_ring(op, ctx, ring)
            return
        profile_key = self.profile_str(op, ctx)
        head = self.head_node(ctx)
        rt = self.runtime(ctx, head)
        res = await self._run_on(op, rt, self.verbs_for(ctx, head).verify(profile_key), timeout=90)
        for ln in res.stdout.strip().splitlines()[-60:]:
            self.livestep_line(op, ln)
        if res.exit not in (0, None):
            op.message = f"verify exited {res.exit}"


    # ================== SparkRing (managed mesh) cluster ops ==================
    # The TP4 ring lifecycle runs through the operator's sparkring.sh console
    # ON THE CONTROLLER (LocalRuntime) — plan → apply → receipt per verb.
    # OPERATIONS invariant honored: never touch containers/routing directly.

    def _cancelled(self, op: OpRecord):
        return lambda: op.state == "cancelled"

    def _head_probe_runtime(self, op: OpRecord, ctx: OpContext):
        head = self.head_node(ctx)
        rt = self.runtime(ctx, head)
        port = int(head.get("api_port") or 8015)
        return head, rt, port

    async def _ring_url_probe(self, op: OpRecord, ctx: OpContext, path: str, port: int,
                              timeout: float = 12.0) -> tuple[bool, str]:
        """Reachability + payload probe. Success = curl exit 0 AND non-empty
        body (works for both the real node shell and the mock exec path)."""
        _head, rt, _ = self._head_probe_runtime(op, ctx)
        cmd = f'curl -s -m 8 http://127.0.0.1:{port}{path} 2>/dev/null'
        res = await self._run_on(op, rt, cmd, timeout=timeout)
        body = (res.stdout or "").strip()
        return (res.exit in (0, None)) and body != "", body

    @staticmethod
    def _head_alias(head: dict) -> str:
        return head.get("ssh_alias") or head.get("name") or "gx10-r0"

    async def _op_cluster_start_ring(self, op: OpRecord, ctx: OpContext, ring: SparkringVerbs) -> None:
        control = ctx.cluster["control"]
        params = op.params
        profile_key = op.profile_key or (ctx.cluster["profiles"][0]["key"] if ctx.cluster["profiles"] else "")
        self.profile(ctx, profile_key)
        timeout_s = int(params.get("health_timeout_s") or control.get("health_timeout_s") or 2700)
        op.steps = [OpStep(name=n) for n in ("console: start (plan→apply→ready)",
                                             "endpoint probe (/v1/models)", "liveness",
                                             "capture KV + image")]
        crt = self.console_rt(ctx)
        self.livestep_line(op, f"sparkring start via {ring.serve_dir} (console runs on this host)")

        self.step(op, 0, "running")
        try:
            rc = await self.stream_into(op, crt, ring.console("start"), timeout=float(timeout_s))
        except OperationError:
            raise
        except Exception as exc:
            self.step(op, 0, "error", detail=str(exc)[:140])
            raise OperationError(f"console start failed: {exc}")
        if rc not in (0, None):
            self.step(op, 0, "error", detail=f"console exit {rc}")
            raise OperationError("./sparkring.sh start failed (see log/receipt)")
        self.step(op, 0, "ok")

        self.step(op, 1, "running")
        head, rt, port = self._head_probe_runtime(op, ctx)
        t0 = time.time()
        deadline = t0 + min(600.0, max(120.0, timeout_s * 0.5))
        models_ok = False
        while time.time() < deadline:
            if op.state == "cancelled":
                raise OperationError("cancelled", fatal=False)
            ok, body = await self._ring_url_probe(op, ctx, "/v1/models", port)
            if ok:
                self.livestep_line(op, f"/v1/models alive after {int(time.time()-t0)}s: {body[:120]}")
                models_ok = True
                break
            await asyncio.sleep(5)
        if not models_ok:
            self.step(op, 1, "error", detail="no 200 from /v1/models")
            raise OperationError("endpoint probe failed (see ./sparkring.sh liveness)")
        self.step(op, 1, "ok")

        self.step(op, 2, "running")
        lv = {}
        try:
            lv_res = await self._run_on(op, rt,
                f'curl -s -m 6 http://127.0.0.1:{port + 1}/liveness || true', timeout=15)
            lv = parse_liveness(lv_res.stdout or "")
        except Exception as exc:
            self.livestep_line(op, f"liveness fetch failed: {exc}")
        if lv:
            self.livestep_line(op, f"liveness: {lv}")
        else:
            self.livestep_line(op, "liveness endpoint not reachable from the head node (non-fatal)")
        self.step(op, 2, "ok")

        self.step(op, 3, "running")
        kv_tokens = None
        for prof in ctx.cluster["profiles"]:
            if prof["key"] == profile_key:
                kv_tokens = prof.get("kv_tokens")
        if kv_tokens and ctx.hub is not None:
            ctx.hub.note_kv_tokens(ctx.cluster["id"], profile_key, int(kv_tokens))
            self.livestep_line(op, f"KV pool (design): {int(kv_tokens):,} tokens")
        try:
            img = await self._run_on(op, rt,
                "docker inspect glm-tp4-r0 --format '{{.Image}}' 2>&1", timeout=15)
            self.livestep_line(op, f"r0 image: {img.stdout.strip()[:20]}")
        except Exception:
            pass
        self.step(op, 3, "ok" if kv_tokens else "skipped", detail=f"{kv_tokens}" if kv_tokens else None)

    async def _op_cluster_stop_ring(self, op: OpRecord, ctx: OpContext, ring: SparkringVerbs) -> None:
        params = op.params
        mode = params.get("mode") or "stop"  # stop: model off, mesh stays; down: full teardown
        if mode not in ("stop", "down"):
            raise OperationError(f"unknown stop mode {mode!r} (stop|down)")
        op.steps = [OpStep(name=f"console: {mode}"), OpStep(name="confirm quiet")]
        crt = self.console_rt(ctx)
        self.step(op, 0, "running")
        rc = await self.stream_into(op, crt, ring.console(mode), timeout=900.0)
        if rc not in (0, None):
            self.step(op, 0, "error", detail=f"console exit {rc}")
            raise OperationError(f"./sparkring.sh {mode} failed (see log/receipt)")
        self.step(op, 0, "ok")
        self.step(op, 1, "running")
        await asyncio.sleep(2)
        head, rt, port = self._head_probe_runtime(op, ctx)
        still_up, _ = await self._ring_url_probe(op, ctx, "/health", port)
        health = "answered" if still_up else "no answer"
        if mode == "down" and still_up:
            self.step(op, 1, "error", detail="API still answering after down")
            raise OperationError("API still answering after ./sparkring.sh down")
        self.livestep_line(op, f"API /health → {health} (mesh supervisors "
                               f"{'stopped' if mode == 'down' else 'still running — up/start'} )".replace(" )", ")"))
        self.step(op, 1, "ok")

    async def _op_cluster_preflight_ring(self, op: OpRecord, ctx: OpContext, ring: SparkringVerbs) -> None:
        op.steps = [OpStep(name="doctor --verify (on r0)"), OpStep(name="nodes reachable")]
        crt = self.console_rt(ctx)
        head = self.head_node(ctx)
        self.step(op, 0, "running")
        res = await self._run_on(op, crt, ring.doctor_verify(self._head_alias(head)), timeout=240.0)
        for ln in res.stdout.strip().splitlines()[-40:]:
            self.livestep_line(op, ln)
        ok = res.exit in (0, None)
        self.step(op, 0, "ok" if ok else "error",
                  detail=None if ok else "doctor reported failures (see log)")
        if not ok:
            raise OperationError("sparkring doctor --verify failed on r0")
        self.step(op, 1, "running")
        for node in ctx.nodes.values():
            rt = self.runtime(ctx, node)
            probe = await self._run_on(op, rt, "echo ok && docker ps --format '{{.Names}}' | head -6", timeout=20)
            self.livestep_line(op, f"{node['name']}: {', '.join(probe.stdout.strip().splitlines()[:6])}")
            if probe.exit != 0:
                raise OperationError(f"{node['name']} unreachable for preflight")
        self.step(op, 1, "ok")

    async def _op_cluster_check_ring(self, op: OpRecord, ctx: OpContext, ring: SparkringVerbs) -> None:
        op.steps = [OpStep(name="native-check (4-rank comm)"), OpStep(name="liveness")]
        crt = self.console_rt(ctx)
        self.step(op, 0, "running")
        rc = await self.stream_into(op, crt, ring.native_check(), timeout=900.0)
        if rc not in (0, None):
            op.message = f"native-check exited {rc} (see log)"
        self.step(op, 0, "ok" if rc in (0, None) else "error")
        self.step(op, 1, "running")
        head, rt, port = self._head_probe_runtime(op, ctx)
        health_ok, _ = await self._ring_url_probe(op, ctx, "/health", port)
        lv_res = await self._run_on(op, rt, f'curl -s -m 6 http://127.0.0.1:{port + 1}/liveness || true', timeout=12)
        lv = parse_liveness(lv_res.stdout or "")
        self.livestep_line(op, f"/health → {'answered' if health_ok else 'no answer'} · liveness: {lv or {}}")
        self.step(op, 1, "ok")

    async def _op_cluster_verify_ring(self, op: OpRecord, ctx: OpContext, ring: SparkringVerbs) -> None:
        op.steps = [OpStep(name="console: ready"), OpStep(name="endpoint verify")]
        crt = self.console_rt(ctx)
        self.step(op, 0, "running")
        rc = await self.stream_into(op, crt, ring.ready(), timeout=600.0)
        if rc not in (0, None):
            self.step(op, 0, "error", detail=f"console exit {rc}")
            raise OperationError(f"./sparkring.sh ready failed (exit {rc})")
        self.step(op, 0, "ok")
        self.step(op, 1, "running")
        port = int((ctx.nodes.get(ctx.cluster["control"].get("head_node_id")) or {}).get("api_port") or 8015)
        ok, body = await self._ring_url_probe(op, ctx, "/v1/models", port)
        self.livestep_line(op, f"/v1/models → {body[:160]}")
        self.step(op, 1, "ok" if ok else "error",
                  detail=None if ok else "endpoint did not answer")

    def profile_str(self, op: OpRecord, ctx: OpContext) -> str:
        k = op.profile_key or ""
        return k or (ctx.cluster["profiles"][0]["key"] if ctx.cluster["profiles"] else (ctx.cluster["profiles"][0]["key"] if ctx.cluster["profiles"] else "tp4-mtp3"))

    # ---------------- node ops ----------------
    async def _op_node_show_gids(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        rt = self.runtime(ctx, node)
        res = await self._run_on(op, rt, "show_gids 2>&1", timeout=30)
        import ipaddress as _ip

        rows = []
        for ln in res.stdout.splitlines():
            toks = ln.split()
            if not toks or ("v2" not in toks and "v1" not in toks):
                continue
            ip = None
            for t in toks:
                try:
                    _ip.IPv4Address(t)
                    ip = t
                    break
                except Exception:
                    continue
            if ip is None:
                continue
            # GID index: the integer directly preceding the vN token
            ver_tok = toks.index("v2" if "v2" in toks else "v1")
            idx = None
            for j in range(ver_tok - 1, 0, -1):
                if toks[j].isdigit():
                    idx = int(toks[j])
                    break
            rows.append({"hca": toks[0], "index": idx, "transport": "v2" if "v2" in toks else "v1", "addr": ip})
        op.params["gid_table"] = rows[:200]
        self.livestep_line(op, f"gid rows parsed: {len(rows)}")

    async def _op_node_ping_fabric(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        peer = str(op.params.get("peer_address") or "")
        if not peer:
            raise OperationError("ping_fabric requires peer_address")
        rt = self.runtime(ctx, node)
        res = await self._run_on(op, rt, f"ping -c 5 -W 2 -q {peer} 2>&1", timeout=30)
        import re as _re

        self.livestep_line(op, res.stdout.strip() or "(no output)")
        m = _re.search(r"([\d.]+)/([\d.]+)/([\d.]+)/([\d.]+) ms", res.stdout)
        loss = _re.search(r"(\d+)% packet loss", res.stdout)
        op.params["ping"] = {
            "min_ms": float(m.group(1)) if m else None,
            "avg_ms": float(m.group(2)) if m else None,
            "max_ms": float(m.group(3)) if m else None,
            "loss_pct": float(loss.group(1)) if loss else None,
        }

    async def _op_node_tailscale_status(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        rt = self.runtime(ctx, node)
        res = await self._run_on(op, rt, "tailscale status --json 2>/dev/null | head -c 2000; echo", timeout=25)
        if not res.stdout.strip():
            self.livestep_line(op, "tailscale not present/installed on node")
            op.params["tailscale"] = {"installed": False}
            return
        import json as _json

        try:
            js = _json.loads(res.stdout)
            self_state = js.get("Self") or {}
            peers = [
                {"hostname": (js.get("Peer", {}) or {}).get(k, {}).get("HostName", k),
                 "online": bool(v.get("Online"))}
                for k, v in list((js.get("Peer", {}) or {}).items())[:12]
            ]
            op.params["tailscale"] = {
                "installed": True, "self": {"hostname": self_state.get("HostName"),
                                            "tailscale_ips": self_state.get("TailscaleIPs", [])},
                "peers": peers,
            }
            self.livestep_line(op, f"tailscale ok: {self_state.get('HostName')}")
        except Exception as exc:
            self.livestep_line(op, f"tailscale parse failed: {exc}")

    async def _op_node_drop_caches(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        rt = self.runtime(ctx, node)
        v = self.verbs_for(ctx, node)
        res = await self._sudo_exec(op, rt, node, v.preflight_drop_caches())
        self.livestep_line(op, f"{node['name']}: page cache dropped (rc={res.exit})")

    async def _op_node_fix_swappiness(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        rt = self.runtime(ctx, node)
        v = self.verbs_for(ctx, node)
        res = await self._sudo_exec(op, rt, node, v.preflight_swappiness_fix())
        self.livestep_line(op, f"{node['name']}: swappiness -> 0 (rc={res.exit})")

    async def _op_collector_deploy(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        rt = self.runtime(ctx, node)
        if hasattr(rt, "_ensure_collector"):
            await rt._ensure_collector()
            self.livestep_line(op, f"{node['name']}: collector deployed/verified")
            return
        raise OperationError("runtime does not support collector deploy (mock?)")

    # ---------------- image ops ----------------
    async def _op_image_set_serving(self, op: OpRecord, ctx: OpContext) -> None:
        cluster = ctx.cluster
        profile_key = op.profile_key or ""
        self.profile(ctx, profile_key)
        image = str(op.params.get("image") or "")
        if not image:
            raise OperationError("image required")
        op.steps = [OpStep(name=n) for n in ("rewrite head env", "rewrite worker env", "confirm")]
        for idx, node in ((0, self.head_node(ctx)), (1, self.worker_node(ctx))):
            self.step(op, idx, "running")
            rt = self.runtime(ctx, node)
            v = self.verbs_for(ctx, node)
            f = v.control["serve_dir"] + "/" + v.env_file(profile_key)
            old = await self._run_on(op, rt, f"grep -E '^SERVING_IMAGE=' {q(f)} | cut -d= -f2- || true", timeout=15)
            self.livestep_line(op, f"{node['name']}: old={old.stdout.strip()} new={image}")
            res = await self._run_on(
                op, rt,
                f"sed -i 's|^SERVING_IMAGE=.*|SERVING_IMAGE={image.replace('|', r'\\|')}|' {q(f)} && grep -E '^SERVING_IMAGE=' {q(f)}",
                timeout=20)
            if res.exit != 0 or image not in res.stdout:
                self.step(op, idx, "error", detail=res.stderr[:160])
                raise OperationError(f"SERVING_IMAGE rewrite failed on {node['name']}")
            self.step(op, idx, "ok")
        self.step(op, 2, "ok", detail="done — restart the pair to use it")

    async def _op_image_copy(self, op: OpRecord, ctx: OpContext) -> None:
        src = ctx.nodes[op.node_id or ""]
        dst_id = str(op.params.get("dst_node_id") or "")
        image = str(op.params.get("image") or "")
        dst = ctx.nodes.get(dst_id)
        if not dst or not image:
            raise OperationError("image_copy requires node_id(src), dst_node_id, image")
        rt_s = self.runtime(ctx, src)
        rt_d = self.runtime(ctx, dst)
        dst_addr = (dst.get("addresses") or [{}])[0].get("host")
        dst_user = dst.get("ssh_user") or "nero"
        src_user = src.get("ssh_user") or "nero"
        op.steps = [OpStep(name=n) for n in ("probe dst", "docker save | ssh docker load", "inspect")]
        self.step(op, 0, "running")
        ok_probe = await self._run_on(op, rt_d, "true", timeout=10)
        self.step(op, 0, "ok")
        self.step(op, 1, "running")
        self.livestep_line(op, f"streaming {image} from {src['name']} to {dst['name']} ({dst_addr}) — 24+ GB; takes minutes")
        stream_cmd = (
            f"docker save {q(image)} | ssh -4 -o BatchMode=yes -o ConnectTimeout=10 "
            f"-o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null {dst_user}@{dst_addr} docker load"
        )
        rc = await runtime_stream_exec(self, op, rt_s, stream_cmd, timeout=3600)
        if rc != 0:
            self.step(op, 1, "error", detail=f"rc={rc}")
            raise OperationError("docker save|load failed; see log")
        self.step(op, 1, "ok")
        self.step(op, 2, "running")
        res = await self._run_on(op, rt_d, f"docker image inspect {q(image)} --format '{{{{.Id}}}}' 2>&1", timeout=30)
        self.livestep_line(op, f"dst inspect: {res.stdout.strip() or res.stderr.strip()[:120]}")
        self.step(op, 2, "ok" if res.exit == 0 else "error")
        if res.exit != 0:
            raise OperationError("image not inspectable on destination")

    async def _op_image_build(self, op: OpRecord, ctx: OpContext) -> None:
        node = ctx.nodes[op.node_id or ""]
        build_file = str(op.params.get("file") or "")
        if not build_file or "/" in build_file or not build_file.endswith(".env"):
            raise OperationError("file must be a builder env profile name (build-*.env)")
        rt = self.runtime(ctx, node)
        builder_dir = v_builder_dir(ctx.cluster)
        log_name = f"build-{int(time.time())}.log"
        remote_log = f"~/.sparkdeck/{log_name}"
        op.steps = [OpStep(name=n) for n in ("spawn build", "follow build log", "inspect image")]
        self.step(op, 0, "running")
        spawn = (
            f"cd {q(builder_dir)} && setsid nohup bash build-spark-cu132.sh {q(build_file)} > {remote_log} 2>&1 & echo $!"
        )
        res = await self._run_on(op, rt, spawn, timeout=20)
        pid = res.stdout.strip().splitlines()[-1] if res.stdout.strip() else ""
        if not pid.isdigit():
            self.livestep_line(op, res.stdout.strip() + res.stderr.strip())
            raise OperationError("failed to spawn builder on node")
        self.livestep_line(op, f"builder pid {pid} on {node['name']}; log {remote_log}")
        self.step(op, 0, "ok")
        self.step(op, 1, "running")
        await runtime_follow(self, op, rt, f"tail -n +1 -f {q(remote_log)}", max_s=5400,
                             done_hint=("successfully tagged", "built", "ERROR", "error:"))
        self.step(op, 1, "ok")
        # derive image tag from env file (IMAGE_REPO/IMAGE_TAG pattern)
        env = await self._run_on(op, rt, f"grep -E '^(IMAGE_REPO|IMAGE_TAG)=' {q(builder_dir + '/' + build_file)}", timeout=15)
        repo, tag = None, None
        for ln in env.stdout.splitlines():
            k, _, val = ln.partition("=")
            if k == "IMAGE_REPO":
                repo = val.strip()
            elif k == "IMAGE_TAG":
                tag = val.strip()
        if repo and tag:
            image = f"{repo}:{tag}"
            res = await self._run_on(op, rt, f"docker image inspect {q(image)} --format '{{{{.Id}}}}'", timeout=20)
            self.step(op, 2, "ok" if res.exit == 0 else "error", detail=image)
            self.livestep_line(op, f"image inspect: {image} -> {res.stdout.strip()[:60]}")
        else:
            self.step(op, 2, "skipped", detail="IMAGE_REPO/TAG not parseable")


def v_builder_dir(cluster: dict) -> str:
    return f"{cluster['control'].get('repo_dir', '~/builds/glm53-flash-dgx-spark-tp2')}/builder/blackwell-llm-docker/dgx-spark-builder"


def q(s: str) -> str:
    import shlex

    return shlex.quote(s)


async def runtime_stream_exec(engine: "OpEngine", op: OpRecord, runtime, cmd: str, timeout: float) -> int:
    """streaming exec with log capture; returns exit code (nonzero on error)."""
    return await runtime.stream_exec(cmd, timeout=timeout, on_line=lambda l: engine.livestep_line(op, l))


async def runtime_follow(engine: "OpEngine", op: OpRecord, runtime, cmd: str, max_s: float, done_hint: tuple = ()) -> None:
    await runtime.stream_exec(cmd, timeout=max_s, on_line=lambda l: engine.livestep_line(op, l),
                              stop_hints=done_hint)
