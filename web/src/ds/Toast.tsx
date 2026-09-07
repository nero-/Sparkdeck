/* ============================================================================
   ds/Toast — bottom-right toast stack. Errors are sticky (manual dismiss),
   others auto-dismiss. Max 5 visible.
   Usage:  import { toast } from '../ds';
           toast.error("op failed: …");  toast.ok("deployed");
   ========================================================================= */

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleCheck, Info, OctagonAlert, TriangleAlert, X } from 'lucide-react';
import { create } from 'zustand';
import { cn } from '../lib/cn';

export type ToastLevel = 'info' | 'ok' | 'warn' | 'error';

export interface ToastItem {
  id: number;
  level: ToastLevel;
  text: string;
  detail?: string;
  sticky: boolean;
}

interface ToastState {
  items: ToastItem[];
  push: (item: Omit<ToastItem, 'id' | 'sticky'> & { sticky?: boolean }) => void;
  dismiss: (id: number) => void;
}

const AUTO_DISMISS_MS = 4000;
const MAX_TOASTS = 5;

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useToasts = create<ToastState>()((set, get) => ({
  items: [],
  push: (item) => {
    const id = nextId++;
    const sticky = item.sticky ?? item.level === 'error';
    const entry: ToastItem = { ...item, id, sticky };
    set((s) => ({
      items: [...s.items.slice(-1 * (MAX_TOASTS - 1)), entry],
    }));
    if (!sticky) {
      const t = setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
      timers.set(id, t);
    }
  },
  dismiss: (id) => {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    }
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));

function push(level: ToastLevel, text: string, detail?: string): void {
  useToasts.getState().push({ level, text, detail, sticky: level === 'error' });
}

/** Imperative toast API — safe to call from stores/handlers. */
export const toast = {
  info: (text: string, detail?: string) => push('info', text, detail),
  ok: (text: string, detail?: string) => push('ok', text, detail),
  warn: (text: string, detail?: string) => push('warn', text, detail),
  error: (text: string, detail?: string) => push('error', text, detail),
  dismiss: (id: number) => useToasts.getState().dismiss(id),
};

const LEVEL_ICON: Record<ToastLevel, ReactNode> = {
  info: <Info size={14} style={{ color: 'var(--sd-accent)' }} />,
  ok: <CircleCheck size={14} style={{ color: 'var(--sd-ok)' }} />,
  warn: <TriangleAlert size={14} style={{ color: 'var(--sd-warn)' }} />,
  error: <OctagonAlert size={14} style={{ color: 'var(--sd-crit)' }} />,
};

const LEVEL_EDGE: Record<ToastLevel, string> = {
  info: 'bg-accent/70',
  ok: 'bg-ok/70',
  warn: 'bg-warn/70',
  error: 'bg-crit/70',
};

export function Toaster() {
  const items = useToasts((s) => s.items);
  const dismiss = useToasts((s) => s.dismiss);

  useEffect(() => () => {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
  }, []);

  if (items.length === 0) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[70] flex w-[min(420px,calc(100vw-32px))] flex-col items-stretch gap-2"
      role="log"
      aria-live="polite"
    >
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            'sd-raised pointer-events-auto flex items-start gap-2.5 overflow-hidden py-2 pl-1.5 pr-2',
            'animate-[sd-fade-in_150ms_cubic-bezier(0.22,0.61,0.36,1)_both]',
          )}
        >
          <span className={cn('mt-0.5 w-[3px] self-stretch rounded-full', LEVEL_EDGE[item.level])} />
          <span className="mt-0.5 shrink-0">{LEVEL_ICON[item.level]}</span>
          <div className="min-w-0 flex-1 py-0.5">
            <div className="text-xs font-medium text-hi break-words">{item.text}</div>
            {item.detail !== undefined && (
              <div className="mt-0.5 font-mono text-[11px] text-low break-words">{item.detail}</div>
            )}
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => dismiss(item.id)}
            className="mt-0.5 cursor-pointer rounded-inner p-0.5 text-low transition-colors duration-fast hover:bg-bg1 hover:text-hi"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
