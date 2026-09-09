// Sparkdeck shared API contract — mirrors docs/API.md. Single source of truth
// for the frontend; backend pydantic models must stay field-compatible.

export type ApiErrorCode =
  | 'node_unreachable' | 'sudo_required' | 'not_found' | 'validation'
  | 'mock_only' | 'conflict' | 'unsupported' | 'internal';

export interface ApiError {
  error: { code: ApiErrorCode; message: string; detail?: Record<string, unknown> };
}

export type ID = string;
export type EpochMs = number;

// ---------- Topology / settings ----------

export type AddressKind = 'lan' | 'fabric' | 'tailscale' | 'custom';

export interface NodeAddress {
  kind: AddressKind;
  host: string;            // IP or tailscale hostname (MagicDNS name)
  label?: string;          // freeform, e.g. "LAN", "TS overseas"
}

export type NodeRole = 'head' | 'worker';

export interface NodeConfig {
  id: ID;
  cluster_id: ID;
  name: string;            // e.g. "gx10-r0"
  role: NodeRole;
  ssh_user: string;
  ssh_port: number;        // default 22
  ssh_alias: string | null;// optional ~/.ssh/config alias; else host list is used
  env_rank: number;        // rank number in rank-<N>-<profile>.env (0..3)
  addresses: NodeAddress[];// ordered, failover order
  api_port: number;        // 8000; health checks run node-local
  interest_ifaces: string[]; // defaults to auto-detect when empty
  enabled: boolean;
}

export interface ProfileDef {
  id: ID;
  cluster_id: ID;
  key: string;             // e.g. "mtp3-spark"
  label: string;           // "MTP3 spark quant (daily driver)"
  served_model_name: string;
  model_dir_hint?: string | null;
  kv_pin_gib?: number | null;
  context?: number | null;
  speculator?: string | null; // "mtp3-adaptive" | "dflash2" | null
  quant?: string | null;      // "spark" | "nvfp4"
  mm_images?: number | null;
  mm_videos?: number | null;
  notes?: string | null;
  /** design KV capacity in tokens (SparkRing TP4: ~2.28 M cluster-wide) */
  kv_tokens?: number | null;
}

export type ClusterKind = 'tp2';

export interface ClusterControl {
  repo_dir: string;        // node-side project dir
  serve_dir: string;       // node-side serve dir (launcher + env files)
  launcher: string;        // e.g. glm53_pair_serve.sh
  start_extra: string;     // pairctl EXTRA passthrough
  health_timeout_s: number;
  head_node_id: ID;
  worker_node_id: ID;
}

export interface ClusterConfig {
  id: ID;
  name: string;
  kind: ClusterKind;
  accent_color: string;
  notes?: string | null;
  control: ClusterControl;
  profiles: ProfileDef[];
}

export interface ClusterTopology extends ClusterConfig {
  nodes: NodeConfig[];
}

export interface AppSettings {
  sampling_interval_s: number;        // collector tick (1..10)
  retention: {
    raw_hours: number;                // raw decimated samples kept (default 12)
    minute_days: number;              // 1m rollups (default 14)
    decaminute_days: number;          // 10m rollups (default 60)
  };
  alerts: {
    mem_warn_pct: number;             // % of node unified-memory total (95 default)
    mem_crit_pct: number;             // % of total (98 default)
    gpu_temp_warn_c: number;
    gpu_temp_crit_c: number;
    container_restarts: number;       // alert at N restarts per hour
    webhook_url: string | null;
  };
  appearance: {
    theme: 'dark' | 'light' | 'system';
    density: 'comfortable' | 'compact';
  };
  bench: {
    bench_repo_dir: string | null;    // glm repo bench dir on THIS machine
    venv_python: string | null;       // resolved venv python for the bench tool
    write_repo_runs: boolean;         // also write run-NN markdown into repo runs/
    defaults: BenchArgs & { label?: string };
  };
  images: {
    filter_glob: string;              // "local/vllm:*"
    hmm_guard_pause_s: number;        // sanity pause before deploy ops
  };
  security: {
    bind_host: string;                // default 127.0.0.1
    port: number;                     // default 8936
    token_set: boolean;               // whether a browse token is required
  };
}

// ---------- Live state ----------

export type ConnState = 'connecting' | 'online' | 'degraded' | 'offline' | 'disabled';
export type CollectorState = 'healthy' | 'stale' | 'down' | 'none' | 'unprobed';
export type ServiceHealth = 'up' | 'down' | 'degraded' | 'unknown';

export interface LiveNodeState {
  node_id: ID;
  cluster_id: ID;
  state: ConnState;
  addr_used: string | null;
  conn_since: EpochMs | null;
  collector: CollectorState;
  last_sample_ts: EpochMs | null;
}

export interface ServiceLiveness {
  healthy?: boolean;
  running_requests?: number;
  kv_cache_usage?: number;        // fraction 0..1
  blocked_seconds?: number;
  output_stalled_seconds?: number;
  model?: string;
  version?: string;
}

export interface ServiceState {
  cluster_id: ID;
  health: ServiceHealth;
  host: string | null;
  port: number | null;
  model: string | null;
  served_models: string[];
  image: string | null;
  profile_key: string | null;
  age_s: number | null;
  kv_tokens: number | null;
  metrics: Record<string, number>;  // curated, see docs/API.md
  errors: string[];
  liveness?: ServiceLiveness | null;  // TP4 ring :8016 snapshot
}

export interface SampleFrame {
  node_id: ID;
  ts: EpochMs;
  series: Record<string, number | null>; // canonical ids from docs/ARCHITECTURE.md
}

export type SeriesKind = 'gauge' | 'counter';

