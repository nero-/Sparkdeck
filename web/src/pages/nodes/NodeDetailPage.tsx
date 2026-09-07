/* ============================================================================
   Node detail — full per-node dashboard (charts wave).

   Data: GET /api/metrics/history (poll: 15 s for ≤1 h windows, else 60 s)
   merged with the live WS ring tail for 5m/15m windows; grouping/windows per
   docs/API.md. Metric ids stay visible + copy-friendly (tile sub lines +
   "copy as curl" for the exact query). Series picking per chart rides the
   TimeChart legend chips (state survives window flips, page-local).
   ========================================================================= */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Cable,
  Copy as CopyIcon,
  EthernetPort,
  Globe,
  Link2,
  RotateCcw,
  Thermometer,
} from 'lucide-react';
import { cn } from '../../lib/cn';
import { PageHeader } from '../../shell/PageShell';
import {
  Btn,
  Chip,
  Empty,
  Panel,
  StatusDot,
  Tabs,
  TimeChart,
  connDot,
  healthDot,
  Tip,
  type ChartSeriesData,
  type ChartSeriesDef,
} from '../../ds';
import { useClusters } from '../../api/queries';
import {
  HIST_WINDOWS,
  WINDOW_MS,
  useHistory,
  historyCurl,
  useSettings,
  windowIsLive,
  type HistWindow,
} from '../../api/monitoring';
import { useNodeState, useServiceState } from '../../api/client';
import { useLastSample } from '../../stores/live';
import { EMPTY_RING, ifacesFromSample, useNodeRings, type RingSeries } from '../../stores/nodeRings';
import { LiveBadge, Skel, accentValid, seriesDataFor, copyText } from '../../components/monShared';
import { fmtClock, fmtIso } from '../../lib/format';
import type {
  ClusterTopology,
  HistoryResponse,
  LiveNodeState,
  NodeConfig,
  SampleFrame,
  ServiceState,
} from '../../api/types';

/* =============================================================================
   Layout model — one tile per question, canonical series ids everywhere
   ========================================================================== */

interface HorizonDef {
  id: string;
  label: string;
  color: string;
  value: number;
}

interface TileDef {
  id: string;
  title: string;
  sub: string;
  height?: number;
  series: ChartSeriesDef[];
  horizons?: HorizonDef[];
  span2?: boolean;
}

const HZ_WARN = '#FBBF24';
const HZ_CRIT = '#F87171';

interface AppAlerts {
  mem_warn_gib: number;
  mem_crit_gib: number;
  gpu_temp_warn_c: number;
  gpu_temp_crit_c: number;
}

const ALERT_DEFAULTS: AppAlerts = {
  mem_warn_gib: 118.5,
  mem_crit_gib: 120.5,
  gpu_temp_warn_c: 85,
  gpu_temp_crit_c: 95,
};

/** Build the default chart layout from the latest sample frame. Dynamic ids
    (net ifaces, temp zones, docker containers, vllm) follow the sample; when
    no frame has arrived yet the static groups stay and the dynamic ones wait. */
