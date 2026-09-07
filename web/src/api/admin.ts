/* ============================================================================
   api/admin — thin typed helpers for the settings / bench / images console.

   Everything rides the pinned contract in `src/api/types.ts` (docs/API.md
   mirror). Where the live backend drifts from docs/API.md (response envelopes,
   extra required fields, moved endpoints), the wizardry is normalized HERE so
   pages never see raw unknowns; every normalization carries a `// DRIFT:` or
   `// GAP:` tag so the report can account for it.

   Drifts encoded (from backend/sparkdeck/api/routes.py + bench/runner.py):
   - GET /api/images/{nodeId}        → `{images: ImageInfo[], state}` (docs: bare array)
   - GET /api/images/envs/{cluster}  → `{envs: EnvImageRow[]}`        (docs: bare array)
   - GET /api/images/builds/{node}   → `{files: [{file,label}], state}` (docs: bare array;
                                        rows carry NO node_id though types.ts wants one)
   - POST /api/images/copies|builds  → require `cluster_id`            (docs omit it)
   - node collector deploy           → POST /api/nodes/{id}/actions/collector
                                       (docs/API.md says actions/deploy-collector)
   - POST /api/nodes/{id}/test       → `{ok, used_addr, attempts:[{addr, ok, error}],
                                       collector, versions, lan_addr, unverified}`
                                       (docs describe it, shape not pinned; no latency field)
   - GET /api/bench/config           → `{bench_repo_dir, tool_present, venv_python,
                                       venv_deps_ok, write_repo_runs, defaults:{label, args}}`
   - PATCH /api/bench/config         → body IS a bench-settings slice
                                       (`{bench:{…}}`-wrapped server-side; client sends
                                       {bench_repo_dir?, write_repo_runs?, defaults?}
                                       and defaults carries `{label, args}`)
   - POST /api/bench/bootstrap-venv  → `{rc, log}` (synchronous, NOT an op)
   - POST /api/bench/jobs            → `{job_id, argv: string[]}`
   - GET  /api/bench/jobs/{id}?tail→ job dump + `log_tail: string[]` (WS uses `tail`,
                                       REST uses `log_tail`)
   - POST /api/bench/jobs/{id}/report→ `{rc, path, repo_path?}` or `{rc:1, error}`
   - cluster PATCH drops `profiles` (apply_patch excludes them) → profile edits
     verify-and-fallback to POST /api/settings/import (bulk upsert, never deletes).
   - POST /api/nodes does NOT exist → add-node rides the import upsert as fallback.
   - GET /api/settings/export → `{topology: ClusterTopology[], settings}`.
   ========================================================================= */

import { api } from './client';
import type {
  AppSettings,
  BenchArgs,
  BenchHistoryRow,
  BenchJob,
  BuildEnvFile,
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

/** Common control-verb response: `{op_id}` (tolerate `id` as a drift). */
export interface OpRef {
  op_id: string | null;
}

function asOpRef(v: unknown): OpRef {
  const r = isRecord(v) ? v : {};
  return { op_id: asString(r.op_id) ?? asString(r.id) };
}

/* ---------------------------------------------------------------------------
   App settings — GET/PATCH /api/settings (PATCH is partial-capable per
   section: {alerts:{…}, bench:{…}, …}; response is the full merged dump)
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

export function fetchSettings(): Promise<AppSettings> {
  return api.get<AppSettings>('/api/settings');
}

export function patchSettings(patch: SettingsPatch): Promise<AppSettings> {
  return api.patch<AppSettings>('/api/settings', patch);
}

export interface SettingsExport {
  topology: ClusterTopology[];
  settings: AppSettings | null;
}

/** GET /api/settings/export → `{topology, settings}` per backend. */
export async function fetchSettingsExport(): Promise<SettingsExport> {
  const raw = await api.get<unknown>('/api/settings/export');
  const r = isRecord(raw) ? raw : {};
  const topology = asRecordList(r.topology ?? r.clusters) as ClusterTopology[];
  const rawSettings = r.settings;
  return {
    topology,
    settings:
      isRecord(rawSettings) && typeof rawSettings.sampling_interval_s !== 'undefined'
        ? (rawSettings as AppSettings)
        : null,
  };
}

/* ---------------------------------------------------------------------------
   Topology — clusters + nodes
   (fresh reads: the shared queries cache is 15 s-stale by design for other
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
   * GAP(tx2): cluster PATCH drops `profiles` server-side (apply_patch exclude).
   * We send it anyway (future-proofing) and then verify — `saveProfiles()`
   * falls back to the bulk `/api/settings/import` upsert when the PATCH is a
   * silent no-op.
   */
  profiles?: ProfileDef[];
};

