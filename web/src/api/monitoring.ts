/* ============================================================================
   api/monitoring — thin typed helpers for the monitoring wave (overview,
   nodes, node detail, inference). Layered over src/api/client.ts; the pinned
   contract stays untouched.

   Notes vs. the pinned client (design-around, see task report "API gaps"):
   - The backend history route is `/api/metrics/history` with params
     `names,csv window from_ms to_ms max_points` (see backend routes.py);
     `from/to` are NOT accepted. We therefore speak the wire names directly
     instead of using client.ts `MetricsHistoryQuery`.
   - `/api/metrics/cluster-history` does not exist on the backend; the
     cluster aggregate rides the same route with `?cluster_id=…`
     (avg across nodes, see telemetry/store.py `_ring_range`).
   ========================================================================= */

import { useCallback, useEffect, useState } from 'react';
import type { QueryState } from './queries';
import { useQuery } from './queries';
import { api, apiBaseUrl } from './client';
import type {
  AppSettings,
  ChatStatsFrame,
  EpochMs,
  HistoryResponse,
  ID,
  ServiceState,
} from './types';

/* ---------------------------------------------------------------------------
   History queries
   --------------------------------------------------------------------------- */

/** Window chips accepted by the backend (`_window_s` parses Nm/Nh/Nd). */
export type HistWindow = '5m' | '15m' | '1h' | '6h' | '24h' | '7d';

export const HIST_WINDOWS: readonly HistWindow[] = ['5m', '15m', '1h', '6h', '24h', '7d'];

/** Windows whose bottom edge is inside the raw ring → merge live WS tail. */
export function windowIsLive(w: HistWindow): boolean {
  return w === '5m' || w === '15m';
}

/** Refresh cadence: 15 s for windows ≤ 1 h, 60 s for rollup windows. */
export function windowPollMs(w: HistWindow): number {
  return w === '6h' || w === '24h' || w === '7d' ? 60_000 : 15_000;
}

export const WINDOW_MS: Record<HistWindow, number> = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 3_600_000,
  '24h': 24 * 3_600_000,
  '7d': 7 * 24 * 3_600_000,
};

export interface MetricsHistoryArgs {
  nodeId?: ID | null;
  clusterId?: ID | null;
  names: readonly string[];
  window: HistWindow;
  maxPoints?: number;
}

function historyQuery(args: MetricsHistoryArgs): Record<string, string | number | undefined> {
  return {
    names: args.names.join(','),
    window: args.window,
    max_points: args.maxPoints ?? 700,
    ...(args.nodeId ? { node_id: args.nodeId } : {}),
    ...(args.nodeId ? {} : args.clusterId ? { cluster_id: args.clusterId } : {}),
  };
}

export function metricsHistory(args: MetricsHistoryArgs): Promise<HistoryResponse> {
  return api.get<HistoryResponse>('/api/metrics/history', historyQuery(args));
}

export function metricsHistoryCluster(args: MetricsHistoryArgs): Promise<HistoryResponse> {
  return api.get<HistoryResponse>('/api/metrics/history', historyQuery(args));
}

const qsHistory = (args: MetricsHistoryArgs): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(historyQuery(args))) {
    if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  }
  return p.toString();
};

/** The exact GET the page performs — for the "copy as curl" affordance. The
    bearer token is referenced as a shell variable, never copied in cleartext. */
export function historyCurl(args: MetricsHistoryArgs): string {
  const base = apiBaseUrl() || (typeof window !== 'undefined' ? window.location.origin : '');
  return [
    'curl -s',
    '-H "Authorization: Bearer $SPARKDECK_TOKEN"',
    `'${base}/api/metrics/history?${qsHistory(args)}'`,
  ].join(' ');
}

/* ---------------------------------------------------------------------------
   Settings (GET /api/settings) — short-TTL promise cache like queries.ts
   --------------------------------------------------------------------------- */

export async function fetchSettings(): Promise<AppSettings> {
  return api.get<AppSettings>('/api/settings');
}

interface CacheSlot<T> {
  v: { at: number; p: Promise<T> } | null;
}

const settingsSlot: CacheSlot<AppSettings> = { v: null };
const SETTINGS_TTL_MS = 15_000;

