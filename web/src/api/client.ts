/* ============================================================================
   Sparkdeck API client — typed fetch + live WebSocket store.
   Contract: docs/API.md + web/src/api/types.ts (pinned, never modified here).

   Exports:
     - ApiClientError, get/setAuthToken
     - api.get/post/patch/del + named endpoint helpers
     - useWs()          zustand store: connection state + topic buffers
     - selector hooks   useWsStatus, useNodeState, useLastSample, useServiceState,
                        useEffectsRing, useUnackedEventCount, ...
   ========================================================================= */

import { create } from 'zustand';
import type {
  ApiErrorCode,
  BenchJob,
  ClusterTopology,
  ContainerInfo,
  EpochMs,
  EventRec,
  HistoryResponse,
  ID,
  ImageInfo,
  LiveNodeState,
  LogFrame,
  OpRecord,
  SampleFrame,
  ServiceState,
  SystemInfo,
  SystemStatus,
  WsIn,
  WsTopic,
} from './types';

declare global {
  interface Window {
    /** Optional absolute API base, e.g. "http://127.0.0.1:8936". Empty = same-origin. */
    __SPARKDECK_API__?: string;
  }
}

/* Decorations beyond the wire contract (client-side only). */
export type ClientErrorCode = ApiErrorCode | 'network' | 'bad_response';

export class ApiClientError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly detail?: Record<string, unknown>;

  constructor(
    code: ClientErrorCode,
    message: string,
    status: number,
    detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function isApiClientError(e: unknown): e is ApiClientError {
  return e instanceof ApiClientError;
}

/* ---------------------------------------------------------------------------
   Base URL + auth
   --------------------------------------------------------------------------- */

export const TOKEN_STORAGE_KEY = 'sparkdeck.token';

export function apiBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.__SPARKDECK_API__ ?? '';
}

export function getAuthToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setAuthToken(token: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
    else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    /* storage unavailable (private mode) — auth silently disabled */
  }
}

function withQuery(path: string, params: Record<string, string | number | undefined | null>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const q = qs.toString();
  return q ? `${path}?${q}` : path;
}

function resolveUrl(path: string): string {
  // path is always "/api/..." style; base is '' (same-origin) or absolute.
  return apiBaseUrl() ? `${apiBaseUrl().replace(/\/+$/, '')}${path}` : path;
}

/* ---------------------------------------------------------------------------
   Fetch core
   --------------------------------------------------------------------------- */

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  params?: Record<string, string | number | undefined | null>,
): Promise<T> {
  const url = resolveUrl(withQuery(path, params ?? {}));
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit', // auth is bearer-token, not cookies
    });
  } catch (cause) {
    throw new ApiClientError('network', `Request failed: ${url}`, 0, {
      cause: String(cause),
    });
  }

  if (!res.ok) {
    // Contract error shape: { error: { code, message, detail? } }
    let code: ClientErrorCode = 'internal';
    let message = `HTTP ${res.status}`;
    let detail: Record<string, unknown> | undefined;
    try {
      const json = (await res.json()) as unknown;
      const err = (json as { error?: { code?: unknown; message?: unknown; detail?: unknown } })
        ?.error;
      if (err && typeof err.message === 'string') {
        message = err.message;
        detail = err.detail as Record<string, unknown> | undefined;
        if (typeof err.code === 'string') code = err.code as ApiErrorCode;
      }
    } catch {
      /* non-JSON error body */
    }
    throw new ApiClientError(code, message, res.status, detail);
  }

  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiClientError('bad_response', 'Response was not valid JSON', res.status);
  }
}

/* ---------------------------------------------------------------------------
   Endpoint surface (the pages may also use api.get/post generically)
   --------------------------------------------------------------------------- */

export interface MetricsHistoryQuery {
  names: string[]; // series ids, e.g. ["gpu.util"]
  window?: '5m' | '1h' | '6h' | '24h' | '7d';
  from?: EpochMs;
  to?: EpochMs;
  maxPoints?: number;
}

function metricsQueryParams(q: MetricsHistoryQuery): Record<string, string | number | undefined> {
  return {
    names: q.names.join(','),
    window: q.window,
    from: q.from,
    to: q.to,
    max_points: q.maxPoints,
  };
}

