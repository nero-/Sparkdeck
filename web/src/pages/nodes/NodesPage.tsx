/* ============================================================================
   Nodes — grid of ALL nodes grouped by cluster, filterable by cluster + state.
   Cards are the shared NodeCard (nodeCard.tsx); click → node detail.
   ========================================================================= */

import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Cpu, RotateCcw } from 'lucide-react';
import { cn } from '../../lib/cn';
import { PageHeader } from '../../shell/PageShell';
import { Btn, Chip, Empty, Panel, StatusDot } from '../../ds';
import { NodeCard } from '../../components/nodeCard';
import { Skel } from '../../components/monShared';
import { useClusters } from '../../api/queries';
import { useSettings } from '../../api/monitoring';
import { useLiveNodes, useLive } from '../../stores/live';
import { isApiClientError } from '../../api/client';
import type { ClusterTopology, ID, LiveNodeState } from '../../api/types';

type StateFilter = 'all' | 'online' | 'degraded' | 'offline' | 'disabled';

const STATE_FILTERS: Array<{ id: StateFilter; label: string }> = [
  { id: 'all', label: 'all' },
  { id: 'online', label: 'online' },
  { id: 'degraded', label: 'degraded' },
  { id: 'offline', label: 'offline' },
  { id: 'disabled', label: 'disabled' },
];

function matchState(state: LiveNodeState | undefined, filter: StateFilter): boolean {
  if (filter === 'all') return true;
  if (state === undefined) return filter === 'offline'; // no live frame yet
  return state.state === filter;
}

