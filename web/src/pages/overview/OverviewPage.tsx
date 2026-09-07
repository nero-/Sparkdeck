/* ============================================================================
   Overview — clusters at a glance (charts/monitoring wave).

   Live sources: REST topology + settings, WS buffers (node conn state, last
   samples, service states, ops, events). Sparklines ride client rings fed by
   the `samples` topic (src/stores/nodeRings.ts); the fleet strip is a
   client-side aggregate of the same frames. Everything degrades gracefully
   when the controller is unreachable.
   ========================================================================= */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Play,
  Power,
  ServerCrash,
  Thermometer,
  Wrench,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { PageHeader } from '../../shell/PageShell';
import {
  Bar,
  Btn,
  Chip,
  ConfirmDialog,
  Empty,
  Gauge,
  Panel,
  SectionHeader,
  Sparkline,
  Spinner,
  StatusDot,
  connDot,
  healthDot,
  toast,
  Tip,
} from '../../ds';
import { api, isApiClientError, useLive } from '../../api/client';
import { useClusters, useSystemInfo } from '../../api/queries';
import { useSettings } from '../../api/monitoring';
import {
  useActiveOps,
  useOpsBusy,
  useRecentOps,
  useOps,
} from '../../stores/ops';
import {
  useEventsRing,
  useLiveNodes,
  useLive,
  useServiceByCluster,
} from '../../stores/live';
import { useNodeRings } from '../../stores/nodeRings';
import {
  Skel,
  connDotState,
  fmtCtx,
  kvMultiplier,
  parseNum,
  pickSample,
} from '../../components/monShared';
import { fmtClock, fmtDuration, fmtGiB, fmtNum } from '../../lib/format';
import type {
  ClusterTopology,
  EventRec,
  ID,
  LiveNodeState,
  ProfileDef,
  SampleFrame,
  ServiceState,
} from '../../api/types';

const SPARK_RATE_CAP = 60; // ring points per mini-card series (stores/nodeRings)

function cardAccent(cluster: ClusterTopology): string {
  const c = cluster.accent_color;
  return c !== undefined && c !== null && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(c)
    ? c
    : '#5EB1FF';
}

/* =============================================================================
   Page
   ========================================================================== */

export default function OverviewPage() {
  const clustersQ = useClusters();
  const infoQ = useSystemInfo();
  const settingsQ = useSettings();
  const nodeStates = useLiveNodes();
  const services = useServiceByCluster();
  const wsStatus = useLive((s) => s.status);
  const opsBusy = useOpsBusy();
  const opsMap = useOps((s) => s.opsById);

  const nodeStateById = useMemo(() => {
    const m = new Map<ID, LiveNodeState>();
    for (const n of nodeStates) m.set(n.node_id, n);
    return m;
  }, [nodeStates]);

  const clusters = clustersQ.data ?? [];

  const context =
    infoQ.data !== null
      ? `${infoQ.data.name} v${infoQ.data.version} · uptime ${fmtDuration(infoQ.data.uptime_s)}` +
        (infoQ.data.mock ? ' · mock data' : ' live')
      : clustersQ.loading
        ? 'connecting to controller…'
        : 'controller info unavailable';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Overview"
        context={context}
        actions={
          <>
            <Chip variant="neutral" title={`WebSocket: ${wsStatus}`}>
              <StatusDot state={wsDot(wsStatus)} />
              ws: {wsStatus}
            </Chip>
            <Btn size="sm" variant="ghost" onClick={clustersQ.reload} loading={clustersQ.loading && clusters.length === 0}>
              Refresh
            </Btn>
          </>
        }
      />

      {clustersQ.error !== null && clusters.length === 0 ? (
        <FailedPanel error={clustersQ.error} onRetry={clustersQ.reload} />
      ) : clusters.length === 0 && (clustersQ.loading || clustersQ.error !== null === false) ? (
        <ClusterSkeletonGrid />
      ) : clusters.length === 0 ? (
        <div className="sd-panel flex min-h-[360px] flex-1 items-center justify-center">
          <Empty
            icon={<ServerCrash />}
            title="No clusters configured yet."
            hint="Add a cluster in Settings to see node health, service state and live charts here."
            action={
              <Link to="/settings">
                <Btn variant="primary" size="sm">Add cluster</Btn>
              </Link>
            }
          />
        </div>
      ) : (
        <>
          <div className="sd-card-gap grid min-w-0 grid-cols-1 xl:grid-cols-2">
            {clusters.map((c) => (
              <ClusterCard
                key={c.id}
                cluster={c}
                nodeStateById={nodeStateById}
                service={services[c.id]}
                alerts={settingsQ.data?.alerts ?? null}
                busy={opsBusy}
                opsMapHas={(opId: string) => opsMap.has(opId)}
              />
            ))}
          </div>
          <FleetStrip nodeStates={nodeStates} clusters={clusters} wsStatus={wsStatus} />
        </>
      )}

      {/* bottom: events mini-feed + running ops strip */}
      <div className="sd-card-gap mt-6 grid min-w-0 grid-cols-1 lg:grid-cols-3">
        <Panel className="lg:col-span-2" title="Recent events" sub="live + persisted feed"
          actions={<Link to="/events" className="inline-flex items-center gap-1 font-mono text-2xs text-accent hover:underline">open events <ArrowRight size={11} /></Link>}
        >
          <EventsMiniFeed events={useEventsRing()} />
        </Panel>
        <Panel
          className="min-w-0"
          title="Operations"
          sub="queued / running first"
          actions={<Link to="/control" className="inline-flex items-center gap-1 font-mono text-2xs text-accent hover:underline">open control <ArrowRight size={11} /></Link>}
        >
          <OpsStrip />
        </Panel>
      </div>
    </div>
  );
}

