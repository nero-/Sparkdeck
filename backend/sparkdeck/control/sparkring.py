"""SparkRing control layer — wraps the operator's `sparkring.sh` console for
the GLM-5.3 Flash TP4/DCP1 managed mesh.

OPERATIONS invariants honored here:
- Model/mesh lifecycle happens ONLY through the managed suite verbs
  (up/start/ready/stop/down/recover/status/logs/native-check) — never direct
  docker/routing surgery.
- start == model start + automatic readiness wait; every action writes a
  timestamped plan/apply receipt under <state-dir> which we surface in op logs.
- The script auto-selects the newest `runtime*/prepared.json` — no edits
  needed after image swaps.
- `sparkring doctor --verify` runs on r0 (node-local PATH addition).
"""

from __future__ import annotations

import json
import re
from pathlib import Path


class SparkringVerbs:
    """Console command strings for one cluster (control dict in, shell out)."""

    _FLAGS = {
        "start": "--allow-model-actions",
        "stop": "--allow-model-actions",
        "down": "--allow-model-actions",
        "recover": "--allow-model-actions",
        "native-check": "--allow-hardware-tests",
    }

    def __init__(self, control: dict) -> None:
        self.control = control
        self.serve_dir = (control.get("serve_dir") or "~/Builds/sparkring-deploy").strip()
        self.launcher = (control.get("launcher") or "sparkring.sh").strip()

    # ---------- command builders ----------
    def cd(self) -> str:
        return f"cd {self.serve_dir} 2>&1"

    def console(self, verb: str, extra: str = "") -> str:
        flag = self._FLAGS.get(verb, "")
        parts = f"{self.cd()} && ./{self.launcher} {verb}"
        if flag:
            parts += f" {flag}"
        if extra:
            parts += f" {extra}"
        return parts + " 2>&1"

    def native_check(self) -> str:
        return f"{self.cd()} && ./{self.launcher} native-check --allow-hardware-tests 2>&1"

    def ready(self) -> str:
        return self.console("ready")

    def doctor_verify(self, head_alias: str = "gx10-r0") -> str:
        return (
            f"ssh -o ConnectTimeout=8 {head_alias} "
            "'PATH=$HOME/.local/bin:$PATH; sparkring doctor --verify' 2>&1"
        )

    @staticmethod
    def container_for_rank(rank: int) -> str:
        return f"glm-tp4-r{rank}"

    @staticmethod
    def rank_containers() -> list[str]:
        return [f"glm-tp4-r{i}" for i in range(4)]

    def docker_logs_follow(self, rank: int, lines: int = 200) -> str:
        return (
            f"docker logs --tail {lines} -f {self.container_for_rank(rank)} 2>&1"
        )

    def shim_node_env(self) -> str:
        """PATH bump used for node-local probes (the suite's binaries may live
        in ~/.local/bin on the hosts)."""
        return 'PATH="$HOME/.local/bin:$PATH"'


def extract_receipt_path(line: str) -> str | None:
    """The console echoes `==> applying: <verb> (sha256 …)` and prints the
    receipt path (run_action's final echo). Grab the last path-ish token that
    ends in -receipt.json (or its plan twin)."""
    m = re.search(r"(\S+-\d{8}-\d{6}\.json)(?:-receipt\.json)?", line)
    if m is None:
        return None
    p = m.group(1)
    if p.endswith("-receipt.json"):
        return p
    return p + "-receipt.json"


def summarize_receipt(text: str) -> dict:
    """Parse `sparkring.sh`-style receipt output snippets into a small dict
    for the op timeline: complete, actions_ok, per-action state/rc."""
    out: dict = {"actions": {}, "complete": None}
    try:
        data = json.loads(text)
        if isinstance(data, dict) and "actions" in data:
            out["complete"] = bool(data.get("complete"))
            for key, v in (data.get("actions") or {}).items():
                r = v.get("result") or {}
                out["actions"][key] = {
                    "state": v.get("state"),
                    "rc": r.get("returncode"),
                    "seconds": r.get("seconds"),
                }
            return out
    except Exception:
        pass
    m = re.search(r"complete=(\w+)\s+actions_ok=(\w+)", text)
    if m is not None:
        out["complete"] = m.group(1).lower() == "true"
        out["actions_ok"] = m.group(2).lower() == "true"
    for line in text.splitlines():
        m2 = re.match(r"\s*\[([^\]]+)\] state=(\w+) rc=(-?\d+)?", line)
        if m2 is not None:
            out["actions"][m2.group(1)] = {
                "state": m2.group(2), "rc": int(m2.group(3)) if m2.group(3) else None,
            }
    return out


def parse_liveness(body: str) -> dict:
    """GET :8016/liveness → small dict of the console-relevant gauges."""
    try:
        d = json.loads(body)
    except Exception:
        return {}
    if not isinstance(d, dict):
        return {}
    keys = ("healthy", "running_requests", "kv_cache_usage", "blocked_seconds",
            "output_stalled_seconds", "queue_depth", "model", "version")
    return {k: d[k] for k in keys if k in d}


def liveness_healthy(lv: dict) -> bool:
    return lv.get("healthy") is True
