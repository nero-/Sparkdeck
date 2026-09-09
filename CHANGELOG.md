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

## 1.2.0 — 2026-09-08 "console-in-your-shell + perf"

- **CLI verbs**: `sparkdeck start|stop|down|ready|verify|check|preflight|
  status|liveness|native-check|logs|prompt` drive the running controller
  through the API (audited ops, streamed progress, proper exit codes). 
  `SPARKDECK_URL` or `--host` reach a controller on another machine; without
  a controller the CLI fails with a clear hint instead of bypassing audits.
- **Perf: node cards stop re-rendering on every tick.** Cards now subscribe
  to single PRIMITIVES (gpu.util, mem.used_gib…, container names via
  shallow-compare) instead of whole sample frames, and are memo()'d — the
  browser-lag report ("almost crashing") came from every WS sample tick
  re-rendering every card. Updates now fire only when displayed values move.
- **Gauge text**: the GPU gauge's big value no longer overlays the ring on
  node cards — it renders below the ring in small mono.
- **Fix — memory bars frozen/identical**: real ring frames carry
  `mem.avgail/used` but no `mem.total_gib`; the collector now maps MemTotal,
  and the card falls back to used+avail (exact for GB10 unified memory).
  Bars are anchored to the true total again, and per-node since data flows.
- **Collector**: container filter broadened `glm53` → `glm` so SparkRing
  containers (`glm-tp4-rN`) appear in docker stats; deploy sha bumps
  automatically on first connect.
- **Alerts**: swap warn threshold raised to 4 GiB (SparkRing nodes sustain
  2–4 GiB of swap while resident — the 0.5 GiB default spammed events).
- Engine probes now treat `{data: []}` model lists as "still loading" and
  wait (the mock + real behavior now aligned).