export function settingsCached(): Promise<AppSettings> {
  const c = settingsSlot.v;
  const now = Date.now();
  if (c !== null && now - c.at <= SETTINGS_TTL_MS) return c.p;
  const p = fetchSettings().catch((e: unknown) => {
    settingsSlot.v = null; // failures invalidate immediately
    throw e;
  });
  settingsSlot.v = { at: now, p };
  return p;
}

export function useSettings(): QueryState<AppSettings> {
  return useQuery(settingsCached);
}

/* ---------------------------------------------------------------------------
   LLM service (Inference page)
   --------------------------------------------------------------------------- */

/** Mirror of backend service/chat.py `RequestStat` (GET /api/llm/{id}/requests). */
export interface LlmRequestStat {
  ts: EpochMs;
  cluster_id: ID;
  host: string;
  port: number;
  model: string;
  ttft_ms: number | null;
  tps: number | null;
  output_tokens: number;
  prompt_tokens: number | null;
  error: string | null;
  total_ms: number;
}

export async function fetchLlmState(clusterId: ID): Promise<ServiceState> {
  return api.get<ServiceState>(`/api/llm/${encodeURIComponent(clusterId)}/state`);
}

export async function fetchLlmRequests(clusterId: ID, limit = 50): Promise<LlmRequestStat[]> {
  return api.get<LlmRequestStat[]>(`/api/llm/${encodeURIComponent(clusterId)}/requests`, {
    limit,
  });
}

/* ---------------------------------------------------------------------------
   Polling query — same shape as queries.ts `useQuery`, on an interval.
   Calm by design: keeps the last good data while the API is unreachable and
   skips ticks while the tab is hidden.
   --------------------------------------------------------------------------- */

export interface PollState<T> {
  data: T | null;
  error: unknown;
  /** true until the first successful (or failed) load */
  loading: boolean;
  reload: () => void;
}

export function usePollingQuery<T>(fetcher: () => Promise<T>, everyMs: number): PollState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;

    const schedule = () => {
      timer = setTimeout(() => {
        // be gentle: skip polling cycles while the tab is hidden
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          schedule();
          return;
        }
        void run();
      }, everyMs);
    };

    const run = async () => {
      if (inFlight) {
        schedule();
        return;
      }
      inFlight = true;
      try {
        const d = await fetcher();
        if (!active) return;
        setData(d);
        setError(null);
      } catch (e) {
        if (!active) return;
        setError(e); // keep last good data visible
      } finally {
        inFlight = false;
        if (active) {
          setLoading(false);
          schedule();
        }
      }
    };

    void run();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [fetcher, everyMs, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

export type { ChatStatsFrame };

/* ---------------------------------------------------------------------------
   useHistory — polled metrics-history query with calm stale-while-refresh:
   keeps the last good body visible while the next poll lands (charts then
   morph into the new window within one beat).
   --------------------------------------------------------------------------- */

export interface HistoryQueryState {
  /** last successful body (may be from the previous args while refetching) */
  data: HistoryResponse | null;
  /** true after the FIRST args resolve/promise rejection settles */
  loading: boolean;
  error: unknown;
  reload: () => void;
}

export function useHistory(args: MetricsHistoryArgs | null | undefined): HistoryQueryState {
  const key =
    args === null || args === undefined
      ? ''
      : JSON.stringify([
          args.nodeId ?? null,
          args.clusterId ?? null,
          args.names,
          args.window,
          args.maxPoints ?? 700,
        ]);

  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  const hasArgs = key !== '';
  const loading = hasArgs && data === null && error === null;

  useEffect(() => {
    if (args === null || args === undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (ms: number) => {
      timer = setTimeout(() => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          schedule(ms);
          return;
        }
        runOnce();
      }, ms);
    };

    const runOnce = () => {
      void (async () => {
        try {
          const d = await metricsHistory(args);
          if (!active) return;
          setData(d);
          setError(null);
        } catch (e) {
          if (!active) return;
          setError(e);
        } finally {
          if (active) schedule(windowPollMs(args.window));
        }
      })();
    };

    runOnce();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
    // args identity is identifier-stable via `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
