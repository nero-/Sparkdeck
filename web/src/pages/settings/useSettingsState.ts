/* settings gate — one query + a patch wrapper that toasts + feeds the 401 gate. */

import { useCallback } from 'react';
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
