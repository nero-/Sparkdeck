# Sparkdeck API contract (v1)

Base: `http://127.0.0.1:8936` (bindable; optional bearer token if
`auth.token` is set). All bodies JSON. Errors:

```json
{ "error": { "code": "node_unreachable|sudo_required|...|internal", "message": "…", "detail": {} } }
```

The TS mirror of every shape below is `web/src/api/types.ts` (single source of
truth for the frontend; ids/fields are snake_cased in JSON).

## System

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/system/info` | app name/version, mock flag, uptime |
| GET | `/api/system/status` | ssh pool states per node, ws clients, sampler state |
| POST | `/api/system/sudo` | session sudo password for nodes (`{password}`); memory-only |
| DELETE | `/api/system/sudo` | clear session sudo |

`POST /api/system/sudo` body: `{"password": "…"}` — held only in process
memory for the current session and used to honor the pairctl sudo convention
(`PAIR_SUDO_PASSWORD` env and `~/.pair-sudo` cache are also probed first, in
that order).

## Clusters & settings topology

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/clusters` | full topology: clusters with nodes + profiles nested |
| POST | `/api/clusters` | create cluster |
| PATCH | `/api/clusters/{id}` | update cluster |
| DELETE | `/api/clusters/{id}` | delete cluster (nodes must be removed first) |
| GET | `/api/clusters/{id}/live` | live aggregate: per-node conn state, service state, current profile, last op |
| GET | `/api/clusters/{id}/envfiles` | read-only live env files per node (SSH `cat`) |

`ClusterConfig`: `{id, name, accent_color, notes, kind:"tp2", control:{repo_dir,
serve_dir, launcher, start_extra, health_timeout_s, head_node_id, worker_node_id},
profiles: [ProfileDef]}`.

`NodeConfig`: `{id, cluster_id, name, role:"head"|"worker", ssh_user, ssh_port,
ssh_alias(null), env_rank, addresses:[{kind:"lan"|"fabric"|"tailscale"|"custom",
host, label}], api_port, interest_ifaces(string[]), enabled}`.

`ProfileDef`: `{id, cluster_id, key, label, served_model_name, model_dir_hint,
kv_pin_gib, context, speculator, quant, mm_images, mm_videos, notes}`.

Control verbs (all return `{op_id}` and stream via ws topic `ops`):

| Method | Path | Body |
|---|---|---|
| POST | `/api/clusters/{id}/actions/start` | `{profile_key, health_timeout_s?, skip_preflight?, extra?}` |
| POST | `/api/clusters/{id}/actions/stop` | `{force?}` |
| POST | `/api/clusters/{id}/actions/preflight` | `{}` |
| POST | `/api/clusters/{id}/actions/check` | `{profile_key?}` |
| POST | `/api/clusters/{id}/actions/verify` | `{profile_key}` |

## Nodes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/nodes/{id}` | node detail + live conn state + last sample |
| PATCH | `/api/nodes/{id}` | update node config |
| POST | `/api/nodes/{id}/test` | reachability/auth/versions probe, address failover report |
| POST | `/api/nodes/{id}/actions/deploy-collector` | push collector.py |
| POST | `/api/nodes/{id}/actions/drop-caches` | sudo |
| POST | `/api/nodes/{id}/actions/fix-swappiness` | sudo |
| POST | `/api/nodes/{id}/actions/show-gids` | parsed RoCE GID table |
| POST | `/api/nodes/{id}/actions/ping-fabric` | `{peer_address}` latency min/avg/max/loss |
| POST | `/api/nodes/{id}/actions/tailscale-status` | compact tailscale report |

## Metrics

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/metrics/catalog` | series defs: `{id, unit, kind, label, cluster_scoped?}` |
| GET | `/api/metrics/history` | `?node_id=&names=a,b&window=5m\|1h\|6h\|24h\|7d` or `from=&to=&max_points=` → `{series:{name:{t:[ms],v:[num]}}}` |
| GET | `/api/metrics/cluster-history` | same, cluster-scoped aggregates (sum/avg semantics per series) |

Time math: `t` = epoch ms. Downsampling: raw ring keeps 2s×~45m per node; DB
rolls 1m (kept 14d) and 10m (kept 60d) mean/max/min series. Windows ≤1h are
served from raw ring (or post-restart from the 10s raw table), larger from
rollups.

## Service / LLM

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/llm/{clusterId}/state` | health, served models, image, uptime, kv tokens, curated metric snapshot |
| GET | `/api/llm/{clusterId}/requests` | console request log with TTFT/TPS stats |
| POST | `/api/llm/{clusterId}/chat` | OpenAI-style passthrough; body `{messages, model?, max_tokens?, temperature?, top_p?}`; SSE frames `{choices:[{delta}]}` + terminal `{stats:{ttft_ms,tps,output_tokens}}` |

