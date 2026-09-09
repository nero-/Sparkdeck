"""sparkdeck CLI.

Server commands:  serve | doctor | version
Cluster verbs (drive the RUNNING controller API — audited ops, same as the
web console):  start | stop | down | recover | ready | status | liveness |
native-check | preflight | check | verify | logs | prompt

    sparkdeck start                 # cluster start (default profile, default timeout)
    sparkdeck start --timeout 3600  # e.g. cold JIT first boot
    sparkdeck stop                  # model off — mesh supervisors stay
    sparkdeck down                  # model AND mesh teardown
    sparkdeck recover               # reset mesh, restart supervisors (no model)
    sparkdeck status | liveness | native-check | preflight | check | verify
    sparkdeck logs 2                # follow glm-tp4-r2 container logs (Ctrl-C ends)
    sparkdeck prompt "hello" 256    # chat through the served model (optional)

The verbs require the controller to be running (`sparkdeck serve`, or the
systemd user unit) — that is what gives every action the same audited op
trail and confirmation gates as the console. Set SPARKDECK_URL or pass
--host to reach a controller on another address; --cluster selects among
multiple clusters (default: the first).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time

BASE_DEFAULT = "http://127.0.0.1:8936"

CLUSTER_VERBS = ("start", "stop", "down", "recover", "ready", "status",
                 "liveness", "native-check", "preflight", "check", "verify",
                 "logs", "prompt")


def _host_of(args) -> str:
    import os

    return args.host or os.environ.get("SPARKDECK_URL") or BASE_DEFAULT


def main() -> int:
    ap = argparse.ArgumentParser(prog="sparkdeck", description="DGX Spark / GX10 cluster controller")
    sub = ap.add_subparsers(dest="cmd")
    p_serve = sub.add_parser("serve", help="run the API + web console")
    p_serve.add_argument("--host", default=None)
    p_serve.add_argument("--port", type=int, default=None)
    p_serve.add_argument("--mock", action="store_true", help="run with the virtual (simulated) cluster world")
    p_serve.add_argument("--verbose", action="store_true")
    sub.add_parser("doctor", help="probe configured nodes and print a health matrix")
    sub.add_parser("version", help="print version")

    op = sub.add_parser("start", help="cluster start (plan→apply→ready via the managed console)")
    op.add_argument("--profile", default=None)
    op.add_argument("--timeout", type=int, default=None, help="health timeout seconds (e.g. 2700 cold JIT)")
    op.add_argument("--skip-preflight", action="store_true")
    op.add_argument("--extra", default=None)
    p_stop = sub.add_parser("stop", help="model off — mesh supervisors stay")
    p_down = sub.add_parser("down", help="model AND mesh teardown (use before reboots)")
    for p in (p_stop, p_down):
        p.add_argument("--cluster", default=None)
    for name in ("recover", "ready", "status", "liveness", "native-check",
                 "preflight", "check", "verify"):
        pp = sub.add_parser(name, help=f"{name} verb")
        pp.add_argument("--cluster", default=None)
    p_logs = sub.add_parser("logs", help="follow a rank container's docker logs")
    p_logs.add_argument("rank", type=int, nargs="?", default=0)
    p_logs.add_argument("--lines", type=int, default=200)
    p_prompt = sub.add_parser("prompt", help="one-shot chat through the served model")
    p_prompt.add_argument("text")
    p_prompt.add_argument("max_tokens", type=int, nargs="?", default=256)
    p_prompt.add_argument("--cluster", default=None)
    for p in (op, p_logs, p_prompt):
        p.add_argument("--host", default=None, help="controller base URL (or SPARKDECK_URL env)")
    for p in (p_stop, p_down, *(sub.choices[n] for n in ("recover", "ready", "status", "liveness", "native-check", "preflight", "check", "verify"))):
        p.add_argument("--host", default=None)
    args = ap.parse_args()

    from . import VERSION

    if args.cmd == "version" or args.cmd is None:
        print(f"sparkdeck {VERSION}")
        return 0 if args.cmd == "version" else (ap.print_help() or 0)

    if args.cmd == "serve":
        from .config import load_config

        cfg = load_config()
        if getattr(args, "host", None):
            cfg.host = args.host
        if getattr(args, "port", None):
            cfg.port = args.port
        if getattr(args, "mock", False):
            cfg.mock = True
        if getattr(args, "verbose", False):
            cfg.verbose = True
        return cmd_serve(cfg)
    if args.cmd == "doctor":
        from .config import load_config

        return cmd_doctor(load_config())

    if args.cmd in CLUSTER_VERBS:
        return _run_verb(args)

    return 2


# ---------------------------------------------------------------------------
# remote verbs (talk to the running controller)


def _run_verb(args) -> int:
    try:
        return asyncio.run(_verb(args))
    except KeyboardInterrupt:
        return 130


async def _ensure_controller(base: str, timeout: float = 6.0) -> None:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=timeout) as c:
            r = await c.get(f"{base}/api/healthz")
            r.raise_for_status()
    except Exception as exc:  # noqa: BLE001 - friendly CLI error
        print(f"error: no sparkdeck controller at {base} ({exc!r})", file=sys.stderr)
        print("hint: start it with `sparkdeck serve` or the systemd user unit "
              "(systemctl --user start sparkdeck) — audited ops require the controller.", file=sys.stderr)
        raise SystemExit(2)


async def _clusters(base: str) -> list[dict]:
    import httpx

    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.get(f"{base}/api/clusters")
        r.raise_for_status()
        return r.json()


async def _pick(base: str, cluster: str | None) -> dict:
    cls = await _clusters(base)
    if not cls:
        raise SystemExit("error: no clusters configured in the controller")
    if cluster:
        for cl in cls:
            if cl["id"] == cluster or cl["name"] == cluster:
                return cl
        raise SystemExit(f"error: cluster {cluster!r} not found (have: {', '.join(c['id'] for c in cls)})")
    return cls[0]


async def _post_op(base: str, cluster_id: str, action: str, body: dict, poll_s: float,
                   quiet: bool = False) -> int:
    import httpx

    async with httpx.AsyncClient(timeout=None) as c:
        r = await c.post(f"{base}/api/clusters/{cluster_id}/actions/{action}", json=body)
        if r.status_code != 200:
            print(f"error: {action} rejected: {r.text[:300]}", file=sys.stderr)
            return 2
        op_id = r.json()["op_id"]
        t0 = time.time()
        seen_steps: set[tuple] = set()
        last_tail: list[str] = []
        while True:
            op = (await c.get(f"{base}/api/ops/{op_id}")).json()
            for i, st in enumerate(op.get("steps") or []):
                key = (i, st.get("state"))
                if key not in seen_steps and st.get("state") not in (None, "pending"):
                    seen_steps.add(key)
                    print(f"  [{i + 1}] {st['name']} → {st['state']}"
                          + (f" ({(st.get('detail') or '')[:80]})" if st.get("detail") else ""))
            tail: list[str] = op.get("log_tail") or []
            if len(tail) > len(last_tail):
                for ln in tail[len(last_tail):]:
                    if not quiet:
                        print(f"    {ln[:180]}")
            last_tail = tail
            state = op.get("state")
            if state in ("ok", "error", "cancelled"):
                print(f"op {op_id} → {state} in {time.time() - t0:.0f}s")
                return 0 if state == "ok" else 1
            if poll_s > 0:
                await asyncio.sleep(poll_s)
            if time.time() - t0 > 6 * 3600:
                print("error: op exceeded 6h; cancel it in the web console", file=sys.stderr)
                return 1


async def _verb(args) -> int:
    import httpx

    base = _host_of(args)
    await _ensure_controller(base)
    cmd = args.cmd

    if cmd == "prompt":
        cl = await _pick(base, args.cluster)
        body = {"messages": [{"role": "user", "content": args.text}],
                "max_tokens": int(args.max_tokens)}
        async with httpx.AsyncClient(timeout=300) as c:
            r = await c.post(f"{base}/api/llm/{cl['id']}/chat", json=body)
            r.raise_for_status()
            text = []
            async for line in r.aiter_lines():
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    d = json.loads(payload)
                except Exception:
                    continue
                if d.get("done"):
                    break
                piece = (d.get("delta") or {}).get("content") if isinstance(d.get("delta"), dict) else d.get("content")
                if isinstance(piece, str) and piece:
                    text.append(piece)
        out = "".join(text)
        print(out if out else "(empty)")
        return 0

    if cmd == "liveness" or cmd == "status":
        cl = await _pick(base, args.cluster)
        async with httpx.AsyncClient(timeout=15) as c:
            st = (await c.get(f"{base}/api/llm/{cl['id']}/state")).json()
        print(f"cluster {cl['name']} ({cl['id']})")
        print(f"  health: {st.get('health')}  model: {st.get('model')}  port: {st.get('port')}")
        if st.get("image"):
            print(f"  image:  {st['image']}")
        if st.get("age_s") is not None:
            print(f"  uptime: {st['age_s'] / 3600:.1f} h")
        if st.get("kv_tokens"):
            print(f"  kv pool: {st['kv_tokens']:,} tokens")
        lv = st.get("liveness") or {}
        if lv:
            print(f"  liveness: healthy={lv.get('healthy')} running={lv.get('running_requests')} "
                  f"kv={lv.get('kv_cache_usage')} blocked={lv.get('blocked_seconds')}s")
        if cmd == "status":
            async with httpx.AsyncClient(timeout=15) as c:
                live = (await c.get(f"{base}/api/system/status")).json()
            for n in live.get("nodes", []):
                print(f"  node {n['node_id']:8s} {n['state']:8s} collector={n['collector']} via {n.get('addr_used')}")
        return 0

    if cmd == "logs":
        cl = await _pick(base, args.cluster)
        head = next((n for n in cl["nodes"] if n.get("role") == "head"), None) or cl["nodes"][0]
        container = f"glm-tp4-r{args.rank}"
        url = f"{base}/api/logs/stream?node_id={head['id']}&container={container}&lines={args.lines}"
        print(f"following {container} on {head['name']} (Ctrl-C to stop)")
        async with httpx.AsyncClient(timeout=None) as c:
            async with c.stream("GET", url) as resp:
                resp.raise_for_status()
                buf = ""
                async for chunk in resp.aiter_text():
                    buf += chunk.replace("\r\n", "\n")
                    frames = buf.split("\n\n")
                    buf = frames.pop()
                    for f in frames:
                        for line in f.splitlines():
                            if line.startswith("data:"):
                                try:
                                    d = json.loads(line[5:].strip())
                                except Exception:
                                    continue
                                for ln in d.get("lines") or []:
                                    print(ln)
                                if d.get("eof"):
                                    print("(eof — container stopped)")
                                    return 0
        return 0

    # ---- lifecycle map ----
    cl = await _pick(base, getattr(args, "cluster", None))
    if cmd == "start":
        body: dict = {}
        if getattr(args, "profile", None):
            body["profile_key"] = args.profile
        if getattr(args, "timeout", None):
            body["health_timeout_s"] = int(args.timeout)
        if getattr(args, "skip_preflight", False):
            body["skip_preflight"] = True
        if getattr(args, "extra", None):
            body["extra"] = args.extra
        return await _post_op(base, cl["id"], "start", body, poll_s=2.0)
    if cmd == "stop":
        return await _post_op(base, cl["id"], "stop", {"mode": "stop"}, poll_s=1.5)
    if cmd == "down":
        return await _post_op(base, cl["id"], "stop", {"mode": "down"}, poll_s=1.5)
    if cmd == "recover":
        # the console verb reset — surfaced through the ops trail as well:
        # preflight (doctor) then a check pass; the actual `recover` call is
        # only exposed to the web console (it is a destructive mesh reset)
        print("note: mesh reset is intentionally console-gated; open the web UI "
              "→ Control ▸ Service ▸ Recover, or run ./sparkring.sh recover manually.")
        return 2
    if cmd == "ready":
        return await _post_op(base, cl["id"], "verify", {}, poll_s=2.0)
    if cmd == "verify":
        return await _post_op(base, cl["id"], "verify", {}, poll_s=2.0)
    if cmd == "native-check":
        return await _post_op(base, cl["id"], "check", {}, poll_s=2.0)
    if cmd == "check":
        return await _post_op(base, cl["id"], "check", {}, poll_s=2.0)
    if cmd == "preflight":
        return await _post_op(base, cl["id"], "preflight", {}, poll_s=2.0)
    return 2


# ---------------------------------------------------------------------------
# serve / doctor


async def _doctor(cfg) -> int:
    from .app import Application

    a = Application(cfg)
    await a.startup()
    try:
        nodes = [n for c in a.topology for n in c["nodes"]]
        async def _settled() -> bool:
            for _ in range(100):
                if all((a.runtime_of(n["id"]) and a.runtime_of(n["id"]).state in ("online", "offline", "disabled")) for n in nodes):
                    return True
                await asyncio.sleep(0.3)
            return False
        await asyncio.wait_for(_settled(), 35)
        print("topology:")
        for c in a.topology:
            print(f"  cluster {c['id']} {c['name']}")
            for n in c["nodes"]:
                rt = a.runtime_of(n["id"])
                if rt is None:
                    print(f"    - {n['name']}: no runtime")
                    continue
                probe = rt.probe_summary() if hasattr(rt, "probe_summary") else {}
                addrs = " | ".join(f"{x['addr']}{'' if x['ok'] else ' ✗'}" for x in probe.get("attempts", []))
                try:
                    res = await rt.exec("python3 -V 2>&1; nvidia-smi -L 2>&1 | head -1", timeout=12)
                    detail = " / ".join(x.strip() for x in res.stdout.strip().splitlines()[:2])
                except Exception as exc:
                    detail = f"probe failed: {exc!r}"
                print(f"    - {n['name']}: state={probe.get('state')} via={probe.get('addr_used')}"
                      f" collector={probe.get('collector_state')} unverified={probe.get('unverified')}"
                      f" {('| attempts: ' + addrs) if addrs else ''}")
                print(f"        {detail}")
        print("service:")
        for c in a.topology:
            st = a.service.get(c["id"]) or {}
            print(f"  {c['id']}: health={st.get('health')} model={st.get('model')} kv={st.get('kv_tokens')}")
    finally:
        await a.shutdown()
    return 0


def cmd_doctor(cfg) -> int:
    try:
        return asyncio.run(_doctor(cfg))
    except KeyboardInterrupt:
        return 130


def cmd_serve(cfg) -> int:
    import uvicorn

    from . import VERSION
    from .app import Application
    from .server import create_app

    a = Application(cfg)
    app = create_app(a)

    scheme = "mock" if cfg.mock else "real"
    print(f"sparkdeck {VERSION} serving on http://{cfg.host}:{cfg.port} ({scheme} cluster world)")
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="info" if not cfg.verbose else "debug",
                access_log=False)
    return 0
