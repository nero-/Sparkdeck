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