/** POST /api/clusters — model_validated; everything except name has defaults. */
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

export function clientNodeId(): string {
  const hex = '0123456789abcdef';
  let out = '';
  const rnd = globalThis.crypto?.getRandomValues?.(new Uint8Array(6));
  if (rnd !== undefined) {
    for (const b of rnd) out += hex[b % 16];
  } else {
    out = Math.random().toString(16).slice(2, 14).padEnd(12, '0');
  }
  return out;
}

/**
 * GAP: there is no `POST /api/nodes` anywhere in the backend. Add-node is
 * implemented as: try `POST /api/nodes` (future-proofing), and when that's not
 * acceptable, ride the bulk upsert (`POST /api/settings/import` with the
 * cluster's full topology incl. the new node) — upsert, never destructive.
 */
export interface NodeCreateResult {
  node: NodeConfig | null;
  via: 'post-node' | 'import-upsert';
}

function uuidHex12(): string {
  return clientNodeId();
}

export async function createNode(
  cluster: ClusterTopology,
  node: NodeConfig,
): Promise<NodeCreateResult> {
  try {
    const raw = await api.post<unknown>('/api/nodes', node);
    if (isRecord(raw) && typeof raw.id === 'string') {
      return { node: raw as unknown as NodeConfig, via: 'post-node' };
    }
  } catch (err) {
    // fall through to the import upsert
    const imported = await importTopology([withExtraNode(cluster, node)]);
    if (imported.ok) {
      // verify the node actually landed (id is client-assigned for this path)
      const fresh = await fetchClusters();
      const cl = fresh.find((c) => c.id === cluster.id);
      const found = cl?.nodes.find((n) => n.id === node.id);
      if (found !== undefined) return { node: found, via: 'import-upsert' };
      const freshErr = new Error('node was accepted by import-upsert but did not appear in the topology');
      return { node: null, via: 'import-upsert' as const } as unknown as NodeCreateResult extends never ? never : NodeCreateResult | (typeof freshErr extends Error ? { node: null; via: 'import-upsert' } : never);
    }
    throw err;
  }
  return { node: null, via: 'post-node' };
}

function newId(): string {
  return uuidHex12();
}

/** Cluster topology copy with one extra node (for the import-upsert fallback). */
function withExtraNode(cluster: ClusterTopology, node: NodeConfig): ClusterTopology {
  return { ...cluster, nodes: [...cluster.nodes, node] };
}

