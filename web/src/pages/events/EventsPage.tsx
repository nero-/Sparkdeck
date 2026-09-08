/* ============================================================================
   EventsPage — operations/events audit.

   Feed: GET /api/events (limit / kind / cluster_id / unacked_only are
   server-side; level is a multi-select applied client-side because the
   server accepts a single level) + live prepends from the WS `events`
   topic via the shared eventsRing buffer. Ack is POST /api/events/ack
   (ids / all) — ack state is also patched into the shared ring so the
   top-bar badge stays truthful. A compact ops table (GET /api/ops) links
   to /control.
   ========================================================================= */

import { useCallback, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Info,
  OctagonAlert,
  RefreshCw,
  ServerCrash,
  TriangleAlert,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../shell/PageShell';
import { Btn, Chip, Empty, Input, Panel, Select, Spinner, Toggle, toast } from '../../ds';
import { api, isApiClientError } from '../../api/client';
import { ackEvents, listEvents } from '../../api/control';
import { useClusters } from '../../api/queries';
import { useLive, useEventsRing } from '../../stores/live';
import { fmtAgo, fmtDateTime, fmtIso } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { EventLevel, EventRec, OpRecord } from '../../api/types';

const FETCH_LIMIT = 500;
const RECORDS_CAP = 800;
const RENDER_CAP = 600;
const LEVELS: EventLevel[] = ['info', 'warn', 'error'];

/* ---------------------------------------------------------------------------
   Page
   --------------------------------------------------------------------------- */

export default function EventsPage() {
  const clustersQ = useClusters();
  const clusters = clustersQ.data ?? [];

  const [clusterSel, setClusterSel] = useState<string>('all');
  const [levels, setLevels] = useState<ReadonlySet<EventLevel>>(new Set(LEVELS));
  const [kind, setKind] = useState('');
  const [unackedOnly, setUnackedOnly] = useState(false);

  const [records, setRecords] = useState<Map<string, EventRec>>(() => new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const fetchNow = useCallback(
    async (silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      try {
        const rows = await listEvents({
          limit: FETCH_LIMIT,
          clusterId: clusterSel === 'all' ? undefined : clusterSel,
          unackedOnly,
        });
        setRecords((prev) => mergeEvents(prev, rows));
        setError(null);
      } catch (e) {
        setError(e);
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [clusterSel, unackedOnly],
  );

  useEffect(() => {
    void fetchNow();
  }, [fetchNow]);

  /* live arrivals — the shared ring is the live surface for the `events` topic */
  const ring = useEventsRing();
  useEffect(() => {
    setRecords((prev) => mergeEvents(prev, ring));
  }, [ring]);

  /* id → display name resolution (cluster + node) */
  const names = useMemo(() => {
    const clusterNames = new Map<string, string>();
    const nodeNames = new Map<string, string>();
    for (const c of clusters) {
      clusterNames.set(c.id, c.name);
      for (const n of c.nodes) nodeNames.set(n.id, n.name);
    }
    return { clusterNames, nodeNames };
  }, [clusters]);

  /* client-side filtration: level set (server takes a single level) + kind
     substring + the unacked-only mirror (also enforced server-side on fetch) */
  const visible = useMemo(() => {
    const kindQ = kind.trim().toLowerCase();
    const out: EventRec[] = [];
    for (const e of records.values()) {
      if (!levels.has(e.level)) continue;
      if (clusterSel !== 'all' && (e.cluster_id ?? null) !== clusterSel) continue;
      if (unackedOnly && e.acked) continue;
      if (kindQ !== '' && !e.kind.toLowerCase().includes(kindQ)) continue;
      out.push(e);
    }
    out.sort((a, b) => b.ts - a.ts || b.id.localeCompare(a.id));
    return out.slice(0, RENDER_CAP);
  }, [records, levels, clusterSel, kind, unackedOnly]);

  const unackedShown = useMemo(() => visible.filter((e) => !e.acked), [visible]);
  const unackedTotal = useMemo(() => {
    let n = 0;
    for (const e of records.values()) if (!e.acked) n++;
    return n;
  }, [records]);

  const markAcked = useCallback((ids: string[]): void => {
    const idSet = new Set(ids);
    setRecords((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of ids) {
        const cur = next.get(id);
        if (cur !== undefined && !cur.acked) {
          next.set(id, { ...cur, acked: true });
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    // keep the shared ring truthful (top-bar badge)
    const ringNow = useLive.getState().eventsRing;
    if (ringNow.some((e) => idSet.has(e.id) && !e.acked)) {
      useLive.setState({ eventsRing: ringNow.map((e) => (idSet.has(e.id) && !e.acked ? { ...e, acked: true } : e)) });
    }
  }, []);

  const ackOne = useCallback(
    (id: string): void => {
      void ackEvents([id])
        .then(() => {
          markAcked([id]);
          toast.ok('Event acked', id);
        })
        .catch((e: unknown) => {
          toast.error('Ack failed', e instanceof Error ? e.message : String(e));
        });
    },
    [markAcked],
  );

  const ackAllShown = useCallback((): void => {
    const ids = unackedShown.map((e) => e.id);
    if (ids.length === 0) return;
    // server caps one ack call at 500 ids — chunk so "all shown" really is all
    const batches: string[][] = [];
    for (let i = 0; i < ids.length; i += 450) batches.push(ids.slice(i, i + 450));
    void Promise.all(batches.map((b) => ackEvents(b)))
      .then((rs) => {
        markAcked(ids);
        const n = rs.reduce((acc, r) => acc + (r.count ?? 0), 0);
        toast.ok(`Acked ${Math.max(n, ids.length)} shown event${ids.length === 1 ? '' : 's'}`);
      })
      .catch((e: unknown) => {
        toast.error('Ack failed', e instanceof Error ? e.message : String(e));
      });
  }, [unackedShown, markAcked]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Events"
        context={`${records.size} events buffered (cap ${RECORDS_CAP}) · live via WS events topic`}
        actions={
          <>
            {unackedTotal > 0 ? (
              <Chip variant="warn" className="font-mono" title="unacked events in buffer">
                {unackedTotal} unacked
              </Chip>
            ) : null}
            <Btn size="sm" variant="ghost" loading={loading} onClick={() => void fetchNow()} title="GET /api/events">
              <RefreshCw size={12} />
              Refresh
            </Btn>
            <Btn
              size="sm"
              variant="primary"
              icon={<Check size={12} />}
              disabled={unackedShown.length === 0}
              onClick={ackAllShown}
              title={`POST /api/events/ack with the ${unackedShown.length} unacked event(s) shown above`}
            >
              Ack all shown
            </Btn>
          </>
        }
      />

      {error !== null && records.size === 0 ? (
        <div className="sd-panel flex min-h-[420px] flex-1 items-center justify-center">
          <Empty
            icon={<ServerCrash />}
            title="Controller unreachable."
            hint={isApiClientError(error) ? `${error.code}: ${error.message}` : String(error)}
            action={
              <Btn variant="primary" size="sm" onClick={() => void fetchNow()}>
                Retry
              </Btn>
            }
          />
        </div>
      ) : (
        <>
          {/* filter bar */}
          <Panel className="mb-[var(--sd-card-gap)]">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="flex items-center gap-1.5" role="group" aria-label="level filter">
                {LEVELS.map((lv) => (
                  <ChipToggle key={lv} level={lv} active={levels.has(lv)} onToggle={() => toggleLevel(setLevels, lv)} />
                ))}
              </div>
              <div className="h-5 w-px bg-stroke" aria-hidden />
              <Input
                value={kind}
                onChange={(e) => setKind(e.currentTarget.value)}
                placeholder="kind contains… e.g. conn, op.done"
                aria-label="kind filter"
                className="w-64"
              />
              <Select value={clusterSel} onChange={(e) => setClusterSel(e.currentTarget.value)} aria-label="cluster filter" className="w-64">
                <option value="all">all clusters</option>
                {clusters.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Toggle checked={unackedOnly} onChange={setUnackedOnly} label={<span className="text-2xs">unacked only</span>} title="GET /api/events?unacked_only=true" />
              {(levels.size !== 3 || clusterSel !== 'all' || kind.trim() !== '' || unackedOnly) && (
                <Btn
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLevels(new Set(LEVELS));
                    setClusterSel('all');
                    setKind('');
                    setUnackedOnly(false);
                  }}
                  title="clear filters"
                >
                  Clear
                </Btn>
              )}
              <div className="flex-1" />
              <span className="sd-num font-mono text-2xs text-low">
                showing {visible.length} / {records.size}
              </span>
            </div>
          </Panel>

          <EventList events={visible} names={names} onAck={ackOne} />
          <OpsTable />
        </>
      )}
    </div>
  );
}

function toggleLevel(
  setLevels: Dispatch<SetStateAction<ReadonlySet<EventLevel>>>,
  lv: EventLevel,
): void {
  setLevels((prev) => {
    const next = new Set(prev);
    if (next.has(lv)) next.delete(lv);
    else next.add(lv);
    return next;
  });
}

function ChipToggle({ level, active, onToggle }: { level: EventLevel; active: boolean; onToggle: () => void }) {
  const variant: 'neutral' | 'ok' | 'warn' | 'crit' | 'accent' = active
    ? level === 'error'
      ? 'crit'
      : level === 'warn'
        ? 'warn'
        : 'accent'
    : 'neutral';
  const Icon = level === 'error' ? OctagonAlert : level === 'warn' ? TriangleAlert : Info;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      onClick={onToggle}
      className="cursor-pointer outline-none"
      title={`filter level: ${level}`}
    >
      <Chip
        variant={variant}
        className={cn(
          'cursor-pointer font-mono transition-colors duration-fast',
          !active && 'text-low opacity-70 hover:opacity-100',
        )}
      >
        <Icon size={11} />
        {level}
      </Chip>
    </button>
  );
}

/* ---------------------------------------------------------------------------
   merge helpers
   --------------------------------------------------------------------------- */

function mergeEvents(prev: Map<string, EventRec>, rows: EventRec[]): Map<string, EventRec> {
  if (rows.length === 0) return prev;
  let changed = false;
  const next = new Map(prev);
  for (const r of rows) {
    if (r === null || typeof r !== 'object' || typeof r.id !== 'string') continue;
    const cur = next.get(r.id);
    if (cur === undefined || cur.ts !== r.ts || cur.acked !== r.acked || cur.message !== r.message) {
      next.set(r.id, r);
      changed = true;
    }
  }
  if (!changed) return prev;
  if (next.size <= RECORDS_CAP) return next;
  // cap: keep the newest N by ts
  const kept = [...next.values()].sort((a, b) => b.ts - a.ts).slice(0, RECORDS_CAP);
  return new Map(kept.map((e) => [e.id, e] as const));
}

/* ---------------------------------------------------------------------------
   Event rows
   --------------------------------------------------------------------------- */

function EventList({
  events,
  names,
  onAck,
}: {
  events: EventRec[];
  names: { clusterNames: Map<string, string>; nodeNames: Map<string, string> };
  onAck: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  if (events.length === 0) {
    return (
      <div className="sd-panel flex min-h-[320px] flex-1 items-center justify-center">
        <Empty
          title="No events match the filters."
          hint="Loosen the level/kind filters, or check whether the controller has anything recorded."
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      {events.map((e) => {
        const open = expanded.has(e.id);
        const hasData = e.data !== null && e.data !== undefined && Object.keys(e.data ?? {}).length > 0;
        return (
          <div
            key={e.id}
            className={cn('rounded-inner border border-stroke transition-colors duration-fast hover:border-stroke-strong', open && 'border-stroke-strong bg-bg2/40')}
          >
            <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
              <button
                type="button"
                onClick={() =>
                  setExpanded((prev) => {
                    const next = new Set(prev);
                    if (next.has(e.id)) next.delete(e.id);
                    else next.add(e.id);
                    return next;
                  })
                }
                aria-expanded={open}
                disabled={!hasData}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left disabled:cursor-default"
                title={e.message}
              >
                <EventIcon level={e.level} />
                <span
                  className="sd-num w-[118px] shrink-0 font-mono text-2xs text-mid"
                  title={fmtIso(e.ts)}
                >
                  {fmtDateTime(e.ts)}
                </span>
                <Chip variant="neutral" className="w-30 shrink-0 justify-center font-mono">
                  {e.kind}
                </Chip>
                <span className="w-44 shrink-0 truncate font-mono text-2xs text-low" title="cluster · node">
                  {nameOf(e.cluster_id, names.clusterNames) || '—'}
                  <span className="text-low/70"> · </span>
                  {nameOf(e.node_id, names.nodeNames) || '—'}
                </span>
                <span className="sd-num min-w-0 flex-1 truncate text-xs text-hi">{e.message}</span>
              </button>
              {!e.acked ? (
                <Btn size="sm" variant="ghost" onClick={() => onAck(e.id)} className="font-mono text-2xs" title="mark this event acknowledged">
                  <Check size={11} />
                  ack
                </Btn>
              ) : (
                <Chip variant="neutral" className="font-mono text-2xs" title="already acknowledged">
                  acked
                </Chip>
              )}
              {hasData ? (
                <ChevronDown
                  size={13}
                  className={cn('shrink-0 text-low transition-transform duration-fast', open && 'rotate-180')}
                />
              ) : (
                <ChevronRight size={13} className="shrink-0 text-low opacity-30" />
              )}
            </div>

            {open && hasData && (
              <div className="px-2.5 pb-2.5">
                <pre className="sd-raised max-h-56 overflow-auto p-2.5 font-mono text-2xs leading-relaxed text-mid">
                  {JSON.stringify(e.data, null, 2)}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function EventIcon({ level }: { level: EventLevel }) {
  if (level === 'error') {
    return <OctagonAlert size={14} className="shrink-0" style={{ color: 'var(--sd-crit)' }} aria-label="error event" />;
  }
  if (level === 'warn') {
    return <TriangleAlert size={14} className="shrink-0" style={{ color: 'var(--sd-warn)' }} aria-label="warning event" />;
  }
  return <Info size={14} className="shrink-0" style={{ color: 'var(--sd-accent)' }} aria-label="info event" />;
}

function nameOf(id: string | null | undefined, m: Map<string, string>): string {
  if (id === null || id === undefined || id === '') return '';
  return m.get(id) ?? id;
}

/* ---------------------------------------------------------------------------
   Recent ops (GET /api/ops) — compact audit linking into /control
   --------------------------------------------------------------------------- */

function OpsTable() {
  const [ops, setOps] = useState<OpRecord[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let dead = false;
    void api
      .ops({ limit: 25 })
      .then((list) => {
        if (!dead) {
          setOps(list);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!dead) setError(e);
      });
    return () => {
      dead = true;
    };
  }, [tick]);

  const clusterNames = useClusters();
  const cNames = useMemo(() => new Map((clusterNames.data ?? []).map((c) => [c.id, c.name] as const)), [clusterNames.data]);

  return (
    <Panel
      className="mt-[var(--sd-card-gap)]"
      title="Recent ops"
      sub="GET /api/ops — newest 25 · live updates stream on the WS ops topic"
      actions={
        <>
          {error !== null ? (
            <span className="font-mono text-2xs text-warn" title={isApiClientError(error) ? error.message : String(error)}>
              ops: {isApiClientError(error) ? error.code : 'error'}
            </span>
          ) : null}
          <Btn size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)} title="re-read the op audit">
            <RefreshCw size={12} />
            Refresh
          </Btn>
          <Link to="/control" className="inline-flex">
            <Btn size="sm" variant="ghost">
              Open control
              <ChevronRight size={12} />
            </Btn>
          </Link>
        </>
      }
    >
      {ops === null ? (
        error !== null ? (
          <div className="px-4 pb-4 text-xs text-low">Ops unavailable — controller unreachable.</div>
        ) : (
          <div className="px-4 pb-4">
            <Spinner />
          </div>
        )
      ) : ops.length === 0 ? (
        <div className="px-4 pb-4 text-xs text-low">No operations recorded yet.</div>
      ) : (
        <div className="flex flex-col gap-0.5 px-2 pb-3">
          <div className="hidden grid-cols-[70px_1fr_180px_120px_90px_minmax(0,1fr)_34px] items-center gap-2 px-1 pb-1 font-mono text-2xs text-low sm:grid">
            <span>state</span>
            <span>kind</span>
            <span>cluster</span>
            <span>created</span>
            <span>dur</span>
            <span>message</span>
            <span className="text-right">ctl</span>
          </div>
          {ops.map((op) => (
            <div
              key={op.id}
              className="grid grid-cols-[70px_1fr_180px_120px_90px_minmax(0,1fr)_34px] items-center gap-2 rounded-inner border border-transparent px-1 py-1 font-mono text-2xs transition-colors duration-fast hover:border-stroke hover:bg-bg2/40"
            >
              <span>
                <Chip variant={opStateVariant(op.state)} className="justify-center">
                  {op.state}
                </Chip>
              </span>
              <span className="min-w-0 truncate text-hi" title={`op ${op.id}`}>
                {op.kind}
              </span>
              <span className="min-w-0 truncate text-low" title={op.cluster_id ?? undefined}>
                {op.cluster_id !== null && op.cluster_id !== undefined ? (cNames.get(op.cluster_id) ?? op.cluster_id) : '—'}
              </span>
              <span className="sd-num truncate text-low" title={op.created > 0 ? fmtIso(op.created) : undefined}>
                {op.created > 0 ? fmtAgo(op.created) : '—'}
              </span>
              <span className="sd-num truncate text-low" title="duration">
                {opDuration(op)}
              </span>
              <span className="min-w-0 truncate text-low" title={op.message ?? undefined}>
                {op.message ?? ''}
              </span>
              <span className="flex justify-end">
                <Link to="/control" title="open /control" className="inline-flex p-0.5 text-low transition-colors hover:text-accent">
                  <ExternalLink size={12} />
                </Link>
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function opDuration(op: OpRecord): string {
  const end = op.finished ?? null;
  const start = op.started ?? null;
  if (end === null || start === null) return '—';
  const s = Math.max(0, (end - start) / 1000);
  return s < 60 ? `${Math.round(s)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

/** op state → chip variant (same mapping as the control page timeline). */
function opStateVariant(state: OpRecord['state']): 'neutral' | 'ok' | 'warn' | 'crit' | 'accent' {
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
