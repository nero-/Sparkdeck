/* ============================================================================
   ControlPage — the pair lifecycle console for the active cluster.

   Live surface: REST poll of GET /api/clusters/{id}/live + the full op audit
   via GET /api/ops?cluster_id= (both merged into the shared WS-store buffer);
   service state arrives live through the WS `service` topic.
   Actions map 1:1 to the contract verbs (start / stop / preflight / check /
   verify). Every destructive step is confirmed through ConfirmDialog with
   the exact remote commands it will run (DESIGN.md "Confirmations").
   ========================================================================= */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ChevronRight,
  ClipboardCheck,
  Eye,
  HeartPulse,
  ListChecks,
  Network,
  Play,
  RefreshCw,
  ServerCrash,
  ShieldCheck,
  Square,
} from 'lucide-react';
import { PageHeader } from '../../shell/PageShell';
import {
  Btn,
  Chip,
  ConfirmDialog,
  Empty,
  Panel,
  Select,
  Tip,
  connDot,
  healthDot,
  toast,
} from '../../ds';
import { Spinner } from '../../ds/primitives';
import { Terminal } from '../../ds/terminal';
import { cn } from '../../lib/cn';
import { fmtCompact, fmtDuration } from '../../lib/format';
import { api, isApiClientError } from '../../api/client';
import { useClusters, useQuery } from '../../api/queries';
import { useLive, useLiveNodes, useServiceState } from '../../stores/live';
import { useUi } from '../../stores/ui';
import { cancelOp } from '../../api/control';
import type {
  ClusterTopology,
  ID,
  LiveNodeState,
  OpRecord,
  ProfileDef,
  ServiceState,
} from '../../api/types';
import type { ClusterLive, LiveNodePartial } from '../../api/control';
import {
  checkCluster,
  getClusterLive,
  getEnvFiles,
  pingFabric,
  preflightCluster,
  readPingParams,
  showGids,
  startCluster,
  stopCluster,
  verifyCluster,
} from '../../api/control';
import {
  GidsDialog,
  OpLogDialog,
  StartDialog,
  isOpActive,
  mergeOpsIntoStore,
  opDurationLabel,
  opStateVariant,
  useTrackedOp,
} from './dialogs';

/* ---------------------------------------------------------------------------
   helpers
   --------------------------------------------------------------------------- */

const ACTIVE_OP_STATES: ReadonlySet<OpRecord['state']> = new Set(['queued', 'running']);

