/* ============================================================================
   lib/pagekit — shared page pieces for the settings/bench/images waves:
   Drawer (right sheet), CodeBlock, NumField, FieldMsg, api-error copy,
   DataTable, DirtySave, OpDrawer (live op detail w/ steps + terminal),
   TokenGate host (401 unlock modal storing localStorage['sparkdeck.token']).
   Built strictly on the ds barrel + pinned API contract.
   ========================================================================= */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, X } from 'lucide-react';
import { cn } from './cn';
import { ApiClientError, api, setAuthToken, useWs, isApiClientError } from '../api/client';
import type { OpRecord } from '../api/types';
import { Btn, Chip, FieldLabel, Input, KeyRow, Modal, Panel, Spinner, Terminal, toast } from '../ds';
import { fmtDateTime, fmtDuration } from './format';

/* ---------------------------------------------------------------------------
   ApiClientError copy helpers
   --------------------------------------------------------------------------- */

export function errCopy(e: unknown): string {
  if (isApiClientError(e)) {
    return e.code === 'network' || e.code === 'bad_response'
      ? `connection error — ${e.message}`
      : `${e.code}: ${e.message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiClientError && e.status === 401;
}

/** Inline validation/message line under a field. */
export function FieldMsg({ tone, children }: { tone: 'ok' | 'error' | 'hint'; children: ReactNode }) {
  return (
    <div
      className={cn(
        'text-2xs',
        tone === 'ok' ? 'text-ok' : tone === 'error' ? 'text-crit' : 'text-low',
      )}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   NumField — numeric input w/ unit + inline validation
   --------------------------------------------------------------------------- */

export function NumField({
  label,
  value,
  onChange,
  min,
  max,
  unit,
  integer = false,
  hint,
  disabled,
  required,
  placeholder,
  className,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  min?: number;
  max?: number;
  unit?: string;
  integer?: boolean;
  hint?: string;
  disabled?: boolean;
  required?: boolean;
  placeholder?: string;
  className?: string;
}) {
  const raw = value === null || !Number.isFinite(value) ? '' : String(value);
  const missing = value === null;
  const rangeBad =
    value !== null &&
    Number.isFinite(value) &&
    ((min !== undefined && value < min) || (max !== undefined && value > max) || (integer === true && !Number.isInteger(value)));
  const invalid = (missing && required === true) || rangeBad;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <Input
        label={label}
        inputMode="numeric"
        dir="ltr"
        disabled={disabled}
        placeholder={placeholder}
        invalid={invalid}
        value={raw}
        onChange={(e) => {
          const s = e.currentTarget.value;
          if (s.trim() === '') {
            onChange(null);
            return;
          }
          const n = Number(s);
          onChange(Number.isFinite(n) ? n : NaN);
        }}
        hint={unit !== undefined && hint !== undefined ? `${hint} (${unit})` : hint ?? unit}
      />
      {invalid && (
        <FieldMsg tone="error">
          {missing && required === true
            ? 'required'
            : rangeBad
              ? min !== undefined && (value ?? min) < min
                ? `must be ≥ ${min}`
                : max !== undefined && (value ?? max) > max
                  ? `must be ≤ ${max}`
                  : integer === true
                    ? 'must be an integer'
                    : ''
              : ''}
        </FieldMsg>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   CodeBlock — mono block for exact commands / argv previews
   --------------------------------------------------------------------------- */

export function CodeBlock({
  lines,
  label,
  className,
  dense = false,
}: {
  lines: string[];
  label?: string;
  className?: string;
  dense?: boolean;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      {label !== undefined && <FieldLabel className="mb-1 block">{label}</FieldLabel>}
      <div
        className={cn(
          'sd-raised overflow-x-auto font-mono text-2xs leading-[1.5] text-hi',
          dense ? 'p-1.5' : 'p-2.5',
        )}
      >
        {lines.length === 0 ? (
          <span className="text-low">—</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="sd-num whitespace-pre-wrap break-all">
              {l}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   DataTable — dense 13px operator table (DESIGN "Tables"): sticky header,
   right-aligned numerics opt-in, hairline row rules.
   --------------------------------------------------------------------------- */

export interface DataColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  title?: string;
  width?: string;
}

export function DataTable({
  columns,
  children,
  empty,
  minWidth = 640,
  className,
}: {
  columns: DataColumn[];
  children: ReactNode;
  empty?: string;
  minWidth?: number;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0 overflow-x-auto', className)}>
      <table className="w-full border-separate border-spacing-0" style={{ minWidth }}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                title={c.title}
                className={cn(
                  'sd-monolabel sticky top-0 z-[1] border-b border-stroke bg-bg1 px-2 py-1.5 font-medium',
                  c.align === 'right' ? 'text-right' : 'text-left',
                )}
                style={{ width: c.width }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="text-sm">{children}</tbody>
      </table>
      {empty !== undefined && (
        <div className="px-2 py-6 text-center text-xs text-low">{empty}</div>
      )}
    </div>
  );
}

export function Td({
  children,
  align = 'left',
  num = false,
  className,
  title,
  colSpan,
}: {
  children: ReactNode;
  align?: 'left' | 'right';
  num?: boolean;
  className?: string;
  title?: string;
  colSpan?: number;
}) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={cn(
        'border-b border-stroke px-2 py-1.5 align-middle',
        align === 'right' ? 'text-right' : 'text-left',
        num && 'sd-num font-mono',
        className,
      )}
    >
      {children}
    </td>
  );
}

/* ---------------------------------------------------------------------------
   DirtySave — standard footer for patch-a-section forms
   --------------------------------------------------------------------------- */

export function DirtySave({
  dirty,
  valid,
  saving,
  error,
  onSave,
  onReset,
  saveLabel = 'Save',
  extraHint,
}: {
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  error: unknown;
  onSave: () => void;
  onReset: () => void;
  saveLabel?: string;
  extraHint?: ReactNode;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stroke pt-3">
      <Btn variant="primary" size="sm" disabled={!dirty || !valid} loading={saving} onClick={onSave}>
        {saveLabel}
      </Btn>
      {dirty && (
        <Btn variant="ghost" size="sm" disabled={saving} onClick={onReset}>
          Discard
        </Btn>
      )}
      {dirty && !valid && <FieldMsg tone="hint">fix the invalid fields to save</FieldMsg>}
      {dirty && valid && extraHint}
      {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Drawer — right-side sheet (portal + Esc + scrim + focus restore)
   --------------------------------------------------------------------------- */

export function Drawer({
  open,
  onClose,
  title,
  sub,
  children,
  actions,
  width = 620,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  /** css width — number (px) or e.g. "min(720px, 92vw)" */
  width?: number | string;
  busy?: boolean;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => {
      restoreRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, busy, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex justify-end bg-scrim backdrop-blur-[2px]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className="sd-panel flex h-full w-full max-w-full flex-col gap-3 overflow-hidden outline-none"
        style={{
          maxWidth: width,
          borderRadius: '10px 0 0 10px',
          borderRight: 'none',
          boxShadow: '-12px 0 40px rgba(0,0,0,0.45)',
        }}
      >
        <div className="flex shrink-0 items-start justify-between gap-3 border-b border-stroke px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="min-w-0 truncate text-[13px] font-semibold text-hi">{title}</h2>
            {sub !== undefined && <div className="truncate text-xs text-low">{sub}</div>}
          </div>
          <button
            type="button"
            aria-label="Close drawer"
            disabled={busy}
            onClick={onClose}
            className="cursor-pointer rounded-inner p-1 text-low transition-colors duration-fast hover:bg-bg2 hover:text-hi disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
        {actions !== undefined && (
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stroke px-4 py-2.5">
            {actions}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------------------
   Op probes — live op detail (steps + log tail) shared by images/bench
   --------------------------------------------------------------------------- */

export const OP_CHIP_VARIANT: Record<OpRecord['state'], 'neutral' | 'ok' | 'warn' | 'crit' | 'accent'> = {
  queued: 'neutral',
  running: 'accent',
  ok: 'ok',
  error: 'crit',
  cancelled: 'warn',
};

export const OP_STEP_VARIANT: Record<
  OpRecord['steps'][number]['state'],
  'neutral' | 'ok' | 'warn' | 'crit' | 'accent'
> = {
  pending: 'neutral',
  running: 'accent',
  ok: 'ok',
  error: 'crit',
  skipped: 'neutral',
  cancelled: 'warn',
};

/**
 * Live op record: resolves from the WS op store first (upserts stream in),
 * falls back to REST + a 2.5 s poll while the op is queued/running.
 */
export function useLiveOp(opId: string | null): OpRecord | null {
  const [fetched, setFetched] = useState<OpRecord | null>(null);
  const fromStore = useOpRef(opId);

  useEffect(() => {
    setFetched(null);
    if (opId === null) return;
    if (fromStore !== undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = (errors: number, delayMs = 2500): void => {
      api
        .op(opId)
        .then((op) => {
          if (!active) return;
          setFetched(op);
          if (op.state === 'queued' || op.state === 'running') {
            timer = setTimeout(() => poll(0, delayMs), delayMs);
          }
        })
        .catch(() => {
          if (active && errors < 3) timer = setTimeout(() => poll(errors + 1, 4000), 4000);
        });
    };
    poll(0);
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [opId, fromStore]);

  if (fromStore !== undefined) return fromStore;
  return fetched;
}

function useOpRef(opId: string | null): OpRecord | undefined {
  return useWs((s) => (opId !== null ? s.opsById.get(opId) : undefined));
}

export function OpSteps({ op }: { op: OpRecord }) {
  return (
    <ol className="flex flex-col gap-1">
      {op.steps.map((st, i) => (
        <li key={i} className="flex min-w-0 items-start gap-2 rounded-inner px-1 py-0.5">
          <Chip variant={OP_STEP_VARIANT[st.state]} className="mt-px shrink-0">
            {st.state}
          </Chip>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] text-hi">{st.name}</div>
            {st.detail !== undefined && (
              <div className="mt-0.5 whitespace-pre-wrap break-all font-mono text-2xs text-low">
                {st.detail}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function OpDetailBody({ op }: { op: OpRecord }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Chip variant={OP_CHIP_VARIANT[op.state]}>{op.state}</Chip>
        <Chip variant="neutral">{op.kind}</Chip>
        {op.exit !== null && op.exit !== undefined && (
          <Chip variant={op.exit === 0 ? 'ok' : 'crit'}>exit {op.exit}</Chip>
        )}
      </div>
      <dl className="flex flex-col gap-1">
        <KeyRow label="created" value={fmtDateTime(op.created)} />
        {op.started !== null && <KeyRow label="started" value={fmtDateTime(op.started)} />}
        {op.finished !== null && (
          <KeyRow
            label="finished"
            value={
              op.started !== null
                ? `${fmtDateTime(op.finished)} (${fmtDuration((op.finished - op.started) / 1000)})`
                : fmtDateTime(op.finished)
            }
          />
        )}
        {op.message !== null && op.message !== undefined && (
          <KeyRow label="message" value={op.message} mono={false} />
        )}
      </dl>
      {op.steps.length > 0 && (
        <Panel title="Steps" className="p-3">
          <OpSteps op={op} />
        </Panel>
      )}
      <Panel title="Log tail" className="flex min-h-0 flex-col p-0">
        <div className="flex min-h-[180px] flex-col">
          <Terminal lines={op.log_tail} className="min-h-[179px]" />
        </div>
      </Panel>
      {Object.keys(op.params).length > 0 && (
        <Panel title="Params" className="p-3">
          <pre className="max-h-40 overflow-auto font-mono text-2xs text-mid">
            {JSON.stringify(op.params, null, 2)}
          </pre>
        </Panel>
      )}
    </div>
  );
}

export function OpDrawer({ opId, onClose }: { opId: string | null; onClose: () => void }) {
  const op = useLiveOp(opId);
  return (
    <Drawer
      open={opId !== null}
      onClose={onClose}
      title="Operation"
      sub={op !== null ? `${op.kind} · ${op.state}` : opId ?? ''}
      width="min(680px, 92vw)"
    >
      {opId === null ? null : op === null ? (
        <div className="flex items-center justify-center gap-2 py-10 text-mid">
          <Spinner size={13} /> loading op…
        </div>
      ) : (
        <OpDetailBody op={op} />
      )}
    </Drawer>
  );
}

/* ---------------------------------------------------------------------------
   Token unlock gate — pinned localStorage['sparkdeck.token'].
   A global 401 intercept would belong in client.ts/App.tsx (pinned / another
   wave's file), so pages render <TokenGateHost/> once and any module can call
   offerAuthGate(error) on a 401 it observes.
   --------------------------------------------------------------------------- */

const gateListeners = new Set<() => void>();

/** Call on any failing request — opens the unlock modal when it's a 401. */
export function offerAuthGate(e: unknown): void {
  if (!isUnauthorized(e)) return;
  for (const l of gateListeners) l();
}

export function TokenGateHost({ onUnlocked }: { onUnlocked: () => void }): ReactNode {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const openIt = (): void => setOpen(true);
    gateListeners.add(openIt);
    return () => {
      gateListeners.delete(openIt);
    };
  }, []);
  return (
    <TokenUnlockModal open={open} onClose={() => setOpen(false)} onUnlocked={onUnlocked} />
  );
}

function TokenUnlockModal({
  open,
  onClose,
  onUnlocked,
}: {
  open: boolean;
  onClose: () => void;
  onUnlocked: () => void;
}) {
  const [token, setToken] = useState('');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <KeyRound size={15} style={{ color: 'var(--sd-warn)' }} /> Unlock required
        </span>
      }
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            disabled={token.trim().length === 0}
            onClick={() => {
              setAuthToken(token.trim());
              toast.ok('Token stored in this browser.');
              onUnlocked();
              onClose();
            }}
          >
            Unlock
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm text-mid">
        <p>
          The controller requires a browse token (<code className="font-mono text-hi">security.token_set</code>) and
          requests are answering <span className="font-mono text-crit">401</span>.
        </p>
        <Input
          label="Browse token"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.currentTarget.value)}
          hint="Stored as localStorage['sparkdeck.token'] on this device only."
        />
      </div>
    </Modal>
  );
}
