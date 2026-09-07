/* ============================================================================
   api/control — typed helpers for the control/audit endpoints this wave
   drives (cluster lifecycle, node ops, env files, event audit, log SSE).

   The pinned contract lives in src/api/types.ts (never edited); shapes that
   the wire actually delivers are declared here client-side (see report notes
   in wave handoff):

   - GET /api/logs/containers/{node} returns `{containers: [...], state}`
     (the generic `api.logContainers` in client.ts types it as a bare array —
     kept as-is there; this module provides the wrapped version).
   - POST /api/events/ack returns `{ok, count?}` (client.ts types `{acked}`).
   - GET /api/events supports `kind` + `unacked_only` server-side; `level`
     accepts a single value, so multi-level filtering stays client-side.
   ========================================================================= */

import { api, apiBaseUrl, getAuthToken } from './client';
import type {
  ContainerInfo,
  EpochMs,
  EventRec,
  ID,
  LiveNodeState,
  LogFrame,
  OpRecord,
  ServiceState,
} from './types';

export type OpIdResponse = { op_id: string };
export type CancelOpResponse = { ok: boolean };

/** GET /api/clusters/{id}/live — nodes/service degrade to partial objects
    when the cluster was never probed (service is `{}` when unknown). */
export type LiveNodePartial = Partial<LiveNodeState> & { node_id: ID };
export type LiveServicePartial =
  | (Partial<ServiceState> & { cluster_id?: ID })
  | Record<string, never>;

export interface ClusterLive {
  cluster_id: ID;
  nodes: LiveNodePartial[];
  service: LiveServicePartial;
  recent_ops: OpRecord[];
}

/** GET /api/clusters/{id}/envfiles — content is null while the node is
    offline; a failed host `cat` arrives as "!! cat failed: …". */
export interface EnvFileRow {
  node_id: ID;
  node_name: string;
  state: string;
  file?: string | null;
  content: string | null;
}
export interface EnvFilesResponse {
  profile_key: string;
  files: EnvFileRow[];
}

export interface ContainersResponse {
  containers: ContainerInfo[];
  state: string;
}

export interface StartClusterBody {
  profile_key: string;
  health_timeout_s?: number | null;
  skip_preflight?: boolean;
  extra?: string | null;
}

export interface ListEventsOpts {
  limit?: number;
  /** single level — the server accepts one; compose levels client-side */
  level?: 'info' | 'warn' | 'error';
  kind?: string;
  clusterId?: ID;
  since?: EpochMs;
  unackedOnly?: boolean;
}

export interface AckResponse {
  ok: boolean;
  count?: number;
}

/* ---------------------------------------------------------------------------
   Cluster control verbs — every action returns {op_id} and streams via the
   WS `ops` topic; poll GET /api/ops/{id} only as a WS fallback.
   --------------------------------------------------------------------------- */

export function getClusterLive(clusterId: ID): Promise<ClusterLive> {
  return api.get<ClusterLive>(`/api/clusters/${clusterId}/live`);
}

export function getEnvFiles(clusterId: ID, profileKey?: string | null): Promise<EnvFilesResponse> {
  return api.get<EnvFilesResponse>(`/api/clusters/${clusterId}/envfiles`, {
    profile_key: profileKey ?? undefined,
  });
}

export function startCluster(clusterId: ID, body: StartClusterBody): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/clusters/${clusterId}/actions/start`, body);
}

export function stopCluster(clusterId: ID): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/clusters/${clusterId}/actions/stop`, {});
}

export function preflightCluster(clusterId: ID): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/clusters/${clusterId}/actions/preflight`, {});
}

export function checkCluster(clusterId: ID, profileKey?: string | null): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/clusters/${clusterId}/actions/check`, {
    profile_key: profileKey ?? undefined,
  });
}

export function verifyCluster(clusterId: ID, profileKey: string): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/clusters/${clusterId}/actions/verify`, {
    profile_key: profileKey,
  });
}

export function pingFabric(nodeId: ID, peerAddress: string): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/nodes/${nodeId}/actions/ping-fabric`, {
    peer_address: peerAddress,
  });
}

export function showGids(nodeId: ID): Promise<OpIdResponse> {
  return api.post<OpIdResponse>(`/api/nodes/${nodeId}/actions/show-gids`, {});
}

export function cancelOp(opId: ID): Promise<CancelOpResponse> {
  return api.post<CancelOpResponse>(`/api/ops/${opId}/cancel`, {});
}

/* ---------------------------------------------------------------------------
   Event / op audit
   --------------------------------------------------------------------------- */

