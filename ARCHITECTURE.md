# Sparkdeck — architecture

Sparkdeck is a unified **cluster controller & operator console** for DGX Spark /
ASUS Ascent GX10 pairs serving **GLM-5.3-Flash** as a TP2 pair. It runs on the
operator's machine, talks to nothing but SSH, and needs **zero installed
components on the nodes** beyond `python3`, `nvidia-smi` and `docker` (all
already present on DGX OS).

Out of scope (deliberate): qwen38next-gx10-tp2 project, disaggregated 4-node
serving (spark-disagg4), anything beyond the GLM-5.3-Flash pair lifecycle.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Browser (React+TS, Vite build served by the backend — one process)     │
│   Overview · Nodes · Control · Inference · Logs · Images · Bench ·      │
│   Events · Settings        ← WS /api/ws (live samples, ops, logs, bench) │
└──────────────┬──────────────────────────────────────────────────────────┘
               │ HTTP + WebSocket (127.0.0.1:8936, optional token)
┌──────────────▼──────────────────────────────────────────────────────────┐
│  sparkdeck backend (FastAPI, async)                                     │
│                                                                          │
│  settings_store ── clusters/nodes/addresses/profiles (SQLite)            │
│  ssh pool ──── one long-lived asyncssh connection per node;              │
│                 address failover in declared order; backoff reconnect    │
│      ┌──────────────────────────┬───────────────────────────────────┐    │
│      │ telemetry plane          │ control plane                     │    │
│      │ persistent exec channel  │ one-off exec jobs (ops)           │    │
│      │ running node collector   │ start/stop/preflight/logs/check,  │    │
│      │ streaming NDJSON 2s      │ docker/image actions, bench run   │    │
│      └──────────┬───────────────┴───────────┬───────────────────────┘    │
│  series store:  │                           │  audit + events/alerts     │
│  ring buffers → │                           │  ops table + WS push       │
│  SQLite 1m/10m rollups + retention                    │                │
│  service plane: vLLM /health /v1/models /metrics parse (curated set)    │
│  chat passthrough: OpenAI-compatible stream proxy + TTFT/tps stats      │
│  bench runner: venv-bootstrap + run llm_decode_bench.py as a job        │
│  mock mode: virtual nodes/ops/bench — full UI dev + e2e without SSH     │
└────────────┬────────────────────────────────────────────────────────────┘
              │ ssh (key auth) tcp/{22, client-config} + node-local HTTP
   ┌──────────▼─────────────┐   ┌────────────────────┐  ┌──────────────┐
   │ gx10-r0 head(rank0)    │   │ gx10-r1 worker(r1) │  (cluster 2:  │
   │ API :8000 · docker     │   │ headless container │   r2 head,    │
   │ collector.py streams   │   │ collector.py       │   r3 worker)  │
   └────────────────────────┘   └────────────────────┘  └──────────────┘
```

## Principles

1. **Node-first telemetry.** A stdlib-only Python collector runs ON each node
   (deployed over SSH at `~/.sparkdeck/collector.py`) and emits one NDJSON
   snapshot per tick. The operator machine never scrapes LAN HTTP for host
   metrics — so monitoring works from anywhere SSH works (Tailscale, VPN,
   fabric). One persistent exec channel per node, not a `ssh` per poll.
2. **Control = the existing, proven semantics.** Start/stop drive the hosts'
   own `glm53_pair_serve.sh` exactly like `pairctl.sh` does (preflight:
   swappiness 0 + page-cache drop, RoCE GID re-check/auto-fix, stale teardown,
   worker-first start, health wait, startup verify). Nothing new is invented;
   the controller just makes it observable and one-click.
3. **Failover addresses are first-class.** Every node carries an *ordered*
   address list (LAN / direct-fabric / Tailscale / custom). The pool tries them
   in order on every (re)connect; one address failing never takes a node down.
4. **Everything is an operation.** Any state-changing act (start/stop/bench/
   image deploy/build/preflight) is a persisted, streamed, cancellable op with
   an audit trail. Destructive ops require typed confirmation in the UI.
5. **History is local and boring.** Ring buffers in memory for the live view;
   SQLite rollups (1m over ~3d, 10m over 30d) + retention so charts across
   restarts and long windows stay cheap.
6. **Mock parity.** `SPARKDECK_MOCK=1` runs a full virtual world (nodes,
   collector output, vLLM metrics, ops, bench). UI and API development and the
   e2e smoke test run entirely against mock; the real pair is only touched via
   read-only ops during verification.
7. **Secrets stay where they are.** Node access = the operator's existing SSH
   keys/config. Sudo: honor `PAIR_SUDO_PASSWORD` env / `~/.pair-sudo` (the
   pairctl convention), else prompt in-UI per session (never persisted by
   default). API: listen on 127.0.0.1 by default; optional bearer token.

## Backend layout (python 3.11+, venv at `.venv/`)

```
sparkdeck/
  cli.py                 sparkdeck serve|doctor|init
  app.py                 FastAPI factory, WS hub wiring, static serving
  config.py              runtime host/port/token/mock flags
  db.py                  sqlite (WAL) + migrations
  models.py              pydantic domain: Cluster, Node, Profile, AppSettings
  settings_store.py      CRUD + seed of the real two-cluster topology
  api/                   routers (settings, nodes, metrics, clusters, ops,
                         llm, logs, images, bench, events, ws, system) + hub
  ssh/pool.py            NodeConn: connect w/ failover, exec, stream, upload
  telemetry/collector.py THE node-side script (stdlib only, shipped)
  telemetry/parser.py    NDJSON validation/normalization
  telemetry/series.py    canonical metric ids/units/pretty labels
  telemetry/store.py     rings, rollups, retention, queries
  control/tp2.py         verb builders (start/stop/status/check/logs/preflight)
  control/engine.py      op runner/audit/cancel + jobs for logs & builds
  service/vllm.py        curated Prometheus parse, health, catalog
  service/chat.py        streaming chat proxy + TTFT/TPS measurement
  bench/runner.py        venv bootstrap, job exec, tail, result parse/save
  mock/                  virtual nodes/ops/bench world
