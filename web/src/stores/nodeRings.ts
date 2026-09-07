/* ============================================================================
   stores/nodeRings — per-node sparkline ring buffers (default 60 points)
   appended from the `samples` WS topic (i.e. from `lastSampleByNode`, the
   newest-wins map fed by the socket).

   Lives OUTSIDE React: one module-level Map and a tiny version store, so a
   page full of mini-cards re-renders only when *its own* requested series
   advanced. `useNodeRings(nodeId, names)` returns stable RingSeries objects
   (t[], v[]) that pages feed straight into <Sparkline>/<TimeChart>.

   Nulls are recorded as gaps — the sparkline components already handle them.
   ========================================================================= */

import { useMemo } from 'react';
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { useWs } from '../api/client';
import type { ID, SampleFrame } from '../api/types';

export const RING_CAP = 60;

export interface RingSeries {
  readonly t: number[];
  readonly v: Array<number | null>;
}

export const EMPTY_RING: RingSeries = { t: [], v: [] };

/* module data (outside React state) --------------------------------------- */

const rings = new Map<string, RingSeries>(); // `${nodeId}\u0000${seriesId}` → ring
const seqs = new Map<string, number>(); // per-key change counter — drives selectors
const lastTsByNode = new Map<ID, number>();

function ringKey(nodeId: ID | string, seriesId: string): string {
  return `${nodeId}\u0000${seriesId}`;
}

function append(nodeId: ID, seriesId: string, ts: number, value: number | null): void {
  const key = ringKey(nodeId, seriesId);
  const cur = rings.get(key);
  if (cur === undefined) {
    rings.set(key, { t: [ts], v: [value] });
  } else {
    const n = cur.t.length;
    if (n > 0 && cur.t[n - 1]! === ts) {
      // same tick — replace the tail point (last write wins)
      const t = cur.t.slice();
      const v = cur.v.slice();
      t[n - 1] = ts;
      v[n - 1] = value;
      rings.set(key, { t, v });
      return; // no seq bump — value replaced in place, nothing new drawn yet
    }
    if (cur.t.length >= RING_CAP) {
      const t = cur.t.slice(cur.t.length - RING_CAP + 1);
      const v = cur.v.slice(cur.v.length - RING_CAP + 1);
      t.push(ts);
      v.push(value);
      rings.set(key, { t, v });
    } else {
      rings.set(key, { t: [...cur.t, ts], v: [...cur.v, value] });
    }
  }
  seqs.set(key, (seqs.get(key) ?? 0) + 1);
}

/** The ring store only carries a version bump; arrays live in the module Map. */
interface RingState {
  version: number;
}
const useRingVersion = create<RingState>()(() => ({ version: 0 }));

let wired = false;

/** Attach the one-time WS-fed appender. Cheap; safe to call from every hook. */
function wire(): void {
  if (wired) return;
  wired = true;

  let prev: Record<ID, SampleFrame> | null = null;

  useWs.subscribe((s) => {
    const cur = s.lastSampleByNode;
    if (cur === prev) return; // map identity == one new frame
    prev = cur;
    let touched = false;
    for (const frame of Object.values(cur)) {
      if (typeof frame !== 'object' || frame === null) continue;
      if (typeof frame.ts !== 'number') continue;
      const prior = lastTsByNode.get(frame.node_id);
      if (prior !== undefined && frame.ts <= prior) continue; // stale/out-of-order
      lastTsByNode.set(frame.node_id, frame.ts);
      touched = true;
      const series = frame.series ?? {};
      for (const [seriesId, v] of Object.entries(series)) {
        append(frame.node_id, seriesId, frame.ts, typeof v === 'number' ? v : null);
      }
    }
    if (touched) useRingVersion.setState((st) => ({ version: st.version + 1 }));
  });
}

/* selector plumbing -------------------------------------------------------- */

function ringSeqSelector(nodeIdOrEmpty: string, seriesIds: readonly string[]) {
  return (): number[] => {
    const out: number[] = [seriesIds.length];
    for (const sid of seriesIds) out.push(seqs.get(ringKey(nodeIdOrEmpty, sid)) ?? 0);
    return out;
  };
}

/**
 * Ring buffers for one node's series — appended from every WS sample frame.
 * Re-renders only when one of the requested series advanced (or the node/name
 * list changed). Returns arrays parallel to `seriesIds`.
 */
export function useNodeRings(nodeId: ID | null | undefined, seriesIds: readonly string[]): RingSeries[] {
  wire();
  const idOrEmpty = nodeId ?? '';
  const nameKey = `${idOrEmpty}\u0001${seriesIds.join('\u0001')}`;

  // shallow-compare per-series seq — skip re-render when none advanced
  const sig = useRingVersion(useShallow(ringSeqSelector(idOrEmpty, seriesIds)));

  return useMemo(
    () => seriesIds.map((sid) => rings.get(ringKey(idOrEmpty, sid)) ?? EMPTY_RING),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [nameKey, sig],
  );
}

/**
 * Latest numeric value from one node's ring (0 when the ring is empty).
 * Re-renders only when that series advanced.
 */
export function useNodeRingLast(nodeId: ID | null | undefined, seriesId: string): number | null {
  wire();
  const idOrEmpty = nodeId ?? '';
  const seq = useRingVersion((s) => {
    void s.version; // touch the store so the selector participates in updates
    return seqs.get(ringKey(idOrEmpty, seriesId)) ?? 0;
  });
  const entry = useMemo(() => rings.get(ringKey(idOrEmpty, seriesId)) ?? EMPTY_RING, [idOrEmpty, seriesId, seq]);
  const n = entry.v.length;
  const last = n > 0 ? entry.v[n - 1] : null;
  return typeof last === 'number' && Number.isFinite(last) ? last : null;
}

/** Non-reactive read (merge helpers, event handlers). */
export function ringFor(nodeId: ID | string, seriesId: string): RingSeries {
  return rings.get(ringKey(nodeId, seriesId)) ?? EMPTY_RING;
}

/** Container names seen in a frame's docker series (`docker.<ctr>.cpu_pct`). */
export function containersFromSample(series: SampleFrame['series'] | undefined): string[] {
  if (series === undefined) return [];
  const names = new Set<string>();
  for (const id of Object.keys(series)) {
    const m = /^docker\.(.+)\.cpu_pct$/.exec(id);
    if (m !== null && m[1] !== undefined) names.add(m[1]);
  }
  return [...names].sort();
}

export interface IfaceTrafficSnapshot {
  iface: string;
  rx: number;
  tx: number;
  total: number;
}

/** Ifaces present in a frame with their latest |rx|+|tx| traffic (kbit/s). */
export function ifacesFromSample(series: SampleFrame['series'] | undefined): IfaceTrafficSnapshot[] {
  if (series === undefined) return [];
  const seen = new Set<string>();
  for (const id of Object.keys(series)) {
    const m = /^net\.(.+)\.rx_kbps$/.exec(id);
    if (m !== null && m[1] !== undefined) seen.add(m[1]);
  }
  const out: IfaceTrafficSnapshot[] = [];
  for (const iface of seen) {
    const rx = series[`net.${iface}.rx_kbps`];
    const tx = series[`net.${iface}.tx_kbps`];
    const rxN = typeof rx === 'number' ? Math.abs(rx) : 0;
    const txN = typeof tx === 'number' ? Math.abs(tx) : 0;
    out.push({ iface, rx: rxN, tx: txN, total: rxN + txN });
  }
  return out.sort((a, b) => b.total - a.total);
}