function wsDot(status: string) {
  switch (status) {
    case 'online':
      return 'ok' as const;
    case 'connecting':
    case 'reconnecting':
      return 'degraded' as const;
    case 'offline':
      return 'offline' as const;
    default:
      return 'unknown' as const;
  }
}

/* =============================================================================
   Load-, error-, empty-states
   ========================================================================== */

function ClusterSkeletonGrid(): ReactNode {
  return (
    <div className="sd-card-gap grid min-w-0 grid-cols-1 xl:grid-cols-2">
      {[0, 1].map((i) => (
        <div key={i} className="sd-panel flex flex-col gap-3 p-4" aria-hidden>
          <div className="flex items-center justify-between gap-2">
            <Skel className="h-4 w-36" />
            <Skel className="h-5 w-16" />
          </div>
          <Skel className="h-3 w-56" />
          <div className="flex gap-2">
            <Skel className="h-6 w-28" />
            <Skel className="h-6 w-28" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Skel className="h-28" />
            <Skel className="h-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

function FailedPanel({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const message = isApiClientError(error) ? `${error.code}: ${error.message}` : String(error);
  return (
    <div className="sd-panel flex flex-1 items-center justify-center">
      <Empty
        icon={<ServerCrash />}
        title="Controller unreachable."
        hint={message}
        action={
          <Btn variant="primary" size="sm" onClick={onRetry}>
            Retry
          </Btn>
        }
      />
    </div>
  );
}

/* =============================================================================
   Cluster card
   ========================================================================== */

function ClusterCard({
  cluster,
  nodeStateById,
  service,
  alerts,
  busy,
}: {
  cluster: ClusterTopology;
  nodeStateById: Map<ID, LiveNodeState>;
  service: ServiceState | undefined;
  alerts: { mem_warn_gib: number; mem_crit_gib: number; gpu_temp_warn_c: number; gpu_temp_crit_c: number } | null;
  busy: boolean;
  voidOps: boolean;
  opsMapHas: (opId: string) => boolean;
}) {
  const accent = cardAccent(cluster);
  const online = cluster.nodes.filter((n) => nodeStateById.get(n.id)?.state === 'online').length;

  const served = service !== undefined && (service.health === 'up' || service.age_s !== null);
  const profile = cluster.profiles.find((p) => p.key === service?.profile_key) ?? null;

  /* quick actions */
  const [startOpen, setStartOpen] = useState<ProfileDef | null>(null);
  const [stopOpen, setStopOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const opInFlight = useClusterOpInFlight(cluster.id);

  const startProfile = async (p: ProfileDef) => {
    setSubmitting(true);
    try {
      const r = await api.post<{ op_id: string }>(`/api/clusters/${cluster.id}/actions/start`, {
        profile_key: p.key,
      });
      toast.ok(`Start queued (${p.key})`, `op ${r.op_id}`);
      setStartOpen(null);
    } catch (e) {
      toast.error('Start failed', apiErrorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  const stopCluster = async () => {
    setSubmitting(true);
    try {
      const r = await api.post<{ op_id: string }>(`/api/clusters/${cluster.id}/actions/stop`, {});
      toast.ok('Stop queued', `op ${r.op_id}`);
      setStopOpen(false);
    } catch (e) {
      toast.error('Stop failed', apiErrorText(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="sd-panel flex min-w-0 flex-col p-4">
      {/* accent header */}
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <div className="flex min-w-0 items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accent }} aria-hidden />
            <Link
              to={`/nodes?cluster=${encodeURIComponent(cluster.id)}`}
              title={`Filter the node grid to ${cluster.name}`}
              className="truncate text-[15px] font-semibold hover:underline"
              style={{ color: accent }}
            >
              {cluster.name}
            </Link>
            <Chip variant="neutral" className="font-mono">{cluster.kind}</Chip>
          </div>
          <div className="mt-0.5 font-mono text-2xs text-low">
            {online}/{cluster.nodes.length} online · {cluster.profiles.length} profile{cluster.profiles.length === 1 ? '' : 's'}
            {cluster.notes !== undefined && cluster.notes !== null ? ` · ${cluster.notes}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {service !== undefined && (
            <Chip
              variant={
                service.health === 'up' ? 'ok' : service.health === 'degraded' ? 'warn' : service.health === 'down' ? 'crit' : 'neutral'
              }
              title={service.model !== null ? `health ${service.health} · ${service.model}` : `health ${service.health}`}
            >
              <StatusDot state={healthDot(service.health)} size={7} />
              {service.health}
            </Chip>
          )}
          {service === undefined && <Chip variant="neutral" title="No service state received yet (ws or REST)">service unknown</Chip>}
        </div>
      </div>

      {/* profile + image + uptime when the service is actually up */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {served && service !== undefined ? (
          <>
            {service.profile_key !== null && (
              <Chip color={accent} title={`Active serving profile (${service.profile_key})`}>
                {service.profile_key}
              </Chip>
            )}
            {service.image !== null && (
              <Tip text={`${service.image} — served image tag`}>
                <Chip variant="neutral" className="font-mono">
                  <span className="max-w-[280px] truncate">{shortTag(service.image)}</span>
                </Chip>
              </Tip>
            )}
            {service.age_s !== null && (
              <Chip variant="neutral" title="Uptime since the service reported healthy">
                up {fmtDuration(service.age_s)}
              </Chip>
            )}
            {service.host !== null && (
              <Chip variant="neutral" className="font-mono" title={`${service.host}:${service.port ?? '—'} — serving endpoint`}>
                {service.host}:{service.port ?? '?'}
              </Chip>
            )}
          </>
        ) : (
          <span className="font-mono text-2xs text-low">idle — not serving</span>
        )}
      </div>

      {/* KV pool tokens + context */}
      {service !== undefined && service.kv_tokens !== null && (
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="sd-monolabel">kv pool</span>
          <span className="sd-num font-mono text-sm text-hi" title={`kv_tokens — cluster KV cache capacity in tokens${profile?.context !== undefined && profile?.context !== null ? ` (context ${fmtCtx(profile.context)})` : ''}`}>
            {fmtNum(service.kv_tokens)}
            <span className="text-low"> tokens</span>
          </span>
          {profile !== null && profile.context !== undefined && profile.context !== null && kvMultiplier(service.kv_tokens, profile.context) !== null && (
            <span className="font-mono text-2xs text-mid">
              ≈ {fmtNum(Math.round((kvMultiplier(service.kv_tokens, profile.context) ?? 0) * 10) / 10)}× {fmtCtx(profile.context)}
            </span>
          )}
        </div>
      )}

      {/* quick actions */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stroke pt-3">
        <StartMenu
          cluster={cluster}
          disabled={busy || opInFlight || submitting}
          onPick={(p) => setStartOpen(p)}
        />
        <Btn
          size="sm"
          variant="ghost"
          icon={<Power size={12} />}
          disabled={busy || opInFlight || submitting}
          onClick={() => setStopOpen(true)}
        >
          Stop
        </Btn>
        <Link
          to="/control"
          className="ml-auto inline-flex items-center gap-1.5 rounded-inner border border-stroke px-2 py-1 font-mono text-2xs text-mid transition-colors duration-fast hover:border-stroke-strong hover:text-hi"
          title="Open the cluster console (start/stop, preflight, op log)"
        >
          open cluster console <ExternalLink size={11} />
        </Link>
      </div>

      {/* per-node mini-cards */}
      <div className="mv-3 mt-3 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {cluster.nodes.map((n) => (
          <NodeMiniCard
            key={n.id}
            node={n}
            accent={accent}
            state={nodeStateById.get(n.id)}
            alerts={alerts}
          />
        ))}
        {cluster.nodes.length === 0 && (
          <div className="col-span-full py-4 text-center text-xs text-low">No nodes on this cluster yet.</div>
        )}
      </div>

      {/* dialogs */}
      <ConfirmDialog
        open={startOpen !== null}
        onClose={() => setStartOpen(null)}
        onConfirm={() => {
          if (startOpen !== null) void startProfile(startOpen);
        }}
        title={startOpen !== null ? `Start — ${cluster.name}` : ''}
        busy={submitting}
        danger={false}
        confirmLabel="Start serving"
        summary={
          <>
            Launch <b>{startOpen?.label ?? 'profile'}</b>{' '}
            <span className="font-mono text-2xs text-mid">({startOpen?.key})</span> on the serving pair — head{' '}
            <span className="font-mono">{headName(cluster)}</span> first, then the worker. The engine takes
            cluster control: preflight, GID check, teardown, then pair start.
          </>
        }
        commands={startCommands(cluster, startOpen)}
      />
      <ConfirmDialog
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        onConfirm={() => void stopCluster()}
        title={`Stop — ${cluster.name}`}
        busy={submitting}
        danger
        confirmLabel="Stop pair"
        confirmWord="stop"
        summary={
          <>
            This stops the serving pair: <b>both ranks go down</b> (head{' '}
            <span className="font-mono">{headName(cluster)}</span> and worker{' '}
            <span className="font-mono">{workerName(cluster)}</span>). In-flight inference is interrupted.
          </>
        }
        commands={stopCommands(cluster)}
      />
    </section>
  );
}

function apiErrorText(e: unknown): string {
  return isApiClientError(e) ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

function headName(c: ClusterTopology): string {
  return c.nodes.find((n) => n.role === 'head')?.name ?? c.control.head_node_id;
}
function workerName(c: ClusterTopology): string {
  return c.nodes.find((n) => n.role === 'worker')?.name ?? c.control.worker_node_id;
}

function shortTag(image: string): string {
  const at = image.lastIndexOf(':');
  const name = at > -1 ? image.slice(at + 1) : image;
  return name.length > 34 ? `${name.slice(0, 33)}…` : name;
}

function startCommands(cluster: ClusterTopology, p: ProfileDef | null): string[] {
  if (p === null) return [];
  const { serve_dir, launcher, start_extra } = cluster.control;
  const lines: string[] = [];
  for (const n of cluster.nodes) {
    lines.push(
      `# ${n.name} (rank ${n.env_rank})`,
      `cd ${serve_dir} && bash ${launcher} --run rank-${n.env_rank}-${p.key}.env${start_extra !== '' ? ` ${start_extra}` : ''}`,
    );
  }
  return lines;
}

function stopCommands(cluster: ClusterTopology): string[] {
  return [`bash ${cluster.control.launcher} --down   # head then worker — both ranks stop`];
}

/* -----------------------------------------------------------------------------
   Start ▾ menu (profiles)
   --------------------------------------------------------------------------- */

function StartMenu({ cluster, disabled, onPick }: { cluster: ClusterTopology; disabled: boolean; onPick: (p: ProfileDef) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current !== null && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <Btn
        size="sm"
        variant="primary"
        icon={<Play size={12} />}
        disabled={disabled || cluster.profiles.length === 0}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Start
        <ChevronDown size={12} className={cn('transition-transform duration-fast', open && 'rotate-180')} />
      </Btn>
      {open && (
        <div
          role="menu"
          className="sd-panel absolute top-full left-0 z-40 mt-1.5 w-[320px] overflow-hidden p-1"
          style={{ background: 'var(--sd-bg2)' }}
        >
          {cluster.profiles.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-low">No profiles configured for this cluster.</div>
          )}
          {cluster.profiles.map((p) => (
            <button
              key={p.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(p);
              }}
              className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-inner px-2 py-1.5 text-left transition-colors duration-fast hover:bg-bg1 hover:text-hi"
            >
              <span className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="truncate text-xs font-medium text-hi">{p.label}</span>
                <span className="sd-num shrink-0 font-mono text-2xs text-low">
                  {p.quant ?? '—'} · {p.speculator ?? 'no spec'}
                </span>
              </span>
              <span className="truncate font-mono text-2xs text-low" title={p.served_model_name}>
                {p.key} · {p.served_model_name}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** true while a start/stop op is actively (queued|running) on this cluster */
function useClusterOpInFlight(clusterId: ID): boolean {
  const busy = useOps((s) => {
    for (const op of s.opsById.values()) {
      if (
        op.cluster_id === clusterId &&
        (op.kind === 'cluster.start' || op.kind === 'cluster.stop') &&
        (op.state === 'running' || op.state === 'queued')
      ) {
        return true;
      }
    }
    return false;
  });
  return busy;
}

/* =============================================================================
   Per-node mini-card
   ========================================================================== */

function NodeMiniCard({
  node,
  accent,
  state,
  alerts,
}: {
  node: ClusterTopology['nodes'][number];
  accent: string;
  state: LiveNodeState | undefined;
  alerts: ClusterCardProps['alerts'];
}) {
  const isHead = node.role === 'head';
  const netRxId = useMemo(() => {
    const interest = node.interest_ifaces[0];
    return interest !== undefined && interest !== '' ? `net.${interest}.rx_kbps` : null;
  }, [node.interest_ifaces]);

  const rings = useNodeRings(node.id, netRxId === null ? [] : [netRxId]);
  const rxRing = rings[0];

  return (
    <Link
      to={`/nodes/${encodeURIComponent(node.id)}`}
      title={`Open node dashboard — ${node.name}`}
      className="sd-raised group flex min-w-0 cursor-pointer flex-col gap-2.5 p-3 transition-colors duration-fast hover:border-stroke-strong"
    >
      {/* header row: dot + name + role */}
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot state={connDot(state?.state ?? 'unknown')} size={8} title={`conn ${state?.state ?? 'unknown'}`} />
        <span className="truncate text-xs font-semibold text-hi group-hover:underline">{node.name}</span>
        <Chip variant={isHead ? 'accent' : 'neutral'} color={isHead ? accent : undefined} className="font-mono" title={`role ${node.role} · env_rank ${node.env_rank}`}>
          {node.role === 'head' ? 'head' : `w${node.env_rank}`}
        </Chip>
        <span className="ml-auto min-w-0 truncate font-mono text-2xs text-low" title={`addr_used ${state?.addr_used ?? 'n/a'}`}>
          {state?.addr_used ?? '—'}
        </span>
      </div>

      {/* gauges row */}
      <div className="flex items-center gap-3">
        <GpuGaugeMini nodeId={node.id} accent={accent} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <MemBarMini nodeId={node.id} alerts={alerts} />
          <div className="flex items-center gap-2">
            <TempChip nodeId={node.id} alerts={alerts} />
            {netRxId !== null && (
              <Tip text={`${netRxId} — last ${SPARK_RATE_CAP} live samples`}>
                <Sparkline
                  values={rxRing?.v ?? []}
                  color={accent}
                  width={92}
                  height={22}
                  title={`net rx kbit/s — last ${SPARK_RATE_CAP} live samples`}
                />
              </Tip>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}

function GpuGaugeMini({ nodeId, accent }: { nodeId: ID; accent: string }) {
  const sample = useLive((s) => s.lastSampleByNode[nodeId]);
  const util = sample?.series === undefined ? null : parseNum(sample.series['gpu.util']);
  return <Gauge value={util} size={56} unit="%" title={`gpu.util — ${util === null ? 'no sample' : `${util.toFixed(1)}%`}`} style={{ color: accent }} className="shrink-0" />;
}

function MemBarMini({
  nodeId,
  alerts,
}: {
  nodeId: ID;
  alerts: { mem_warn_gib: number; mem_crit_gib: number; gpu_temp_warn_c: number; gpu_temp_crit_c: number } | null;
}) {
  const sample = useLive((s) => s.lastSampleByNode[nodeId]);
  const used = sample?.series === undefined ? null : parseNum(sample.series['mem.used_gib']);
  const warn = alerts?.mem_warn_gib ?? 118.5;
  const crit = alerts?.mem_crit_gib ?? 120.5;
  const max = Math.max(crit, used === null ? crit : Math.max(crit, used + 2));
  const frac = used === null ? null : Math.max(0, Math.min(1, used / max));
  const tone = used === null ? undefined : used >= crit ? 'crit' : used >= warn ? 'warn' : 'ok';
  const valueColor = tone === 'crit' ? 'var(--sd-crit)' : tone === 'warn' ? 'var(--sd-warn)' : 'var(--sd-mid)';
  return (
    <div className="min-w-0" title={`mem.used_gib — ${used === null ? 'no sample' : fmtGiB(used)}`}>
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="sd-monolabel">mem</span>
        <span className="sd-num font-mono text-2xs" style={{ color: valueColor }}>
          {fmtGiB(used)}
        </span>
      </div>
      <Bar value={used} max={max} horizon={warn / max} thresholds={[{ at: crit, color: TONE_HEX.crit }, { at: warn, color: TONE_HEX.warn }]} title={`mem used / ${max} GiB envelope · horizon ${fmtGiB(warn)}`} height={5} />
    </div>
  );
}

function TempChip({ nodeId, alerts }: { nodeId: ID; alerts: { mem_warn_gib: number; mem_crit_gib: number; gpu_temp_warn_c: number; gpu_temp_crit_c: number } | null }) {
  const sample = useLive((s) => s.lastSampleByNode[nodeId]);
  const temp = sample?.series === undefined ? null : pickSample(sample.series, 'gpu.temp');
  const warn = alerts?.gpu_temp_warn_c ?? 85;
  const crit = alerts?.gpu_temp_crit_c ?? 95;
  const variant = temp === null ? 'neutral' : temp >= crit ? 'crit' : temp >= warn ? 'warn' : 'neutral';
  return (
    <Chip variant={variant} title={`gpu.temp — ${temp === null ? 'no sample' : `${temp.toFixed(1)}°C (warn ${warn}°, crit ${crit}°)`}`}>
      <Thermometer size={11} aria-hidden />
      <span className="sd-num font-mono">{temp === null ? '—' : `${fmtNum(Math.round(temp * 10) / 10)}°`}</span>
    </Chip>
  );
}

/* =============================================================================
   Fleet footer strip — client-side aggregate over the live sample frames
   ========================================================================== */

interface FleetPoint {
  t: number;
  gpu: number | null;
  mem: number | null;
}
const FLEET_CAP = 60;

function FleetStrip({
  nodeStates,
  clusters,
  wsStatus,
}: {
  nodeStates: LiveNodeState[];
  clusters: ClusterTopology[];
  wsStatus: string;
}) {
  const samples = useLive((s) => s.lastSampleByNode);
  const [fleet, setFleet] = useState<{ t: number[]; gpu: Array<number | null>; mem: Array<number | null> }>({
    t: [],
    gpu: [],
    mem: [],
  });
  const lastTs = useRef(0);

  useEffect(() => {
    const nodes = Object.values(samples);
    if (nodes.length === 0) return;
    const ts = Math.max(...nodes.map((n) => n.ts));
    if (!Number.isFinite(ts) || ts <= lastTs.current) return;
    lastTs.current = ts;

    let gpuSum = 0;
    let gpuN = 0;
    let memSum = 0;
    let memN = 0;
    for (const f of nodes) {
      const s = f.series ?? {};
      const g = s['gpu.util'];
      const mem = s['mem.used_gib'];
      if (typeof g === 'number' && Number.isFinite(g)) {
        gpuSum += g;
        gpuN++;
      }
      if (typeof mem === 'number' && Number.isFinite(mem)) {
        memSum += mem;
        memN++;
      }
    }
    setFleet((p) => ({
      t: [...p.t, ts].slice(-FLEET_CAP),
      gpu: [...p.gpu, gpuN > 0 ? gpuSum / gpuN : null].slice(-FLEET_CAP),
      mem: [...p.mem, memN > 0 ? memSum / memN : null].slice(-FLEET_CAP),
    }));
  }, [samples]);

  const lastGpu = lastValue(fleet.gpu);
  const lastMem = lastValue(fleet.mem);
  const nodeCount = nodeStates.length;

  return (
    <Panel className="mt-6 shrink-0 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2" title="Average gpu.util across every node currently reporting">
          <span className="sd-monolabel">fleet gpu.util</span>
          <span className="sd-num font-mono text-lg font-semibold text-hi">{lastGpu === null ? '—' : `${fmtNum(Math.round(lastGpu * 10) / 10)}%`}</span>
          <Sparkline values={fleet.gpu} width={140} height={26} title="fleet gpu.util — avg across clusters" />
        </div>
        <div className="flex items-center gap-2" title="Average mem.used_gib across every node currently reporting">
          <span className="sd-monolabel">fleet mem</span>
          <span className="sd-num font-mono text-lg font-semibold text-hi">{fmtGiB(lastMem)}</span>
          <Sparkline values={fleet.mem} width={140} height={26} title="fleet mem used — avg across clusters" />
        </div>
        <span className="ml-auto font-mono text-2xs text-low" title="Data source note">
          {wsStatus === 'online' ? 'live' : 'stale'} ws sample frames · avg across {nodeCount || clusters.reduce((n, c) => n + c.nodes.length, 0)} node{(nodeCount || clusters.length) === 1 ? '' : 's'} · x-axis live tail (60 pts)
        </span>
      </div>
    </Panel>
  );
}

function lastValue(arr: Array<number | null>): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (typeof v === 'number') return v;
  }
  return null;
}

/* =============================================================================
   Recent events mini-feed (last 6) + ops strip
   ========================================================================== */

function EventsMiniFeed({ events }: { events: EventRec[] }) {
  const last6 = events.slice(0, 6);
  if (last6.length === 0) {
    return <Empty title="No events yet." hint="Alerts, op completions and connection changes land here as they happen." className="py-6" />;
  }
  return (
    <ul className="flex flex-col pb-2">
      {last6.map((ev) => (
        <EventRow key={ev.id} ev={ev} />
      ))}
    </ul>
  );
}

function EventRow({ ev }: { ev: EventRec }): ReactNode {
  const toneText = ev.level === 'error' ? 'text-crit' : ev.level === 'warn' ? 'text-warn' : 'text-mid';
  return (
    <li className="flex min-w-0 items-center gap-2 border-b border-stroke px-4 py-1.5 last:border-b-0">
      <StatusDot
        state={ev.level === 'error' ? 'crit' : ev.level === 'warn' ? 'warn' : 'ok'}
        title={ev.level}
        className="shrink-0"
      />
      <span className="sd-num shrink-0 font-mono text-2xs text-low" title={ev.kind}>
        {fmtClock(ev.ts)}
      </span>
      <span className={cn('shrink-0 font-mono text-2xs', toneText)} title={ev.kind}>
        {ev.kind}
      </span>
      <span className="min-w-0 flex-1 truncate text-xs text-mid" title={`${ev.message}${ev.data !== undefined && ev.data !== null ? ` · ${JSON.stringify(ev.data)}` : ''}`}>
        {ev.message}
      </span>
      {!ev.acked && <Chip variant="neutral" className="shrink-0" title="unacknowledged">unack</Chip>}
    </li>
  );
}

function OpsStrip(): ReactNode {
  const active = useActiveOps();
  const recent = useRecentOps(8);
  const rows = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof recent = [];
    for (const op of [...active, ...recent]) {
      if (seen.has(op.id)) continue;
      seen.add(op.id);
      out.push(op);
      if (out.length >= 6) break;
    }
    return out;
  }, [active, recent]);

  if (rows.length === 0) {
    return <Empty title="Operations are idle." hint="Starts, stops, image moves and bench runs are audited here." className="py-6" />;
  }
  return (
    <ul className="flex flex-col pb-2">
      {rows.map((op) => (
        <li key={op.id} className="flex min-w-0 items-center gap-2 border-b border-stroke px-4 py-1.5 last:border-b-0" title={op.message ?? op.kind}>
          {op.state === 'running' || op.state === 'queued' ? (
            <Spinner size={10} />
          ) : (
            <Wrench size={11} className={op.state === 'error' ? 'text-crit' : op.state === 'ok' ? 'text-ok' : 'text-low'} aria-hidden />
          )}
          <span className="sd-num shrink-0 font-mono text-2xs text-low">{fmtClock(op.created)}</span>
          <span className="truncate font-mono text-2xs text-mid">{op.kind}</span>
          <Chip
            variant={op.state === 'ok' ? 'ok' : op.state === 'error' ? 'crit' : op.state === 'running' ? 'accent' : op.state === 'cancelled' ? 'warn' : 'neutral'}
            className="ml-auto shrink-0 font-mono"
            title={`op ${op.id} — ${op.state}`}
          >
            {op.state}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