export default function NodesPage() {
  const clustersQ = useClusters();
  const settingsQ = useSettings();
  const nodeStates = useLiveNodes();
  const wsStatus = useLive((s) => s.status);
  const [params] = useSearchParams();
  const [clusterFilter, setClusterFilter] = useState<string>('all');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');

  const clusters = clustersQ.data ?? [];

  // deep-link filter from Overview (?cluster=…)
  const requestedCluster = params.get('cluster');
  const effectiveCluster =
    clusterFilter !== 'all'
      ? clusterFilter
      : requestedCluster !== null && clusters.some((c) => c.id === requestedCluster)
        ? requestedCluster
        : 'all';

  const stateById = useMemo(() => {
    const m = new Map<ID, LiveNodeState>();
    for (const n of nodeStates) m.set(n.node_id, n);
    return m;
  }, [nodeStates]);

  const totalNodes = clusters.reduce((acc, c) => acc + c.nodes.length, 0);
  const shown = useMemo(
    () =>
      clusters
        .filter((c) => effectiveCluster === 'all' || c.id === effectiveCluster)
        .map((c) => ({
          cluster: c,
          nodes: c.nodes.filter((n) => matchState(stateById.get(n.id), stateFilter)),
        }))
        .filter((g) => g.nodes.length > 0 || stateFilter === 'all'),
    [clusters, stateById, effectiveCluster, stateFilter],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Nodes"
        context={
          clustersQ.loading && clusters.length === 0
            ? 'loading topology…'
            : `${totalNodes} node${totalNodes === 1 ? '' : 's'} · ${clusters.length} cluster${clusters.length === 1 ? '' : 's'} · collector & docker state from the live samples`
        }
        actions={
          <>
            <span className="font-mono text-2xs text-low" title={`WebSocket: ${wsStatus}`}>
              ws: {wsStatus}
            </span>
            <Btn size="sm" variant="ghost" onClick={clustersQ.reload} icon={<RotateCcw size={12} />}>
              Refresh
            </Btn>
          </>
        }
      />

      {/* filters */}
      <Panel className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Filter by cluster">
          <span className="sd-monolabel">cluster</span>
          <FilterChip active={effectiveCluster === 'all'} onClick={() => setClusterFilter('all')} label="all" />
          {clusters.map((c) => (
            <FilterChip
              key={c.id}
              active={effectiveCluster === c.id}
              onClick={() => setClusterFilter(c.id)}
              label={c.name}
              accent={accentOr(c.accent_color)}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" role="group" aria-label="Filter by state">
          <span className="sd-monolabel">state</span>
          {STATE_FILTERS.map((f) => (
            <FilterChip key={f.id} active={stateFilter === f.id} onClick={() => setStateFilter(f.id)} label={f.label} />
          ))}
        </div>
        <span className="ml-auto font-mono text-2xs text-low" title="alerts thresholds come from GET /api/settings">
          mem warn/crit {settingsQ.data ? `${settingsQ.data.alerts.mem_warn_pct}% / ${settingsQ.data.alerts.mem_crit_pct}% of total` : '…'}
        </span>
      </Panel>

      {clustersQ.error !== null && clusters.length === 0 ? (
        <Panel className="flex flex-1 items-center justify-center">
          <Empty
            icon={<Cpu />}
            title="Controller unreachable — node grid unavailable."
            hint={isApiClientError(clustersQ.error) ? `${clustersQ.error.code}: ${clustersQ.error.message}` : String(clustersQ.error)}
            action={
              <Btn variant="primary" size="sm" onClick={clustersQ.reload}>
                Retry
              </Btn>
            }
          />
        </Panel>
      ) : clustersQ.loading && clusters.length === 0 ? (
        <NodeGridSkeleton />
      ) : clusters.length === 0 ? (
        <Panel className="flex flex-1 items-center justify-center">
          <Empty icon={<Cpu />} title="No clusters configured yet." hint="Add a cluster in Settings; nodes nest under clusters." />
        </Panel>
      ) : shown.length === 0 ? (
        <Panel className="flex flex-1 items-center justify-center">
          <Empty
            icon={<Cpu />}
            title="No nodes match the current filters."
            hint="Loosen the state filter (offline nodes disappear fast on a live grid)."
            action={
              <Btn variant="ghost" size="sm" onClick={() => setStateFilter('all')}>
                Reset filters
              </Btn>
            }
          />
        </Panel>
      ) : (
        <div className="flex min-w-0 flex-col gap-6">
          {shown.map(({ cluster, nodes }) => (
            <ClusterSection
              key={cluster.id}
              cluster={cluster}
              nodes={nodes}
              stateById={stateById}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function accentOr(color: string | undefined | null): string {
  return color !== undefined && color !== null && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color) ? color : '#5EB1FF';
}

/* ---------------------------------------------------------------------------
   filter chip (double duty: cluster + state)
   --------------------------------------------------------------------------- */

function FilterChip({
  active,
  onClick,
  label,
  accent,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  accent?: string;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-inner border px-2 font-mono text-2xs transition-colors duration-fast',
        active
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-stroke bg-transparent text-mid hover:border-stroke-strong hover:text-hi',
      )}
    >
      {accent !== undefined && (
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: accent }} aria-hidden />
      )}
      {label}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Cluster section
   --------------------------------------------------------------------------- */

function ClusterSection({
  cluster,
  nodes,
  stateById,
}: {
  cluster: ClusterTopology;
  nodes: ClusterTopology['nodes'];
  stateById: Map<ID, LiveNodeState>;
}) {
  const accent = accentOr(cluster.accent_color);
  const online = nodes.filter((n) => stateById.get(n.id)?.state === 'online').length;

  return (
    <section className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center gap-2 px-1">
        <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: accent }} aria-hidden />
        <h2 className="text-[13px] font-semibold" style={{ color: accent }}>
          {cluster.name}
        </h2>
        <Chip variant="neutral" className="font-mono">{cluster.id}</Chip>
        <span className="font-mono text-2xs text-low">
          {online}/{nodes.length} shown online
        </span>
      </div>
      <div className="sd-card-gap grid min-w-0 grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
        {nodes.map((n) => (
          <NodeCard key={n.id} node={n} accent={accent} state={stateById.get(n.id)} alerts={undefined} />
        ))}
      </div>
    </section>
  );
}

function NodeGridSkeleton(): ReactNode {
  return (
    <div className="flex flex-col gap-6">
      {[0, 1].map((c) => (
        <div key={c}>
          <Skel className="mb-2 h-4 w-40" />
          <div className="gap-5 grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3">
            {[0, 1].map((i) => (
              <div key={i} className="sd-panel flex flex-col gap-3 p-3" aria-hidden>
                <div className="flex items-center gap-2">
                  <StatusDot state="unknown" />
                  <Skel className="h-3.5 w-24" />
                  <Skel className="h-4 w-14" />
                </div>
                <div className="flex gap-3">
                  <Skel className="h-24 w-24 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skel className="h-2.5 w-full" />
                    <Skel className="h-3 w-2/3" />
                    <Skel className="h-5 w-full" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
