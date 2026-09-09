# Changelog

## 1.0.0 — 2026-09-07 "public release"

First public release of the unified DGX Spark / ASUS Ascent GX10 pair
controller & operator console (GLM-5.3-Flash TP2 scope).

- Live monitoring: GPU temp/power/clocks/util, GB10 unified-memory envelope,
  per-core CPU + PSI, per-interface network (fabric/tailscale/LAN/docker),
  disks, thermal zones, per-container docker stats, curated vLLM engine
  metrics (both v0/v1 metric-name generations), swappable series and window
  chips (5m→7d), local layered history (2s rings → 10s raw → 1m/10m rollups).
- Cluster control mirroring pairctl semantics: preflight (drop_caches +
  swappiness 0), RoCE GID check/auto-fix, stale teardown, worker-first start,
  health wait, `--verify`, boot-time KV-pool capture; streamed op console
  (step chips, logs, cancel) with full audit + events.
- Live LLM view + streaming chat console (relay-timed TTFT/TPS) + request log.
- Integrated `llm-inference-bench` runner (checkpoint resumes, live per-cell
  progress, cancel-safe, summary grids, repo-run history import, reports).
- Engine/image management: drift-highlighted env table, SERVING_IMAGE rewrite
  with preview + confirmation, fabric copy, detached builds with logs.
- Multi-cluster topology editor with per-node ordered address failover
  (LAN → fabric → Tailscale → custom), SSH alias/user/port per node,
  sudo-password session cache honoring `PAIR_SUDO_PASSWORD` / `~/.pair-sudo`.
- Alerts (memory envelope, thermals, restarts, webhook), security (token,
  bind), mock world for offline demos/tests (`SPARKDECK_MOCK=1`).

## 1.1.0 — 2026-09-08 "SparkRing edition"

- **New topology**: the two TP2 pairs are consolidated into ONE four-node
  SparkRing (GLM-5.3 Flash TP4/DCP1). Settings reseed automatically
  (topology-rev migration) while the legacy TP2 engine stays supported.
- **Ring control plane**: cluster ops now drive the managed
  `sparkring.sh` suite (up/start/ready/stop[-down]/recover/status/logs/
  native-check) with plan→apply→receipt streaming; `doctor --verify`
  preflight maps to r0; liveness (:8016) is fetched and broadcast in the
  service state (`liveness` field) and shown in the op + engine panels.
- **Model**: `glm-5.3-flash-spark` — single-seed profile `tp4-mtp3`
  (KV 24 GiB/rank fp8; ~2.28 M token pool; 1M context; native MTP3).
- **Alerts re-modeled**: memory thresholds are now percent-of-node-total
  (warn 95 %, crit 98 %) — LLM serving runs high by design, so absolute
  GiB alarm lines fired during normal operation. The mem gauge on node
  cards is anchored to the REAL memory total and now shows the used
  percentage explicitly (fixes the "percentage doesn't update" report:
  the bar asymptoted when used exceeded the old crit line).
- **Overview** is a real dashboard now: engine chips per cluster (model,
  uptime, decode/prefill, TTFT, spec accept, KV usage, queue, blocked),
  last bench run (best cell, C1, prefill, spec), live image state and log
  quick-links — one slice from every tab.
- Bench defaults auto-detect the tool at `~/Builds` root;
  `SPARKDECK_BENCH_DIR` and `SPARKDECK_SPARKRING_DIR` env overrides added.