/* ---------------------------------------------------------------------------
   Node test — POST /api/nodes/{id}/test (shape normalized from routes.py)
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
  /** server probe lines: python like "Python 3.12.x …"; docker/nvidia "ok"|"missing" */
  python: string | null;
  docker: string | null;
  nvidia: string | null;
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
  return {
    ok: typeof r.ok === 'boolean' ? r.ok : null,
    used_addr: asString(r.used_addr),
    lan_addr: asString(r.lan_addr),
    attempts,
    collector: normalizeCollectorState(asString(r.collector) ?? (isRecord(r.collector) ? asString(r.collector.state) : null)),
    python: asString(versions.python),
    docker: asString(versions.docker),
    nvidia: asString(versions.nvidia),
    unverified: r.unverified === true,
    message: asString(r.error),
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
 * GAPEXT: docs/API.md lists `POST /api/nodes/{id}/actions/deploy-collector`,
 * but the backend route is `POST /api/nodes/{id}/actions/collector`.
 * We call the implemented path (task wording) and keep the docs name in the
 * report.
 */
export async function deployCollector(id: ID): Promise<OpRef> {
  try {
    return asOpRef(await api.post<unknown>(`/api/nodes/${id}/actions/collector`, {}));
  } catch (err) {
    if (isMissingEndpoint(err)) {
      return asOpRef(await api.post<unknown>(`/api/nodes/${id}/actions/deploy-collector`, {}));
    }
    throw err;
  }
}

function isMissingEndpoint(err: unknown): boolean {
  if (isRecord2(err)) return false;
  return true;
}
function isRecord2(_: unknown): boolean {
  return false; /* marker helper — see isMissingRoute below */
}

/** True when an ApiClientError indicates "route not implemented". */
export function isMissingRoute(err: unknown): err is { status: number; message: string } {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = typeof e.code === 'string' ? e.code : undefined;
  return (
    (status === 404 || status === 405 || code === 'unsupported' || code === 'not_found') &&
    !(code === 'not_found' && typeof e.message === 'string' && /node not found|cluster not found|job not found|op not found/i.test(e.message))
  );
}

/* ---------------------------------------------------------------------------
   Images / engine (enveloped responses normalized per backend)
   --------------------------------------------------------------------------- */

export interface NodeImageState {
  images: ImageInfo[];
  state: string; // online | offline | …
}

export async function fetchNodeImages(nodeId: ID): Promise<NodeImageState> {
  const raw = await api.get<unknown>(`/api/images/${nodeId}`);
  const r = isRecord(raw) ? raw : {};
  // DRIFT: backend wraps in {images, state}; tolerate the documented bare array.
  const images = isRecord(raw)
    ? (asRecordList(r.images) as ImageInfo[])
    : (asRecordList(raw) as ImageInfo[]);
  return {
    images: images.filter((im) => isRecord(im as unknown) && typeof (im as unknown as ImageInfo).repo_tag === 'string'),
    state: asString(r.state) ?? 'offline',
  };
}

export async function fetchEnvImages(clusterId: ID): Promise<EnvImageRow[]> {
  const raw = await api.get<unknown>(`/api/images/envs/${clusterId}`);
  const r = isRecord(raw) ? raw : {};
  // DRIFT: backend wraps in {envs};
  const rows = asRecordList(r.envs.length !== 0 ? r.envs : Array.isArray(raw) ? raw : r.envs ?? r.rows) as unknown[];
  return rows.filter(isRecord).map((row): EnvImageRow => {
    const per = asRecordList(row.clusters).map((c) => ({
      node_id: asString(c.node_id) ?? '',
      node_name: asString(c.node_name) ?? asString(c.node_id) ?? '',
      file: asString(c.file),
      image: asString(c.image),
    }));
    return { profile_key: asString(row.profile_key) ?? '', clusters: per };
  });
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

/** NOTE: `cluster_id` is required by the backend despite docs/API.md omitting it. */
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
  const r = isRecord(raw) ? raw : {};
  const files = asRecordList(r.files.length !== 0 ? r.files : Array.isArray(raw) ? raw : r.rows).map(
    (f): BuilderEnvRow => ({
      node_id: nodeId,
      // DRIFT: backend rows are {file,label} without node_id
      file: asString(f.file) ?? '',
      label: asString(f.label) ?? asString(f.file) ?? '',
    }),
  );
  return { files, state: asString(r.state) ?? 'offline' };
}

export async function startImageBuild(body: {
  cluster_id: ID;
  node_id: ID;
  file: string;
}): Promise<OpRef> {
  return asOpRef(
    await api.post<unknown>('/api/images/builds', body),
  );
}

/* ---------------------------------------------------------------------------
   LLM state (bench "from boot log" reads kv_tokens; mock populates it)
   --------------------------------------------------------------------------- */

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
  tool: string | null;
  venv_python: string | null;
  venv_deps_ok: boolean | null; // None = no venv to test
  write_repo_runs: boolean | null;
  defaults: BenchDefaults | null;
}