function buildLayout(node: NodeConfig, sample: SampleFrame | undefined, isHead: boolean): TileDef[] {
  const s = sample?.series;
  const has = (id: string): boolean => typeof s?.[id] === 'number';
  const present = (id: string): boolean => s !== undefined && id in s;
  const keys = Object.keys(s ?? {});

  const gpu: TileDef = {
    id: 'gpu',
    title: 'GPU',
    sub: 'gpu.util · gpu.power_w · gpu.clock_sm_mhz',
    series: [
      { id: 'gpu.util', color: '#5EB1FF', label: 'util', unit: '%' },
      { id: 'gpu.power_w', color: '#FBBF24', label: 'power', unit: 'W' },
      { id: 'gpu.clock_sm_mhz', color: '#A78BFA', label: 'SM clock', unit: 'MHz' },
    ],
  };

  const mem: TileDef = {
    id: 'mem',
    title: 'Unified memory',
    sub: 'mem.used_gib · mem.pagecache_gib · mem.avail_gib',
    series: [
      { id: 'mem.used_gib', color: '#5EB1FF', label: 'used', unit: 'GiB' },
      { id: 'mem.pagecache_gib', color: '#4ADE80', label: 'pagecache', unit: 'GiB' },
      { id: 'mem.avail_gib', color: '#FBBF24', label: 'available', unit: 'GiB' },
    ],
  };

  const cpu: TileDef = {
    id: 'cpu',
    title: 'CPU',
    sub: 'cpu.util_pct · cpu.load1',
    series: [
      { id: 'cpu.util_pct', color: '#5EB1FF', label: 'cpu', unit: '%' },
      { id: 'cpu.load1', color: '#A78BFA', label: 'load 1m', unit: '×' },
    ],
  };

  /* temps: gpu + zones_max + top-3 hottest zones present in the sample */
  const tempSeries: ChartSeriesDef[] = [
    { id: 'temp.gpu', color: '#F87171', label: 'gpu', unit: '°C' },
    { id: 'temp.zones_max', color: '#FB923C', label: 'max zone', unit: '°C' },
  ];
  const zones: Array<{ id: string; v: number }> = [];
  for (const id of keys) {
    if (!id.startsWith('temp.zone.')) continue;
    const v = s?.[id];
    if (typeof v === 'number') zones.push({ id, v });
  }
  for (const z of zones.sort((a, b) => b.v - a.v).slice(0, 3)) {
    tempSeries.push({ id: z.id, color: '#E879F9', label: z.id.replace('temp.zone.', 'zone '), unit: '°C' });
  }
  const temp: TileDef = {
    id: 'temp',
    title: 'Temperatures',
    sub: tempSeries.map((t) => t.id).join(' · '),
    series: tempSeries,
  };

  const tiles: TileDef[] = [gpu, mem, cpu, temp];

  /* net — top-2 ifaces by |rx|+|tx| in the latest sample */
  const ifaces = sample === undefined ? [] : ifacesFromSample(sample.series);
  if (ifaces.length > 0) {
    const netSeries: ChartSeriesDef[] = [];
    for (const it of ifaces.slice(0, 2)) {
      netSeries.push({ id: `net.${it.iface}.rx_kbps`, color: '#5EB1FF', label: `rx ${it.iface}`, unit: 'kbit/s' });
      netSeries.push({ id: `net.${it.iface}.tx_kbps`, color: '#22D3EE', label: `tx ${it.iface}`, unit: 'kbit/s' });
    }
    tiles.push({
      id: 'net',
      title: 'Network — busiest ifaces',
      sub: netSeries.map((x) => x.id).join(' · '),
      series: netSeries,
      span2: true,
    });
  }

  tiles.push({
    id: 'disk',
    title: 'Disk',
    sub: 'disk.r_mbps · disk.w_mbps · disk.root_used_pct',
    series: [
      { id: 'disk.r_mbps', color: '#4ADE80', label: 'read', unit: 'MB/s' },
      { id: 'disk.w_mbps', color: '#22D3EE', label: 'write', unit: 'MB/s' },
      { id: 'disk.root_used_pct', color: '#F87171', label: 'root used', unit: '%' },
    ],
  });

  /* docker — containers present in the latest sample */
  const ctrs: string[] = [];
  for (const id of keys) {
    const m = /^docker\.(.+)\.cpu_pct$/.exec(id);
    if (m !== null && m[1] !== undefined) ctrs.push(m[1]);
  }
  if (ctrs.length > 0) {
    const pad = ['#5EB1FF', '#FBBF24', '#A78BFA', '#22D3EE'] as const;
    const padMem = ['#4ADE80', '#FB923C', '#E879F9', '#93C5FD'] as const;
    const cpuDefs: ChartSeriesDef[] = ctrs.map((c, i) => ({
      id: `docker.${c}.cpu_pct`,
      color: pad[i % pad.length] as string,
      label: `${c} cpu`,
      unit: '%',
    }));
    const memDefs: ChartSeriesDef[] = ctrs.map((c, i) => ({
      id: `docker.${c}.mem_gib`,
      color: padMem[i % padMem.length] as string,
      label: `${c} mem`,
      unit: 'GiB',
    }));
    tiles.push(
      { id: 'docker-cpu', title: 'Containers — CPU', sub: cpuDefs.map((x) => x.id).join(' · '), series: cpuDefs },
      {
        id: 'docker-mem',
        title: 'Containers — memory',
        sub: memDefs.map((x) => x.id).join(' · '),
        series: memDefs,
      },
    );
  }

  /* vllm — head nodes with vllm gauges in the latest sample */
  const vllmLive =
    isHead &&
    (has('vllm.decode_tok_s') ||
      has('vllm.kv_usage_perc') ||
      has('vllm.num_running') ||
      present('vllm.ttft_ms_avg'));
  if (vllmLive) {
    tiles.push(
      {
        id: 'vllm-throughput',
        title: 'vLLM — throughput',
        sub: 'vllm.decode_tok_s · vllm.prompt_tok_s',
        series: [
          { id: 'vllm.decode_tok_s', color: '#5EB1FF', label: 'decode', unit: 'tok/s' },
          { id: 'vllm.prompt_tok_s', color: '#4ADE80', label: 'prefill', unit: 'tok/s' },
        ],
      },
      {
        id: 'vllm-scheduler',
        title: 'vLLM — scheduler & KV',
        sub: 'vllm.num_running · vllm.num_waiting · vllm.kv_usage_perc',
        series: [
          { id: 'vllm.num_running', color: '#5EB1FF', label: 'running', unit: 'ct' },
          { id: 'vllm.num_waiting', color: '#FBBF24', label: 'waiting', unit: 'ct' },
          { id: 'vllm.kv_usage_perc', color: '#E879F9', label: 'kv usage', unit: '%' },
        ],
      },
      {
        id: 'vllm-latency',
        title: 'vLLM — latency',
        sub: 'vllm.ttft_ms_avg · vllm.ttft_ms_p95 · vllm.tpot_ms_avg',
        span2: true,
        series: [
          { id: 'vllm.ttft_ms_avg', color: '#5EB1FF', label: 'ttft avg', unit: 'ms' },
          { id: 'vllm.ttft_ms_p95', color: '#F87171', label: 'ttft p95', unit: 'ms' },
          { id: 'vllm.tpot_ms_avg', color: '#4ADE80', label: 'tpot', unit: 'ms' },
        ],
      },
    );
  }

  return tiles;
}