```

## Frontend layout (React 19 + TS + Vite + Tailwind 4)

```
web/src/
  api/types.ts         THE shared contract (mirrored by backend models)
  api/client.ts        typed fetch client + WS store
  ds/                  design system: primitives, tokens, chart kit
  pages/               overview, nodes(+detail), control, inference, logs,
                       images, bench, events, settings
  stores/              live ws store, ops store, settings cache
```

Design language is pinned in `docs/DESIGN.md` (dark-first operator console;
Inter + JetBrains Mono numerals; per-cluster accents; glass cards; 1px
borders; no rounded-wacky shapes; monospace everywhere numbers change).

## Canonical metric ids

gauge/série identifiers used by collector, store, API and charts (units in
brackets): `gpu.util[%] gpu.mem_used_gib gpu.temp gpu.power_w gpu.clock_sm_mhz
gpu.clock_mem_mhz` `cpu.util_pct cpu.load1 cpu.load5 cpu.load15 cpu.core.<i>`
`mem.used_gib mem.avail_gib mem.swappiness mem.psi_mem_some_avg10 mem.pagecache_gib`
`net.<iface>.rx_kbps net.<iface>.tx_kbps` (interest ifaces: LAN + fabric)
`disk.used_pct disk.r_mbps disk.w_mbps` `temp.cpu temp.zones_max
temp.nvme[<k>]` `docker.<ctr>.cpu_pct docker.<ctr>.mem_gib`
`vllm.decode_tok_s vllm.prefill_tok_s vllm.tok_s_out vllm.num_running
vllm.num_waiting vllm.kv_usage_perc vllm.prefix_hit_perc vllm.ttft_ms_p50
vllm.ttft_ms_p95 vllm.tpot_ms_p50 vllm.spec_accept_perc vllm.req_active`.

## SparkRing TP4 facts (from ~/Builds/sparkring-deploy + OPERATIONS.md)

- One cluster, 4 ranks, one model: `glm-5.3-flash-spark` (NVFP4-spark),
  API `192.168.50.23:8015` (OpenAI-compatible, no auth, LAN only),
  liveness `:8016/liveness` (healthy/running_requests/kv_cache_usage/
  blocked_seconds/output_stalled_seconds). Mesh 9975, graph 9970/9971,
  master 29775. vLLM /metrics rides the API port alongside.
- Lifecycle is console-driven ON THE CONTROLLER: `sparkring.sh
  up|start|ready|stop|down|recover|status|logs|native-check|liveness` —
  every action writes a plan + receipt JSON (sha256-approved apply).
  `sparkring doctor --verify` runs on r0. Containers are `glm-tp4-r{0..3}`,
  ONE per node.
- Invariants from the repo's AGENTS/OPERATIONS docs: never touch containers
  or routing directly, always the managed suite; image swaps follow the
  runbook (staging → install → up), `systemd-networkd` masked, NM owns the
  links; GID index is FIXED at 3 with `ipv6.addr-gen-mode eui64`.
- Per-node memory envelope: ~40 GiB weights + 24 GiB KV (fp8_ds_mla) +
  graphs/JIT/pagecache of 128 GiB unified → alerts default to **95 % / 98 %
  of total** instead of absolute GiB.
- Measured on the ring (image 35db0557…): prefill ~3470 tok/s @8k, C1 decode
  58 tok/s, MTP acceptance 2.3–2.5 of 3, KV ~2,278,454 tokens cluster-wide.
- The 2026 TP2 pair facts below are kept as legacy context; the legacy
  `glm53_pair_serve.sh` engine path still exists for compatibility.

## Verified node facts (from the operator's builds and confirmed live 2026-09-07)

- All four GB10 nodes connect over SSH (LAN) with the operator's keys; fabric
  addresses are node-to-node only (the controller host cannot reach them
  directly) — hence seeded order LAN → Tailscale → fabric.
- **asyncssh quirk (live-verified)**: `create_process` with separately-piped
  stderr wedges `readline()` on these nodes — merged-stderr default works and
  the NDJSON filter tolerates stray diagnostics. Any new stream path must use
  the default streams.
- **nvidia-smi on GB10**: utilization/temp/power/sm-clock valid; memory NOT
  exposed ("Not Supported") — the real unified-memory gauges come from
  `/proc/meminfo` (MemAvailable; MemAvailable+SwapFree is the official
  allocatable estimate). DGX Dashboard/DCGM/tegrastats are dead ends.
- GB10 live serving measurement (r2, idle): ~120.7 GiB used of 121.7 — alert
  defaults therefore warn at 121.0 / crit at 121.4 GiB (OOM risk ~121.5).
- Idle GPU temps on the nodes can touch 88 °C with the fan curve; thermal
  warn/crit defaults are 86/94 °C (zones throttle near ~96 °C).
- vLLM metric names DILEMMA resolved: both v0 (`GPU_cache_usage_perc`,
  `time_per_output_token_seconds`) and v1 (`kv_cache_usage_perc`,
  `inter_token_latency_seconds`) aliases are accepted by the collector.
- Live env files on the hosts are ground truth (repo `env/` templates are
  IP-scrubbed) — the console reads them via SSH (`--check` + `grep`).
- Real serving pair is NOT to be cycled by automation (agent/OWUI/Hermes/DSH
  dependency) — WRITE ops always require an explicit operator confirmation.