export const api = {
  /* raw verbs ------------------------------------------------------------- */
  get: <T>(path: string, params?: Record<string, string | number | undefined | null>) =>
    request<T>('GET', path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),

  /* system ---------------------------------------------------------------- */
  systemInfo: () => request<SystemInfo>('GET', '/api/system/info'),
  systemStatus: () => request<SystemStatus>('GET', '/api/system/status'),

  /* topology -------------------------------------------------------------- */
  clusters: () => request<ClusterTopology[]>('GET', '/api/clusters'),
  clusterLive: (clusterId: ID) =>
    request<Record<string, unknown>>('GET', `/api/clusters/${clusterId}/live`),

  /* metrics --------------------------------------------------------------- */
  metricsHistory: (nodeId: ID, q: MetricsHistoryQuery) =>
    request<HistoryResponse>('GET', `/api/metrics/history`, undefined, {
      node_id: nodeId,
      ...metricsQueryParams(q),
    }),
  metricsClusterHistory: (clusterId: ID, q: MetricsHistoryQuery) =>
    request<HistoryResponse>('GET', `/api/metrics/cluster-history`, undefined, {
      cluster_id: clusterId,
      ...metricsQueryParams(q),
    }),

  /* events / ops ----------------------------------------------------------- */
  events: (opts?: { limit?: number; level?: 'info' | 'warn' | 'error'; clusterId?: ID; since?: EpochMs }) =>
    request<EventRec[]>('GET', '/api/events', undefined, {
      limit: opts?.limit,
      level: opts?.level,
      cluster_id: opts?.clusterId,
      since: opts?.since,
    }),
  ackEvents: (ids?: ID[]) =>
    ids
      ? request<{ acked: number }>('POST', '/api/events/ack', { ids })
      : request<{ acked: number }>('POST', '/api/events/ack', { all: true }),
  ops: (opts?: { limit?: number; kind?: string; clusterId?: ID }) =>
    request<OpRecord[]>('GET', '/api/ops', undefined, {
      limit: opts?.limit,
      kind: opts?.kind,
      cluster_id: opts?.clusterId,
    }),
  op: (id: ID) => request<OpRecord>('GET', `/api/ops/${id}`),

  /* logs / images ---------------------------------------------------------- */
  logContainers: (nodeId: ID) =>
    request<ContainerInfo[]>('GET', `/api/logs/containers/${nodeId}`),
  images: (nodeId: ID) => request<ImageInfo[]>('GET', `/api/images/${nodeId}`),
};

/* ---------------------------------------------------------------------------
   WebSocket store
   --------------------------------------------------------------------------- */

export type WsStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';

export const WS_TOPICS = [
  'nodes',
  'samples',
  'service',
  'ops',
  'events',
  'bench',
  'logs',
] as const satisfies readonly WsTopic[];

const EVENTS_RING_MAX = 500;
const LOG_TAIL_MAX_LINES = 4000;
const LOG_TAIL_MAX_KEYS = 64;
const RECONNECT_MAX_MS = 15_000;
const RECONNECT_BASE_MS = 400;

export interface WsStoreState {
  /* buffers (per contract) */
  lastSampleByNode: Record<ID, SampleFrame>;
  liveNodes: Record<ID, LiveNodeState>; // upsert keyed by node_id
  serviceByCluster: Record<ID, ServiceState>;
  opsById: Map<ID, OpRecord>;
  eventsRing: EventRec[]; // newest first, max 500
  benchById: Map<ID, BenchJob>;
  logTails: Map<string, string[]>; // "node:container" | "bench:<id>" -> lines tail

  /* connection */
  status: WsStatus;
  attempts: number;
  lastError: string | null;
  topics: readonly WsTopic[];

  /* actions */
  connect: () => void;
  disconnect: () => void;
  subscribe: (topics: WsTopic[]) => void;
  resetBuffers: () => void;
}

let socket: WebSocket | null = null;
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let disposition: 'auto' | 'stopped' = 'auto';
let listenersBound = false;
let seedInFlight = false;

function wsUrl(): string {
  const base = apiBaseUrl();
  let origin: string;
  if (!base) {
    const loc = typeof window !== 'undefined' ? window.location : undefined;
    if (!loc) return 'wss://127.0.0.1:8936/api/ws';
    const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    origin = `${proto}//${loc.host}`;
  } else if (base.startsWith('http://')) {
    origin = `ws://${base.slice('http://'.length).replace(/\/+$/, '')}`;
  } else if (base.startsWith('https://')) {
    origin = `wss://${base.slice('https://'.length).replace(/\/+$/, '')}`;
  } else if (base.startsWith('ws://') || base.startsWith('wss://')) {
    origin = base.replace(/\/+$/, '');
  } else {
    origin = base.replace(/\/+$/, '');
  }
  const token = getAuthToken();
  // Browsers can't set Authorization on WebSocket handshake — pass the token
  // as a query param (the server accepts either).
  return token ? `${origin}/api/ws?token=${encodeURIComponent(token)}` : `${origin}/api/ws`;
}