/** Wire the settings-driven alert horizons onto the memory tile. */
function withMemHorizons(tiles: TileDef[], alerts: AppAlerts): TileDef[] {
  return tiles.map((t) =>
    t.id !== 'mem'
      ? t
      : {
          ...t,
          horizons: [
            {
              id: 'hz.warn',
              label: `warn ${alerts.mem_warn_gib} GiB`,
              color: HZ_WARN,
              value: alerts.mem_warn_gib,
            },
            {
              id: 'hz.crit',
              label: `crit ${alerts.mem_crit_gib} GiB`,
              color: HZ_CRIT,
              value: alerts.mem_crit_gib,
            },
          ],
        },
  );
}

/* =============================================================================
   Page
   ========================================================================== */

export default function NodeDetailPage(): ReactNode {
  const { nodeId = '' } = useParams<{ nodeId: string }>();
  const clustersQ = useClusters();
  const settingsQ = useSettings();

  const found = useMemo((): { cluster: ClusterTopology; node: NodeConfig } | null => {
    for (const c of clustersQ.data ?? []) {
      const n = c.nodes.find((x) => x.id === nodeId);
      if (n !== undefined) return { cluster: c, node: n };
    }
    return null;
  }, [clustersQ.data, nodeId]);

  if (found !== null) {
    return (
      <NodeDashboard node={found.node} cluster={found.cluster} alerts={settingsQ.data?.alerts ?? null} />
    );
  }

  if (clustersQ.loading || clustersQ.data === null) {
    return <DetailSkeleton />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={`Node ${nodeId !== '' ? nodeId : '—'}`} context="not found in cluster topology" />
      <Panel className="flex flex-1 items-center justify-center">
        <Empty
          icon={<Thermometer />}
          title="Node not found."
          hint={`No node with id "${nodeId}" — the topology may have changed. Check the nodes grid.`}
          action={
            <Link to="/nodes">
              <Btn variant="primary" size="sm">
                Back to nodes
              </Btn>
            </Link>
          }
        />
      </Panel>
    </div>
  );
}

