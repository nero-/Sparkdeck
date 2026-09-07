/* ============================================================================
   pages/control/dialogs — modals for the pair lifecycle console:
   StartDialog (profile pick + health-timeout override w/ 720/1900 presets +
   extra flags + skip_preflight + switch narrative), OpLogDialog (streamed op
   terminal + step chips + cancel), GidsDialog (RoCE GID table over
   op.params.gid_table). Command strings mirror the backend Tp2Verbs shapes —
   nothing invented beyond the contract.
   ========================================================================= */

import { useEffect, useMemo, useState } from 'react';
import { Square } from 'lucide-react';
import { cn } from '../../lib/cn';
import { Btn, Chip, Empty, Modal, Spinner, Terminal, toast } from '../../ds';
import { api } from '../../api/client';
import { cancelOp, readGidTable } from '../../api/control';
import { useLive } from '../../stores/live';
import type { ClusterTopology, ID, NodeConfig, OpRecord, ProfileDef } from '../../api/types';
import { fmtDuration } from '../../lib/format';

/* ---------------------------------------------------------------------------
   op bookkeeping shared by every dialog here
   --------------------------------------------------------------------------- */

const ACTIVE_OP_STATES: ReadonlySet<OpRecord['state']> = new Set(['queued', 'running']);

/** Merge op records into the shared live-store buffer (single source of truth).
    Skips records whose presentation-relevant fields did not change, so DB
    re-reads don't churn subscribers. */
export function mergeOpsIntoStore(ops: OpRecord[]): void {
  if (ops.length === 0) return;
  const next = new Map(useLive.getState().opsById);
  let changed = false;
  for (const op of ops) {
    const cur = next.get(op.id);
    if (
      cur === undefined ||
      cur.state !== op.state ||
      cur.log_tail.length !== op.log_tail.length ||
      cur.steps.length !== op.steps.length ||
      (cur.message ?? '') !== (op.message ?? '')
    ) {
      next.set(op.id, op);
      changed = true;
    }
  }
  if (changed) useLive.setState({ opsById: next });
}

/** Track one op: hydrate from the store, refresh on an interval while active.
    (The WS `ops` topic pushes the same records at ~5 Hz; polling is the
    fallback for the WS-down case.) */
