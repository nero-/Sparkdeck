"""Local exec runtime — same surface as SSHRuntime, but runs commands on the
CONTROLLER host (asyncio subprocesses). SparkRing cluster lifecycle lives on
the controller (sparkring.sh drives the managed mesh over SSH itself), so the
op engine addresses it through this runtime instead of a per-node SSH session.
"""

from __future__ import annotations

import asyncio
import signal
import time
from pathlib import Path
from typing import Callable, Sequence

from ..ssh.pool import ExecResult


class LocalRuntime:
    kind = "local"

    def __init__(self, name: str = "console") -> None:
        self.name = name
        self.state = "online"
        self.collector = "none"

    async def stop(self) -> None:  # parity with the runtime interface
        return None

    def snapshot(self) -> dict:
        return {
            "node_id": self.name, "cluster_id": "", "state": "online",
            "addr_used": "127.0.0.1", "conn_since": int(time.time() * 1000),
            "collector": "none", "last_sample_ts": None, "attempts": [],
            "unverified": False,
        }

    # ---------------- exec ----------------
    async def exec(self, argv: Sequence[str] | str, *, timeout: float = 120.0,
                   env: dict | None = None) -> tuple[int, str, str]:
        import os as _os

        joined = argv if isinstance(argv, str) else " ".join(argv)
        env_map: dict | None = None
        if env:
            env_map = _os.environ.copy()
            env_map.update({k: v for k, v in env.items() if v is not None})
        proc = await asyncio.create_subprocess_shell(
            joined,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,  # merged — mirrors the SSH conventions
            start_new_session=True,
            env=env_map,
        )
        try:
            out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        except asyncio.TimeoutError:
            with_cancel(proc)
            return ExecResult(124, "", f"timeout after {timeout:g}s")
        return ExecResult(proc.returncode or 0, out.decode("utf-8", "replace"), "")

    async def sudo_exec(self, argv: Sequence[str] | str, *, password: str | None = None,
                        timeout: float = 120.0) -> tuple[int, str, str]:
        return await self.exec(argv, timeout=timeout, env=None)

    async def stream_exec(self, cmd: Sequence[str] | str, *, timeout: float = 36000.0,
                          on_line: Callable[[str], None] | None = None,
                          stop_hints: tuple[str, ...] = (),
                          cancelled: Callable[[], bool] | None = None) -> tuple[int, str]:
        """Spawn locally, stream merged stdout+stderr line-wise. Returns
        (rc, tail) like SSHRuntime. Cancel via `cancelled` poll or by the
        caller cancelling the task (SIGINT to the process group)."""
        joined = cmd if isinstance(cmd, str) else " ".join(cmd)
        proc = await asyncio.create_subprocess_shell(
            joined,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        buf: list[str] = []
        deadline = time.monotonic() + timeout + 5

        async def reader() -> None:
            assert proc.stdout is not None
            while True:
                raw = await proc.stdout.readline()
                if not raw:
                    return
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
                buf.append(line)
                if len(buf) > 8000:
                    del buf[:4000]
                if on_line is not None:
                    on_line(line)

        rt = asyncio.create_task(reader())
        try:
            while proc.returncode is None:
                await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=0.5)
                if cancelled is not None and cancelled():
                    signal_group(proc, signal.SIGINT)
                    await _await_exit(proc, 10.0)
                    if proc.returncode is None:
                        signal_group(proc, signal.SIGKILL)
                    return 130, "\n".join(buf[-500:])
                if any(h in "\n".join(buf[-40:]) for h in stop_hints):
                    signal_group(proc, signal.SIGINT)
                    await _await_exit(proc, 5.0)
                    return 0, "\n".join(buf[-500:])
                if time.monotonic() > deadline:
                    signal_group(proc, signal.SIGKILL)
                    return 124, "\n".join(buf[-500:])
        except asyncio.CancelledError:
            signal_group(proc, signal.SIGINT)
            await _await_exit(proc, 10.0)
            if proc.returncode is None:
                signal_group(proc, signal.SIGKILL)
            return 130, "\n".join(buf[-500:])
        rt.cancel()
        try:
            await rt
        except Exception:
            pass
        return proc.returncode or 0, "\n".join(buf[-500:])

    async def upload_file(self, content: bytes, remote_path: str) -> None:
        Path(remote_path).expanduser().write_bytes(content)


def signal_group(proc: asyncio.subprocess.Process, sig: signal.Signals) -> None:
    try:
        import os as _os

        _os.killpg(_os.getpgid(proc.pid), sig)
    except Exception:
        try:
            proc.send_signal(sig)
        except Exception:
            pass


async def _await_exit(proc: asyncio.subprocess.Process, timeout: float) -> None:
    try:
        await asyncio.wait_for(asyncio.shield(proc.wait()), timeout=timeout)
    except Exception:
        pass


def with_cancel(proc) -> None:
    try:
        signal_group(proc, signal.SIGKILL)
    except Exception:
        pass
