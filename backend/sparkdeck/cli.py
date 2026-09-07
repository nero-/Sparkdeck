"""sparkdeck CLI: serve | doctor | version."""

from __future__ import annotations

import argparse
import asyncio
import json
import sys


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
    args = ap.parse_args()

    from . import VERSION

    if args.cmd == "version" or args.cmd is None:
        print(f"sparkdeck {VERSION}")
        return 0 if args.cmd == "version" else (ap.print_help() or 0)

    if args.cmd in ("serve", "doctor"):
        from .config import load_config

        cfg = load_config()
        if args.cmd == "serve":
            if args.host:
                cfg.host = args.host
            if args.port:
                cfg.port = args.port
            if args.mock:
                cfg.mock = True
            if args.verbose:
                cfg.verbose = True
            return cmd_serve(cfg)
        return cmd_doctor(cfg)
    return 2


async def _doctor(cfg) -> int:
    from .app import Application

    a = Application(cfg)
    await a.startup()
    try:
        nodes = [n for c in a.topology for n in c["nodes"]]
        # wait for terminal connection states (or 30s cap)
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
        for cid in ("c1", "c2"):
            st = a.service.get(cid) or {}
            print(f"  {cid}: health={st.get('health')} model={st.get('model')} kv={st.get('kv_tokens')}")
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
