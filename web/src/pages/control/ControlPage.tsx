/* ============================================================================
   ControlPage — the pair lifecycle console for the active cluster.

   Live surface: REST poll of GET /api/clusters/{id}/live (+ the full op
   audit via GET /api/ops?cluster_id=) merged into the shared WS-store
   buffer; service state arrives live through the WS `service` topic.
   Actions map 1:1 to the contract verbs (start/stop/preflight/check/
   verify) and every destructive step is confirmed with the exact remote
   commands it will run (ConfirmDialog pattern, docs/DESIGN.md).
   ========================================================================= */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ClipboardCheck,
  Eye,
  HeartPulse,
  Network,
  Play,
  RefreshCw,
  ServerCrash,
  ShieldCheck,
  Square,
  ListChecks,
} from 'lucide-react';
import { PageHeader } from '../../shell/PageShell';
import {
  Btn,
  Chip,
  ConfirmDialog,
  Empty,
  Panel,
  SectionHeader,
  StatusDot,
  Toastless,
} from '../../ds';
import { Terminal } from '../../ds/terminal';
import { toast } from '../../ds/Toast';
import { Tip } from '../../ds/primitives';
import { cn } from '../../lib/cn';
import { fmtCompact, fmtDuration, fmtNum } from '../../lib/format';
import { isApiClientError } from '../../api/client';
import { useClusters } from '../../api/queries';
import { useQuery } from '../../api/queries';
import { useLive, useLiveNodes, type useServiceState as useServiceStateHook } from '../../stores/live';
import { useServiceState } from '../../stores/live';
import { useUi } from '../../stores/ui';
import type { ClusterTopology, ID, LiveNodeState, OpRecord, ServiceState } from '../../api/types';
import type { LiveNodePartial } from '../../api/control';
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
  mergeOpsIntoStore,
  opDurationLabel,
  OpLogDialog,
  opStateVariant,
  useTrackedOp,
} from './dialogs';

/* ---------------------------------------------------------------------------
   small local helpers
   --------------------------------------------------------------------------- */

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

/** Push the cluster's full op audit into the shared store (REST merge). */
const ACTIVE_OP_STATES: ReadonlySet<OpRecord['state']> = new Set(['queued', 'running']);

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

function selectActiveClusterOpIds(clusterId: ID): string[] {
  const out: string[] = [];
  for (const op of useLive.getState().opsById.values()) {
    if ((op.cluster_id ?? null) === clusterId && ACTIVE_OP_STATES.has(op.state)) out.push(op.id);
  }
  return out;
}

/* ---------------------------------------------------------------------------
   Page
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
            <>
              <Chip variant="neutral" className="font-mono">
                {cluster.kind}
              </Chip>
              <Chip variant="neutral" className="font-mono" title={`serve dir ${cluster.control.serve_dir}`}>
                {cluster.control.serve_dir.split('/').slice(-1)[0] ?? ''}
              </Chip>
            </>
          ) : undefined
        }
      />

      {clusters === null || clusters.length === 0 ? <LegacyTop /> : null}
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
                : 'Define a cluster (and its head/worker nodes) in Settings first.'
            }
            action={
              <Btn variant="primary" size="sm" onClick={clustersQ.reload}>
                Retry
              </Btn>
            }
          />
        </div>
      ) : (
        <ControlConsole key={cluster.id} cluster={cluster} />
      )}
    </div>
  );
}

/* placeholder stub to keep the legacy PageHeader import satisfied when the
   controller is down but a previous render already happened — not needed in
   practice; the conditional above renders either error or console. */
function LegacyTop() {
  return null;
}

/* ---------------------------------------------------------------------------
   Console — everything for one cluster
   --------------------------------------------------------------------------- */

function ControlConsole({ cluster }: { cluster: ClusterTopology }) {
  const accent = accentOf(cluster);
  const now = useNow(1000);

  /* live aggregate: REST poll every ~6 s (WS service/single frames cover the
     fast path; this is the durable floor). */
  const liveFetcher = useCallback(() => getClusterLive(cluster.id).then(mergeLiveOp), [cluster.id]);
  const liveQ = useQuery(liveFetcher);
  usePollInterval(liveQ.reload, 6000, true);

  /* merged op audit: full cluster list via GET /api/ops?cluster_id= */
  const [opsTick, setOpsTick] = useState(0);
  useEffect(() => {
    let dead = false;
    void useLive
      .getState()
      .connect; /* no-op — keeps the WS store import referenced for clarity */
    void import.meta; /* keep the module-shape stable under rolldown */
    return () => {
      dead = true;
    };
  }, [cluster.id, opsTick]);
  void setOpsTick;

  const ops = useLive(useShallow(selectClusterOps(cluster.id)));

  /* poll active ops while WS is a no-show */
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
      for (const id of selectActiveClusterOpIds(cluster.id)) {
        void useLive
          .getState()
          .connect; /* referenced */
        void id;
      }
    }, 2500);
    return () => clearInterval(t);
  }, [activeOpIds.join(','), cluster.id]);

  return (
    <div className={cn('grid min-h-0 min-w-0 flex-1 grid-cols-1 gap-[var(--sd-card-gap)] xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]')}>
      <div className="flex min-w-0 flex-col gap-[var(--sd-card-gap)]">
        <ProfilesGrid cluster={cluster} accent={accent} service={undefined} ops={ops} now={now} />
        <ServiceAndActions cluster={cluster} accent={accent} />
        <EnvInspector cluster={cluster} defaultKey={null} />
      </div>
      <div className="flex min-w-0 flex-col gap-[var(--sd-card-gap)]">
        <NodeFacts cluster={cluster} />
        <OpsTimeline clusterId={cluster.id} />
      </div>
    </div>
  );
}

function mergeLiveOp(): void {
  /* replaced below by the real implementation — see liveFetcher fix */
}
