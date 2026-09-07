/* ============================================================================
   api/admin — thin typed helpers for the settings / bench / images console.

   Rides the pinned contract in `src/api/types.ts` (docs/API.md mirror).
   Where the live backend drifts from docs/API.md (response envelopes, extra
   required fields, moved endpoints), normalization lives HERE so pages never
   see raw unknowns; each normalization carries a `// DRIFT:` or `// GAP:` tag
   the report can cite.

   Drifts encoded (verified against backend/sparkdeck/api/routes.py + bench/runner.py):
   - GET /api/images/{nodeId}        → `{images: ImageInfo[], state}`  (docs: bare array)
   - GET /api/images/envs/{cluster}  → `{envs: EnvImageRow[]}`         (docs: bare array)
   - GET /api/images/builds/{node}   → `{files: [{file,label}], state}` (docs: bare array;
                                       rows carry NO node_id though types.ts wants one)
   - POST /api/images/copies|builds  → require `cluster_id`             (docs omit it)
   - collector deploy                → POST /api/nodes/{id}/actions/collector
                                       (docs/API.md says actions/deploy-collector)
   - POST /api/nodes/{id}/test       → `{ok, used_addr, attempts:[{addr, ok, error}],
                                       collector, versions, lan_addr, unverified}`
                                       (docs describe it, shape not pinned; no latency field)
   - GET /api/bench/config           → `{bench_repo_dir, tool_present, venv_python,
                                       venv_deps_ok, write_repo_runs, defaults:{label, args}}`
   - PATCH /api/bench/config         → partial-capable; defaults is `{label, args}`
   - POST /api/bench/bootstrap-venv  → `{rc, log}` (synchronous, NOT an op)
   - POST /api/bench/jobs            → `{job_id, argv: string[]}`
   - GET  /api/bench/jobs/{id}?tail  → job dump + `log_tail: string[]` (WS uses `tail`,
                                       REST uses `log_tail`)
   - POST /api/bench/jobs/{id}/report→ `{rc, path, repo_path?}` | `{rc:1, error}`
   - cluster PATCH drops `profiles` (apply_patch excludes them) → profile edits
     PATCH-then-verify, then fall back to POST /api/settings/import (bulk
     upsert, never deletes) when the patch is a silent no-op.
   - POST /api/nodes does NOT exist → add-node rides the import upsert.
   - GET /api/settings/export → `{topology: ClusterTopology[], settings}`.
   - POST /api/settings/import exists in backend (routes.py), missing from docs.
   ========================================================================= */

import { api } from './client';
import type {
  AppSettings,
  BenchArgs,
  BenchHistoryRow,
  BenchJob,
  ClusterConfig,
  ClusterControl,
  ClusterKind,
  ClusterTopology,
  CollectorState,
  EnvImageRow,
  ID,
  ImageInfo,
  ImageSetPreview,
  NodeConfig,
  ProfileDef,
  ServiceState,
} from './types';

/* ---------------------------------------------------------------------------
   Shape guards
   --------------------------------------------------------------------------- */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asRecordList(v: unknown): Record<string, unknown>[] {
  return asList(v).filter(isRecord);
}

/** True when an ApiClientError says "route not implemented / wrong method". */
export function isMissingRoute(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as unknown as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = typeof e.code === 'string' ? e.code : undefined;
  const msg = typeof e.message === 'string' ? e.message : '';
  const notFoundEntity = /node not found|cluster not found|job not found|op not found/.test(msg);
  return (status === 404 && !notFoundEntity) || status === 405 || code === 'unsupported';
}

/** `{op_id}` (control verbs; tolerate `id`). */
export interface OpRef {
  op_id: string | null;
}

function asOpRef(v: unknown): OpRef {
  const r = isRecord(v) ? v : {};
  return { op_id: asString(r.op_id) ?? asString(r.id) };
}

/* ---------------------------------------------------------------------------
   App settings
   --------------------------------------------------------------------------- */

export type SettingsPatch = {
  sampling_interval_s?: number;
  retention?: Partial<AppSettings['retention']>;
  alerts?: Partial<AppSettings['alerts']>;
  appearance?: Partial<AppSettings['appearance']>;
  bench?: {
    bench_repo_dir?: string | null;
    venv_python?: string | null;
    write_repo_runs?: boolean;
    defaults?: { label?: string; args: BenchArgs };
  };
  images?: Partial<AppSettings['images']>;
  security?: { bind_host?: string; port?: number };
};

