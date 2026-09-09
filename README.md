# Sparkdeck

**Unified cluster controller & operator console** for the **SparkRing** GLM-5.3-Flash
TP4/DCP1 four-Spark ring (one cluster, 4×GB10, same LAN addresses as the old
TP2 pairs; legacy TP2 pair flow is still supported side by side via
Settings ▸ Clusters). Runs on the operator's machine; lifecycle goes through
the managed `sparkring.sh` suite on the controller host, per-node telemetry
speaks SSH only; installs **nothing** on the nodes except
a stdlib-only collector script (`~/.sparkdeck/collector.py`, uploaded on
first contact, sha-verified).

```
$ make setup          # venv + backend deps + editable install + web deps
$ make serve-mock     # simulated two-cluster world  → http://127.0.0.1:8936
$ make web            # build the console (web/dist, served by the backend)
$ make serve          # REAL clusters (reads $HOME/.ssh/config + keys)
$ make doctor         # read-only probe of the configured nodes
```

## What it does

| Area | Details |
|---|---|
| **Monitoring** | Live per-node metrics — GPU util/temp/power/clocks/throttle-reasons, unified-memory envelope (official GB10 rule: `/proc/meminfo` MemAvailable(+SwapFree)), per-core CPU, load, PSI, per-interface net kbit/s (LAN + CX7 fabric + tailscale), disk MB/s, thermal zones, per-serving-container docker stats, plus the full curated set of vLLM engine metrics (both v0/v1 metric-name generations). Swappable series, timescales 5m→7d, local history (2s live rings + 1m/10m rollups in SQLite with retention). |
| **Cluster control** | SparkRing lifecycle through the managed console (`sparkring.sh up/start/ready/stop/down/recover/status/logs/native-check`) — plan→apply→receipt semantics, only suite verbs (never direct docker/routing), plus `doctor --verify` preflight on r0 and the :8016 liveness feed. Legacy TP2 `glm53_pair_serve.sh` pair flow (preflight + GID + worker-first) is kept for compatibility clusters. Both paths: streamed op logs, step chips, cancel, full audit. |
| **Inference** | Live LLM telemetry (decode/prefill tok/s, TTFT p50/p95, TPOT, queue/KV usage, spec-decode acceptance, preemptions, scheduler blocked/stalled from the ring liveness port) + an OpenAI-compatible streaming **chat console** with per-response TTFT/tok/s measurement. |
| **Bench** | One-click runs of the operator's own `llm-inference-bench` tool (`bench/llm_decode_bench.py`) with presets from OPS-GUIDE, checkpoint-based live per-cell progress, parsed summary grids (aggregate tok/s matrix, prefill table, spec-accept, coding-peak), history across runs (stored + repo artifacts), run reports written as `run-NN-*.md`. |
| **Images / engine** | docker image inventory (filtered), SERVING_IMAGE cross-check per profile/env-file, copy image between pair nodes over the CX7 (docker save‖load), trigger detached image builds on the builder host with streamed logs, switch a profile's SERVING_IMAGE (with preview + confirmation). |
| **Logs** | Follow serving container logs (`docker logs -f`) with ANSI rendering, filters, download. |
| **Events/alerts** | Memory-envelope thresholds (121.0/121.4 GiB defaults — ~119-120 GiB is normal serving; >121.4 OOM risk), thermal thresholds, thermal-throttle flags, swap usage, node/SSH health transitions, op outcomes — dedup'd, ack-able, optional webhook. |
| **Settings** | Multi-cluster topology editor with the key feature: **per-node ordered address lists** (LAN / direct CX7 fabric / Tailscale / custom) with address failover + reachability tests; per-node ssh alias/user/port; profiles; bench paths; retention; alert thresholds. Export/import the whole config as JSON. |

Out of scope (by design): the qwen38next project, 4-node disaggregated
serving (spark-disagg4), anything non-GLM. The cluster/node model is generic;
a future adapter can extend `backend/sparkdeck/control/`.

## Arch notes

