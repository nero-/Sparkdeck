/* ============================================================================
   ds/Modal — overlay modal + ConfirmDialog (DESIGN.md "Confirmations"):
   typed action summary, remote commands in a code block, explicit Run.
   ========================================================================= */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Btn, Input } from './primitives';


/* Nested-overlay Escape discipline: only the TOPMOST open overlay consumes
   Escape (module-level claim stack — the last mounted overlay owns the key). */
const escapeStack: symbol[] = [];

export function useEscapeClaim(open: boolean, busy: boolean, onClose: () => void): void {
  const cbRef = useRef(onClose);
  cbRef.current = onClose;
  const sym = useMemo(() => Symbol('esc'), []);
  useEffect(() => {
    if (!open) return;
    escapeStack.push(sym);
    let alive = true;
    const onKey = (e: KeyboardEvent): void => {
      if (!alive) return;
      if (e.key !== 'Escape') return;
      if (escapeStack[escapeStack.length - 1] !== sym) return; // newer overlay is on top
      if (busy) return;
      e.preventDefault();
      cbRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      alive = false;
      window.removeEventListener('keydown', onKey, true);
      const i = escapeStack.lastIndexOf(sym);
      if (i !== -1) escapeStack.splice(i, 1);
    };
  }, [open, busy, sym]);
}

export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  width = 560,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  width?: number;
  busy?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // initial focus lands on the card so Escape works before any control
    cardRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open]);

  useEscapeClaim(open, busy, onClose);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4 backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      data-testid="modal-scrim"
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cn(
          'sd-panel flex max-h-[84dvh] w-full flex-col gap-3 p-4 outline-none',
          'animate-[sd-fade-in_150ms_cubic-bezier(0.22,0.61,0.36,1)_both]',
        )}
        style={{ maxWidth: width }}
      >
        <div className="flex min-w-0 items-start justify-between gap-3">
          <h2 className="min-w-0 text-base font-semibold text-hi">{title}</h2>
          <button
            type="button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
            className="cursor-pointer rounded-inner p-1 text-low transition-colors duration-fast hover:bg-bg2 hover:text-hi disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
        {actions !== undefined && (
          <div className="flex shrink-0 items-center justify-end gap-2 pt-1">{actions}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------------------
   ConfirmDialog — destructive action confirmation.
   `confirmWord`, when set, requires typing the exact word to enable Run.
   --------------------------------------------------------------------------- */

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  summary,
  commands,
  confirmWord,
  confirmLabel = 'Run',
  danger = true,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  summary: ReactNode;
  /** remote commands the action will execute — shown in a mono code block */
  commands?: string[];
  /** if set, Run stays disabled until the user types this word */
  confirmWord?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
}) {
  const [typed, setTyped] = useState('');

  useEffect(() => {
    if (open) setTyped('');
  }, [open]);

  const ready = busy !== true && (confirmWord === undefined || typed === confirmWord);

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={title}
      width={520}
      actions={
        <>
          <Btn variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn
            variant={danger ? 'danger' : 'primary'}
            size="md"
            onClick={onConfirm}
            disabled={!ready}
            loading={busy}
          >
            {confirmLabel}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="text-sm text-mid">{summary}</div>
        {commands !== undefined && commands.length > 0 && (
          <pre className="sd-raised max-h-44 overflow-auto p-3 font-mono text-xs text-mid">
            {commands.map((c) => (
              <div key={c} className="sd-num">
                <span className="mr-2 text-low select-none" aria-hidden>
                  $
                </span>
                {c}
              </div>
            ))}
          </pre>
        )}
        {confirmWord !== undefined && (
          <Input
            label={`Type "${confirmWord}" to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.currentTarget.value)}
            invalid={typed.length > 0 && typed !== confirmWord}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </div>
    </Modal>
  );
}
