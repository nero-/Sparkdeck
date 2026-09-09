"""TP2-pair control adapter: builds the exact remote verb commands that the
operator's proven pairctl.sh performs — driving each node's own
glm53_pair_serve.sh launcher (single source of truth on the host).

Semantics preserved: preflight (swappiness→0 + drop_caches), RoCE GID
re-check with auto-fix, stale teardown, worker-first start order, health
wait on the head's node-local API, startup verify markers.
"""

from __future__ import annotations

import shlex


def q(s: str) -> str:
    return shlex.quote(s)


class Tp2Verbs:
    """Cluster-config → remote command strings."""

    def __init__(self, control: dict, node: dict) -> None:
        # control/serve_dir/launcher from ClusterControl; node gives env_rank
        self.control = control
        self.node = node

    # ---------- names ----------
    def env_file(self, profile_key: str, env_rank: int | None = None) -> str:
        rank = self.node.get("env_rank", 0) if env_rank is None else env_rank
        return f"rank-{rank}-{profile_key}.env"

    def serve_dir_cmd(self) -> str:
        return f"cd {q(self.control['serve_dir'])}"

    def launcher(self) -> str:
        return f"bash {q(self.control['launcher'])}"

    # ---------- verbs ----------
    def run_head(self, profile_key: str, extra: str = "") -> str:
        env = self.env_file(profile_key, self.node.get("env_rank"))
        return f"{self.serve_dir_cmd()} && {self.launcher()} --run {q(env)} {extra} 2>&1"

    def run_worker(self, profile_key: str, extra: str = "") -> str:
        return self.run_head(profile_key, extra)  # same shape; ordering is engine's job

    def down(self, profile_key: str | None = None) -> str:
        env = self.env_file(profile_key) if profile_key else None
        base = f"{self.serve_dir_cmd()} && {self.launcher()} --down"
        if env:
            base += f" {q(env)}"
        return base + " 2>&1"

    def status(self, profile_key: str | None = None) -> str:
        env = self.env_file(profile_key) if profile_key else None
        base = f"{self.serve_dir_cmd()} && {self.launcher()} --status"
        if env:
            base += f" {q(env)}"
        return base + " 2>&1"

    def check(self, profile_key: str) -> str:
        return f"{self.serve_dir_cmd()} && {self.launcher()} --check {q(self.env_file(profile_key))} 2>&1"

    def verify(self, profile_key: str) -> str:
        return f"{self.serve_dir_cmd()} && {self.launcher()} --verify {q(self.env_file(profile_key))} 2>&1"

    def logs_tail(self, profile_key: str, follow: bool = True, lines: int = 200) -> str:
        env = self.env_file(profile_key)
        if follow:
            return f"cd {q(self.control['serve_dir'])} && {self.launcher()} --logs {q(env)} 2>&1"
        return (
            f"docker logs --tail {int(lines)} $(docker ps -aq --filter name=glm 2>/dev/null | head -1) 2>&1"
        )

    def health_poll(self) -> str:
        port = self.node.get("api_port", 8000)
        return f"curl -fsS -m 4 http://127.0.0.1:{int(port)}/health >/dev/null 2>&1; echo $?"

    def kv_marker(self) -> str:
        """Extract boot-time KV pool size (tokens) from the head container log."""
        return (
            "docker logs $(docker ps --filter name=glm --format '{{.Names}}' | head -1) 2>&1 | "
            "grep -m1 -Eo 'GPU KV cache size: [0-9,]+' | grep -Eo '[0-9,]+' | tr -d ',' || true"
        )

    def container_list(self) -> str:
        return ("docker ps -a --format '{{json .}}' --filter name=glm 2>&1 || docker ps -a --format '{{json .}}' 2>&1")

    def docker_stats(self, minutes: int = 0) -> str:
        return "docker stats --no-stream --format '{{json .}}' 2>&1 | head -6"

    def image_list(self, glob: str = "local/vllm:*") -> str:
        return f"docker images --format '{{{{json .}}}}' --filter reference={q(glob)} 2>&1"

    def env_grep_image(self, profile_key: str) -> str:
        f = self.control["serve_dir"] + "/" + self.env_file(profile_key)
        return f"grep -E '^(SERVING_IMAGE)=' {q(f)} 2>/dev/null | cut -d= -f2-"

    def env_cat(self, profile_key: str) -> str:
        return f"{self.serve_dir_cmd()} && {self.launcher()} --check {q(self.env_file(profile_key))} >/dev/null 2>&1 && cat {q(self.control['serve_dir'] + '/' + self.env_file(profile_key))}"

    def show_gids(self, hca: str, ip: str) -> str:
        return "show_gids 2>&1"

    def preflight_swappiness_check(self) -> str:
        return "cat /proc/sys/vm/swappiness 2>/dev/null || echo 60"

    def preflight_swappiness_fix(self) -> str:
        return "sysctl vm.swappiness=0"

    def preflight_drop_caches(self) -> str:
        return "sync; echo 3 > /proc/sys/vm/drop_caches"

    def uptime_and_boot(self) -> str:
        return "cat /proc/uptime; echo ---; uname -r"

    def systemd_collector_probe(self) -> str:
        return "python3 -V; command -v docker >/dev/null && echo docker-ok || echo docker-missing; command -v nvidia-smi >/dev/null && echo nvidia-ok || echo nvidia-missing"


def gid_check_script(serve_dir: str, env_file: str, hca_default: str = "rocep1s0f1") -> str:
    """The pairctl fix_gid logic, as a single remote shell script."""
    return f"""
cd {q(serve_dir)} || exit 1
file={q(env_file)}
hca=$(grep -U '^[[:space:]]*NCCL_IB_HCA=' $file | tail -1 | cut -d= -f2 | tr -d '[:space:]')
ip=$(grep -U '^[[:space:]]*VLLM_HOST_IP=' $file | tail -1 | cut -d= -f2 | tr -d '[:space:]')
[ -z "$hca" ] && hca={q(hca_default)}
set_idx=$(grep -U '^[[:space:]]*NCCL_IB_GID_INDEX=' $file | tail -1 | cut -d= -f2 | tr -d '[:space:]')
live_idx=$(show_gids 2>/dev/null | awk -v h="$hca" -v i="$ip" '$1==h && $5==i && $6=="v2" {{print $3}}' | head -1)
if [ -z "$live_idx" ]; then
  echo "SPARKDECK-GID: ERROR no RoCEv2 GID row for HCA=$hca IP=$ip (fabric down or IP changed?)"
  exit 3
fi
if [ -n "$set_idx" ] && [ "$live_idx" != "$set_idx" ]; then
  sed -i "s/^NCCL_IB_GID_INDEX=.*/NCCL_IB_GID_INDEX=$live_idx/" $file
  echo "SPARKDECK-GID: changed $set_idx -> $live_idx (fixed $file)"
else
  echo "SPARKDECK-GID: OK index=$live_idx"
fi
""".strip()