/** GET /api/settings — full dump. */
export function fetchSettings(): Promise<AppSettings> {
  return api.get<AppSettings>('/api/settings');
}

/** PATCH /api/settings — partial-capable per section; returns merged dump. */
export function patchSettings(patch: SettingsPatch): Promise<AppSettings> {
  return api.patch<AppSettings>('/api/settings', patch);
}

export interface SettingsExport {
  topology: ClusterTopology[];
  settings: AppSettings | null;
}

/** GET /api/settings/export → `{topology, settings}`. */
export async function fetchSettingsExport(): Promise<SettingsExport> {
  const raw = await api.get<unknown>('/api/settings/export');
  const r = isRecord(raw) ? raw : {};
  const topology = asRecordList(r.topology ?? r.clusters) as unknown as ClusterTopology[];
  const rawSettings = r.settings;
  return {
    topology,
    settings:
      isRecord(rawSettings) && typeof rawSettings.sampling_interval_s !== 'undefined'
        ? (rawSettings as unknown as AppSettings)
        : null,
  };
}

/**
 * POST /api/settings/import — bulk upsert `{topology, settings}`.
 * Present in the backend (routes.py), missing from docs/API.md (gap). When
 * the endpoint answers as missing, the caller can run the per-cluster
 * dispatcher (Data section) instead.
 */
