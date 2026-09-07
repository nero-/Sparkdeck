"""Long-lived SSH connections per node with ordered address failover.

One `SSHRuntime` per enabled node:
  * keeps an asyncssh connection, trying each address in declaration order
    (LAN → fabric → Tailscale), plus optional ssh-config alias first
  * exec-on-demand with timeout capture; sudo via ssh.sudo
  * persistent streaming (collector NDJSON feed; container log follows)
  * collector deploy (SFTP, cat fallback) driven by content sha
  * reconnect with backoff; state changes are callbacks to the WS hub
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

import asyncssh

from .sudo import shquote

log = logging.getLogger("sparkdeck.ssh")

CONNECT_TIMEOUT_S = 8.0
KEEPALIVE_S = 12
BACKOFF = (1, 2, 5, 10, 20, 45, 90)

OnState = Callable[[str, dict], None]
OnSample = Callable[[str, dict], None]
OnStreamLine = Callable[[str, str], None]  # stream_key, line


class NodeUnreachable(Exception):
    pass


@dataclass
class ExecResult:
    exit: int | None
    stdout: str
    stderr: str


@dataclass
class AddressAttempt:
    addr: str
    ok: bool
    error: str = ""


def _home_ssh(name: str) -> Path:
    return Path.home() / ".ssh" / name


class SSHRuntime:
    def __init__(
        self,
        node_id: str,
        cluster_id: str,
        cfg: dict,
        on_state: OnState,
        on_sample: OnSample,
        collector_source: str,
        collector_sha: str,
        interval_s: float = 2.0,
    ) -> None:
        self.node_id = node_id
        self.cluster_id = cluster_id
        self.cfg = dict(cfg)
        self._on_state = on_state
        self._on_sample = on_sample
        self._collector_source = collector_source
        self._collector_sha = collector_sha
        self._interval = interval_s
        self._conn: asyncssh.SSHClientConnection | None = None
        self._task: asyncio.Task | None = None
        self._closing = False
        self.state: str = "connecting"
        self.collector_state: str = "unprobed"
        self.addr_used: str | None = None
        self.conn_since: int | None = None
        self.last_sample_ts: int | None = None
        self.attempts_log: list[AddressAttempt] = []
        self.unverified = False
        self._disk_cache: dict[str, tuple[float, tuple]] = {}

    # ---------------- lifecycle -------------------------------------------------
    async def start(self) -> None:
        self._closing = False
        self.state = "connecting"
        self._emit()
        self._task = asyncio.create_task(self._loop(), name=f"ssh-{self.node_id}")

    async def stop(self) -> None:
        self._closing = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
        self.state = "disabled"
        self._emit()

    def _emit(self) -> None:
        try:
            self._on_state(self.node_id, self.snapshot())
        except Exception:  # never kill the runtime for a hub hiccup
            log.exception("on_state callback failed")

    def snapshot(self) -> dict:
        return {
            "node_id": self.node_id,
            "cluster_id": self.cluster_id,
            "state": self.state,
            "addr_used": self.addr_used,
            "conn_since": self.conn_since,
            "collector": self.collector_state,
            "last_sample_ts": self.last_sample_ts,
            "attempts": [
                {"addr": a.addr, "ok": a.ok, "error": a.error} for a in self.attempts_log[-4:]
            ],
            "unverified": self.unverified,
        }

    # ---------------- connect loop ---------------------------------------------
    async def _loop(self) -> None:
        i = 0
        while not self._closing:
            try:
                await self._connect_cycle()
                i = 0
            except asyncio.CancelledError:
                return
            except (NodeUnreachable, asyncssh.Error, OSError, TimeoutError) as exc:
                log.info("node %s connect cycle failed: %r", self.node_id, exc)
            if self._closing:
                return
            self.state = "offline"
            self.addr_used = None
            self.conn_since = None
            self.collector_state = "down"
            self._emit()
            await asyncio.sleep(BACKOFF[min(i, len(BACKOFF) - 1)])
            i += 1

    def _target_attempts(self) -> list[tuple[str, int, bool]]:
        cfg = self.cfg
        port = int(cfg.get("ssh_port") or 22)
        alias = (cfg.get("ssh_alias") or "").strip()
        addrs = [a for a in (cfg.get("addresses") or []) if str(a.get("host") or "").strip()]
        attempts: list[tuple[str, int, bool]] = []
        if alias:
            attempts.append((alias, port, True))
        attempts += [(a["host"], port, False) for a in addrs]
        return attempts

    async def _connect_any(self) -> tuple[str, asyncssh.SSHClientConnection]:
        user = self.cfg.get("ssh_user") or "nero"
        cfg_file = _home_ssh("config")
        common: dict[str, Any] = dict(connect_timeout=CONNECT_TIMEOUT_S, keepalive_interval=KEEPALIVE_S)
        if cfg_file.exists():
            common["config"] = [str(cfg_file)]
        known = _home_ssh("known_hosts")
        if not known.exists():
            common["known_hosts"] = None  # nothing to verify against; TOFU below
        last_err: Exception | None = None
        self.attempts_log = []
        for host, hport, is_alias in self._target_attempts():
            # round 0: honour known_hosts; round 1: TOFU-style fallback for
            # operators who started fresh (e.g. node reimaged) — flagged.
            for round_no, use_known_hosts in ((0, True), (1, False)):
                kw: dict[str, Any] = dict(common)
                if not use_known_hosts:
                    kw["known_hosts"] = None
                    self.unverified = True
                if is_alias:
                    kw["host"] = host           # resolution fully delegated to ssh config
                else:
                    kw["host"] = host
                    kw["username"] = user
                    kw["port"] = hport
                    kw["family"] = 2            # -4: force IPv4 (mDNS/IPv6 quirk)
                try:
                    conn = await asyncio.wait_for(asyncssh.connect(**kw), CONNECT_TIMEOUT_S + 2)
                    self.attempts_log.append(AddressAttempt(addr=host, ok=True))
                    return host, conn
                except Exception as exc:  # noqa: BLE001 — failover is the feature
                    self.attempts_log.append(AddressAttempt(addr=host, ok=False, error=repr(exc)[:140]))
                    last_err = exc
                    continue
        raise NodeUnreachable(f"all addresses failed; last={last_err!r}")

    # ---------------- main cycle -------------------------------------------------
    async def _connect_cycle(self) -> None:
        self.state = "connecting"
        self._emit()
        used, conn = await self._connect_any()
        self._conn = conn
        self.addr_used = used
        self.conn_since = int(time.time() * 1000)
        self.state = "online"
        self._emit()
        log.info("node %s connected via %s", self.node_id, used)
        if self._collector_source:
            await self._ensure_collector()
        await self._run_stream()

    async def _ensure_collector(self) -> None:
        conn = self._conn
        assert conn is not None
        if not self._collector_source:
            return
        probe = await self.exec(
            "python3 -V 2>&1; [ -f ~/.sparkdeck/collector.sha ] && cat ~/.sparkdeck/collector.sha || true",
            timeout=10,
        )
        lines = [ln.strip() for ln in probe.stdout.strip().splitlines() if ln.strip()]
        pyv = lines[0] if lines and lines[0].startswith("Python") else ""
        remote_sha = ""
        for ln in lines[1:]:
            if len(ln) in (64, 63) and all(c in "0123456789abcdef" for c in ln.lower()):
                remote_sha = ln.lower()
                break
        needs = remote_sha != self._collector_sha.lower()
        self.collector_probe = {"python": pyv or "python3?", "sha": remote_sha or None}
        if needs:
            await self.upload_file("/tmp/.sparkdeck-collector.py", self._collector_source)
            cmd = (
                "mkdir -p ~/.sparkdeck && "
                f"cat /tmp/.sparkdeck-collector.py > ~/.sparkdeck/collector.py && rm -f /tmp/.sparkdeck-collector.py && "
                f"printf {shquote(self._collector_sha)} > ~/.sparkdeck/collector.sha"
            )
            res = await self.exec(cmd, timeout=20)
            if res.exit != 0:
                raise NodeUnreachable(f"collector deploy failed: {res.stderr.strip()[:200]}")
            self.collector_state = "healthy"
            log.info("collector deployed to %s (python %s)", self.node_id, pyv)
        else:
            self.collector_state = "healthy"

    async def upload_file(self, remote_path: str, content: str) -> None:
        conn = self._conn
        assert conn is not None
        try:
            async with conn.start_sftp_client() as sftp:  # type: ignore[attr-defined]
                async with sftp.open(remote_path, "wb") as f:  # type: ignore[assignment]
                    await f.write(content.encode())
            return
        except (AttributeError, asyncssh.SFTPError, OSError):
            pass
        res = await conn.run(
            f"cat > {shquote(remote_path)}", input=content
        )  # type: ignore[attr-defined]
        if res.exit_status != 0:
            raise NodeUnreachable(f"upload failed: {res.stderr}")

    async def _run_stream(self) -> None:
        conn = self._conn
        assert conn is not None
        api_port = int(self.cfg.get("api_port") or 8000)
        interest = ",".join(self.cfg.get("interest_ifaces") or [])
        containers = "glm53"  # serving container name prefix (config later)
        cmd = (
            f"exec python3 -u ~/.sparkdeck/collector.py"
            f" --interval {self._interval} --api-port {api_port}"
            f" --containers {shquote('^' + containers)}"
            f" --interest-ifaces {shquote(interest)}"
        )
        proc = await conn.create_process(cmd)  # stdout=PIPE, stderr merged (verbatim warnings are skipped by the json filter)
        err_tail: list[str] = []
        try:
            reader = proc.stdout
            while True:
                line = await reader.readline()
                if not line:
                    break
                s = line.strip()
                if not s:
                    continue
                if not s.startswith("{"):
                    err_tail.append(s)
                    if len(err_tail) > 30:
                        err_tail = err_tail[-30:]
                    continue
                try:
                    import json as _json

                    frame = _json.loads(s)
                except Exception:
                    err_tail.append(s[-160:])
                    continue
                self.last_sample_ts = int(frame.get("ts") or time.time() * 1000)
                self.collector_state = "healthy"
                self._on_sample(self.node_id, frame)
        except asyncio.CancelledError:
            pass
        except asyncssh.Error as exc:
            err_tail.append(repr(exc))
        finally:
            if self.collector_state == "healthy":
                self.collector_state = "down"
            try:
                proc.close()
            except Exception:
                pass
        if err_tail:
            log.debug("collector stderr on %s: %s", self.node_id, "\n".join(err_tail[-5:]))

    # ---------------- one-off calls ---------------------------------------------
    @property
    def conn(self):  # type: ignore[override]
        return self._conn

    async def exec(self, cmd: str, timeout: float = 30.0, stdin_data: str | None = None,
                   ) -> ExecResult:
        conn = self._conn
        if conn is None:
            raise NodeUnreachable("not connected")
        res = await asyncio.wait_for(
            conn.run(cmd, input=stdin_data, stderr="p"), timeout  # type: ignore[arg-type]
        )
        return ExecResult(res.exit_status, res.stdout or "", res.stderr or "")

    async def sudo_exec(self, cmd: str, timeout: float = 60.0) -> ExecResult:
        """Privileged execution honouring the sudo resolution order."""
        from .sudo import sudo_run

        conn = self._conn
        if conn is None:
            raise NodeUnreachable("not connected")
        exit_code, out, err = await sudo_run(conn, cmd, timeout=timeout)
        return ExecResult(exit_code, out, err)

    async def stream_exec(
        self,
        cmd: str,
        timeout: float,
        on_line: Callable[[str], None] | None = None,
        stop_hints: tuple = (),
        cancelled: Callable[[], bool] | None = None,
    ) -> int:
        """Run a command capturing stdout lines; early-stop on stop_hints text
        or cancelled(). Returns exit status (or -1 on timeout/cancel)."""
        conn = self._conn
        if conn is None:
            raise NodeUnreachable("not connected")
        proc = await conn.create_process(cmd)  # merged stderr — see note at _run_stream
        buf: list[str] = []
        exit_code: int = -1
        deadline = time.time() + timeout
        try:
            while True:
                if cancelled and cancelled():
                    exit_code = -1
                    break
                if stop_hints and any(h in chunk for chunk in buf for h in stop_hints):
                    exit_code = 0  # hint satisfied
                    break
                if time.time() > deadline:
                    exit_code = -1
                    break
                line = await proc.stdout.readline()
                if not line:
                    break
                line = line.rstrip("\r\n")
                if line and on_line:
                    on_line(line)
                buf.append(line)
                if len(buf) > 50:
                    buf = buf[-50:]
            try:
                res = await asyncio.wait_for(proc.wait(), 10)
                if exit_code == -1 and res is not None and isinstance(res, int) and res >= 0:
                    exit_code = res
            except Exception:
                pass
        finally:
            try:
                proc.close()
            except Exception:
                pass
        return exit_code

    async def stream(self, cmd: str, key: str, on_line: OnStreamLine) -> None:
        """Follow a long-running remote command's stdout until EOF."""
        conn = self._conn
        if conn is None:
            raise NodeUnreachable("not connected")
        proc = await conn.create_process(cmd, stdout="p", stderr="s")  # type: ignore[attr-defined]
        try:
            while True:
                chunk = await proc.stdout.readline()
                if not chunk:
                    break
                on_line(key, chunk.rstrip("\n"))
        finally:
            try:
                proc.close()
            except Exception:
                pass

    def probe_summary(self) -> dict:
        return {
            "state": self.state,
            "addr_used": self.addr_used,
            "attempts": [a.__dict__ for a in self.attempts_log],
            "collector_state": self.collector_state,
            "unverified": self.unverified,
            "collector_probe": getattr(self, "collector_probe", None),
        }