function replaceKeepTail(list: string[], lines: string[]): string[] {
  const next = list.length === 0 ? lines.slice() : list.concat(lines);
  return next.length > LOG_TAIL_MAX_LINES ? next.slice(next.length - LOG_TAIL_MAX_LINES) : next;
}

function handleWsMessage(raw: string): void {
  let msg: unknown;
  try {
    msg = JSON.parse(raw) as unknown;
  } catch {
    return; // tolerate non-JSON frames
  }
  const frame = msg as { topic?: unknown; data?: unknown };
  const topic = frame.topic;
  if (typeof topic !== 'string') return;
  const store = useWs.getState();
  const data = frame.data;

  switch (topic as WsTopic) {
    case 'nodes': {
      if (!Array.isArray(data)) return;
      const next: Record<ID, LiveNodeState> = { ...store.liveNodes };
      for (const item of data as LiveNodeState[]) {
        if (item && typeof item.node_id === 'string') next[item.node_id] = item;
      }
      useWs.setState({ liveNodes: next });
      break;
    }
    case 'samples': {
      const f = data as SampleFrame | null;
      if (!f || typeof f.node_id !== 'string') return;
      useWs.setState({ lastSampleByNode: { ...store.lastSampleByNode, [f.node_id]: f } });
      break;
    }
    case 'service': {
      const s = data as ServiceState | null;
      if (!s || typeof s.cluster_id !== 'string') return;
      useWs.setState({ serviceByCluster: { ...store.serviceByCluster, [s.cluster_id]: s } });
      break;
    }
    case 'ops': {
      const op = data as OpRecord | null;
      if (!op || typeof op.id !== 'string') return;
      const next = new Map(store.opsById);
      next.set(op.id, op);
      useWs.setState({ opsById: next });
      break;
    }
    case 'events': {
      const ev = data as EventRec | null;
      if (!ev || typeof ev.id !== 'string') return;
      const ring = store.eventsRing.filter((e) => e.id !== ev.id);
      ring.unshift(ev);
      useWs.setState({ eventsRing: ring.slice(0, EVENTS_RING_MAX) });
      break;
    }
    case 'bench': {
      const payload = data as { job?: BenchJob; tail?: string } | null;
      const job = payload?.job;
      if (!job || typeof job.id !== 'string') return;
      const benchById = new Map(store.benchById);
      benchById.set(job.id, job);
      let logTails = store.logTails;
      if (typeof payload?.tail === 'string') {
        logTails = new Map(store.logTails);
        const key = `bench:${job.id}`;
        logTails.delete(key);
        logTails.set(key, replaceKeepTail(logTails.get(key) ?? [], payload.tail.split('\n')));
        evictLogKeys(logTails);
      }
      useWs.setState({ benchById, logTails });
      break;
    }
    case 'logs': {
      const frameData = data as LogFrame | null;
      if (!frameData || typeof frameData.key !== 'string' || !Array.isArray(frameData.lines))
        return;
      const logTails = new Map(store.logTails);
      logTails.delete(frameData.key);
      logTails.set(
        frameData.key,
        replaceKeepTail(logTails.get(frameData.key) ?? [], frameData.lines),
      );
      evictLogKeys(logTails);
      useWs.setState({ logTails });
      break;
    }
    case 'hello':
      /* server greeting — no buffer */
      break;
    default:
      /* unknown topic — ignore forward-compat */
      break;
  }
}

function evictLogKeys(map: Map<string, string[]>): void {
  while (map.size > LOG_TAIL_MAX_KEYS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/* Best-effort hydration from REST on each (re)connect so the UI is never a
   blank slate while topics are quiet. */
async function seedFromRest(): Promise<void> {
  if (seedInFlight) return;
  seedInFlight = true;
  try {
    try {
      const status = await api.systemStatus();
      const next: Record<ID, LiveNodeState> = { ...useWs.getState().liveNodes };
      for (const n of status.nodes) next[n.node_id] = n;
      useWs.setState({ liveNodes: next });
    } catch {
      /* cluster controller may be down — live view will populate via ws */
    }
    try {
      const ops = await api.ops({ limit: 25 });
      const cur = useWs.getState().opsById;
      const next = new Map(cur);
      for (const op of ops) if (!next.has(op.id)) next.set(op.id, op);
      useWs.setState({ opsById: next });
    } catch {
      /* ignore */
    }
    try {
      const events = await api.events({ limit: 100 });
      const cur = useWs.getState().eventsRing;
      const byId = new Map(cur.map((e) => [e.id, e] as const));
      for (const e of events) {
        if (!byId.has(e.id)) byId.set(e.id, e);
        else {
          const prior = byId.get(e.id);
          if (prior && prior.acked !== e.acked) byId.set(e.id, e); // ack state changed
        }
      }
      const merged = [...byId.values()].sort((a, b) => b.ts - a.ts).slice(0, EVENTS_RING_MAX);
      useWs.setState({ eventsRing: merged });
    } catch {
      /* ignore */
    }
  } finally {
    seedInFlight = false;
  }
}

function scheduleReconnect(): void {
  if (disposition === 'stopped') return;
  if (reconnectTimer !== null) return;
  const jitter = Math.floor(Math.random() * 250);
  const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt) + jitter;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void openSocket();
  }, delay);
}