export async function importTopology(
  topology: ClusterTopology[],
): Promise<{ ok: boolean; clusters: number | null; endpointExists: boolean; error: unknown }> {
  try {
    const raw = await api.post<unknown>('/api/settings/import', { topology });
    const r = isRecord(raw) ? raw : {};
    return { ok: r.ok === true, clusters: asNumber(r.clusters), endpointExists: true, error: null };
  } catch (err) {
    if (isMissingRoute(err)) {
      return { ok: false, clusters: null, endpointExists: false, error: err };
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   Topology — clusters + nodes
   (fresh reads: the shared queries cache is 15-s-stale by design for other
   pages; the settings console patches and must read its own writes)
   --------------------------------------------------------------------------- */

export const fetchClusters = (): Promise<ClusterTopology[]> => api.clusters();

export type ClusterPatchBody = {
  name?: string;
  accent_color?: string;
  notes?: string | null;
  /** sent whole so a partial-merge backend can't leave stale keys behind */
  control?: ClusterControl;
  /**
   * GAP: cluster PATCH drops `profiles` server-side (routes.apply_patch
   * exclusion). We send it anyway so the same call works on backends that
   * honor it; saveProfiles() verifies and falls back to the import upsert.
   */
  profiles?: ProfileDef[];
};

export interface ClusterCreateInput {
  name: string;
  kind?: ClusterKind;
  accent_color?: string;
  notes?: string | null;
  control?: ClusterControl;
  profiles?: ProfileDef[];
}

export async function createCluster(input: ClusterCreateInput): Promise<ClusterConfig> {
  const raw = await api.post<unknown>('/api/clusters', input);
  if (isRecord(raw) && typeof raw.id === 'string') return raw as unknown as ClusterConfig;
  throw new Error('POST /api/clusters returned no cluster id');
}

export function patchCluster(id: ID, body: ClusterPatchBody): Promise<unknown> {
  return api.patch<unknown>(`/api/clusters/${id}`, body);
}

export function deleteCluster(id: ID): Promise<{ ok: boolean }> {
  return api.del<{ ok: boolean }>(`/api/clusters/${id}`);
}

export type NodePatchBody = Partial<Omit<NodeConfig, 'id' | 'cluster_id'>>;

export function patchNode(id: ID, body: NodePatchBody): Promise<unknown> {
  return api.patch<unknown>(`/api/nodes/${id}`, body);
}

/** Short id in the same style the backend mints (`uuid4().hex[:12]`). */
export function clientNodeId(): string {
  const hex = '0123456789abcdef';
  const bytes = globalThis.crypto?.getRandomValues?.(new Uint8Array(6)) ?? null;
  if (bytes === null) return Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  let out = '';
  for (const b of bytes) out += hex[b % 16];
  return out;
}

export type NodeCreateVia = 'post-node' | 'import-upsert';

/**
 * GAP: there is no `POST /api/nodes` anywhere in the backend. Add-node tries
 * `POST /api/nodes` first (future-proofing) and rides the bulk import upsert
 * (`POST /api/settings/import` with the cluster topology incl. the new node)
 * when the route is absent. The node id is client-minted on the upsert path.
 */
export async function createNode(cluster: ClusterTopology, node: Omit<NodeConfig, 'id'> & { id?: ID }): Promise<{ node: NodeConfig | null; via: NodeCreateVia | null }> {
  try {
    const raw = await api.post<unknown>('/api/nodes', node);
    if (isRecord(raw) && typeof raw.id === 'string') {
      return { node: raw as unknown as NodeConfig, via: 'post-node' };
    }
  } catch {
    /* route missing / not accepted — ride the import upsert */
  }
  const withNew = { ...node, id: node.id ?? clientNodeId() } as NodeConfig;
  const clusterWithNew: ClusterTopology = { ...cluster, nodes: [...cluster.nodes, withNew] };
  const res = await importTopology([clusterWithNew]);
  if (!res.ok && res.endpointExists) throw new Error('add-node failed via import upsert');
  const fresh = await fetchClusters();
  const cl = fresh.find((c) => c.id === cluster.id);
  const found = cl?.nodes.find((n) => n.id === withNew.id) ?? null;
  return { node: found, via: 'import-upsert' };
}

/* ---------------------------------------------------------------------------
   Node test (shape normalized from routes.py node_test)
   --------------------------------------------------------------------------- */

export interface NodeTestAttempt {
  addr: string;
  ok: boolean | null;
  error: string | null;
}

export interface NodeTestReport {
  ok: boolean | null;
  used_addr: string | null;
  lan_addr: string | null;
  attempts: NodeTestAttempt[];
  collector: CollectorState;
  python: string | null;
  docker: string | null; // "ok" | "missing"
  nvidia: string | null; // "ok" | "missing"
  unverified: boolean;
  message: string | null;
}

export async function testNode(id: ID): Promise<NodeTestReport> {
  const raw = await api.post<unknown>(`/api/nodes/${id}/test`, {});
  const r = isRecord(raw) ? raw : {};
  const attempts = asRecordList(r.attempts).map((a): NodeTestAttempt => ({
    addr: asString(a.addr) ?? asString(a.host) ?? '—',
    ok: typeof a.ok === 'boolean' ? a.ok : null,
    error: asString(a.error),
  }));
  const versions = isRecord(r.versions) ? r.versions : {};
  const collectorRaw = isRecord(r.collector) ? r.collector.state : r.collector;
  return {
    ok: typeof r.ok === 'boolean' ? r.ok : null,
    used_addr: asString(r.used_addr),
    lan_addr: asString(r.lan_addr),
    attempts,
    collector: normalizeCollectorState(asString(collectorRaw)),
    python: asString(versions.python),
    docker: asString(versions.docker),
    nvidia: asString(versions.nvidia),
    unverified: r.unverified === true,
    message: asString(r.error) ?? asString(r.message),
  };
}

function normalizeCollectorState(v: string | null): CollectorState {
  switch (v) {
    case 'healthy':
    case 'stale':
    case 'down':
    case 'none':
    case 'unprobed':
      return v;
    default:
      return 'unprobed';
  }
}

/**
 * GAPEXT: docs/API.md lists `POST /api/nodes/{id}/actions/deploy-collector`;
 * the implemented route is `.../actions/collector`. Primary = implemented
 * path, fallback = docs name (future-proofing both directions).
 */
export async function deployCollector(id: ID): Promise<OpRef> {
  try {
    return asOpRef(await api.post<unknown>(`/api/nodes/${id}/actions/collector`, {}));
  } catch (err) {
    if (isMissingRoute(err)) {
      return asOpRef(await api.post<unknown>(`/api/nodes/${id}/actions/deploy-collector`, {}));
    }
    throw err;
  }
}

/* ---------------------------------------------------------------------------
   Images / engine (enveloped responses normalized per backend)
   --------------------------------------------------------------------------- */

export interface NodeImageState {
  images: ImageInfo[];
  state: string; // "online" | "offline" | …
}

export async function fetchNodeImages(nodeId: ID): Promise<NodeImageState> {
  const raw = await api.get<unknown>(`/api/images/${nodeId}`);
  // DRIFT: backend wraps in {images, state}; tolerate the documented bare array.
  const rows = isRecord(raw)
    ? (asRecordList(raw.images) as unknown[] as Record<string, unknown>[])
    : asRecordList(raw);
  const images: ImageInfo[] = [];
  for (const row of rows) {
    const repoTag = asString(row.repo_tag);
    if (repoTag !== null) {
      images.push({
        node_id: nodeId,
        repo_tag: repoTag,
        image_id: asString(row.image_id) ?? '',
        created_label: asString(row.created_label) ?? '',
        size_mb: asNumber(row.size_mb) ?? 0,
      });
    }
  }
  return { images, state: isRecord(raw) ? (asString(raw.state) ?? 'offline') : 'online' };
}

export async function fetchEnvImages(clusterId: ID): Promise<EnvImageRow[]> {
  const raw = await api.get<unknown>(`/api/images/envs/${clusterId}`);
  // DRIFT: backend wraps in {envs}; tolerate the documented bare array.
  const rows = Array.isArray(raw) ? raw : isRecord(raw) ? (raw.envs ?? raw.rows ?? []) : [];
  const out: EnvImageRow[] = [];
  for (const row of asRecordList(rows)) {
    // GAP: types.ts pins file/image as non-null strings, but the backend sends
    // `null` for offline nodes — normalize to '' (page renders as "offline").
    const per = asRecordList(row.clusters).map((c) => ({
      node_id: asString(c.node_id) ?? '',
      node_name: asString(c.node_name) ?? asString(c.node_id) ?? '',
      file: asString(c.file) ?? '',
      image: asString(c.image) ?? '',
    }));
    out.push({ profile_key: asString(row.profile_key) ?? '', clusters: per });
  }
  return out;
}

export function fetchDeployPreview(
  clusterId: ID,
  profileKey: string,
  image: string,
): Promise<ImageSetPreview> {
  return api.get<ImageSetPreview>('/api/images/deploys/preview', {
    cluster_id: clusterId,
    profile_key: profileKey,
    image,
  });
}

export async function deployImageSet(body: {
  cluster_id: ID;
  profile_key: string;
  image: string;
}): Promise<OpRef> {
  return asOpRef(await api.post<unknown>('/api/images/deploys', body));
}

/** EXTRA+DRIFT: `cluster_id` is required by the backend (docs/API.md omits it). */
export async function copyImage(body: {
  cluster_id: ID;
  src_node_id: ID;
  dst_node_id: ID;
  image: string;
}): Promise<OpRef> {
  return asOpRef(await api.post<unknown>('/api/images/copies', body));
}

export interface BuilderEnvRow {
  node_id: ID; // client-attached (backend rows don't carry it)
  file: string;
  label: string;
}

export async function fetchBuildEnvs(nodeId: ID): Promise<{ files: BuilderEnvRow[]; state: string }> {
  const raw = await api.get<unknown>(`/api/images/builds/${nodeId}`);
  // DRIFT: backend returns {files:[{file,label}], state} — no node_id per row.
  const payload = isRecord(raw) ? raw : {};
  const rows = Array.isArray(raw) ? raw : payload.files ?? payload.rows ?? [];
  const files = asRecordList(rows).map(
    (f): BuilderEnvRow => ({
      node_id: nodeId,
      file: asString(f.file) ?? '',
      label: asString(f.label) ?? asString(f.file) ?? '',
    }),
  );
  return { files, state: asString(payload.state) ?? 'offline' };
}

export async function startImageBuild(body: {
  cluster_id: ID;
  node_id: ID;
  file: string;
}): Promise<OpRef> {
  return asOpRef(await api.post<unknown>('/api/images/builds', body));
}

/* ---------------------------------------------------------------------------
   LLM state (bench "from boot log" reads kv_tokens; populated after a boot)
   --------------------------------------------------------------------------- */

/** GET /api/llm/{clusterId}/state — ServiceState per docs/API.md. */
export const fetchLlmState = (clusterId: ID): Promise<ServiceState> =>
  api.get<ServiceState>(`/api/llm/${clusterId}/state`);

/* ---------------------------------------------------------------------------
   Bench
   --------------------------------------------------------------------------- */

export interface BenchDefaults {
  label: string;
  args: BenchArgs;
}

export interface BenchConfig {
  bench_repo_dir: string | null;
  tool_present: boolean;
  venv_python: string | null;
  venv_deps_ok: boolean | null; // null = no venv to test
  write_repo_runs: boolean | null;
  defaults: BenchDefaults | null;
}

function parseBenchConfigRaw(raw: unknown): BenchConfig {
  const r = isRecord(raw) ? raw : {};
  const defaultsRaw = isRecord(r.defaults) ? r.defaults : null;
  const argsRaw = defaultsRaw !== null && isRecord(defaultsRaw.args) ? defaultsRaw.args : defaultsRaw;
  return {
    bench_repo_dir: asString(r.bench_repo_dir),
    tool_present: r.tool_present === true,
    venv_python: asString(r.venv_python),
    venv_deps_ok: typeof r.venv_deps_ok === 'boolean' ? r.venv_deps_ok : null,
    write_repo_runs: typeof r.write_repo_runs === 'boolean' ? r.write_repo_runs : null,
    defaults:
      argsRaw !== null && isRecord(argsRaw)
        ? {
            label: asString(defaultsRaw?.label) ?? 'adhoc',
            args: normalizeBenchArgs(argsRaw),
          }
        : null,
  };
}

export async function fetchBenchConfig(): Promise<BenchConfig> {
  return parseBenchConfigRaw(await api.get<unknown>('/api/bench/config'));
}

/** PATCH /api/bench/config — partial-capable slice of bench settings. */
export interface BenchConfigPatch {
  bench_repo_dir?: string | null;
  write_repo_runs?: boolean;
  defaults?: { label?: string; args: BenchArgs };
}

export async function patchBenchConfig(body: BenchConfigPatch): Promise<BenchConfig> {
  return parseBenchConfigRaw(await api.patch<unknown>('/api/bench/config', body));
}

/** POST /api/bench/bootstrap-venv → `{rc, log}` (synchronous; NOT an op). */
export async function bootstrapBenchVenv(): Promise<{ rc: number | null; log: string[] }> {
  const raw = await api.post<unknown>('/api/bench/bootstrap-venv', {});
  const r = isRecord(raw) ? raw : {};
  const log = asString(r.log) ?? '';
  return { rc: asNumber(r.rc), log: log.length > 0 ? log.split('\n') : [] };
}

export interface BenchJobInput {
  cluster_id: ID;
  profile_key?: string | null;
  host: string;
  port: number;
  model: string;
  label: string;
  kv_budget?: number | null;
  args: BenchArgs;
}

/** POST /api/bench/jobs → `{job_id, argv}` (confirmed shape). */
export interface BenchJobCreated {
  job_id: string | null;
  argv: string[];
}

export async function createBenchJob(input: BenchJobInput): Promise<BenchJobCreated> {
  const raw = await api.post<unknown>('/api/bench/jobs', input);
  const r = isRecord(raw) ? raw : {};
  const job_id = asString(r.job_id) ?? asString(r.id);
  if (job_id === null) return { job_id: null, argv: [] };
  const argv = asList(r.argv).filter((x): x is string => typeof x === 'string');
  return { job_id, argv };
}

export async function fetchBenchJobs(limit?: number): Promise<BenchJob[]> {
  const raw = await api.get<unknown>(
    '/api/bench/jobs',
    limit === undefined ? undefined : { limit },
  );
  const rows = isRecord(raw) ? asList(raw.jobs) : asList(raw);
  const out: BenchJob[] = [];
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === 'string') out.push(row as unknown as BenchJob);
  }
  return out;
}

export interface BenchJobDetail {
  job: BenchJob | null;
  tail: string[];
}

/**
 * GET /api/bench/jobs/{id}?tail=N → job dump + `log_tail` lines.
 * (WS frames use `tail` as one string; REST returns `log_tail: string[]`.)
 */
export async function fetchBenchJob(id: ID, tailLines = 100): Promise<BenchJobDetail> {
  const raw = await api.get<unknown>(`/api/bench/jobs/${id}`, { tail: tailLines });
  const r = isRecord(raw) ? raw : {};
  const job = typeof r.id === 'string' ? (raw as unknown as BenchJob) : null;
  const tailRaw = r.log_tail ?? r.tail;
  let tail: string[] = [];
  if (typeof tailRaw === 'string') tail = tailRaw.split('\n');
  else if (Array.isArray(tailRaw)) tail = tailRaw.filter((x): x is string => typeof x === 'string');
  return { job, tail };
}

/** SIGINT semantics: partial results preserved (runner keeps SIGKILL as last resort). */
export async function cancelBenchJob(id: ID): Promise<{ ok: boolean }> {
  const raw = await api.post<unknown>(`/api/bench/jobs/${id}/cancel`, {});
  const r = isRecord(raw) ? raw : {};
  return { ok: r.ok === true };
}

/** GET /api/bench/jobs/{id}/result — raw tool JSON ({}) while absent. */
export const fetchBenchResult = (id: ID): Promise<unknown> =>
  api.get<unknown>(`/api/bench/jobs/${id}/result`);

export interface BenchReportWritten {
  rc: number | null;
  path: string | null;
  repo_path: string | null;
  repo_error: string | null;
  error: string | null;
}

export async function writeBenchReport(id: ID): Promise<BenchReportWritten> {
  const raw = await api.post<unknown>(`/api/bench/jobs/${id}/report`, {});
  const r = isRecord(raw) ? raw : {};
  return {
    rc: asNumber(r.rc),
    path: asString(r.path),
    repo_path: asString(r.repo_path),
    repo_error: asString(r.repo_error),
    error: asString(r.error),
  };
}

export async function fetchBenchHistory(): Promise<BenchHistoryRow[]> {
  const raw = await api.get<unknown>('/api/bench/history');
  const rows = isRecord(raw) ? asList(raw.rows) : asList(raw);
  const out: BenchHistoryRow[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const summary = isRecord(row.summary) ? row.summary : {};
    out.push({
      job_id: asString(row.job_id),
      source: asString(row.source) === 'repo' ? 'repo' : 'sparkdeck',
      path: asString(row.path) ?? '',
      label: asString(row.label) ?? '(unlabelled)',
      ts: asNumber(row.ts),
      summary,
    });
  }
  out.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
  return out;
}

export function normalizeBenchArgs(r: Record<string, unknown>): BenchArgs {
  return {
    concurrency: asString(r.concurrency) ?? '',
    contexts: asString(r.contexts) ?? '',
    prefill_contexts: asString(r.prefill_contexts) ?? '',
    max_tokens: asNumber(r.max_tokens) ?? 2048,
    duration: asNumber(r.duration) ?? 30,
    coding_peak: r.coding_peak === true,
    coding_peak_runs: asNumber(r.coding_peak_runs) ?? undefined,
    coding_peak_max_tokens: asNumber(r.coding_peak_max_tokens) ?? undefined,
    kv_budget: asNumber(r.kv_budget),
    extra: asString(r.extra) ?? undefined,
  };
}

/* ---------------------------------------------------------------------------
   Profiles save (PATCH → verify → import-upsert fallback) + profile delete
   --------------------------------------------------------------------------- */

/** Save a cluster's profile set; returns the wins + the path that worked. */
export async function saveProfiles(
  cluster: ClusterTopology,
  profiles: ProfileDef[],
): Promise<{ applied: boolean; via: 'patch' | 'import' | 'none' }> {
  await patchCluster(cluster.id, {
    name: cluster.name,
    accent_color: cluster.accent_color,
    notes: cluster.notes ?? null,
    control: cluster.control,
    profiles,
  });
  const fresh = await fetchClusters();
  const freshCl = fresh.find((c) => c.id === cluster.id);
  if (profilesEqual(freshCl?.profiles ?? [], profiles)) return { applied: true, via: 'patch' };
  // DRIFT: backend cluster PATCH drops `profiles` → ride the import upsert.
  const res = await importTopology([{ ...cluster, profiles }]);
  if (!res.ok && res.endpointExists) return { applied: false, via: 'import' };
  if (!res.endpointExists) return { applied: false, via: 'none' };
  const after = await fetchClusters();
  const afterCl = after.find((c) => c.id === cluster.id);
  if (profilesEqual(afterCl?.profiles ?? [], profiles)) return { applied: true, via: 'import' };
  return { applied: false, via: 'import' };
}

function profilesEqual(a: ProfileDef[], b: ProfileDef[]): boolean {
  if (a.length !== b.length) return false;
  const keyOf = (p: ProfileDef): string =>
    [
      p.id,
      p.key,
      p.label,
      p.served_model_name,
      p.model_dir_hint ?? '',
      p.kv_pin_gib ?? '',
      p.context ?? '',
      p.speculator ?? '',
      p.quant ?? '',
      p.mm_images ?? '',
      p.mm_videos ?? '',
      p.notes ?? '',
    ].join('¦');
  const sa = a.map(keyOf).sort();
  const sb = b.map(keyOf).sort();
  return sa.every((v, i) => v === sb[i]);
}