function DetailSkeleton(): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-hidden>
      <Skel className="mb-5 h-7 w-64" />
      <Skel className="mb-4 h-28 w-full" />
      <div className="sd-card-gap grid min-w-0 grid-cols-1 xl:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="sd-panel flex flex-col p-3">
            <Skel className="mb-2 h-4 w-28" />
            <Skel className="h-36 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* =============================================================================
   Dashboard
   ========================================================================== */

function NodeDashboard({
  node,
  cluster,
  alerts,
}: {
  node: NodeConfig;
  cluster: ClusterTopology;
  alerts: AppAlerts | null;
}): ReactNode {
  const accent = accentValid(cluster.accent_color);
  const nodeId = node.id;
  const live = useNodeState(nodeId);
  const sample = useLastSample(nodeId);
  const service = useServiceState(cluster.id);
  const isHead = node.role === 'head';
  const alertsv = alerts ?? ALERT_DEFAULTS;

  const [window, setWindow] = useState<HistWindow>('5m');
  const age = useSampleAge(live);

  const tiles = useMemo(
    () => withMemHorizons(buildLayout(node, sample, isHead), alertsv),
    [node, sample, isHead, alertsv],
  );

  const allNames = useMemo(() => tiles.flatMap((t) => t.series.map((x) => x.id)), [tiles]);
  const histQ = useHistory(allNames.length > 0 ? { nodeId, names: allNames, window, maxPoints: 800 } : null);

  const ringsList = useNodeRings(nodeId, allNames);
  const ringMap = useMemo(() => {
    const m: Record<string, RingSeries> = {};
    allNames.forEach((n, i) => {
      m[n] = ringsList[i] ?? EMPTY_RING;
    });
    return m;
  }, [allNames, ringsList]);

  const liveOn = windowIsLive(window);

  const [hiddenByTile, setHiddenByTile] = useState<Record<string, ReadonlySet<string>>>({});
  const setHidden = (tileId: string, next: ReadonlySet<string> | null): void => {
    setHiddenByTile((prev) => {
      if (next === null) {
        if (!(tileId in prev)) return prev;
        const copy = { ...prev };
        delete copy[tileId];
        return copy;
      }
      return { ...prev, [tileId]: next };
    });
  };

  const hist = histQ.data;
  const curlArgs = allNames.length > 0 ? { nodeId, names: allNames, window, maxPoints: 800 } : null;
  const curl = curlArgs !== null ? historyCurl(curlArgs) : '';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            <Link
              to="/nodes"
              className="text-low transition-colors hover:text-hi"
              title="Back to the node grid"
              aria-label="Back to nodes"
            >
              <ArrowLeft size={16} aria-hidden />
            </Link>
            {node.name}
            <Chip variant="neutral" className="font-mono" title="cluster">
              {cluster.name}
            </Chip>
          </span>
        }
        context={
          <span className="inline-flex flex-wrap items-center gap-2">
            <Chip variant={isHead ? 'accent' : 'neutral'} color={isHead ? accent : undefined} className="font-mono" title="role">
              {node.role}
            </Chip>
            <Chip variant="neutral" className="font-mono" title="rank number in rank-&lt;N&gt;-&lt;profile&gt;.env">
              rank {node.env_rank}
            </Chip>
            <span className="font-mono text-2xs text-low">
              conn {live?.state ?? 'unknown'} · collector {live?.collector ?? 'unprobed'} · last sample {age}
            </span>
          </span>
        }
        actions={
          <>
            {isHead && service !== undefined && (
              <Chip
                variant={service.health === 'up' ? 'ok' : service.health === 'down' ? 'crit' : 'warn'}
                title={service.model !== null ? service.model : 'serving health'}
              >
                <StatusDot state={healthDot(service.health)} size={7} />
                serving {service.health}
              </Chip>
            )}
            <Link
              to="/inference"
              className="hidden font-mono text-2xs text-accent hover:underline sm:inline"
              title="Open the inference console for this pair"
            >
              inference →
            </Link>
          </>
        }
      />

      <FactStrip node={node} live={live} sample={sample} service={service} accent={accent} isHead={isHead} />

      {/* toolbar: per-page window selector + live badge + copy-as-curl */}
      <Panel className="mb-4 flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="sd-monolabel shrink-0">window</span>
          <Tabs
            variant="chip"
            tabs={HIST_WINDOWS.map((w) => ({ id: w, label: w }))}
            value={window}
            onChange={(id) => setWindow(id as HistWindow)}
            ariaLabel="Chart window"
          />
        </div>
        <LiveBadge on={liveOn} />
        <span
          className="min-w-0 truncate font-mono text-2xs text-low"
          title={hist !== null ? `history body: ${fmtIso(hist.from)} → ${fmtIso(hist.to)} · ${hist.resolution_note} resolution` : 'history body: none yet'}
        >
          {hist !== null
            ? `${hist.resolution_note} · refreshed ${fmtAgo(hist.to)} · ${tileCount(allNames)} series`
            : 'no history loaded'}
        </span>
        {histQ.error !== null && (
          <Chip variant="warn" title="history fetch failed — the charts show the last good body until the poll recovers">
            history: {histErrorText(histQ.error)}
          </Chip>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {curlArgs !== null && (
            <Btn
              size="sm"
              variant="ghost"
              icon={<CopyIcon size={12} />}
              title="Copy the exact GET /api/metrics/history request as curl"
              onClick={() => void copyText(curl, 'history query as curl')}
            >
              copy as curl
            </Btn>
          )}
          <Btn size="sm" variant="ghost" icon={<RotateCcw size={12} />} onClick={histQ.reload} title="Refetch history now">
            Reload
          </Btn>
        </div>
      </Panel>

      {/* chart tiles */}
      <div className="sd-card-gap grid min-w-0 grid-cols-1 xl:grid-cols-2">
        {tiles.map((t) => (
          <ChartTile
            key={t.id}
            tile={t}
            window={window}
            hist={hist}
            ringMap={ringMap}
            live={liveOn}
            hidden={hiddenByTile[t.id]}
            onHiddenChange={(next) => setHidden(t.id, next)}
            className={t.span2 === true ? 'xl:col-span-2' : undefined}
          />
        ))}
      </div>

      <p className="mt-4 font-mono text-2xs text-low" title="Wire names per docs/API.md contract">
        series ids are the wire metric names — copy-ready; legend chips toggle series (double-click a chart to reset zoom)
      </p>
    </div>
  );
}