export function listEvents(opts?: ListEventsOpts): Promise<EventRec[]> {
  return api.get<EventRec[]>('/api/events', {
    limit: opts?.limit,
    level: opts?.level,
    kind: opts?.kind,
    cluster_id: opts?.clusterId,
    since: opts?.since,
    unacked_only: opts?.unackedOnly === true ? 'true' : undefined,
  });
}

export function ackEvents(ids: ID[]): Promise<AckResponse> {
  return api.post<AckResponse>('/api/events/ack', { ids });
}

export function ackAllEvents(): Promise<AckResponse> {
  return api.post<AckResponse>('/api/events/ack', { all: true });
}

/* Logs — wrapped response (see header note); includes Exited containers. */
export function listLogContainers(nodeId: ID): Promise<ContainersResponse> {
  return api.get<ContainersResponse>(`/api/logs/containers/${nodeId}`);
}

/* ---------------------------------------------------------------------------
   Live log follow — SSE via streamed fetch.

   Frames are LogFrame-shaped (`{key, node_id, container, lines[], eof?}`),
   one line each on the current backend. `subscribeLogStream` returns a
   cancel function (aborts the fetch); status callbacks let the page show
   connecting/open/error/closed and switch to the WS `logs` fallback buffer.
   --------------------------------------------------------------------------- */

export type LogStreamStatus = 'connecting' | 'open' | 'error' | 'closed';

export function subscribeLogStream(
  nodeId: ID,
  container: string,
  onFrame: (frame: LogFrame) => void,
  opts?: {
    lines?: number;
    onStatus?: (status: LogStreamStatus) => void;
  },
): () => void {
  const ac = new AbortController();
  let stopped = false;
  const emit = (s: LogStreamStatus): void => {
    if (!stopped) opts?.onStatus?.(s);
  };

  void (async () => {
    const base = apiBaseUrl().replace(/\/+$/, '');
    const q = new URLSearchParams({ node_id: nodeId, container, lines: String(opts?.lines ?? 200) });
    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const res = await fetch(`${base}/api/logs/stream?${q}`, {
        headers,
        signal: ac.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
      if (stopped) return;
      if (!res.ok || res.body === null) {
        emit('error');
        return;
      }
      emit('open');
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (stopped) return;
        if (done) {
          emit('closed');
          return;
        }
        buf += dec.decode(value, { stream: true });
        let idx = buf.indexOf('\n\n');
        while (idx !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const frame = parseSseFrame(block);
          // tolerate partial/foreign frames; only well-shaped frames flow on
          if (frame !== null) onFrame(frame);
          idx = buf.indexOf('\n\n');
        }
      }
    } catch {
      // AbortError lands here on cancel — treat deliberate stops as closed
      if (!stopped) emit('closed');
    }
  })();

  return () => {
    stopped = true;
    emit('closed');
    ac.abort();
  };
}

/** Best-effort SSE `data:` frame parse (concatenates multi-line data). */
function parseSseFrame(block: string): LogFrame | null {
  const data = block
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trimStart())
    .join('\n');
  if (data === '') return null;
  try {
    const parsed = JSON.parse(data) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as LogFrame).key === 'string' &&
      Array.isArray((parsed as LogFrame).lines)
    ) {
      return parsed as LogFrame;
    }
    return null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------------------
   Op params accessors — params is Record<string, unknown> on the wire; these
   narrow the two payloads the UI renders (guarded, never throws).
   --------------------------------------------------------------------------- */

export interface PingSummary {
  min_ms: number | null;
  avg_ms: number | null;
  max_ms: number | null;
  loss_pct: number | null;
}

export function readPingParams(op: OpRecord | null | undefined): PingSummary | null {
  const raw = op?.params?.['ping'];
  if (raw === null || raw === undefined || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    min_ms: num(p['min_ms']),
    avg_ms: num(p['avg_ms']),
    max_ms: num(p['max_ms']),
    loss_pct: num(p['loss_pct']),
  };
}

export interface GidRow {
  hca: string;
  index: number | null;
  transport: 'v1' | 'v2' | string;
  addr: string;
}

export function readGidTable(op: OpRecord | null | undefined): GidRow[] {
  const raw = op?.params?.['gid_table'];
  if (!Array.isArray(raw)) return [];
  const rows: GidRow[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r['hca'] !== 'string') continue;
    rows.push({
      hca: r['hca'],
      index: typeof r['index'] === 'number' ? r['index'] : null,
      transport: typeof r['transport'] === 'string' ? r['transport'] : '?',
      addr: typeof r['addr'] === 'string' ? r['addr'] : '?',
    });
  }
  return rows;
}