export function useTrackedOp(opId: ID | null | undefined): OpRecord | undefined {
  const storeOp = useLive((s) =>
    opId !== undefined && opId !== null ? s.opsById.get(opId) : undefined,
  );

  useEffect(() => {
    if (opId === undefined || opId === null || storeOp !== undefined) return;
    let dead = false;
    api
      .op(opId)
      .then((op) => {
        if (!dead) mergeOpsIntoStore([op]);
      })
      .catch(() => {
        /* controller unreachable — dialog shows the empty state */
      });
    return () => {
      dead = true;
    };
  }, [opId, storeOp]);

  const state = storeOp?.state;
  useEffect(() => {
    if (opId === undefined || opId === null) return;
    if (state !== 'queued' && state !== 'running') return;
    const t = setInterval(() => {
      void api
        .op(opId)
        .then((op) => mergeOpsIntoStore([op]))
        .catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [opId, state]);

  return storeOp;
}

export function isOpActive(op: OpRecord | null | undefined): boolean {
  return op !== null && op !== undefined && ACTIVE_OP_STATES.has(op.state);
}

/** Op state → chip variant (timeline + events ops table use the same map). */
export function opStateVariant(state: OpRecord['state']): 'neutral' | 'ok' | 'warn' | 'crit' | 'accent' {
  switch (state) {
    case 'running':
      return 'accent';
    case 'ok':
      return 'ok';
    case 'error':
      return 'crit';
    case 'cancelled':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function opDurationLabel(op: OpRecord | null | undefined, now: number): string {
  if (op === null || op === undefined) return '—';
  const running = ACTIVE_OP_STATES.has(op.state);
  const end = op.finished ?? (running ? now : null);
  const start = op.started ?? op.created;
  if (end === null) return running ? '—' : '—';
  return fmtDuration(Math.max(0, end - start) / 1000);
}

/* ---------------------------------------------------------------------------
   StartDialog
   --------------------------------------------------------------------------- */

const TIMEOUT_PRESETS = [720, 1900] as const;
const TIMEOUT_MIN = 180;
const TIMEOUT_MAX = 3600;
const TIMEOUT_STEP = 10;

function envFileOf(node: NodeConfig | undefined, profileKey: string): string {
  return `rank-${node?.env_rank ?? 0}-${profileKey}.env`;
}

function startCommands(cluster: ClusterTopology, profileKey: string, extra: string): string[] {
  const ctl = cluster.control;
  const head = cluster.nodes.find((n) => n.id === ctl.head_node_id);
  const worker = cluster.nodes.find((n) => n.id === ctl.worker_node_id);
  const extraPart = extra.trim();
  const cmdFor = (n: NodeConfig | undefined): string =>
    `cd ${ctl.serve_dir} && bash ${ctl.launcher} --run ${envFileOf(n, profileKey)}${extraPart !== '' ? ` ${extraPart}` : ''} 2>&1`;
  const cmds: string[] = [];
  if (worker !== undefined) cmds.push(`# worker ${worker.name}\n${cmdFor(worker)}`);
  if (head !== undefined) cmds.push(`# head ${head.name}\n${cmdFor(head)}`);
  return cmds;
}

export function StartDialog({
  cluster,
  serviceProfileKey,
  open,
  onClose,
  onSubmit,
}: {
  cluster: ClusterTopology;
  /** currently serving profile (pre-select) */
  serviceProfileKey: string | null;
  open: boolean;
  onClose: () => void;
  /** POSTs the action; resolves once accepted (caller toasts), rejects on error */
  onSubmit: (v: {
    profile_key: string;
    health_timeout_s: number;
    skip_preflight: boolean;
    extra: string;
  }) => Promise<void>;
}) {
  const profiles = cluster.profiles;
  const defaultKey =
    serviceProfileKey ??
    (profiles.find((p) => p.key === 'mtp3-spark')?.key ?? profiles[0]?.key ?? 'mtp3-spark');
  const [selected, setSelected] = useState(defaultKey);
  const [timeoutS, setTimeoutS] = useState(cluster.control.health_timeout_s ?? 720);
  const [extra, setExtra] = useState(cluster.control.start_extra ?? '');
  const [skipPreflight, setSkipPreflight] = useState(false);
  const [busy, setBusy] = useState(false);

  // re-sync the pre-select each time the dialog opens
  useEffect(() => {
    if (open) setSelected(defaultKey);
  }, [open, defaultKey]);

  const cmds = useMemo(() => startCommands(cluster, selected, extra), [cluster, selected, extra]);

  const submit = (): void => {
    setBusy(true);
    onSubmit({ profile_key: selected, health_timeout_s: timeoutS, skip_preflight: skipPreflight, extra })
      .then(onClose)
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      width={660}
      title="Start pair"
      actions={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" onClick={submit} loading={busy}>
            Start pair
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {/* profile pick — radio cards */}
        <div role="radiogroup" aria-label="Serving profile" className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {profiles.map((p) => (
            <ProfileRadio key={p.key} profile={p} active={p.key === selected} onPick={() => setSelected(p.key)} />
          ))}
        </div>

        {/* health timeout slider + presets */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className="sd-monolabel">health timeout override</span>
            <span className="sd-num font-mono text-xs text-hi">{timeoutS} s</span>
          </div>
          <input
            type="range"
            min={TIMEOUT_MIN}
            max={TIMEOUT_MAX}
            step={TIMEOUT_STEP}
            value={timeoutS}
            onChange={(e) => setTimeoutS(Number(e.currentTarget.value))}
            className="w-full cursor-pointer"
            style={{ accentColor: 'var(--sd-accent)' }}
            aria-label="health timeout seconds"
          />
          <div className="flex flex-wrap items-center gap-1.5">
            {TIMEOUT_PRESETS.map((p) => (
              <Btn
                key={p}
                size="sm"
                variant={timeoutS === p ? 'primary' : 'ghost'}
                onClick={() => setTimeoutS(p)}
                title={p === (cluster.control.health_timeout_s ?? 720) ? 'cluster default' : p === 1900 ? 'slow-load reserve' : p === 720 ? '720 s preset' : `${p} s preset`}
              >
                {p} s
              </Btn>
            ))}
          </div>
        </div>

        {/* extra flags passthrough */}
        <label className="flex flex-col gap-1">
          <span className="sd-monolabel">extra flags (EXTRA passthrough)</span>
          <input
            className="sd-raised h-9 px-2.5 font-mono text-xs text-hi outline-none transition-colors duration-fast focus:border-accent/60"
            value={extra}
            onChange={(e) => setExtra(e.currentTarget.value)}
            spellCheck={false}
            placeholder="— (pairctl EXTRA)"
          />
          <span className="text-2xs text-low">prefilled from the cluster&apos;s start_extra.</span>
        </label>

        {/* skip preflight toggle */}
        <label className="flex cursor-pointer items-start gap-2">
          <input
            type="checkbox"
            checked={skipPreflight}
            onChange={(e) => setSkipPreflight(e.currentTarget.checked)}
            className="mt-0.5 cursor-pointer"
            style={{ accentColor: 'var(--sd-accent)' }}
          />
          <span className="flex flex-col">
            <span className="text-xs text-hi">skip preflight</span>
            <span className="text-2xs text-low">
              skips swappiness trim + page-cache drop on both nodes; the RoCE GID re-check always runs.
            </span>
          </span>
        </label>

        {/* switch narrative (the operator&apos;s ops conventions) */}
        <div className="rounded-inner border border-warn/25 bg-warn/5 px-3 py-2 text-xs text-mid">
          <span className="font-semibold text-warn">Model switch:</span> Start brings the pair UP — worker first, then
          head; takes ~3–5 min. OWUI/Hermes/DSH lose their model during the switch. A currently-serving pair is torn
          down first, GIDs are re-checked, and health is polled on the head&apos;s node-local API.
        </div>

        {/* the exact remote commands, worker first */}
        <pre className="sd-raised max-h-40 overflow-auto p-3 font-mono text-2xs leading-relaxed text-mid">
          {cmds.map((c, i) => (
            <div key={i} className="sd-num whitespace-pre-wrap">
              {c}
            </div>
          ))}
        </pre>
      </div>
    </Modal>
  );
}

function ProfileRadio({
  profile,
  active,
  onPick,
}: {
  profile: ProfileDef;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onPick}
      className={cn(
        'flex cursor-pointer flex-col gap-0.5 rounded-inner border px-2.5 py-2 text-left transition-colors duration-fast',
        active
          ? 'border-accent/50 bg-accent/10'
          : 'border-stroke bg-transparent hover:border-stroke-strong hover:bg-bg2',
      )}
    >
      <span className="flex items-center gap-1.5">
        <span className={cn('h-2 w-2 rounded-full', active ? 'bg-accent' : 'bg-low')} aria-hidden />
        <span className="font-mono text-xs text-hi">{profile.key}</span>
      </span>
      <span className="truncate text-2xs text-low">{profile.label}</span>
      <span className="sd-num font-mono text-2xs text-low">
        kv {profile.kv_pin_gib ?? '—'} GiB · ctx{' '}
        {profile.context !== null && profile.context !== undefined
          ? new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(profile.context)
          : '—'}{' '}
        · {profile.quant ?? '—'}
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------------
   step chips
   --------------------------------------------------------------------------- */

const STEP_VARIANT: Record<OpStepState, 'neutral' | 'ok' | 'warn' | 'crit' | 'accent'> = {
  pending: 'neutral',
  running: 'accent',
  ok: 'ok',
  skipped: 'warn',
  error: 'crit',
  cancelled: 'warn',
};
type OpStepState = OpRecord['steps'][number]['state'];

/* ---------------------------------------------------------------------------
   OpLogDialog
   --------------------------------------------------------------------------- */

export function OpLogDialog({
  opId,
  title,
  onClose,
}: {
  opId: ID | null;
  title: string;
  onClose: () => void;
}) {
  const op = useTrackedOp(opId);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const running = isOpActive(op);

  const doCancel = (): void => {
    if (opId === null) return;
    void cancelOp(opId)
      .then((r) => {
        if (r.ok) toast.ok('Cancel requested', `op ${opId} — best-effort, remote step runs to timeout`);
        else toast.warn('Cancel not accepted — op may have already finished');
      })
      .catch((e: unknown) => {
        toast.error('Cancel failed', e instanceof Error ? e.message : String(e));
      });
    setConfirmCancel(false);
  };

  return (
    <Modal
      open={opId !== null}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          <span className="font-mono">{title}</span>
          {op !== undefined && (
            <Chip variant={opStateVariant(op.state)}>
              {op.state === 'running' ? <Spinner size={9} /> : null}
              {op.state}
            </Chip>
          )}
        </span>
      }
      width={760}
      actions={
        <>
          {running && (
            <Btn variant="danger" size="sm" icon={<Square size={12} />} onClick={() => setConfirmCancel(true)}>
              Cancel op
            </Btn>
          )}
          <Btn variant="ghost" size="md" onClick={onClose}>
            Close
          </Btn>
        </>
      }
    >
      {op === undefined ? (
        <Empty
          title="Op not in the live buffer (yet)."
          hint="It appears as soon as the controller publishes it — or after Refresh with the controller reachable."
          className="py-10"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {op.steps.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              {op.steps.map((s, i) => (
                <Chip key={`${s.name}-${i}`} variant={STEP_VARIANT[s.state]} title={s.detail ?? undefined}>
                  {s.name}: {s.state}
                </Chip>
              ))}
            </div>
          )}

          <div className="flex h-[min(46vh,460px)] flex-col">
            <Terminal lines={op.log_tail} showLineNumbers={false} follow maxLines={600} className="sd-raised" />
          </div>

          {op.message !== null && op.message !== undefined && op.message !== '' && (
            <div className="rounded-inner border border-crit/30 bg-crit/10 px-3 py-2 font-mono text-2xs break-words text-crit">
              {op.message}
            </div>
          )}

          {/* the cancel confirmation nests as a second modal */}
          <ConfirmCancelOp
            open={confirmCancel}
            op={op}
            onClose={() => setConfirmCancel(false)}
            onConfirm={doCancel}
          />
        </div>
      )}
    </Modal>
  );
}

function ConfirmCancelOp({
  open,
  op,
  onClose,
  onConfirm,
}: {
  open: boolean;
  op: OpRecord;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Cancel operation?"
      width={480}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose}>
            No — let it run
          </Btn>
          <Btn variant="danger" onClick={onConfirm}>
            Cancel op
          </Btn>
        </>
      }
    >
      <div className="text-xs text-mid">
        <span className="font-mono text-hi">{op.kind}</span> is {op.state}. Cancellation is best-effort: the running
        remote step (SSH exec) continues until its own timeout, so teardown may still complete afterwards.
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------------------------
   GidsDialog — RoCE GID table from op.params.gid_table, rid (GID index)
   column first; raw op log beneath as ground truth.
   --------------------------------------------------------------------------- */

export function GidsDialog({ opId, nodeName, onClose }: { opId: ID | null; nodeName: string; onClose: () => void }) {
  const op = useTrackedOp(opId);
  const rows = useMemo(() => readGidTable(op).sort((a, b) => a.hca.localeCompare(b.hca) || (a.index ?? 0) - (b.index ?? 0)), [op]);

  return (
    <Modal
      open={opId !== null}
      onClose={onClose}
      title={
        <span className="inline-flex items-center gap-2">
          RoCE GID table
          <span className="font-mono text-xs text-mid">{nodeName}</span>
          {op !== undefined && <Chip variant={opStateVariant(op.state)}>{op.state}</Chip>}
        </span>
      }
      width={640}
      actions={
        <Btn variant="ghost" size="md" onClick={onClose}>
          Close
        </Btn>
      }
    >
      {op === undefined ? (
        <Empty title="Op not in the live buffer (yet)." className="py-8" />
      ) : op.state !== 'ok' && rows.length === 0 ? (
        <div className="px-1 py-2 text-xs text-mid">
          GID table not parsed yet — the op is {op.state}. Raw log below.
          <div className="mt-2 flex h-[min(30vh,280px)] flex-col">
            <Terminal lines={op.log_tail} follow maxLines={200} className="sd-raised" />
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="sd-raised max-h-64 overflow-auto">
            <table className="w-full font-mono text-2xs">
              <thead>
                <tr className="border-b border-stroke text-left">
                  {['rid', 'hca', 'transport', 'addr'].map((h) => (
                    <th key={h} className="sd-monolabel px-2.5 py-1.5">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.hca}-${i}`} className="border-b border-stroke/60 last:border-0">
                    <td className="sd-num px-2.5 py-1 text-hi">{r.index ?? '—'}</td>
                    <td className="px-2.5 py-1 text-mid">{r.hca}</td>
                    <td className="px-2.5 py-1 text-mid">{r.transport}</td>
                    <td className="px-2.5 py-1 text-mid">{r.addr}</td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-2.5 py-3 text-center text-mid">
                      no RoCE GID rows parsed
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="flex h-[min(24vh,220px)] flex-col">
            <Terminal lines={op.log_tail} follow maxLines={200} className="sd-raised" />
          </div>
        </div>
      )}
    </Modal>
  );
}