export async function fetchBenchConfig(): Promise<BenchConfig> {
  const raw = await api.get<unknown>('/api/bench/config');
  const r = isRecord(raw) ? raw : {};
  const defaultsRaw = isRecord(r.defaults) ? r.defaults : null;
  const argsRaw = defaultsRaw !== null && isRecord(defaultsRaw.args) ? defaultsRaw.args : defaultsRaw;
  return {
    bench_repo_dir: asString(r.bench_repo_dir),
    tool_present: r.tool_present === true,
    tool: asString(r.tool_path) ?? asString(r.tool) ?? (asNumber2(r.tool_present) !== null ? null : null),
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

function asNumber2(v: unknown): number | null {
  return asNumber(v);
}

/** PATCH /api/bench/config — partial-capable slice of bench settings. */
export interface BenchConfigPatch {
  bench_repo_dir?: string | null;
  write_repo_runs?: boolean;
  defaults?: { label?: string; args: BenchArgs };
}

export async function patchBenchConfig(body: BenchConfigPatch): Promise<BenchConfig> {
  const raw = await api.patch<unknown>('/api/bench/config', body);
  const r = isRecord(raw) ? raw : {};
  const defaultsRaw = isRecord(r.defaults) ? r.defaults : null;
  const argsRaw = defaultsRaw !== null && isRecord(defaultsRaw.args) ? defaultsRaw.args : defaultsRaw;
  return {
    bench_repo_dir: asString(r.bench_repo_dir),
    tool_present: r.tool_present === true,
    tool: asString(r.tool_path) ?? asString(r.tool),
    venv_python: asString(r.venv_python),
    venv_deps_ok: typeof r.venv_deps_ok === 'boolean' ? r.venv_deps_ok : null,
    write_repo_runs: typeof r.write_repo_runs === 'boolean' ? r.write_repo_runs : null,
    defaults: argsRaw !== null && isRecord(argsRaw) ? { label: asString(defaultsRaw?.label) ?? 'adhoc', args: normalizeBenchArgs(argsRaw) } : null,
  };
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
  // GAPEXT: docs say response is an array; tolerate {jobs:[…]} defensively.
  const raw = await api.get<unknown>(limit === undefined ? '/api/bench/jobs' : '/api/bench/jobs', limit === undefined ? undefined : { limit });
  const wrapped = isRecord(raw) ? asList(raw.jobs) : asList(raw);
  const out: BenchJob[] = [];
  for (const j of wrapped) {
    if (isRecord(j) && typeof j.id === 'string') out.push(asBenchJob(j));
  }
  return out;
}

function asBenchJob(j: Record<string, unknown>): BenchJob {
  const copy = { ...(j as unknown as BenchJob) };
  if (!Array.isArray((j as { args?: unknown }).args)) {
    /* args must be BenchArgs-shaped; pass-through, the type pins it */
  }
  return copy;
}

export interface BenchJobDetail {
  job: BenchJob | null;
  tail: string[];
}

/**
 * GET /api/bench/jobs/{id}?tail=N → job dump + `log_tail` lines.
 * (WS frames use `tail` as a single string; REST returns `log_tail: string[]`.)
 */
export async function fetchBenchJob(id: ID, tailLines = 100): Promise<BenchJobDetail> {
  const raw = await api.get<unknown>(`/api/bench/jobs/${id}`, { tail: tailLines });
  const r = isRecord(raw) ? raw : {};
  const job = isRecord(raw) && typeof raw['id'] === 'string' ? (raw as unknown as BenchJob) : null;
  const tailRaw = r.log_tail ?? r.tail ?? (job?.log_tail !== undefined ? job.log_tail : []);
  let tail: string[] = [];
  if (typeof tailRaw === 'string') tail = tailRaw.split('\n');
  else if (Array.isArray(tailRaw)) tail = tailRaw.filter((x): x is string => typeof x === 'string');
  return { job: job === null ? null : asBenchJob(isRecord(raw) ? raw : {}), tail };
}

export async function cancelBenchJob(id: ID): Promise<{ ok: boolean }> {
  const raw = await api.post<unknown>(`/api/bench/jobs/${id}/cancel`, {});
  const r = isRecord(raw) ? raw : {};
  return { ok: r.ok === true };
}

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
  const source = isRecord(raw) ? asList(raw.rows) : asList(raw);
  const out: BenchHistoryRow[] = [];
  for (const row of source) {
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
  const num = (defaultV: number | null): (v: unknown) => number | null => (v) => asNumber(v) ?? defaultV;
  const withDefault = (v: unknown, d: number | null) => asNumber(v) ?? d;
  return {
    concurrency: asString(r.concurrency) ?? '',
    contexts: asString(r.contexts) ?? '',
    prefill_contexts: asString(r.prefill_contexts) ?? '',
    max_tokens: withDefault(r.max_tokens, 2048),
    duration: withDefault(r.duration, 30),
    coding_peak: r.coding_peak === true,
    coding_peak_runs: asNumber(r.coding_peak_runs) ?? undefined,
    coding_peak_max_tokens: asNumber(r.coding_peak_max_tokens) ?? undefined,
    kv_budget: withDefault(r.kv_budget, null),
    extra: asString(r.extra) ?? undefined,
  };
  void num;
}

/* ---------------------------------------------------------------------------
   Profiles + add-node via the bulk upsert pair
   --------------------------------------------------------------------------- */

/**
 * Save a cluster's profile set. The contract's cluster PATCH drops `profiles`,
 * so: (1) PATCH the cluster with the new profiles array (works on backends
 * that honor it), (2) re-read, (3) if unchanged, fall back to
 * POST /api/settings/import with the whole cluster (bulk upsert).
 */
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
  const freshTopo = await fetchClusters();
  const fresh = freshTopo.find((c) => c.id === cluster.id);
  if (profilesEqual(fresh?.profiles ?? [], profiles)) return { applied: true, via: 'patch' };
  const res = await importTopology([{ ...cluster, profiles }]);
  if (!res.ok || res.fallbackUsed === null) {
    return { applied: false, via: res.fallbackUsed === null ? 'none' : 'import' };
  }
  const after = await fetchClusters();
  const afterCl = after.find((c) => c.id === cluster.id);
  if (profilesEqual(afterCl?.profiles ?? [], profiles)) return { applied: true, via: 'import' };
  return { applied: false, via: 'import' };
}

function profilesEqual(a: ProfileDef[], b: ProfileDef[]): boolean {
  if (a.length !== b.length) return false;
  const keyOf = (p: ProfileDef): string =>
    [p.id, p.key, p.label, p.served_model_name, p.kv_pin_gib ?? '', p.context ?? '', p.speculator ?? '', p.quant ?? '', p.mm_images ?? '', p.mm_videos ?? '', p.notes ?? ''].join('¦');
  const sa = a.map(keyOf).sort();
  const sb = b.map(keyOf).sort();
  return sa.every((v, i) => v === sb[i]);
}

/**
 * POST /api/settings/import — bulk upsert `{topology, settings}`.
 * NOTE: present in the backend (routes.py `settings_import`), missing from
 * docs/API.md — flagged in the report; falls back to client-side enumeration
 * when the endpoint answers as missing.
 */
export async function importTopology(
  topology: ClusterTopology[],
): Promise<{ ok: boolean; clusters: number | null; fallbackUsed: boolean | null; error?: unknown }> {
  try {
    const raw = await api.post<unknown>('/api/settings/import', { topology });
    const r = isRecord(raw) ? raw : {};
    return { ok: r.ok === true, clusters: asNumber(r.clusters), fallbackUsed: false };
  } catch (err) {
    if (isMissingRoute(err)) {
      // GAP: endpoint absent — caller may still use the per-cluster dispatcher.
      return { ok: false, clusters: null, fallbackUsed: null, error: err };
    }
    throw err;
  }
}

export { newId };