/* -----------------------------------------------------------------------------
   fact strip
   --------------------------------------------------------------------------- */

function FactStrip({
  node,
  live,
  sample,
  service,
  accent,
  isHead,
}: {
  node: NodeConfig;
  live: LiveNodeState | undefined;
  sample: SampleFrame | undefined;
  service: ServiceState | undefined;
  accent: string;
  isHead: boolean;
}): ReactNode {
  const used = live?.addr_used ?? null;
  const connSince = live?.conn_since ?? null;

  return (
    <Panel className="mb-4 p-4">
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
        {/* identity + state */}
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <StatusDot state={connDot(live?.state ?? 'unknown')} title={`conn ${live?.state ?? 'unknown'}`} />
            <span className="text-lg font-semibold text-hi">{node.name}</span>
            <Chip variant={isHead ? 'accent' : 'neutral'} color={isHead ? accent : undefined} className="font-mono">
              {node.role}
            </Chip>
            <Chip variant="neutral" className="font-mono" title="rank-N env file numbering">
              rank {node.env_rank}
            </Chip>
            {!node.enabled && (
              <Chip variant="warn" title="node disabled in the topology">
                disabled
              </Chip>
            )}
            {sample !== undefined && (
              <Chip variant="neutral" className="font-mono" title="latest sampled frame timestamp">
                ts {fmtClock(sample.ts)}
              </Chip>
            )}
          </div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 font-mono text-2xs text-mid">
            <dt className="sd-monolabel">addr_used</dt>
            <dd className="sd-num truncate" title="address the collector last reached this node on">
              {live?.addr_used ?? '—'}
            </dd>
            <dt className="sd-monolabel">conn since</dt>
            <dd className="sd-num">{connSince !== null ? fmtIso(connSince) : '—'}</dd>
            <dt className="sd-monolabel">ssh</dt>
            <dd className="truncate" title={`${node.ssh_user} · port ${node.ssh_port}${node.ssh_alias !== null ? ` · alias ${node.ssh_alias}` : ''}`}>
              {node.ssh_user} · port {node.ssh_port}
              {node.ssh_alias !== null ? ` · alias ${node.ssh_alias}` : ''}
            </dd>
            <dt className="sd-monolabel">api port</dt>
            <dd className="sd-num">
              {node.api_port}
              {isHead && service?.health === 'up' ? ' · serving' : ''}
            </dd>
          </dl>
          {isHead && service?.model != null && (
            <div className="min-w-0 truncate font-mono text-2xs text-mid" title="served model name">
              model <span className="text-hi">{service.model}</span>
              {service.served_models.length > 1 ? ` · +${service.served_models.length - 1} more alias(es)` : ''}
            </div>
          )}
        </div>

        {/* addresses (failover order) + collector */}
        <div className="flex min-w-0 flex-col gap-2">
          <span className="sd-monolabel">addresses (failover order)</span>
          <ol className="flex flex-col gap-1">
            {node.addresses.map((a, i) => {
              const active = used !== null && a.host === used;
              return (
                <li key={`${a.kind}:${a.host}:${i}`} className="flex min-w-0 items-center gap-2 font-mono text-2xs">
                  <span className="w-4 shrink-0 text-low">{i + 1}.</span>
                  <AddressKindIcon kind={a.kind} />
                  <span className={cn('truncate', active ? 'text-accent' : 'text-mid')} title={a.label ?? a.kind}>
                    {a.host}
                  </span>
                  {a.label !== undefined && <span className="truncate text-low">· {a.label}</span>}
                  {active && (
                    <Chip variant="accent" color={accent} className="shrink-0" title="right now traffic flows over this address">
                      in use
                    </Chip>
                  )}
                </li>
              );
            })}
            {node.addresses.length === 0 && (
              <li className="font-mono text-2xs text-low">no addresses configured</li>
            )}
          </ol>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip
              variant={
                live?.collector === 'healthy'
                  ? 'ok'
                  : live?.collector === 'stale'
                    ? 'warn'
                    : live?.collector === 'down'
                      ? 'crit'
                      : 'neutral'
              }
              className="font-mono"
              title="collector probing state (healthy | stale | down | none | unprobed)"
            >
              collector: {live?.collector ?? 'unprobed'}
            </Chip>
            <Chip
              variant={
                live === undefined
                  ? 'neutral'
                  : live.state === 'online'
                    ? 'ok'
                    : live.state === 'degraded'
                      ? 'warn'
                      : live.state === 'offline'
                        ? 'crit'
                        : 'neutral'
              }
              className="font-mono"
              title="SSH/collector transport state"
            >
              conn: {live?.state ?? 'unknown'}
            </Chip>
            {sample !== undefined && (
              <Chip variant="neutral" className="font-mono" title={`last sample — ${fmtIso(sample.ts)}`}>
                {fmtClock(sample.ts)}
              </Chip>
            )}
          </div>
        </div>
      </div>
    </Panel>
  );
}

