/* ============================================================================
   stores/ops — operations derived from the live WS store.
   `useOps` is an alias of the live store (single source of truth); use the
   selector hooks below for derived views.
   ========================================================================= */

import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWs } from '../api/client';
import type { OpRecord } from '../api/types';

/** ops live in the shared live-store buffer — this alias is the store handle. */
export const useOps = useWs;

const ACTIVE_STATES: ReadonlySet<OpRecord['state']> = new Set(['queued', 'running']);

export function useOpsMap(): Map<string, OpRecord> {
  return useWs((s) => s.opsById);
}

/** Active (queued|running) ops, newest first. */
export function useActiveOps(): OpRecord[] {
  return useWs(
    useShallow((s) => {
      const active: OpRecord[] = [];
      for (const op of s.opsById.values()) {
        if (ACTIVE_STATES.has(op.state)) active.push(op);
      }
      active.sort((a, b) => b.created - a.created);
      return active;
    }),
  );
}

/** Most recent active op (banner slot). */
export function useCurrentOp(): OpRecord | undefined {
  return useWs((s) => {
    let latest: OpRecord | undefined;
    for (const op of s.opsById.values()) {
      if (!ACTIVE_STATES.has(op.state)) continue;
      if (latest === undefined || op.created > latest.created) latest = op;
    }
    return latest;
  });
}

/** Recent ops sorted newest-first. */
export function useRecentOps(limit = 50): OpRecord[] {
  const m = useWs((s) => s.opsById);
  return useMemo(() => {
    const list = [...m.values()]
      .sort((a, b) => b.created - a.created)
      .slice(0, limit);
    return list;
  }, [m, limit]);
}

export function useOpById(id: string | null | undefined): OpRecord | undefined {
  return useWs((s) => (id !== undefined && id !== null ? s.opsById.get(id) : undefined));
}

/** True while any op is running (used by the top bar spinner). */
export function useOpsBusy(): boolean {
  return useWs((s) => {
    for (const op of s.opsById.values()) {
      if (ACTIVE_STATES.has(op.state)) return true;
    }
    return false;
  });
}
