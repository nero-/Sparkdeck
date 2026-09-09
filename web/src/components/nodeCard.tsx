/* ============================================================================
   components/nodeCard — the per-node mini-card shared by Overview and Nodes
   (DESIGN.md "Node card: one glance = is this node healthy").

   PERFORMANCE CONTRACT (the browser-lag lesson): the card NEVER subscribes
   to whole sample frames. Every meter reads its own PRIMITIVE via a stable
   selector (useSampleValue / useShallow string lists), so React re-renders
   only when a displayed number actually changes — not on every WS tick.
   The card itself is memo()'d: parent grids (overview/nodes) re-render on
   events/ops churn without dragging every card along.
   ========================================================================= */

import { memo, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Cable, Container, EthernetPort, Globe, Link2, Thermometer } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cn } from '../lib/cn';
import { Bar, Chip, Gauge, Sparkline, StatusDot, connDot, Tip } from '../ds';
import { useSampleValue } from '../stores/live';
import { useWs } from '../api/client';
import { RING_CAP, useNodeRings } from '../stores/nodeRings';
import { fmtGiB, fmtNum } from '../lib/format';
import type { LiveNodeState, NodeConfig } from '../api/types';

export interface NodeAlerts {
  mem_warn_pct: number;
  mem_crit_pct: number;
  gpu_temp_warn_c: number;
  gpu_temp_crit_c: number;
}

export const NODE_ALERT_DEFAULTS: Required<NodeAlerts> = {
  mem_warn_pct: 95,
  mem_crit_pct: 98,
  gpu_temp_warn_c: 86,
  gpu_temp_crit_c: 94,
};

function alertsFull(alerts: NodeAlerts | null | undefined): Required<NodeAlerts> {
  return alerts ?? NODE_ALERT_DEFAULTS;
}

const COLLECTOR_TONE = {
  healthy: 'ok',
  stale: 'warn',
  down: 'crit',
  none: 'neutral',
  unprobed: 'neutral',
} as const;

/* ---------------------------------------------------------------------------
   NodeCard — compact: dot·name·role, addr+collector, gpu gauge (value placed
   BELOW the ring — center text collided at this size), mem bar anchored to
   the node's real memory total with an explicit % readout, temp chip, net rx
   sparkline, docker-container chips.
   --------------------------------------------------------------------------- */

