"""Bench runner: drives the operator's llm-inference-bench tool as a managed
background job with live progress, checkpoint-based per-cell telemetry, and
parsed summaries.

Facts encoded from the tool itself (verified against source + artifacts):
  * success = output JSON exists + parseable; exit 0 alone means nothing
  * always pass --resume explicitly (non-tty stdin silently drops checkpoints)
  * cancel via SIGINT (partial save); SIGTERM saves nothing → KILL last resort
  * per-cell checkpoint `<output>.resume.json` written atomically after every
    completed cell → used as live progress
  * display plain + --no-hw-monitor (monitoring is the collector's job)
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..db import DB, jdumps, jloads, now_ms
from ..models import BenchArgs, BenchJob

TOOL_NAME = "llm_decode_bench.py"


@dataclass
class BenchTarget:
    host: str
    port: int
    model: str


class BenchRunner:
    def __init__(self, db: DB, hub, runtime_dir: Path) -> None:
        self.db = db
        self.hub = hub
        self.root = runtime_dir / "bench"
        self.root.mkdir(parents=True, exist_ok=True)
        self._jobs: dict[str, BenchJob] = {}
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._settings_ref = None  # set by app (.settings = AppSettings)

    def bind_settings(self, settings_ref) -> None:
        self._settings_ref = settings_ref

    def bind_mock(self, mock_world=None) -> None:
        """In mock mode, bench jobs are simulated (never a real network run)."""
        self._mock_world = mock_world

    # ------------- paths / venv -------------
    def bench_repo_dir(self) -> Path | None:
        s = getattr(self._settings_ref, "settings", None)
        if not s or not s.bench.bench_repo_dir:
            return None
        return Path(s.bench.bench_repo_dir).expanduser()

    def venv_python(self) -> Path | None:
        s = getattr(self._settings_ref, "settings", None)
        if s and s.bench.venv_python:
            p = Path(s.bench.venv_python).expanduser()
            if p.exists():
                return p
        brd = self.bench_repo_dir()
        if brd and (brd / ".venv/bin/python").exists():
            return brd / ".venv" / "bin" / "python"
        return None

    def tool_path(self) -> Path | None:
        brd = self.bench_repo_dir()
        if brd and (brd / TOOL_NAME).exists():
            return brd / TOOL_NAME
        return None

    async def status(self) -> dict:
        brd = self.bench_repo_dir()
        tool = self.tool_path()
        venv = self.venv_python()
        deps_ok = None
        if venv:
            try:
                proc = await asyncio.create_subprocess_exec(
                    str(venv), "-c", "import httpx, rich; print('ok')",
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                out, err = await asyncio.wait_for(proc.communicate(), 10)
                deps_ok = (proc.returncode == 0 and b"ok" in out)
            except Exception:
                deps_ok = False
        return {
            "bench_repo_dir": str(brd) if brd else None,
            "tool_present": bool(tool),
            "venv_python": str(venv) if venv else None,
            "venv_deps_ok": deps_ok,
        }

    async def bootstrap_venv(self) -> dict:
        import sys as _sys

        brd = self.bench_repo_dir()
        if not brd:
            return {"rc": 1, "log": "bench_repo_dir not configured"}
        venv_dir = brd / ".venv"
        logs: list[str] = []
        if not (venv_dir / "bin" / "python").exists():
            proc = await asyncio.create_subprocess_exec(
                _sys.executable, "-m", "venv", str(venv_dir), cwd=str(brd),
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate()
            logs.append(_to_text(out)[-1500:])
            if proc.returncode != 0:
                return {"rc": proc.returncode, "log": "\n".join(logs)}
        proc = await asyncio.create_subprocess_exec(
            str(venv_dir / "bin" / "pip"), "install", "httpx", "rich", "--quiet",
            cwd=str(brd), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
        out, _ = await proc.communicate()
        logs.append(_to_text(out)[-1500:])
        return {"rc": proc.returncode, "log": "\n".join(logs)}

    # ------------- job lifecycle -------------
    def _argv(self, job: BenchJob) -> list[str]:
        args = job.args
        py = self.venv_python()
        tool = self.tool_path()
        out_dir = (self.root / job.id).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        out_json = (out_dir / f"{_safe_name(job.label)}-{job.id}.json").resolve()
        job.result_path = str(out_json)
        argv = [
            str(py or "python3"), str(tool or TOOL_NAME),
            "--host", job.host, "--port", str(job.port), "--model", job.model,
            "--concurrency", _csv(args.concurrency),
            "--contexts", _csv(args.contexts),
            "--max-tokens", str(args.max_tokens),
            "--duration", str(args.duration),
            "--display-mode", "plain",
            "--no-hw-monitor",
            "--resume",
            "--output", str(out_json),
        ]
        if args.prefill_contexts:
            argv += ["--prefill-contexts", _csv(args.prefill_contexts)]
        if args.kv_budget:
            argv += ["--kv-budget", str(args.kv_budget)]
        if args.coding_peak:
            argv += ["--coding-peak"]
            if args.coding_peak_runs:
                argv += ["--coding-peak-runs", str(args.coding_peak_runs)]
            if args.coding_peak_max_tokens:
                argv += ["--coding-peak-max-tokens", str(args.coding_peak_max_tokens)]
        if args.extra:
            argv += shlex_split(args.extra)
        return argv

    def resume_path(self, job: BenchJob) -> Path | None:
        return (Path(job.result_path).with_suffix(".json.resume.json")
                if job.result_path else None)

    def _pub(self, job: BenchJob, tail: str | None = None) -> None:
        """Fire-and-forget bench progress publish (safe without a loop)."""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self.hub.publish_bench_progress(job, tail))

    async def _mock_submit(self, job: BenchJob) -> None:
        """Simulated bench for mock mode: staged lifecycle + plausible summary."""
        job.state = "running"
        job.started = now_ms()
        out_dir = (self.root / job.id).resolve()
        out_dir.mkdir(parents=True, exist_ok=True)
        job.result_path = str((out_dir / f"{_safe_name(job.label)}-{job.id}.json").resolve())
        await self._persist(job)
        self._pub(job)
        from ..mock.world import format_mock_bench

        await format_mock_bench(job, out_dir, self._pub)
        job.exit = 0
        job.finished = now_ms()
        job.state = "ok"
        job.summary = await self.load_result(job.id, refresh=True)
        await self._persist(job)
        self._pub(job)

    async def submit(self, job: BenchJob, argv: list[str]) -> None:
        if getattr(self, "_mock_world", None) is not None:
            await self._mock_submit(job)
            return
        cwd = self.bench_repo_dir() or Path.cwd()
        logf = self.root / job.id / "bench.log"
        logf.parent.mkdir(parents=True, exist_ok=True)
        job.state = "running"
        job.started = now_ms()
        await self._persist(job)
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, cwd=str(cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
            )
            self._procs[job.id] = proc
            progress = asyncio.create_task(self._progress_loop(job))
            with logf.open("ab") as log:
                log.write(_cmdline(argv).encode() + b"\n\n")
                log.flush()
                async for line in proc.stdout:  # type: ignore[union-attr]
                    txt = _to_text(line)
                    log.write(txt.encode() + b"\n")
                    self._pub(job, txt)
                await proc.wait()
            progress.cancel()
            with contextlib_suppress():
                await progress
            job.exit = proc.returncode
            job.finished = now_ms()
            if job.state != "cancelled":
                job.state = _final_state(job)
            job.summary = await self.load_result(job.id, refresh=True) or checkpoint_summary(self.resume_path(job))
            if not job.summary:
                # no output file: recover last lines for the error message
                job.summary = {"error": "no output file; server unreachable or invalid args"}
            await self._persist(job)
        except asyncio.CancelledError:
            job.state = "cancelled"
            job.finished = now_ms()
            await self._persist(job)
            raise
        except Exception as exc:  # noqa: BLE001
            job.state = "error"
            job.exit = -1
            job.finished = now_ms()
            job.summary = {"error": f"{type(exc).__name__}: {exc}"}
            await self._persist(job)
        finally:
            self._procs.pop(job.id, None)
            self._pub(job)

    async def _progress_loop(self, job: BenchJob) -> None:
        while True:
            await asyncio.sleep(8)
            cs = checkpoint_summary(self.resume_path(job))
            if cs:
                await self.hub.publish_bench_progress(job, tail_line=None)
                job.summary = cs  # provisional (UI live view) — final comes from result file

    def running_proc(self, job_id: str):
        return self._procs.get(job_id)

    async def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id) if self._jobs.get(job_id) else await self.get(job_id)
        if not job:
            return False
        if job.state != "running":
            return False
        job.state = "cancelled"  # provisional; submit() keeps it after finalize
        await self._persist(job)
        self.hub.publish_bench_progress(job)
        proc = self._procs.get(job_id)
        if proc:
            _send_sigint(proc)

            async def killer():
                await asyncio.sleep(10)
                p = self._procs.get(job_id)
                if p and p.returncode is None:
                    try:
                        os.killpg(os.getpgid(p.pid), signal.SIGKILL)
                    except Exception:
                        self.hub.publish_bench_progress(job)
            asyncio.get_running_loop().create_task(killer())
        return True

    # ------------- lookups -------------
    async def list(self, limit: int = 40) -> list[BenchJob]:
        rows = await self.db.fetch_all(
            "SELECT * FROM bench_jobs ORDER BY created DESC LIMIT ?", (int(limit),))
        return [_job_from_row(r) for r in rows]

    async def get(self, job_id: str) -> BenchJob | None:
        job = self._jobs.get(job_id)
        if job:
            return job
        row = await self.db.fetch_one("SELECT * FROM bench_jobs WHERE id=?", (job_id,))
        return _job_from_row(row) if row else None

    # ------------- results -------------
    async def load_result(self, job_id: str, refresh: bool = False) -> dict | None:
        job = await self.get(job_id)
        if not job or not job.result_path:
            return None
        path = Path(job.result_path)
        if not path.exists():
            return None
        try:
            js = json.loads(path.read_text())
        except Exception:
            return {"invalid": True, "path": str(path)}
        s = summarize(js)
        if refresh:
            job.summary = s
            await self._persist(job)
        return s

    async def raw_result(self, job_id: str) -> dict | None:
        job = await self.get(job_id)
        if not job or not job.result_path:
            return None
        path = Path(job.result_path)
        if not path.exists():
            return None
        return json.loads(path.read_text())

    async def tail(self, job_id: str, lines: int = 400) -> list[str]:
        logf = self.root / job_id / "bench.log"
        if logf.exists():
            return logf.read_text(errors="replace").splitlines()[-lines:]
        return []

    # ------------- history / reports -------------
    async def repo_history(self, limit: int = 60) -> list[dict]:
        """Parse *.json artifacts sitting beside the tool (operator's own runs)."""
        brd = self.bench_repo_dir()
        out: list[dict] = []
        if not brd:
            return out
        candidates = sorted(brd.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for path in candidates[:max(limit * 6, 60)]:
            if "resume" in path.name or "completed_profile" in path.name:
                continue
            try:
                js = json.loads(path.read_text())
            except Exception:
                continue
            if not isinstance(js, dict) or ("summary_table" not in js and "metadata" not in js):
                continue
            summary = summarize(js)
            summary["path"] = str(path)
            out.append({
                "job_id": None, "source": "repo", "path": str(path),
                "label": path.stem, "ts": int(path.stat().st_mtime * 1000),
                "summary": summary,
            })
            if len(out) >= limit:
                break
        return out

    async def write_report(self, job_id: str) -> dict:
        job = await self.get(job_id)
        if not job:
            return {"rc": 1, "error": "no such job"}
        raw = await self.raw_result(job_id)
        if not raw:
            return {"rc": 1, "error": "no result file yet"}
        s = summarize(raw)
        # next run number
        nn = 1
        names = []
        for pat_dir in (self.root.parent, self.bench_repo_dir() and self.bench_repo_dir().parent / "runs"):
            if pat_dir and Path(pat_dir).exists():
                names += [p.name for p in Path(pat_dir).glob("run-*.md")]
        for name in names:
            m = re.match(r"run-(\d+)", name)
            if m:
                nn = max(nn, int(m.group(1)) + 1)
        fname = f"run-{nn:02d}-{_safe_name(job.label)}.md"
        out_path = self.root / fname
        lines = [
            f"# run-{nn:02d} — {job.label}",
            "",
            f"- target: `{job.host}:{job.port}` ({job.model})",
            f"- profile: `{job.profile_key or '—'}` · cluster `{job.cluster_id}`",
            f"- kv budget: {s['kv_budget']} · engine: {s['engine']} · server url: {s['server_url']}",
            f"- gates: concurrency {s['concurrency_levels']} · contexts {s['context_lengths']}",
            "",
            "## Aggregate decode tok/s",
            "",
            "| ctx \\ conc | " + " | ".join(str(c) for c in sorted({g['conc'] for g in s['grid']})) + " |",
            "|---" * (len({g['conc'] for g in s['grid']}) + 1) + "|",
        ]

        def cell(ctx, conc):
            for g in s["grid"]:
                if g["ctx"] == ctx and g["conc"] == conc:
                    return f"{g['tps']:.1f}" if g["tps"] else "—"
            return "—"

        for ctx in s["context_lengths"]:
            lines.append("| " + str(ctx) + " | " + " | ".join(cell(ctx, c) for c in sorted({g['conc'] for g in s['grid']})) + " |")
        lines += ["", "## Prefill"] + [
            f"- {p['ctx']}: {p['tok_per_sec']:.0f} tok/s (ttft {p['ttft_s']:.2f}s)" for p in s["prefill"]]
        if s["c1"]:
            lines += ["", f"best C=1: {s['c1']['tps']:.1f} tok/s @ ctx {s['c1']['ctx']}"]
        if s["best"]:
            lines += [f"best overall: {s['best']['tps']:.1f} tok/s @ ctx {s['best']['ctx']} C={s['best']['conc']}"]
        if s.get("spec_accept_avg"):
            lines += [f"avg spec accept len: {s['spec_accept_avg']}"]
        out_path.write_text("\n".join(lines) + "\n")
        wrote_repo = None
        try:
            ref = getattr(self._settings_ref, "settings", None)
            if ref and ref.bench.write_repo_runs and self.bench_repo_dir():
                runs = self.bench_repo_dir().parent / "runs"
                runs.mkdir(exist_ok=True)
                (runs / fname).write_text("\n".join(lines) + "\n")
                wrote_repo = str(runs / fname)
        except Exception as exc:
            return {"rc": 0, "path": str(out_path), "repo_error": str(exc)}
        return {"rc": 0, "path": str(out_path), "repo_path": wrote_repo}

    # ------------- persistence -------------
    async def _persist(self, job: BenchJob) -> None:
        self._jobs[job.id] = job
        row = (
            job.id, job.cluster_id, job.profile_key, job.label, job.host, job.port, job.model,
            job.args.model_dump_json(), job.state, job.created, job.started, job.finished,
            job.exit, job.result_path, job.log_path,
            jdumps(job.summary) if job.summary else None,
        )
        await self.db.execute(
            "INSERT OR REPLACE INTO bench_jobs(id,cluster_id,profile_key,label,host,port,model,"
            "args,state,created,started,finished,exit,result_path,log_path,summary)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", row)


class contextlib_suppress:
    def __enter__(self):
        return self

    def __exit__(self, *a) -> bool:
        return True


def _to_text(line) -> str:
    return line.decode(errors="replace") if isinstance(line, bytes) else line


def _safe_name(label: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", (label or "run").strip())[:48] or "run"


def _csv(s: str) -> str:
    return ",".join(x.strip() for x in s.split(",") if x.strip())


def shlex_split(s: str) -> list[str]:
    import shlex

    try:
        return shlex.split(s)
    except ValueError:
        return [s]


def _cmdline(argv: list[str]) -> str:
    import shlex

    return " ".join(shlex.quote(a) for a in argv)


def _send_sigint(proc: asyncio.subprocess.Process) -> None:
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGINT)
    except Exception:
        try:
            proc.send_signal(signal.SIGINT)
        except Exception:
            pass


def _final_state(job: BenchJob) -> str:
    path = Path(job.result_path or "")
    if not path.exists():
        return "error"
    try:
        js = json.loads(path.read_text())
    except Exception:
        return "error"
    if not js.get("summary_table"):
        return "error"
    return "ok"


def checkpoint_summary(path: Path | None) -> dict | None:
    """Parse the per-cell checkpoint for live progress (or partial recovery)."""
    if not path or not path.exists():
        return None
    try:
        js = json.loads(path.read_text())
    except Exception:
        return None
    cells = []
    for r in js.get("results") or []:
        if not isinstance(r, dict):
            continue
        cells.append({
            "ctx": r.get("context_tokens"), "conc": r.get("concurrency"),
            "tps": r.get("aggregate_tps"), "ttft_p50": r.get("ttft_p50"),
            "capacity_limited": bool(r.get("capacity_limited")),
            "loop_detected": bool(r.get("loop_detected")),
        })
    valid = [c for c in cells if c["tps"] and c["tps"] > 0]
    return {
        "engine": (js.get("signature") or {}).get("model", "…") and "partial",
        "model": (js.get("signature") or {}).get("model"),
        "grid": cells, "cells": len(cells),
        "best": max(valid, key=lambda c: c["tps"]) if valid else None,
        "partial": True,
    }


def summarize(js: dict) -> dict:
    md = js.get("metadata", {}) or {}
    grid: list[dict] = []
    st = js.get("summary_table") or {}
    for ctx, per in st.items():
        if not isinstance(per, dict):
            continue
        for conc, tps in per.items():
            grid.append({"ctx": int(ctx) if str(ctx).isdigit() else ctx,
                         "conc": int(conc), "tps": None if tps in (None, -1, -3, -4) else tps})
    valid = [g for g in grid if g["tps"] is not None]
    best = max(valid, key=lambda g: g["tps"]) if valid else None
    c1 = [g for g in grid if g["conc"] == 1 and g["tps"] is not None]
    c1_best = max(c1, key=lambda g: g["tps"]) if c1 else None

    prefill_rows = []
    for ctx, pr in (js.get("prefill") or {}).items():
        if isinstance(pr, dict) and pr.get("tok_per_sec"):
            prefill_rows.append({
                "ctx": int(ctx) if str(ctx).isdigit() else ctx,
                "tok_per_sec": pr.get("tok_per_sec"),
                "ttft_s": pr.get("ttft_seconds"),
                "prompt_tokens": pr.get("prompt_tokens"),
            })
    spec_lens = [r.get("server_spec_accept_length") for r in (js.get("results") or [])]
    spec_lens = [s for s in spec_lens if s]
    spec_avg = (sum(spec_lens) / len(spec_lens)) if spec_lens else None
    coding = (js.get("coding_peak") or {}).get("summary") or {}
    diag = (js.get("startup_diagnostics") or {})
    return {
        "engine": md.get("engine"),
        "model": md.get("model"),
        "server_url": diag.get("server_url") or md.get("server"),
        "concurrency_levels": md.get("concurrency_levels") or [],
        "context_lengths": md.get("context_lengths") or [],
        "kv_budget": md.get("kv_budget"),
        "grid": sorted(grid, key=lambda g: (str(g["ctx"]), g["conc"])),
        "best": best,
        "c1": c1_best,
        "prefill": prefill_rows,
        "spec_accept_avg": round(spec_avg, 3) if spec_avg else None,
        "coding_peak": coding or None,
        "cells": len(js.get("results") or []),
    }


def _job_from_row(r) -> BenchJob:
    return BenchJob(
        id=r["id"], cluster_id=r["cluster_id"], profile_key=r["profile_key"],
        label=r["label"], host=r["host"], port=r["port"], model=r["model"],
        args=BenchArgs.model_validate(jloads(r["args"], {})),
        state=r["state"], created=r["created"], started=r["started"],
        finished=r["finished"], exit=r["exit"], result_path=r["result_path"],
        log_path=r["log_path"], summary=jloads(r["summary"], None),
    )