- Backend: **Python 3.11+** (FastAPI + asyncssh + pydantic + sqlite WAL) in
  `backend/sparkdeck/`; frontend: **React 19 + TS + Vite + Tailwind 4 +
  ECharts** in `web/`; single process serves both (uvicorn on 127.0.0.1:8936).
- The contract between them is pinned twice on purpose: `docs/API.md` +
  `web/src/api/types.ts` (TS mirrors; keep in lock-step).
- Telemetry: one persistent SSH exec per node streams NDJSON snapshots
  (2 s) → parser → ring buffers → WS to browsers (~1 Hz) → SQLite rollups.
- Control ops are transport-agnostic against runtimes implementing
  `exec / sudo_exec / stream_exec` — the **mock world** implements the same
  surface, so the engine is verified offline; `tests/` covers parsers,
  store, and a real-server mock smoke (REST+WS+ops+bench).
- SSH nodes: ordered address failover per node; optional `ssh_alias` (uses
  the operator's `~/.ssh/config`, including Tailscale ProxyJump aliases like
  `gx10-r0-ts`); sudo honors `PAIR_SUDO_PASSWORD` env → `~/.pair-sudo` →
  in-session password (never persisted outside those existing conventions).
- GB10 facts encoded: nvidia-smi memory *not* exposed (unified memory);
  SparkRing memory envelope per node ≈ 40 GiB weights + 24 GiB KV (fp8) +
  graphs/JIT/pagecache — alerts are **percent of total** (default warn 95 %,
  crit 98 %) so LLM-dense operation doesn't cry wolf; ring fabric is a direct
  cable loop (198.18.0–3/24, GID index 3 pinned via `addr-gen-mode eui64`).

## Repo layout

```
docs/ARCHITECTURE.md   design + verified node facts
docs/API.md            the HTTP/WS contract
docs/DESIGN.md         UI design language (tokens, patterns)
docs/PLAN.md           build plan & verification matrix
backend/sparkdeck/     the server (api/, ssh/, telemetry/, control/, service/, bench/, mock/)
web/                   the console (React/TS/Vite/Tailwind)
scripts/               run.sh (prod), dev-backend.sh (reload), setup.sh
tests/                 pytest (parsers, store, REST smoke, mock world, op engine)
sparkdeck.service      optional systemd user unit (install: cp to ~/.config/systemd/user/ && systemctl --user enable --now sparkdeck)
```

## Bench integration details

The runner passes `--display-mode plain --no-hw-monitor --resume` always,
targets the head's API URL, stores artifacts under
`~/.local/share/sparkdeck/runtime/bench/<job>/`, treats **success = output
JSON present & parseable** (the tool exits 0 even on dead servers), feeds
`--kv-budget` from the boot-log KV marker when available, and can write
`runs/run-NN-<label>.md` into the glm repo when
`bench.write_repo_runs` is enabled (default off).

## Verification status (as of 2026-09-07)

- REST + WS + full start/stop lifecycle now exercised through the **SparkRing
  console flow** (mock world) over a real uvicorn server (legacy TP2 engine
  still covered).
- Parsers + LTTB + bench `summarize` unit-tested (incl. both vLLM metric
  generations and the 83-field CellResult shape).
- **Real hardware**: all 4 GB10 nodes connect; collector deploys + streams on
  every node; both pairs serving GLM-5.3-Flash parsed live (KV/TTFT metrics,
  engine uptime from `process_start_time_seconds`); one minimal real bench
  (C=1, ctx 0, 8 s) through the full runner pipeline → summary grid + run
  report; production UI verified against live data (metrics, env files,
  images inventory, bench history import).
- Frontend: strict tsc clean project-wide, production bundle green; every
  page verified against the mock world with zero console errors; a full
  adversarial review pass (13 findings) applied — WS node snapshot shape,
  chart rebind on empty windows, chat-stream abort on unmount, map caps,
  SSE CRLF, logs auto-reconnect, settings draft dirty-gating, ring eviction,
  nested-modal Escape stack, OS theme listener.
- Lifecycle WRITE ops against the real pair intentionally require the
  operator (mock-disabled); the console gates them behind typed confirmations.