function openSocket(): void {
  if (disposition === 'stopped') return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING))
    return;

  useWs.setState({
    status: attempt === 0 ? 'connecting' : 'reconnecting',
    attempts: attempt,
  });

  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl());
  } catch (e) {
    useWs.setState({ lastError: String(e) });
    attempt = Math.min(attempt + 1, 8);
    scheduleReconnect();
    return;
  }
  socket = ws;

  ws.onopen = () => {
    attempt = 0;
    useWs.setState({ status: 'online', lastError: null, attempts: 0 });
    try {
      ws.send(JSON.stringify({ op: 'sub', topics: [...WS_TOPICS] } satisfies WsIn));
    } catch {
      /* send before OPEN race—reconnect will resubscribe */
    }
    void seedFromRest();
  };

  ws.onmessage = (ev) => {
    if (typeof ev.data === 'string') handleWsMessage(ev.data);
  };

  ws.onerror = () => {
    useWs.setState((s) => ({
      lastError: s.status === 'online' ? null : 'websocket error',
    }));
  };

  ws.onclose = (ev) => {
    if (socket === ws) socket = null;
    useWs.setState((s) => ({
      status: 'reconnecting',
      lastError: s.status === 'online' && ev.wasClean ? null : `closed (${ev.code})`,
    }));
    attempt = Math.min(attempt + 1, 8);
    scheduleReconnect();
  };
}

function bindWindowListeners(): void {
  if (listenersBound || typeof window === 'undefined') return;
  listenersBound = true;
  // Reconnect immediately when the tab becomes visible / network returns.
  window.addEventListener('online', () => {
    if (disposition === 'auto' && (!socket || socket.readyState !== WebSocket.OPEN)) {
      attempt = 0;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      void openSocket();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && disposition === 'auto'
      && (!socket || socket.readyState === WebSocket.CLOSED)) {
      void openSocket();
    }
  });
}

export const useWs = create<WsStoreState>()((set) => ({
  lastSampleByNode: {},
  liveNodes: {},
  serviceByCluster: {},
  opsById: new Map(),
  eventsRing: [],
  benchById: new Map(),
  logTails: new Map(),

  status: 'idle',
  attempts: 0,
  lastError: null,
  topics: WS_TOPICS,

  connect: () => {
    disposition = 'auto';
    bindWindowListeners();
    openSocket();
  },

  disconnect: () => {
    disposition = 'stopped';
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      const ws = socket;
      socket = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
    set({ status: 'offline' });
  },

  subscribe: (topics) => {
    const ws = socket;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ op: 'sub', topics } satisfies WsIn));
      } catch {
        /* will resubscribe on next reconnect */
      }
    }
  },

  resetBuffers: () => {
    set({
      lastSampleByNode: {},
      liveNodes: {},
      serviceByCluster: {},
      opsById: new Map(),
      eventsRing: [],
      benchById: new Map(),
      logTails: new Map(),
    });
  },
}));

/* Convenience getter for imperative checks from non-React code. */
export const wsStore = useWs;

/* ---------------------------------------------------------------------------
   Selectors (client-level primitives; domain selectors live in src/stores/)
   --------------------------------------------------------------------------- */

export function useWsStatus(): WsStatus {
  return useWs((s) => s.status);
}

export function useNodeState(nodeId: ID | null | undefined): LiveNodeState | undefined {
  return useWs((s) => (nodeId ? s.liveNodes[nodeId] : undefined));
}

export function useLastSample(nodeId: ID | null | undefined): SampleFrame | undefined {
  return useWs((s) => (nodeId ? s.lastSampleByNode[nodeId] : undefined));
}

export function useServiceState(clusterId: ID | null | undefined): ServiceState | undefined {
  return useWs((s) => (clusterId ? s.serviceByCluster[clusterId] : undefined));
}

export function useLogTail(key: string | null | undefined): string[] {
  return useWs((s) => (key ? s.logTails.get(key) : undefined)) ?? [];
}
