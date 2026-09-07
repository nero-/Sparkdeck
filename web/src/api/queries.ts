/* ============================================================================
   api/queries — tiny React fetch hooks over the API surface.
   Deliberately minimal (no react-query): pages need one-shot reads with
   reload; live streams come from the WS store, not this file.
   ========================================================================= */

import { useCallback, useEffect, useState } from 'react';
import { api } from './client';
import type { ClusterTopology, SystemInfo, SystemStatus } from './types';

export interface QueryState<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

export function useQuery<T>(fetcher: () => Promise<T>): QueryState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetcher()
      .then((d) => {
        if (!active) return;
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!active) return;
        setError(e);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fetcher, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/* Topology changes rarely — share a short-TTL promise per module instance so
   multiple consumers (top bar pills, overview, pages) don't hammer /api. */
interface CacheSlot<T> {
  v: Cache<T> | null;
}
interface Cache<T> {
  at: number;
  p: Promise<T>;
}

function cached<T>(slot: CacheSlot<T>, ttlMs: number, make: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const c = slot.v;
  if (c !== null && now - c.at <= ttlMs) return c.p;
  const p = make().catch((e: unknown) => {
    slot.v = null; // failures invalidate immediately
    throw e;
  });
  slot.v = { at: now, p };
  return p;
}

const clustersSlot: CacheSlot<ClusterTopology[]> = { v: null };
const infoSlot: CacheSlot<SystemInfo> = { v: null };

const _clustersFetcher = (): Promise<ClusterTopology[]> =>
  cached(clustersSlot, 15_000, () => api.clusters());
const _infoFetcher = (): Promise<SystemInfo> =>
  cached(infoSlot, 30_000, () => api.systemInfo());
const _statusFetcher = (): Promise<SystemStatus> => api.systemStatus();

export function useClusters(): QueryState<ClusterTopology[]> {
  return useQuery(_clustersFetcher);
}

export function useSystemInfo(): QueryState<SystemInfo> {
  return useQuery(_infoFetcher);
}

export function useSystemStatus(): QueryState<SystemStatus> {
  return useQuery(_statusFetcher);
}