export interface SeriesDef {
  id: string;
  unit: string;             // "%", "GiB", "MB/s", "C", "ms", "tok/s", "w", "mhz", "ct"
  kind: SeriesKind;
  label: string;
  group: string;            // gpu | cpu | mem | net | disk | temp | docker | vllm
  cluster_scoped?: boolean;
}

export interface HistorySeries {
  t: EpochMs[];
  v: (number | null)[];     // null = gap
}

export interface HistoryResponse {
  window: string;           // echoed window or "range"
  from: EpochMs; to: EpochMs;
  resolution_note: 'raw' | 'mixed' | 'rollup';
  series: Record<string, HistorySeries>;
}

// ---------- Operations / events ----------

export type OpKind =
  | 'cluster.start' | 'cluster.stop' | 'cluster.preflight' | 'cluster.check' | 'cluster.verify'
  | 'collector.deploy' | 'node.drop_caches' | 'node.fix_swappiness' | 'node.show_gids'
  | 'node.ping_fabric' | 'node.tailscale_status' | 'node.test'
  | 'image.copy' | 'image.set_serving' | 'image.build'
  | 'bench.run' | 'system.op';

export type OpState = 'queued' | 'running' | 'ok' | 'error' | 'cancelled';

export interface OpStep {
  name: string;
  state: 'pending' | 'running' | 'ok' | 'error' | 'skipped' | 'cancelled';
  detail?: string;
}

export interface OpRecord {
  id: ID;
  kind: OpKind;
  cluster_id: ID | null;
  profile_key?: string | null;
  node_id?: ID | null;
  state: OpState;
  created: EpochMs;
  started: EpochMs | null;
  finished: EpochMs | null;
  exit?: number | null;
  message?: string | null;
  steps: OpStep[];
  log_tail: string[];
  params: Record<string, unknown>;
}

export type EventLevel = 'info' | 'warn' | 'error';

export interface EventRec {
  id: string;
  ts: EpochMs;
  level: EventLevel;
  kind: string;             // e.g. "mem.crit", "conn.lost", "container.exit", "op.done"
  cluster_id?: ID | null;
  node_id?: ID | null;
  message: string;
  data?: Record<string, unknown> | null;
  acked: boolean;
}

// ---------- LLM ----------

export interface ChatMsg { role: 'system' | 'user' | 'assistant'; content: string }
export interface ChatRequest {
  messages: ChatMsg[];
  model?: string | null;
  max_tokens?: number | null;
  temperature?: number | null;
  top_p?: number | null;
}

// SSE: chunks mirror OpenAI deltas; the final frame is: {"stats": {...}}
export interface ChatStatsFrame {
  stats: {
    ttft_ms: number;
    tps: number;
    output_tokens: number;
    prompt_tokens?: number | null;
    total_ms: number;
  };
}

// ---------- Images ----------

export interface ImageInfo {
  node_id: ID;
  repo_tag: string;
  image_id: string;
  created_label: string;
  size_mb: number;
}

export interface EnvImageRow {
  profile_key: string;
  clusters: { node_id: ID; node_name: string; file: string; image: string }[];
}

export interface ImageSetPreview {
  rows: { node_id: ID; node_name: string; file: string; old: string; new: string }[];
}

export interface BuildEnvFile { node_id: ID; file: string; label: string }

// ---------- Bench ----------

export interface BenchArgs {
  concurrency: string;        // csv, e.g. "1,2,3,4,8"
  contexts: string;           // csv, e.g. "0,8192,32768"
  prefill_contexts: string;   // csv, e.g. "8k,32k"
  max_tokens: number;
  duration: number;           // seconds per config
  coding_peak: boolean;
  coding_peak_runs?: number;
  coding_peak_max_tokens?: number;
  kv_budget?: number | null;
  extra?: string;             // passthrough flags
}

export interface BenchJob {
  id: ID;
  cluster_id: ID;
  profile_key?: string | null;
  label: string;
  host: string;
  port: number;
  model: string;
  args: BenchArgs;
  state: 'queued' | 'running' | 'ok' | 'error' | 'cancelled';
  created: EpochMs;
  started?: EpochMs | null;
  finished?: EpochMs | null;
  exit?: number | null;
  result_path?: string | null;
  log_path?: string | null;
  summary?: Record<string, unknown> | null;
}

export interface BenchHistoryRow {
  job_id: ID | null;
  source: 'sparkdeck' | 'repo';
  path: string;
  label: string;
  ts: EpochMs | null;
  summary: Record<string, unknown>;
}

// ---------- Containers / logs ----------

export interface ContainerInfo {
  id: string; name: string; image: string; state: string; status: string; created: string;
}

export interface LogFrame {
  key: string;
  node_id: ID;
  container: string;
  lines: string[];
  eof?: boolean;
}

// ---------- System ----------

export interface SystemInfo {
  name: string; version: string; mock: boolean;
  uptime_s: number; data_dir: string; python: string;
}

export interface SystemStatus {
  nodes: LiveNodeState[];
  ws_clients: number;
  ops_running: number;
  sampler_running: boolean;
}

// ---------- WebSocket ----------

export type WsTopic =
  | 'nodes' | 'samples' | 'service' | 'ops' | 'events' | 'bench' | 'logs' | 'hello';

export interface WsOut { topic: WsTopic; data: any; ts: EpochMs }
export interface WsIn { op: 'sub' | 'unsub'; topics: WsTopic[] }

// Convenience unions for topic "data"
export type NodeTopicData = LiveNodeState[];
export type SampleTopicData = SampleFrame;
export type ServiceTopicData = ServiceState;
export type OpsTopicData = OpRecord;
export type EventsTopicData = EventRec;
export type BenchTopicData = { job: BenchJob; tail?: string };
export type LogsTopicData = LogFrame;
