/* ============================================================================
   shell/hotkeys — "g" chord + digit navigates (g-1..g-9 per routes).
   Ignored while typing in inputs/textareas/contenteditables or with modifiers.
   ========================================================================= */

import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_ITEMS } from '../router';

const CHORD_WINDOW_MS = 1400;

export function useNavHotkeys(): void {
  const navigate = useNavigate();

  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearPending = (): void => {
      pending = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        return;
      }

      if (pending && /^[1-9]$/.test(e.key)) {
        const item = NAV_ITEMS[Number(e.key) - 1];
        clearPending();
        if (item !== undefined) {
          e.preventDefault();
          void navigate(item.path);
        }
        return;
      }

      if (e.key === 'g' && !e.shiftKey && !e.repeat) {
        pending = true;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(clearPending, CHORD_WINDOW_MS);
      } else {
        clearPending();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearPending();
    };
  }, [navigate]);
}
