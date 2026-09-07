/* ============================================================================
   stores/live — live view over the WS store buffer (useLive).
   Thin facade around src/api/client.ts#useWs so pages get domain-shaped
   selectors instead of touching the store internals.
   ========================================================================= */

import type { EventRec, ID, LiveNodeState, SampleFrame, ServiceState } from '../api/types';
import type { WsStatus } from '../api/client';
import { useWs } from '../api/client';

/** The live store itself (connection + buffers). */
export { useWs as useLive } from '../api/client';
export { wsStore, useWsStatus, useNodeState, useLastSample, useServiceState, WS_TOPICS } from '../api/client';
export type { WsStatus };

/** All node conn-states, newest-wins upserts. */
export function useLiveNodes(): LiveNodeState[] {
  return useWs((s) => Object.values(s.liveNodes));
}

/** Number of nodes currently reporting 'online', optionally filtered by cluster. */
export function useOnlineCount(): number {
  return useWs((s) => {
    let n = 0;
    for (const st of Object.values(s.liveNodes)) if (st.state === 'online') n++;
    return n;
  });
}

export function useClusterOnlineCount(clusterId: ID | null | undefined): number {
  return useWs((s) => {
    if (!clusterId) return 0;
    let n = 0;
    for (const st of Object.values(s.liveNodes)) {
      if (st.cluster_id === clusterId && st.state === 'online') n++;
    }
    return n;
  });
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

/** Unacked event count for the top-bar bell badge. */
export function useUnackedEventCount(): number {
  return useWs((s) => {
    let n = 0;
    for (const e of s.eventsRing) if (!e.acked) n++;
    return n;
  });
}

/** Newest event first (ring buffer copy). */
export function useEventsRing(): EventRec[] {
  return useWs((s) => s.eventsRing);
}
