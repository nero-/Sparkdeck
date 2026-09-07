/* ============================================================================
   stores/live — live view over the WS store buffer (useLive).
   Thin facade around src/api/client.ts#useWs so pages get domain-shaped
   selectors instead of touching the store internals.

   ZUSTAND v5 RULE (the render-loop foot-gun): getSnapshot must return a
   STABLE reference. Selectors may only return values already held in the
   store (or primitives); anything derived goes through useMemo keyed on
   the store reference.
   ========================================================================= */

import { useMemo } from 'react';

import type { EventRec, ID, LiveNodeState, SampleFrame, ServiceState } from '../api/types';
import type { WsStatus } from '../api/client';
import { useWs } from '../api/client';

/** The live store itself (connection + buffers). */
export { useWs as useLive } from '../api/client';
export { wsStore, useWsStatus, useNodeState, useLastSample, useServiceState, WS_TOPICS } from '../api/client';
export type { WsStatus };

/** All node conn-states, newest-wins upserts. */
export function useLiveNodes(): LiveNodeState[] {
  const map = useWs((s) => s.liveNodes);
  return useMemo(() => Object.values(map), [map]);
}

function onlineCount(s: { liveNodes: Record<string, LiveNodeState> }, clusterId?: ID | null): number {
  let n = 0;
  for (const st of Object.values(s.liveNodes)) {
    if (st.state === 'online' && (clusterId == null || st.cluster_id === clusterId)) n++;
  }
  return n;
}

/** Number of nodes currently reporting 'online'. */
export function useOnlineCount(): number {
  return useWs((s) => onlineCount(s));
}

export function useClusterOnlineCount(clusterId: ID | null | undefined): number {
  return useWs((s) => onlineCount(s, clusterId ?? undefined));
}

function countUnacked(events: EventRec[]): number {
  let n = 0;
  for (const e of events) if (!e.acked) n++;
  return n;
}

/** All last samples keyed by node. */
export function useSampleMap(): Record<ID, SampleFrame> {
  return useWs((s) => s.lastSampleByNode);
}

/** One numeric series from a node's latest sample frame. */
export function useSampleValue(nodeId: ID | null | undefined, seriesId: string): number | null {
  return useWs((s) => {
    if (!nodeId) return null;
    const v = s.lastSampleByNode[nodeId]?.series[seriesId];
    return typeof v === 'number' ? v : null;
  });
}

export function useServiceByCluster(): Record<ID, ServiceState> {
  return useWs((s) => s.serviceByCluster);
}

/** Unacked event count for the top-bar bell badge (primitive — loop-safe). */
export function useUnackedEventCount(): number {
  const ring = useWs((s) => s.eventsRing);
  return useMemo(() => countUnacked(ring), [ring]);
}

/** Newest event first (ring buffer reference — stable between updates). */
export function useEventsRing(): EventRec[] {
  return useWs((s) => s.eventsRing);
}
