"""Sudo password acquisition + privileged command execution, matching the
pairctl conventions.

Resolution order (never persisted beyond the operator's existing caches):
1. `PAIR_SUDO_PASSWORD` env var on the sparkdeck process,
2. `~/.pair-sudo` (pairctl's cached password, chmod 600),
3. session password supplied in-UI (memory only, TTL),
4. else ops that need sudo return error code `sudo_required` and the UI
   prompts; the password POSTed to `/api/system/sudo` lives in RAM only.

Execution strategy: try passwordless sudo first (`-n`), then `sudo -S -k`
with the resolved password. Never logs the password.
"""

from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path


def shquote(s: str) -> str:
    return "'" + s.replace("'", "'\\''") + "'"


class NoSudo(Exception):
    pass


class SudoStore:
    def __init__(self, ttl_s: float = 4 * 3600) -> None:
        self._session: dict[str, str] = {}
        self._seen: dict[str, float] = {}
        self._ttl = ttl_s

    def has_session(self, key: str = "pair") -> bool:
        v = self._session.get(key)
        if not v:
            return False
        if time.time() - self._seen.get(key, 0) > self._ttl:
            self._session.pop(key, None)
            return False
        return True

    @staticmethod
    def env_password() -> str:
        return os.environ.get("PAIR_SUDO_PASSWORD", "")

    @staticmethod
    def cached_file_password() -> str:
        p = Path.home() / ".pair-sudo"
        try:
            if p.exists():
                data = p.read_text().strip()
                if data:
                    return data
        except Exception:
            pass
        return ""

    def available(self) -> bool:
        return bool(self.env_password()) or bool(self.cached_file_password()) or self.has_session()

    def source(self) -> str:
        if self.env_password():
            return "env"
        if self.cached_file_password():
            return "pair-sudo"
        if self.has_session():
            return "session"
        return "none"

    def current(self, key: str = "pair") -> str | None:
        for getter in (self.env_password, self.cached_file_password):
            v = getter()  # type: ignore[operator]
            if v:
                return v
        return self._session.get(key)

    def set_session(self, password: str, key: str = "pair") -> None:
        if not password:
            self._session.pop(key, None)
            self._seen.pop(key, None)
            return
        self._session[key] = password
        self._seen[key] = time.time()

    def clear(self) -> None:
        self._session.clear()
        self._seen.clear()


SUDO: SudoStore = SudoStore()

_EXEC_TIMEOUT = 60.0


async def sudo_run(conn, cmd: str, password: str | None = None, timeout: float = _EXEC_TIMEOUT) -> tuple[int, str, str]:
    """Run a privileged command. Returns (exit, combined_out, stderr_marked)."""
    # 1) passwordless attempt (host-side sudo timestamp may already be cached)
    try:
        res = await asyncio.wait_for(
            conn.run(f"sudo -n -p '' sh -c {shquote(cmd)}"), timeout
        )  # type: ignore[attr-defined]
        if res.exit_status == 0:
            return 0, res.stdout or "", res.stderr or ""
    except Exception:
        pass

    pw = password or SUDO.current()
    if not pw:
        raise NoSudo(cmd)
    # 2) interactive -S with supplied password
    res = await asyncio.wait_for(
        conn.run(
            f"sudo -S -p '' -k sh -c {shquote(cmd)}",
            input=pw + "\n",
        ),
        timeout,
    )  # type: ignore[attr-defined]
    return res.exit_status, res.stdout or "", res.stderr or ""