## Logs

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/logs/containers/{nodeId}` | serving-related containers (`docker ps --format json`) |
| GET/WS | `logs:{nodeId}:{container}` ws topic (SSE fallback `/api/logs/stream`) | live `docker logs -f --tail N` |

## Images / engine

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/images/{nodeId}` | docker image list filtered (`local/vllm:*` default) |
| GET | `/api/images/envs/{clusterId}` | `SERVING_IMAGE` per profile from live env files |
| GET | `/api/images/deploys/preview` | preview `[ {node, file, old, new} ]` of sed rewrite |
| POST | `/api/images/deploys` | `{cluster_id, profile_key, image}` → op: rewrite SERVING_IMAGE on both rank files |
| POST | `/api/images/copies` | `{src_node_id, dst_node_id, image}` → op: `docker save | ssh docker load` |
| GET | `/api/images/builds/{nodeId}` | list builder env files (build-*.env) |
| POST | `/api/images/builds` | `{node_id, file}` → op: detached builder run + log follow |

## Bench

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bench/config` | tool path, venv state, defaults |
| PATCH | `/api/bench/config` | set `bench_repo_dir`, defaults |
| POST | `/api/bench/bootstrap-venv` | create/repair the bench venv (httpx, rich) |
| POST | `/api/bench/jobs` | `{cluster_id, host?, port?, model, label, profile_key?, kv_budget?, args:{concurrency, contexts, prefill_contexts, max_tokens, duration, coding_peak, coding_peak_runs, coding_peak_max_tokens, extra}}` → op |
| GET | `/api/bench/jobs?limit=` | history |
| GET | `/api/bench/jobs/{id}` | job + tail |
| GET | `/api/bench/jobs/{id}/result` | parsed JSON (or null while running) |
| POST | `/api/bench/jobs/{id}/cancel` | stop the bench process |
| POST | `/api/bench/jobs/{id}/report` | write run report md (app data; optional repo `runs/` if enabled) |
| GET | `/api/bench/history` | stored + repo-`runs/*.json` summaries, newest first |

## Events / Ops

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/events?limit&level&cluster_id&kind&since&unacked_only` | event feed (level = single value; chain filters client-side) |
| POST | `/api/events/ack` | `{ids:[...]}` or `{all:true}` → `{ok, count}`; ack returns `{ok}` |
| GET | `/api/ops?limit&kind&cluster_id` | op audit |
| GET | `/api/ops/{id}` | op detail incl. step log |
| POST | `/api/ops/{id}/cancel` | best-effort cancel |

`OpRecord`: `{id, kind, cluster_id, profile_key?, node_id?, state:"queued|running|ok|error|cancelled", created, started?, finished?, exit?, message?, steps:[{name, state, detail?}], log_tail:string[], params:{}}`.

`EventRec`: `{id, ts, level:"info|warn|error", kind, cluster_id?, node_id?, message, data?, acked}`.

## WebSocket `/api/ws`

One socket per client. Client: `{"op":"sub","topics":[…]}` (default all);
server messages: `{"topic": string, "data": any, "ts": ms}`.

Topics and payloads:
- `nodes` → `[{node_id, state:"online|degraded|offline|connecting", addr_used, conn_since, collector:"healthy|stale|down|none"}]`
- `samples` → `{node_id, ts, series:{"gpu.util": 71.2, …}}` (each node's latest tick, ~1/s summarised)
- `service` → `{cluster_id, health:"up|down|degraded", api_addr, model, kv_tokens, age_s, metrics:{…curated…}}`
- `ops` → `OpRecord` (full upserts on change)
- `events` → `EventRec`
- `bench` → `{job: BenchJob, tail?: string}` on state/tail changes
- `logs` → `{key:"node:ctr", node_id, container, lines:[…], eof?}`

Server coalesces high-rate topics (samples ~1 Hz per node). Client reconnects
with backoff and re-requests missed history via REST as needed.