function accentOf(cluster: ClusterTopology): string {
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(cluster.accent_color)
    ? cluster.accent_color
    : 'var(--sd-accent)';
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function usePollInterval(reload: () => void, ms: number, active: boolean): void {
  useEffect(() => {
    if (!active || ms <= 0) return undefined;
    const t = setInterval(reload, ms);
    return () => clearInterval(t);
  }, [reload, ms, active]);
}

/** Cluster-scoped op list from the store, newest first (shallow-stable). */
function selectClusterOps(clusterId: ID): (s: { opsById: Map<string, OpRecord> }) => OpRecord[] {
  return (s) => {
    const out: OpRecord[] = [];
    for (const op of s.opsById.values()) {
      if ((op.cluster_id ?? null) === clusterId) out.push(op);
    }
    out.sort((a, b) => b.created - a.created);
    return out;
  };
}

function activeClusterOpIds(clusterId: ID): string[] {
  const out: string[] = [];
  for (const op of useLive.getState().opsById.values()) {
    if ((op.cluster_id ?? null) === clusterId && ACTIVE_OP_STATES.has(op.state)) out.push(op.id);
  }
  return out;
}

/** Service view with every field defaulted (the live endpoint returns a bare
    `{}` while unknown; WS traffic delivers the populated shape). */
interface ServiceView {
  health: 'up' | 'down' | 'degraded' | 'unknown';
  profileKey: string | null;
  model: string | null;
  apiAddr: string | null;
  image: string | null;
  ageS: number | null;
  kvTokens: number | null;
  servedModels: string[];
  metrics: [string, number][];
  errors: string[];
}

function serviceView(svc: Partial<ServiceState> | undefined | null): ServiceView {
  if (svc === undefined || svc === null) {
    return {
      health: 'unknown',
      profileKey: null,
      model: null,
      apiAddr: null,
      image: null,
      ageS: null,
      kvTokens: null,
      servedModels: [],
      metrics: [],
      errors: [],
    };
  }
  const metrics: [string, number][] = [];
  if (svc.metrics !== undefined && svc.metrics !== null && typeof svc.metrics === 'object') {
    for (const [k, v] of Object.entries(svc.metrics)) {
      if (typeof v === 'number' && Number.isFinite(v)) metrics.push([k, v]);
    }
  }
  return {
    health:
      svc.health === 'up' ||
      svc.health === 'down' ||
      svc.health === 'degraded' ||
      svc.health === 'unknown'
        ? svc.health
        : 'down',
    profileKey: svc.profile_key ?? null,
    model: svc.model ?? null,
    apiAddr: svc.host !== null && svc.host !== undefined ? `${svc.host}:${String(svc.port ?? '')}` : null,
    image: svc.image ?? null,
    ageS: svc.age_s ?? null,
    kvTokens: svc.kv_tokens ?? null,
    servedModels: Array.isArray(svc.served_models)
      ? svc.served_models.filter((m): m is string => typeof m === 'string')
      : [],
    metrics: metrics.sort((a, b) => a[0].localeCompare(b[0])).slice(0, 10),
    errors: Array.isArray(svc.errors)
      ? svc.errors.filter((e): e is string => typeof e === 'string')
      : [],
  };
}

function headNodeOf(cluster: ClusterTopology): NodeConfigOrNothing {
  return (
    cluster.nodes.find((n) => n.id === cluster.control.head_node_id) ??
    cluster.nodes.find((n) => n.role === 'head') ??
    cluster.nodes[0] ??
    null
  );
}
type NodeConfigOrNothing = ClusterTopology['nodes'][number] | null;

function workerNodeOf(cluster: ClusterTopology): NodeConfigOrNothing {
  return (
    cluster.nodes.find((n) => n.id === cluster.control.worker_node_id) ??
    cluster.nodes.find((n) => n.role === 'worker') ??
    null
  );
}

function workerFabricAddr(cluster: ClusterTopology): string | null {
  const worker = workerNodeOf(cluster);
  const addr = worker?.addresses.find((a) => a.kind === 'fabric') ?? worker?.addresses[0];
  return addr?.host ?? null;
}

/** Swappiness per node name, mined from the ops preflight/start logs
    (`<node>: swappiness=<N>` steps — the collector has no vm.swappiness
    series). Newest op wins. */
function swappinessFromOps(ops: OpRecord[]): Map<string, { value: number; at: number }> {
  const out = new Map<string, { value: number; at: number }>();
  for (const op of ops) {
    if (op.kind !== 'cluster.preflight' && op.kind !== 'cluster.start') continue;
    const tail = op.log_tail ?? [];
    for (let i = tail.length - 1; i >= 0; i--) {
      const line = tail[i];
      if (line === undefined) continue;
      const m = /^([\w.-]+): swappiness=(\d+)\s*$/.exec(line);
      if (m !== null && m[1] !== undefined && !out.has(m[1])) {
        out.set(m[1], { value: Number(m[2] ?? '0'), at: op.created });
      }
    }
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Page + cluster selection
   --------------------------------------------------------------------------- */

export default function ControlPage() {
  const clustersQ = useClusters();
  const activeId = useUi((s) => s.activeClusterId);
  const clusters = clustersQ.data ?? [];

  const cluster = useMemo(
    () => clusters.find((c) => c.id === activeId) ?? clusters[0] ?? null,
    [clusters, activeId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Control"
        context={
          cluster !== null
            ? `${cluster.name} — pair lifecycle console · ${cluster.control.launcher}`
            : 'pair lifecycle console'
        }
        actions={
          cluster !== null ? (
            <Chip variant="neutral" className="font-mono" title={cluster.control.serve_dir}>
              {cluster.kind}
            </Chip>
          ) : undefined
        }
      />

      {cluster === null ? (
        <div className="sd-panel flex min-h-[420px] flex-1 items-center justify-center">
          <Empty
            icon={<ServerCrash />}
            title={clustersQ.error !== null ? 'Controller unreachable.' : 'No clusters configured yet.'}
            hint={
              clustersQ.error !== null
                ? isApiClientError(clustersQ.error)
                  ? `${clustersQ.error.code}: ${clustersQ.error.message}`
                  : String(clustersQ.error)
                : 'Define a cluster (head + worker nodes, profiles) in Settings first.'
            }
            action={
              <Btn variant="primary" size="sm" onClick={clustersQ.reload}>
                Retry
              </Btn>
            }
          />
        </div>
      ) : (
        <ControlConsole key={cluster.id} cluster={cluster} accent={accentOf(cluster)} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Console layout
   --------------------------------------------------------------------------- */

function ControlConsole({ cluster, accent }: { cluster: ClusterTopology; accent: string }) {
  const now = useNow(1000);

  /* live aggregate poll — ~6 s floor; WS service frames cover the fast path */
  const liveFetcher = useCallback(
    (): Promise<ClusterLive> =>
      getClusterLive(cluster.id).then((d) => {
        mergeOpsIntoStore(d.recent_ops ?? []);
        return d;
      }),
    [cluster.id],
  );
  const liveQ = useQuery(liveFetcher);
  usePollInterval(liveQ.reload, 6000, true);

  /* full cluster op audit: GET /api/ops?cluster_id= merged into the store */
  const [, setOpsTick] = useState(0);
  useEffect(() => {
    let dead = false;
    const pull = (): void => {
      void api
        .ops({ limit: 80, clusterId: cluster.id })
        .then((list) => {
          if (!dead) mergeOpsIntoStore(list);
        })
        .catch(() => {});
    };
    pull();
    const t = setInterval(pull, 30_000);
    return () => {
      dead = true;
      clearInterval(t);
    };
  }, [cluster.id]);
  const refreshOps = useCallback(() => setOpsTick((t) => t + 1), []);

  /* poll active ops over REST as well (covers a dead websocket) */
  const activeOpIds = useLive(
    useShallow((s) => {
      const ids: string[] = [];
      for (const op of s.opsById.values()) {
        if ((op.cluster_id ?? null) === cluster.id && ACTIVE_OP_STATES.has(op.state)) ids.push(op.id);
      }
      return ids;
    }),
  );
  useEffect(() => {
    if (activeOpIds.length === 0) return undefined;
    const t = setInterval(() => {
      for (const id of activeClusterOpIds(cluster.id)) {
        void api
          .op(id)
          .then((op) => mergeOpsIntoStore([op]))
          .catch(() => {});
      }
    }, 2500);
    return () => clearInterval(t);
  }, [activeOpIds.join(','), cluster.id]);

  /* service state: WS topic first, REST live aggregate as fallback */
  const wsService = useServiceState(cluster.id);
  const restService = liveQ.data?.service ?? null;
  const svc =
    wsService ??
    (restService !== null && typeof restService === 'object' && Object.keys(restService).length > 0
      ? restService
      : null);
  const view = serviceView(svc);

  /* node conn state: WS upserts beat the REST snapshot */
  const wsNodes = useLiveNodes();
  const restNodes = useMemo(() => {
    const m = new Map<string, LiveNodePartial>();
    for (const n of liveQ.data?.nodes ?? []) m.set(n.node_id, n);
    return m;
  }, [liveQ.data]);
  const nodeStateOf = useCallback(
    (nodeId: string): Partial<LiveNodeState> | undefined =>
      wsNodes.find((n) => n.node_id === nodeId) ?? restNodes.get(nodeId),
    [wsNodes, restNodes],
  );

  const opsForCluster = useLive(useShallow(selectClusterOps(cluster.id)));
  const anyBusy = opsForCluster.some((o) => isOpActive(o));

  /* action plumbing */
  const [startOpen, setStartOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [preflightOpen, setPreflightOpen] = useState(false);
  const [opLog, setOpLog] = useState<{ id: ID | null; title: string }>({ id: null, title: 'op' });
  const [gidsOp, setGidsOp] = useState<{ id: ID | null; node: string }>({ id: null, node: '' });

  const submit = useCallback(
    async (label: string, p: Promise<{ op_id: string }>): Promise<boolean> => {
      try {
        const r = await p;
        toast.ok(`${label} submitted`, `op ${r.op_id}`);
        setOpLog({ id: r.op_id, title: label });
        return true;
      } catch (e) {
        toast.error(`${label} failed`, e instanceof Error ? e.message : String(e));
        return false;
      }
    },
    [],
  );

  const doStart = useCallback(
    async (v: {
      profile_key: string;
      health_timeout_s: number;
      skip_preflight: boolean;
      extra: string;
    }): Promise<void> => {
      const ok = await submit(
        'cluster.start',
        startCluster(cluster.id, {
          profile_key: v.profile_key,
          health_timeout_s: v.health_timeout_s,
          skip_preflight: v.skip_preflight,
          extra: v.extra.trim() === '' ? null : v.extra.trim(),
        }),
      );
      if (!ok) throw new Error('start rejected');
    },
    [cluster.id, submit],
  );

  const doPreflight = useCallback(
    async (): Promise<void> => {
      setPreflightOpen(false);
      await submit('cluster.preflight', preflightCluster(cluster.id));
    },
    [cluster.id, submit],
  );

  const doStop = useCallback(
    async (): Promise<void> => {
      setStopOpen(false);
      await submit('cluster.stop', stopCluster(cluster.id));
    },
    [cluster.id, submit],
  );

  /* exact remote commands for the confirms (Tp2Verbs shapes) */
  const downCommands = useMemo(() => {
    const ctl = cluster.control;
    return `cd ${ctl.serve_dir} && bash ${ctl.launcher} --down 2>&1`;
  }, [cluster]);
  const headName = headNodeOf(cluster)?.name ?? 'head';
  const workerName = workerNodeOf(cluster)?.name ?? 'worker';

  const verifyKey = view.profileKey ?? cluster.profiles[0]?.key ?? null;

  return (
    <>
      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-[var(--sd-card-gap)] xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {/* left column */}
        <div className="flex min-w-0 flex-col gap-[var(--sd-card-gap)]">
          <ProfilesGrid
            cluster={cluster}
            accent={accent}
            service={view}
            now={now}
            onCheck={(key) => void submit('cluster.check', checkCluster(cluster.id, key)).then(() => undefined)}
            onVerify={(key) => void submit('cluster.verify', verifyCluster(cluster.id, key)).then(() => undefined)}
          />
          <ServiceStatus
            service={view}
            anyBusy={anyBusy}
            onStart={() => setStartOpen(true)}
            onPreflight={() => setPreflightOpen(true)}
            onCheck={() => void doCheck(cluster, submit)}
            onVerify={() => verifyKey !== null && void submit('cluster.verify', verifyCluster(cluster.id, verifyKey))}
            onStop={() => setStopOpen(true)}
          />
          <EnvInspector cluster={cluster} serviceProfileKey={view.profileKey} />
        </div>

        {/* right column */}
        <div className="flex min-w-0 flex-col gap-[var(--sd-card-gap)]">
          <NodeFacts
            cluster={cluster}
            nodeStateOf={nodeStateOf}
            ops={opsForCluster}
            onShowGids={(nodeId, nodeName) => {
              void showGids(nodeId)
                .then((r) => setGidsOp({ id: r.op_id, node: nodeName }))
                .catch((e: unknown) => {
                  toast.error('show-gids failed', e instanceof Error ? e.message : String(e));
                });
            }}
          />
          <OpsTimeline clusterId={cluster.id} />
        </div>
      </div>

      {/* ---- modals ---- */}
      <StartDialog
        cluster={cluster}
        serviceProfileKey={view.profileKey}
        open={startOpen}
        onClose={() => setStartOpen(false)}
        onSubmit={doStart}
      />

      <ConfirmDialog
        open={stopOpen}
        onClose={() => setStopOpen(false)}
        onConfirm={doStop}
        title="Stop the serving pair?"
        summary={
          <>
            Stops both rank containers and confirms teardown. The served model
            goes away for <strong className="text-hi">every consumer on this machine</strong>. Runs
            the head first, then the worker.
          </>
        }
        commands={[
          `${downCommands.cmd}   # head: ${headName}`,
          `${downCommands.cmd}   # worker: ${workerName}`,
        ]}
        confirmWord="stop"
        confirmLabel="Stop pair"
      />

      <ConfirmDialog
        open={preflightOpen}
        onClose={() => setPreflightOpen(false)}
        onConfirm={doPreflight}
        title="Run preflight?"
        summary={
          <>
            Per node (worker → head): reads swappiness, forces it to 0 and drops
            the page cache. Needs sudo — the op fails fast with a clear message
            when no sudo password is set.
          </>
        }
        commands={[
          'cat /proc/sys/vm/swappiness 2>/dev/null || echo 60',
          'sysctl vm.swappiness=0                    # only when the read is not 0 (sudo)',
          'sync; echo 3 > /proc/sys/vm/drop_caches   # sudo',
        ]}
        confirmLabel="Preflight"
        danger={false}
      />

      <OpLogDialog opId={opLog.id} title={opLog.title} onClose={() => setOpLog({ id: null, title: 'op' })} />

      <GidsDialog opId={gidsOp.id} nodeName={gidsOp.node} onClose={() => setGidsOp({ id: null, node: '' })} />
    </>
  );
}

/* cluster.check helper kept a free function so the button wiring stays honest */
function doCheck(cluster: ClusterTopology, submit: (label: string, p: Promise<{ op_id: string }>) => Promise<boolean>): void {
  void submit('cluster.check', checkCluster(cluster.id, null));
}

/* ---------------------------------------------------------------------------
   Profiles grid — the 4 GLM-5.3-Flash serving profiles from the topology
   --------------------------------------------------------------------------- */

function ProfilesGrid({
  cluster,
  accent,
  service,
  now,
  onCheck,
  onVerify,
}: {
  cluster: ClusterTopology;
  accent: string;
  service: ServiceView;
  now: number;
  onCheck: (key: string) => void;
  onVerify: (key: string) => void;
}) {
  const servingKey = service.profileKey;
  return (
    <Panel title="Serving profiles" sub="from cluster topology — Start picks one; Check/Verify run per profile">
      <div className="grid grid-cols-1 gap-[var(--sd-card-gap)] px-4 pb-4 md:grid-cols-2">
        {cluster.profiles.map((p) => (
          <ProfileCard
            key={p.key}
            profile={p}
            serving={servingKey === p.key}
            uptimeS={servingKey === p.key ? service.ageS : null}
            accent={accent}
            now={now}
            onCheck={() => onCheck(p.key)}
            onVerify={() => onVerify(p.key)}
          />
        ))}
        {cluster.profiles.length === 0 && (
          <div className="col-span-full py-6 text-center text-xs text-low">No profiles configured on this cluster.</div>
        )}
      </div>
    </Panel>
  );
}

function ProfileCard({
  profile,
  serving,
  uptimeS,
  accent,
  onCheck,
  onVerify,
}: {
  profile: ProfileDef;
  serving: boolean;
  uptimeS: number | null;
  accent: string;
  onCheck: () => void;
  onVerify: () => void;
  now: number;
}) {
  void now;
  const facts: [string, ReactNode][] = [
    ['kv pin', profile.kv_pin_gib !== null && profile.kv_pin_gib !== undefined ? `${profile.kv_pin_gib} GiB` : '—'],
    ['context', profile.context !== null && profile.context !== undefined ? fmtCompact(profile.context) : '—'],
    ['speculator', profile.speculator ?? '—'],
    ['quant', profile.quant ?? '—'],
    ['img/vid', `${String(profile.mm_images ?? '—')}/${String(profile.mm_videos ?? '—')}`],
    ['model', profile.served_model_name],
  ];
  return (
    <article
      className={cn(
        'flex min-w-0 flex-col gap-2 rounded-inner border p-3 transition-colors duration-fast',
        serving ? 'bg-bg2/40' : 'border-stroke',
      )}
      style={serving ? { borderColor: accent } : undefined}
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-hi" title={profile.label}>
          {profile.key}
        </span>
        {serving && (
          <Chip variant="ok" color={accent} title={`serving — up ${uptimeS !== null ? fmtDuration(uptimeS) : '—'}`}>
            serving{uptimeS !== null ? ` ${fmtDuration(uptimeS)}` : ''}
          </Chip>
        )}
      </div>

      <div className="truncate text-2xs text-low" title={profile.label}>
        {profile.label}
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {facts.map(([k, v]) => (
          <div
            key={k}
            className="flex min-w-0 items-baseline gap-1.5"
            title={`${k}: ${typeof v === 'string' ? v : String(v)}`}
          >
            <dt className="sd-monolabel shrink-0">{k}</dt>
            <dd className="sd-num min-w-0 truncate text-right font-mono text-2xs text-hi">{v}</dd>
          </div>
        ))}
      </dl>

      {profile.notes !== null && profile.notes !== undefined && profile.notes !== '' && (
        <div className="rounded-inner border border-stroke bg-bg2/50 px-2 py-1 text-2xs text-low" title={profile.notes}>
          {profile.notes}
        </div>
      )}

      <div className="mt-auto flex items-center justify-end gap-1.5 pt-1">
        <Btn size="sm" variant="ghost" onClick={onCheck} className="font-mono text-2xs" title={`launcher --check rank-*-<key>.env`}>
          Check
        </Btn>
        <Btn size="sm" variant="ghost" onClick={onVerify} className="font-mono text-2xs" title={`launcher --verify rank-<head>-<key>.env`}>
          Verify
        </Btn>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------------------
   Service status + lifecycle actions
   --------------------------------------------------------------------------- */

function ServiceStatus({
  service,
  anyBusy,
  onStart,
  onPreflight,
  onCheck,
  onVerify,
  onStop,
}: {
  service: ServiceView;
  anyBusy: boolean;
  onStart: () => void;
  onPreflight: () => void;
  onCheck: () => void;
  onVerify: () => void;
  onStop: () => void;
}) {
  const healthVariant =
    service.health === 'up'
      ? 'ok'
      : service.health === 'degraded'
        ? 'warn'
        : service.health === 'down'
          ? 'crit'
          : 'neutral';
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-1.5">
          <HeartPulse size={14} className="text-mid" />
          Service
        </span>
      }
      sub={service.health === 'up' ? `serving ${service.model ?? '—'} on ${service.apiAddr ?? '—'}` : 'not serving'}
      actions={
        <Chip variant={healthVariant}>
          <StatusDot state={healthDot(service.health)} />
          {service.health}
        </Chip>
      }
    >
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 px-4 pb-3 lg:grid-cols-4">
        <KeyRowView label="profile" value={service.profileKey ?? '—'} mono />
        <KeyRowView label="uptime" value={service.ageS !== null ? fmtDuration(service.ageS) : '—'} mono />
        <KeyRowView label="kv tokens" value={service.kvTokens !== null ? fmtCompact(service.kvTokens) : '—'} mono />
        <KeyRowView label="image" value={service.image ?? '—'} mono title={service.image ?? undefined} />
        <KeyRowView label="host:port" value={service.apiAddr ?? '—'} mono />
        <KeyRowView label="served" value={service.servedModels.join(' · ') || '—'} mono />
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
        {service.metrics.map(([k, v]) => (
          <Chip key={k} variant="neutral" className="font-mono" title={`service metric ${k}`}>
            {k.replace('vllm:', '')}={fmtCompact(v)}
          </Chip>
        ))}
        {service.metrics.length === 0 && <span className="text-2xs text-low">no curated metrics published</span>}
      </div>

      {service.errors.length > 0 && (
        <div className="mx-4 mb-3 rounded-inner border border-crit/30 bg-crit/10 px-2.5 py-1.5 font-mono text-2xs text-crit">
          {service.errors.map((e, i) => (
            <div key={i} className="break-all" title={e}>
              ⚠︎ {e}
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-stroke px-4 py-2.5">
        <Btn
          variant="primary"
          size="sm"
          icon={<Play size={13} />}
          onClick={onStart}
          disabled={anyBusy}
          title={anyBusy ? 'an op is running — one lifecycle op at a time' : 'start the pair (profile picker)'}
        >
          Start…
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          icon={<ListChecks size={13} />}
          onClick={onPreflight}
          disabled={anyBusy}
          title="preflight only — swappiness trim + page-cache drop (sudo)"
        >
          Preflight only
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          icon={<ClipboardCheck size={13} />}
          onClick={onCheck}
          disabled={anyBusy}
          title="validate env on both nodes (launcher --check)"
        >
          Check
        </Btn>
        <Btn
          variant="ghost"
          size="sm"
          icon={<ShieldCheck size={13} />}
          onClick={onVerify}
          disabled={anyBusy}
          title="verify markers on the head (launcher --verify)"
        >
          Verify
        </Btn>
        <div className="flex-1" />
        <Btn
          variant="danger"
          size="sm"
          icon={<Square size={13} />}
          onClick={onStop}
          disabled={anyBusy}
          title={anyBusy ? 'an op is running — wait for it' : 'stop the pair (confirm with exact commands)'}
        >
          Stop pair…
        </Btn>
      </div>
    </Panel>
  );
}

function KeyRowView({
  label,
  value,
  mono = false,
  title,
}: {
  label: string;
  value: string;
  mono?: boolean;
  title?: string | undefined;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2" title={title ?? undefined}>
      <dt className="sd-monolabel shrink-0">{label}</dt>
      <dd className={cn('sd-num min-w-0 truncate text-right text-2xs text-hi', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Node server facts strip — swappiness chips (ops preflight log), fabric
   ping (POST ping-fabric with the worker's fabric address), show-gids.
   --------------------------------------------------------------------------- */

function NodeFacts({
  cluster,
  nodeStateOf,
  ops,
  onShowGids,
}: {
  cluster: ClusterTopology;
  nodeStateOf: (id: string) => Partial<LiveNodeState> | undefined;
  ops: OpRecord[];
  onShowGids: (nodeId: ID, nodeName: string) => void;
}) {
  const swappiness = useMemo(() => swappinessFromOps(ops), [ops]);
  const head = headNodeOf(cluster);
  const worker = workerNodeOf(cluster);
  const peer = workerFabricAddr(cluster);

  const [pingOpId, setPingOpId] = useState<ID | null>(null);
  const pingOp = useTrackedOp(pingOpId);
  const pingSummary = readPingParams(pingOp);
  const pingRunning = isOpActive(pingOp);

  return (
    <Panel title="Node server facts" sub="swappiness from the ops preflight log · ping fabric head → worker">
      <div className="flex flex-col gap-2 px-4 pb-4">
        {cluster.nodes.map((n) => {
          const st = nodeStateOf(n.id);
          const sw = swappiness.get(n.name);
          return (
            <div key={n.id} className="flex min-w-0 items-center gap-2">
              <StatusDot state={connDot(st?.state ?? 'unknown')} title={`node ${n.name} conn: ${st?.state ?? 'unknown'}`} />
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-hi">{n.name}</span>
              <Chip variant={n.role === 'head' ? 'accent' : 'neutral'} className="font-mono">
                {n.role}
              </Chip>
              <Tip text={sw !== undefined ? `vm.swappiness=${sw.value} (ops preflight log)` : 'no preflight line yet — run preflight/first start to populate'}>
                <Chip variant={sw === undefined ? 'neutral' : sw.value === 0 ? 'ok' : 'warn'} className="font-mono">
                  swappiness {sw !== undefined ? sw.value : '—'}
                </Chip>
              </Tip>
              <Btn
                size="sm"
                variant="ghost"
                onClick={() => onShowGids(n.id, n.name)}
                className="font-mono text-2xs"
                title={`show_gids on ${n.name} (RoCE GID table)`}
              >
                <Eye size={12} />
                GIDs
              </Btn>
            </div>
          );
        })}
        {cluster.nodes.length === 0 && <div className="py-2 text-xs text-low">No nodes configured.</div>}

        {/* fabric rail ping */}
        <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-stroke pt-2">
          <Network size={13} className="shrink-0 text-low" />
          <span
            className="min-w-0 flex-1 truncate font-mono text-2xs text-low"
            title="worker fabric address (peer for the head's ping)"
          >
            rail peer {peer ?? '— (no fabric addr on worker)'}
          </span>
          {pingSummary !== null && pingOp?.state === 'ok' && (
            <Chip
              variant={pingSummary.loss_pct === null || pingSummary.loss_pct > 0 ? 'warn' : 'ok'}
              className="font-mono"
              title="ping -c 5 -W 2 -q — min/avg/max ms · loss %"
            >
              {pingSummary.min_ms ?? '—'}/{pingSummary.avg_ms ?? '—'}/{pingSummary.max_ms ?? '—'} · loss{' '}
              {pingSummary.loss_pct ?? '—'}%
            </Chip>
          )}
          {pingOp?.state === 'error' && <Chip variant="crit">ping failed</Chip>}
          {pingOp?.state === 'error' && pingOp.message !== null && pingOp.message !== undefined && (
            <span className="min-w-0 flex-1 truncate font-mono text-2xs text-crit" title={pingOp.message}>
              {pingOp.message}
            </span>
          )}
          <Btn
            size="sm"
            variant="ghost"
            disabled={peer === null || pingRunning}
            loading={pingRunning}
            onClick={() => {
              if (head === null || peer === null) return;
              void pingFabric(head.id, peer)
                .then((r) => {
                  setPingOpId(r.op_id);
                  toast.ok('ping-fabric submitted', `op ${r.op_id} — head ${head.name} → ${worker?.name ?? 'worker'} ${peer}`);
                })
                .catch((e: unknown) => {
                  toast.error('ping-fabric failed', e instanceof Error ? e.message : String(e));
                });
            }}
            title="POST /api/nodes/{head}/actions/ping-fabric — resolves via the op result"
          >
            ping fabric
          </Btn>
        </div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   Operations timeline — running + recent ops (store merged from the REST
   audit + WS `ops` topic), expandable streaming terminal, cancel on running.
   --------------------------------------------------------------------------- */

function OpsTimeline({ clusterId }: { clusterId: ID }) {
  const ops = useLive(useShallow(selectClusterOps(clusterId)));
  const now = useNow(1000);
  const [openRows, setOpenRows] = useState<ReadonlySet<string>>(new Set());
  const [cancelId, setCancelId] = useState<ID | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const running = ops.filter((o) => isOpActive(o));

  const refresh = (): void => {
    setRefreshing(true);
    void api
      .ops({ limit: 80, clusterId })
      .then((list) => {
        mergeOpsIntoStore(list);
      })
      .catch((e: unknown) => {
        toast.error('op list refresh failed', e instanceof Error ? e.message : String(e));
      })
      .finally(() => setRefreshing(false));
  };

  const cancelOpNow = (): void => {
    const id = cancelId;
    if (id === null) return;
    setCancelId(null);
    void cancelOp(id)
      .then((r) => {
        if (r.ok) toast.ok('Cancel requested', `op ${id} — best-effort; the remote step runs to timeout`);
        else toast.warn('Cancel not accepted — op already finished');
      })
      .catch((e: unknown) => {
        toast.error('Cancel failed', e instanceof Error ? e.message : String(e));
      });
  };

  return (
    <Panel
      title="Operations"
      sub={running.length > 0 ? `${running.length} active · ${ops.length} in buffer` : `${ops.length} ops in buffer`}
      actions={
        <Btn size="sm" variant="ghost" onClick={refresh} loading={refreshing} title="GET /api/ops?cluster_id=">
          <RefreshCw size={12} />
        </Btn>
      }
    >
      <div className="flex max-h-[640px] min-h-0 flex-col gap-1 overflow-y-auto px-2 pb-2">
        {ops.slice(0, 40).map((op) => (
          <OpRow
            key={op.id}
            op={op}
            now={now}
            expanded={openRows.has(op.id)}
            onToggle={() =>
              setOpenRows((prev) => {
                const next = new Set(prev);
                if (next.has(op.id)) next.delete(op.id);
                else next.add(op.id);
                return next;
              })
            }
            onCancel={() => setCancelId(op.id)}
          />
        ))}
        {ops.length === 0 && (
          <Empty
            title="No operations yet."
            hint="Start / stop / preflight / check / verify stream here as they run."
            className="py-8"
          />
        )}
      </div>

      <ConfirmDialog
        open={cancelId !== null}
        onClose={() => setCancelId(null)}
        onConfirm={cancelOpNow}
        title="Cancel operation?"
        summary={
          <>
            Best-effort cancel of <span className="font-mono text-hi">{cancelId ?? ''}</span>. The SSH exec backing the
            current step runs until its own timeout, so a teardown may still complete after the cancel.
          </>
        }
        confirmLabel="Cancel op"
      />
    </Panel>
  );
}

function OpRow({
  op,
  now,
  expanded,
  onToggle,
  onCancel,
}: {
  op: OpRecord;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}) {
  const active = isOpActive(op);
  return (
    <div
      className={cn(
        'rounded-inner border transition-colors duration-fast',
        expanded ? 'border-stroke-strong bg-bg2/50' : 'border-stroke hover:border-stroke-strong',
      )}
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <Chip variant={opStateVariant(op.state)} className="w-16 justify-center font-mono text-2xs">
          {op.state === 'running' ? <Spinner size={9} /> : null}
          {op.state}
        </Chip>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-hi">{op.kind}</span>
          <span className="hidden shrink-0 font-mono text-2xs text-low sm:inline">{op.profile_key ?? op.node_id ?? ''}</span>
          <span className="sd-num w-14 shrink-0 text-right font-mono text-2xs text-mid">{opDurationLabel(op, now)}</span>
          <ChevronRight
            size={13}
            className={cn('shrink-0 text-low transition-transform duration-fast', expanded && 'rotate-90')}
          />
        </button>
        {active && (
          <Btn
            size="sm"
            variant="danger"
            onClick={onCancel}
            className="text-2xs"
            title="cancel this op (best-effort)"
          >
            Cancel
          </Btn>
        )}
      </div>

      {expanded && (
        <div className="px-2.5 pb-2">
          {op.steps.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1">
              {op.steps.map((s, i) => (
                <Chip key={`${s.name}-${i}`} variant={stepVariant(s.state)} title={s.detail ?? undefined} className="font-mono">
                  {s.name}:{s.state}
                </Chip>
              ))}
            </div>
          )}
          <div className="flex h-64 flex-col">
            <Terminal lines={op.log_tail} follow maxLines={300} className="sd-raised" />
          </div>
          {(op.message ?? '') !== '' && (
            <div className="mt-1 font-mono text-2xs break-all text-crit" title={op.message ?? undefined}>
              {op.message}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function stepVariant(state: OpRecord['steps'][number]['state']): 'neutral' | 'ok' | 'warn' | 'crit' | 'accent' {
  switch (state) {
    case 'ok':
      return 'ok';
    case 'running':
      return 'accent';
    case 'error':
      return 'crit';
    case 'skipped':
    case 'cancelled':
      return 'warn';
    default:
      return 'neutral';
  }
}

/* ---------------------------------------------------------------------------
   Env files inspector — GET /api/clusters/{id}/envfiles?profile_key=
   --------------------------------------------------------------------------- */

interface EnvSummaryView {
  image: string | null;
  kvGib: number | null;
  gidIndex: number | null;
  servedModel: string | null;
  hca: string | null;
  maxModelLen: number | null;
}

/** Client-side parse of the live env file text (regex on content). */
function parseEnvSummary(content: string | null): EnvSummaryView | null {
  if (content === null || content.trim() === '') return null;
  const grab = (re: RegExp): string | null => re.exec(content)?.[1]?.trim() ?? null;
  const kvRaw = grab(/^KV_CACHE_MEMORY_BYTES=(\d+)/m);
  const maxLen = grab(/^MAX_MODEL_LEN=(\d+)/m);
  const gid = grab(/^NCCL_IB_GID_INDEX=(\d+)/m);
  return {
    image: grab(/^SERVING_IMAGE=(.*)$/m),
    kvGib: kvRaw !== null ? Number(kvRaw) / 2 ** 30 : null,
    gidIndex: gid !== null ? Number(gid) : null,
    servedModel: grab(/^SERVED_MODEL_NAME=(.*)$/m),
    hca: grab(/^NCCL_IB_HCA=(.*)$/m),
    maxModelLen: maxLen !== null ? Number(maxLen) : null,
  };
}

function EnvInspector({
  cluster,
  serviceProfileKey,
}: {
  cluster: ClusterTopology;
  serviceProfileKey: string | null;
}) {
  const defaultKey =
    serviceProfileKey ??
    cluster.profiles.find((p) => p.key === 'mtp3-spark')?.key ??
    cluster.profiles[0]?.key ??
    'mtp3-spark';
  const [manualKey, setManualKey] = useState<string | null>(null);
  const key = manualKey ?? defaultKey;

  const fetcher = useCallback(() => getEnvFiles(cluster.id, key), [cluster.id, key]);
  const envQ = useQuery(fetcher);
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});

  return (
    <Panel
      title="Env files (live)"
      sub="live host env files are ground truth — repo copies may lag"
      actions={
        <>
          <span className="sd-monolabel">profile</span>
          <Select value={key} onChange={(e) => setManualKey(e.currentTarget.value)} aria-label="env profile" className="w-64">
            {cluster.profiles.map((p) => (
              <option key={p.key} value={p.key}>
                {p.key} — {p.label}
              </option>
            ))}
          </Select>
          <Btn size="sm" variant="ghost" loading={envQ.loading} onClick={envQ.reload} title="re-read both env files over SSH (cat)">
            <RefreshCw size={12} />
            Refresh
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-2 px-4 pb-4">
        {envQ.error !== null && !envQ.loading ? (
          <div className="rounded-inner border border-warn/30 bg-warn/5 px-2.5 py-1.5 font-mono text-2xs text-warn">
            {isApiClientError(envQ.error) ? `${envQ.error.code}: ${envQ.error.message}` : String(envQ.error)}
          </div>
        ) : null}

        {envQ.data === null && envQ.loading ? <Spinner /> : null}

        {(envQ.data?.files ?? []).map((f) => {
          const summary = parseEnvSummary(f.content);
          const isOpen = openRows[f.node_id] ?? f.content !== null;
          return (
            <EnvFileRowView
              key={f.node_id}
              nodeName={f.node_name}
              state={f.state}
              filePath={f.file ?? null}
              content={f.content}
              summary={summary}
              profile={cluster.profiles.find((p) => p.key === key)}
              open={isOpen}
              onToggle={() =>
                setOpenRows((prev) => ({ ...prev, [f.node_id]: !isOpen }))
              }
            />
          );
        })}

        {envQ.data !== null && envQ.data.files.length === 0 ? (
          <div className="py-3 text-xs text-low">No nodes to read env files from.</div>
        ) : null}
      </div>
    </Panel>
  );
}

function EnvFileRowView({
  nodeName,
  state,
  filePath,
  content,
  summary,
  profile,
  open,
  onToggle,
}: {
  nodeName: string;
  state: string;
  filePath: string | null;
  content: string | null;
  summary: EnvSummaryView | null;
  profile: ProfileDef | undefined;
  open: boolean;
  onToggle: () => void;
}) {
  const kvPinned =
    summary?.kvGib !== null &&
    summary?.kvGib !== undefined &&
    profile?.kv_pin_gib != null &&
    Math.abs(summary.kvGib - profile.kv_pin_gib) <= 0.05;
  const lines = useMemo(
    () => (content ?? '').replace(/\n$/, '').split('\n').slice(0, 600),
    [content],
  );

  return (
    <div className="rounded-inner border border-stroke transition-colors duration-fast hover:border-stroke-strong">
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-2.5 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <ChevronRight
            size={13}
            className={cn('shrink-0 text-low transition-transform duration-fast', open && 'rotate-90')}
          />
          <StatusDot state={connDot(state)} title={`node ${nodeName} conn: ${state}`} />
          <span className="shrink-0 font-mono text-xs text-hi">{nodeName}</span>
          <span className="min-w-0 truncate font-mono text-2xs text-low" title={filePath ?? undefined}>
            {filePath ?? '(node offline — no file read)'}
          </span>
        </button>
        <Chip variant={state === 'online' ? 'ok' : 'warn'} className="font-mono" title={`node state: ${state}`}>
          {state}
        </Chip>
        {summary !== null ? (
          <>
            <Tip text={`SERVING_IMAGE=${summary.image ?? ''}`}>
              <Chip variant="neutral" className="max-w-[240px] font-mono">
                <span className="min-w-0 truncate">{summary.image ?? 'no SERVING_IMAGE'}</span>
              </Chip>
            </Tip>
            <Tip
              text={
                summary.kvGib !== null
                  ? `KV pin (env) ≈ ${summary.kvGib.toFixed(2)} GiB${
                      profile?.kv_pin_gib != null
                        ? ` · profile kv_pin_gib ${profile.kv_pin_gib} GiB${kvPinned ? '' : ' — MISMATCH'}`
                        : ''
                    }`
                  : 'no KV_CACHE_MEMORY_BYTES line'
              }
            >
              <Chip variant={summary.kvGib === null ? 'neutral' : kvPinned ? 'ok' : 'warn'} className="font-mono">
                KV pin {summary.kvGib !== null ? `≈ ${summary.kvGib.toFixed(1)} GiB` : '—'}
              </Chip>
            </Tip>
            <Tip text={summary.hca !== null ? `NCCL_IB_HCA=${summary.hca}` : 'no NCCL_IB_HCA line'}>
              <Chip variant="neutral" className="font-mono">
                GID idx {summary.gidIndex ?? '—'}
              </Chip>
            </Tip>
          </>
        ) : null}
      </div>

      {open && content !== null ? (
        <div className="px-2.5 pb-2">
          <div className="sd-raised max-h-72 overflow-auto p-0 font-mono text-2xs leading-5">
            {lines.map((ln, i) => (
              <div key={i} className="flex">
                <span
                  aria-hidden
                  className="sd-num mr-3 inline-block w-9 shrink-0 text-right select-none"
                  style={{ color: 'var(--sd-low)', opacity: 0.8 }}
                >
                  {i + 1}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-all text-hi">{ln === '' ? '\u00A0' : ln}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {open && content !== null && content.trim() === '' ? (
        <div className="px-2.5 pb-2 text-2xs text-low">file is empty on the host</div>
      ) : null}
    </div>
  );
}