function AddressKindIcon({ kind }: { kind: string }): ReactNode {
  const size = 12;
  switch (kind) {
    case 'lan':
      return <EthernetPort size={size} aria-hidden />;
    case 'fabric':
      return <Cable size={size} aria-hidden />;
    case 'tailscale':
      return <Globe size={size} aria-hidden />;
    default:
      return <Link2 size={size} aria-hidden />;
  }
}

/* -----------------------------------------------------------------------------
   ChartTile — panel + legend-as-picker + live ring merge
   --------------------------------------------------------------------------- */

function ChartTile({
  tile,
  window,
  hist,
  ringMap,
  live,
  hidden,
  onHiddenChange,
  className,
}: {
  tile: TileDef;
  window: HistWindow;
  hist: HistoryResponse | null;
  ringMap: Record<string, RingSeries>;
  live: boolean;
  hidden: ReadonlySet<string> | undefined;
  onHiddenChange: (next: ReadonlySet<string> | null) => void;
  className?: string;
}): ReactNode {
  const endMs: number = hist !== null && hist.to > 0 ? hist.to : Date.now();
  const startMs: number = hist !== null && hist.from > 0 ? hist.from : endMs - WINDOW_MS[window];

  const data: ChartSeriesData[] = useMemo(
    () =>
      tile.series.map((s) =>
        hist === null
          ? seriesDataFor(s.id, undefined, ringMap[s.id], live, window, endMs)
          : seriesDataFor(s.id, hist.series[s.id], ringMap[s.id], live, window, endMs),
      ),
    [tile.series, hist, ringMap, live, window, endMs],
  );

  const horizonData: ChartSeriesData[] = useMemo(() => {
    const hs = tile.horizons ?? [];
    return hs.map((h) => ({ id: h.id, t: [startMs, endMs], v: [h.value, h.value] }));
  }, [tile.horizons, startMs, endMs]);

  const allDefs: ChartSeriesDef[] = useMemo(
    () => [
      ...tile.series,
      ...(tile.horizons ?? []).map((h) => ({ id: h.id, color: h.color, label: h.label, unit: '' })),
    ],
    [tile.series, tile.horizons],
  );

  const units = useMemo(() => {
    const set = new Set<string>();
    for (const s of tile.series) if (s.unit !== undefined && s.unit !== '') set.add(s.unit);
    return [...set];
  }, [tile.series]);

  const hiddenSet = hidden ?? new Set<string>();

  return (
    <Panel className={cn('min-w-0 flex flex-col p-3 pb-2.5', className)}>
      <div className="mb-1 flex min-w-0 flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate text-xs font-semibold text-hi">{tile.title}</h3>
          {units.map((u) => (
            <Chip key={u} variant="neutral" className="shrink-0 font-mono" title={`series unit: ${u}`}>
              {u}
            </Chip>
          ))}
        </div>
        <Tip text={tile.sub}>
          <span className="truncate font-mono text-2xs text-low" title="metric ids (selectable)">
            {tile.sub}
          </span>
        </Tip>
      </div>
      <TimeChart
        height={tile.height ?? 170}
        series={allDefs}
        data={[...data, ...horizonData]}
        live={live}
        hiddenIds={hiddenSet}
        onHiddenIdsChange={onHiddenChange}
        emptyMessage="No samples recorded for this metric in the window."
      />
    </Panel>
  );
}

/* -----------------------------------------------------------------------------
   misc helpers
   --------------------------------------------------------------------------- */

function useSampleAge(live: LiveNodeState | undefined): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (live?.last_sample_ts === null || live?.last_sample_ts === undefined) return;
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [live?.last_sample_ts]);
  const ts = live?.last_sample_ts;
  if (ts === null || ts === undefined) return 'no live frame';
  const d = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

function fmtAgo(ts: number): string {
  const d = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ${d % 60}s ago`;
  return `${Math.floor(d / 3600)}h ago`;
}

function tileCount(ids: readonly string[]): string {
  return `${ids.length}`;
}

function histErrorText(e: unknown): string {
  const c = e as { code?: string; message?: string; status?: number };
  const code = c.code ?? 'error';
  return `${code}${c.status !== undefined ? ` (http ${c.status})` : ''} — ${c.message ?? 'unknown'}`;
}
