# Sparkdeck build plan & verification matrix

Status as of 2026-09-07 (see README for a short status block).

## Scope decisions (operator-approved)

- GLM-5.3-Flash only (both clusters, 4 profiles each) — no qwen, no disagg.
- The bench tool (`llm-inference-bench`, `bench/llm_decode_bench.py`) is a
  first-class feature of the console, driven by a service-side runner.
- The грузов cluster lifecycle semantics follow pairctl.sh faithfully; the
  controller is the UI/audit layer over the same host-side launcher.
- Multiple clusters + arbitrary per-node address lists (LAN/fabric/Tailscale)
  with failover ordering is core to the settings UX.

## Shipped

| Component | State | Verified by |
|---|---|---|
| seed topology (2 clusters × 2 nodes × 4 profiles; real LAN/fabric IPs) | done | mock_server_smoke + doctor (real) |
| SSH pool: ordered failover, alias mode, keepalive, backoff, TOFU fallback | done | doctor real: 4/4 GB10 online via LAN |
| collector (stdlib; GB10-aware) + SFTP/cat deploy + NDJSON stream | done | doctor real: healthy on all 4; manual parse on r2 trace |
| parser + canonic series + parser tests | done | pytest |
| series store: rings, 1m/10m rollups, retention, per-node deps | done | server smoke (query across restarts) |
| OpEngine: start/stop/preflight/check/verify + node ops + image ops + building | done | mock world full-lifecycle smoke (10 steps) |
| events/alerts engine (+webhook best-effort) | done | mock smoke + threshold cooldowns |
| vLLM service state + curated metrics (dual-generation tolerance) | done | real r2: serving GLM-5.3 parsed live (kv usage, TTFT histograms) |
| bench runner (argv, SIGINT-security cancel, checkpoint progress, summarize, report, repo import) | done | real bench on r2 → 29.15 t/s C1 ctx0; summary + run-17 markdown |
| mock world (nodes/frames/lifecycle/bench/logs) | done | all smoke green |
| FastAPI app + WS hub + static SPA serving | done | mock_server_smoke.py |
| web foundation (design system, shell, stores, chart kit, terminal) | done (wave 1) | npm build green + agent report |
| web pages (overview/nodes/inference, control/logs/events, settings/bench/images) | in flight (wave 2, 3 agents) | — |

## Next after wave 2 (integration checklist)

1. Merge page waves; central `npm run build`; fix type tails.
2. Serve built console from the backend (mock mode); browser screenshot pass
   through every page; fix layout/data-flow defects.
3. Real-world read-only pass: monitor page on live r2 data, env-file
   inspector, images inventory, bench history import.
4. Optional follow-ups (not in v1 scope unless asked): chat-stat persistence
   hardening, per-request spec-accept overlay, image digest pinning UI,
   notification actions (webhook templates), CSV import of sparktop configs.

## Guardrails honored

- No cluster-1/cluster-2 lifecycle WRITE happens without an explicit operator
  action in the console; ops audit + confirm dialogs expose exact commands.
- The agent runtime is hosted on the operator's machine (post 2026-09-07
  topology) — the pair can go down without killing the controller.
