"""Runtime knobs for the sparkdeck process itself (host/port/token/mock).

Persistent state lives in the SQLite store; this module is only the process
bootstrap configuration (CLI/env), so operators can retarget it without
editing data.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _default_data_dir() -> Path:
    override = os.environ.get("SPARKDECK_DATA_DIR")
    if override:
        return Path(override).expanduser()
    base = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")).expanduser()
    return base / "sparkdeck"


@dataclass(slots=True)
class RuntimeConfig:
    host: str = "127.0.0.1"
    port: int = 8936
    mock: bool = False
    data_dir: Path = Path.home() / ".local" / "share" / "sparkdeck"
    verbose: bool = False

    @property
    def db_path(self) -> Path:
        return self.data_dir / "sparkdeck.sqlite3"

    @property
    def runtime_dir(self) -> Path:
        return self.data_dir / "runtime"   # op logs, bench artifacts, tmp

    @property
    def token(self) -> str | None:
        tok = os.environ.get("SPARKDECK_TOKEN")
        return tok or None

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)


def load_config() -> RuntimeConfig:
    cfg = RuntimeConfig(data_dir=_default_data_dir())
    host = os.environ.get("SPARKDECK_HOST")
    port = os.environ.get("SPARKDECK_PORT")
    if host:
        cfg.host = host
    if port and port.isdigit():
        cfg.port = int(port)
    cfg.mock = os.environ.get("SPARKDECK_MOCK", "0") not in ("", "0", "false")
    cfg.verbose = os.environ.get("SPARKDECK_VERBOSE", "0") not in ("", "0", "false")
    cfg.ensure_dirs()
    return cfg
