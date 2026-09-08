/* settings gate — one query + a patch wrapper that toasts + feeds the 401 gate. */

import { useCallback, useEffect, useRef } from 'react';
import { useQuery } from '../../api/queries';
import {
  fetchSettings,
  patchSettings,
  type SettingsPatch,
} from '../../api/admin';
import { errCopy, offerAuthGate } from '../../lib/pagekit';
import { toast } from '../../ds';
import type { AppSettings } from '../../api/types';

export type { SettingsPatch } from '../../api/admin';

export interface SettingsGate {
  data: AppSettings | null;
  loading: boolean;
  error: unknown;
  reload: () => void;
  /** PATCH a settings slice; errors toast + feed the unlock gate. */
  save: (patch: SettingsPatch) => Promise<AppSettings | null>;
}

export function useSettingsState(): SettingsGate {
  const q = useQuery(fetchSettings);
  const reload = q.reload;

  const save = useCallback(
    async (patch: SettingsPatch): Promise<AppSettings | null> => {
      try {
        const merged = await patchSettings(patch);
        reload();
        return merged;
      } catch (err) {
        offerAuthGate(err);
        toast.error('Settings change rejected', errCopy(err));
        throw err;
      }
    },
    [reload],
  );

  return {
    data: q.data,
    loading: q.loading,
    error: q.error,
    reload: q.reload,
    save,
  };
}

/** Fire-and-forget save used by toggle-style controls. */
export function saveQuietly(
  save: (p: SettingsPatch) => Promise<AppSettings | null>,
  patch: SettingsPatch,
  okMsg: string,
): void {
  save(patch)
    .then(() => toast.ok(okMsg))
    .catch(() => {
      /* already toasted by the gate */
    });
}

/**
 * Section draft gate: apply a server refresh ONLY while the local draft is
 * clean. Any other section's save() triggers a gate reload; without this,
 * a dirty draft in an untouched section would be silently overwritten
 * (review finding #8). Call `dirtyRef.current = <computed>` AFTER the hook
 * (updated per render); the gate never honors refreshes while it is true.
 */
export function useDraftGate<T>(fresh: T | null, dirtyRef: { current: boolean }, apply: (t: T) => void): void {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useEffect(() => {
    if (fresh === null) return;
    if (dirtyRef.current) return;
    applyRef.current(fresh);
  }, [fresh, dirtyRef]);
}