export const NodeCard = memo(function NodeCard({
  node,
  accent,
  state,
  alerts,
  className,
}: {
  node: NodeConfig;
  accent: string;
  state: LiveNodeState | undefined;
  alerts: NodeAlerts | null | undefined;
  className?: string;
}): ReactNode {
  const conn = state?.state ?? 'unknown';
  const collector = state?.collector ?? 'unprobed';
  const isHead = node.role === 'head';
  const alertsv = alertsFull(alerts);

  return (
    <Link
      to={`/nodes/${encodeURIComponent(node.id)}`}
      title={`Open node dashboard — ${node.name}`}
      className={cn(
        'sd-raised group flex min-w-0 cursor-pointer flex-col gap-2.5 p-3 transition-colors duration-fast hover:border-stroke-strong',
        node.enabled ? undefined : 'opacity-70',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot state={connDot(conn)} size={8} title={`conn ${conn}`} />
        <span className="truncate text-xs font-semibold text-hi group-hover:underline">{node.name}</span>
        <Chip
          variant={isHead ? 'accent' : 'neutral'}
          color={isHead ? accent : undefined}
          className="font-mono"
          title={`role ${node.role} · rank ${node.env_rank}`}
        >
          {isHead ? 'head' : `r${node.env_rank}`}
        </Chip>
        {node.enabled ? null : (
          <Chip variant="warn" title="node disabled in the topology">
            disabled
          </Chip>
        )}
        <span
          className="ml-auto min-w-0 truncate font-mono text-2xs text-low"
          title="addr_used — the address this node was last reached on"
        >
          {state?.addr_used ?? '—'}
        </span>
      </div>

      <div className="flex items-start gap-3">
        <GpuGaugeMini nodeId={node.id} accent={accent} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <MemBarMini nodeId={node.id} alerts={alertsv} />
          <div className="flex min-w-0 items-center gap-2">
            <TempChipMini nodeId={node.id} alerts={alertsv} />
            <NetSparkMini node={node} accent={accent} />
          </div>
        </div>
      </div>

      <DockerChips nodeId={node.id} accent={accent} />

      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-stroke pt-1.5">
        <Chip
          variant={COLLECTOR_TONE[collector] as 'ok' | 'warn' | 'crit' | 'neutral'}
          title={`collector — pushes samples every tick (${collector})`}
          className="font-mono"
        >
          collector: {collector}
        </Chip>
        {state?.state === 'online' && state.conn_since !== null && (
          <span className="font-mono text-2xs text-low" title="connection established">
            {new Date(state.conn_since).toLocaleTimeString()}
          </span>
        )}
      </div>
    </Link>
  );
});

/* ---------------------------------------------------------------------------
   The meters — each reads ONE primitive from the shared live store.
   --------------------------------------------------------------------------- */

export function GpuGaugeMini({ nodeId, accent }: { nodeId: string; accent: string }): ReactNode {
  const util = useSampleValue(nodeId, 'gpu.util');
  return (
    <Gauge
      value={util}
      size={56}
      unit="%"
      color={accent}
      valueMode="below"
      className="shrink-0"
      title={`gpu.util — ${util === null ? 'no sample yet' : `${util.toFixed(1)}%`}`}
    />
  );
}

/** Total unified memory of the node — mem.total_gib when the collector maps
    it, falling back to used+avail (MemAvailable semantics make that exact
    for GB10 unified boards). Keeps the bar anchored to something absolute;
    anchoring to `used` itself made the fill asymptote and freeze (bug). */
function useMemTotalGib(nodeId: string): number | null {
  const total = useSampleValue(nodeId, 'mem.total_gib');
  const used = useSampleValue(nodeId, 'mem.used_gib');
  const avail = useSampleValue(nodeId, 'mem.avail_gib');
  if (total !== null && total > 0) return total;
  if (used !== null && avail !== null && used + avail > 0) return used + avail;
  return null;
}

export function MemBarMini({ nodeId, alerts }: { nodeId: string; alerts: Required<NodeAlerts> }): ReactNode {
  const used = useSampleValue(nodeId, 'mem.used_gib');
  const total = useMemTotalGib(nodeId);
  const { mem_warn_pct: warnPct, mem_crit_pct: critPct } = alerts;
  const max = total ?? 0;
  const warnGib = max > 0 ? (max * warnPct) / 100 : 0;
  const critGib = max > 0 ? (max * critPct) / 100 : 0;
  const pct = used !== null && max > 0 ? Math.min(100, (used / max) * 100) : null;
  const valueColor =
    used === null ? 'var(--sd-low)'
      : pct !== null && pct >= critPct ? 'var(--sd-crit)'
        : pct !== null && pct >= warnPct ? 'var(--sd-warn)' : 'var(--sd-mid)';
  return (
    <div
      className="min-w-0"
      title={`mem.used_gib — ${used === null ? 'no sample' : `${fmtGiB(used)} of ${max > 0 ? fmtGiB(max) : '?'} (${pct === null ? '—' : pct.toFixed(1)}%) · warn ${warnPct}% / crit ${critPct}% of total`}`}
    >
      <div className="mb-0.5 flex items-baseline justify-between gap-2">
        <span className="sd-monolabel">mem</span>
        <span className="sd-num font-mono text-2xs" style={{ color: valueColor }}>
          {used === null ? '—' : `${fmtGiB(used)} · ${pct === null ? '—' : pct.toFixed(0)}%`}
        </span>
      </div>
      <Bar
        value={used}
        max={max}
        horizon={max > 0 ? warnGib / max : null}
        thresholds={
          max > 0
            ? [
                { at: warnGib, color: '#FBBF24' },
                { at: critGib, color: '#F87171' },
              ]
            : []
        }
        title={`mem used of total · warn at ${warnPct}% · crit at ${critPct}% of ${max > 0 ? fmtGiB(max) : '?'}`}
        height={5}
      />
    </div>
  );
}

export function TempChipMini({ nodeId, alerts }: { nodeId: string; alerts: Required<NodeAlerts> }): ReactNode {
  const temp = useSampleValue(nodeId, 'gpu.temp');
  const { gpu_temp_warn_c: warn, gpu_temp_crit_c: crit } = alerts;
  const variant = temp === null ? 'neutral' : temp >= crit ? 'crit' : temp >= warn ? 'warn' : 'neutral';
  return (
    <Chip
      variant={variant}
      className="shrink-0"
      title={`gpu.temp — ${temp === null ? 'no sample' : `${temp.toFixed(1)}°C (warn ${warn}°, crit ${crit}°)`}`}
    >
      <Thermometer size={11} aria-hidden />
      <span className="sd-num font-mono">{temp === null ? '—°' : `${(Math.round(temp * 10) / 10).toFixed(1)}°`}</span>
    </Chip>
  );
}

/** Busiest interface id chosen from the live sample — a STRING selector so
    the component re-renders only when the ranking actually changes. */
export function useBusiestIface(nodeId: string): string | null {
  return useWs(
    useShallow((s): string | null => {
      const series = s.lastSampleByNode[nodeId]?.series;
      if (!series) return null;
      let best: { name: string; rx: number } | null = null;
      for (const key in series) {
        if (!key.startsWith('net.') || !key.endsWith('.rx_kbps')) continue;
        const rx = series[key];
        const n = key.slice(4, -7);
        if (typeof rx === 'number' && Number.isFinite(rx) && (best === null || rx > best.rx)) {
          best = { name: n, rx };
        }
      }
      return best?.name ?? null;
    }),
  );
}

/** net rx sparkline for the node's primary iface (interest_ifaces[0] first,
    else the currently busiest iface in the sample). */
export function NetSparkMini({ node, accent }: { node: NodeConfig; accent: string }): ReactNode {
  const busiest = useBusiestIface(node.id);
  const rxId = useMemo(() => {
    const interest = node.interest_ifaces[0];
    if (interest !== undefined && interest !== '') return `net.${interest}.rx_kbps`;
    return busiest !== null ? `net.${busiest}.rx_kbps` : null;
  }, [node.interest_ifaces, busiest]);

  const rings = useNodeRings(node.id, rxId !== null ? [rxId] : []);
  const ring = rings[0];
  if (rxId === null) return null;
  return (
    <Tip text={`${rxId} — last ${RING_CAP} live samples`}>
      <Sparkline
        values={ring?.v ?? []}
        color={accent}
        width={90}
        height={22}
        title={`net rx kbit/s — last ${RING_CAP} live samples`}
        className="ml-auto shrink-0"
      />
    </Tip>
  );
}

/* ---------------------------------------------------------------------------
   Docker-aware container chips — swept from the sample's docker series
   (ids like docker.<ctr>.cpu_pct / .mem_gib). useShallow over the NAME list:
   re-render only when a container appears/disappears, not per tick.
   --------------------------------------------------------------------------- */

export function DockerChips({ nodeId, accent }: { nodeId: string; accent: string }): ReactNode {
  const names = useWs(
    useShallow((s): string[] => {
      const series = s.lastSampleByNode[nodeId]?.series;
      if (!series) return [];
      const set = new Set<string>();
      for (const key in series) {
        const m = /^docker\.(.+)\.cpu_pct$/.exec(key);
        if (m !== null && m[1] !== undefined) set.add(m[1]);
      }
      return [...set].sort();
    }),
  );
  if (names.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {names.map((ctr) => (
        <ContainerChip key={ctr} nodeId={nodeId} ctr={ctr} accent={accent} />
      ))}
    </div>
  );
}

function ContainerChip({ nodeId, ctr, accent }: { nodeId: string; ctr: string; accent: string }): ReactNode {
  const cpu = useSampleValue(nodeId, `docker.${ctr}.cpu_pct`);
  const mem = useSampleValue(nodeId, `docker.${ctr}.mem_gib`);
  return (
    <Tip
      text={`docker kernels for ${ctr}: cpu_pct ${cpu === null ? '—' : cpu.toFixed(0)}% · mem_gib ${mem === null ? '—' : mem.toFixed(1)} (from the latest sample frame)`}
    >
      <Chip variant="ok" title={`container ${ctr} reported by the collector's docker tick`} className="font-mono">
        <Container size={10} aria-hidden style={{ color: accent }} />
        <span className="max-w-[150px] truncate">{ctr}</span>
        <span className="sd-num text-low">{cpu === null ? '—' : fmtNum(Math.round(cpu))}%</span>
        <span className="sd-num text-low">{mem === null ? '' : fmtGiB(mem)}</span>
      </Chip>
    </Tip>
  );
}

/** Address-kind icon — NodeCard/detail list helper (kept local to the wave). */
export function AddressKindIcon({ kind, size = 12 }: { kind: string; size?: number }): ReactNode {
  const common = size;
  switch (kind) {
    case 'lan':
      return <EthernetPort size={common} aria-hidden />;
    case 'fabric':
      return <Cable size={common} aria-hidden />;
    case 'tailscale':
      return <Globe size={common} aria-hidden />;
    default:
      return <Link2 size={common} aria-hidden />;
  }
}
