/* ============================================================================
   components/nodeCard — the per-node mini-card shared by Overview and Nodes
   (DESIGN.md "Node card: one glance = is this node healthy").
   Reads its own live state from the WS buffers, so it can be embedded anywhere.
   ========================================================================= */

import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Cable, Container, EthernetPort, Globe, Link2, Thermometer } from 'lucide-react';
import { cn } from '../lib/cn';
import { Bar, Chip, Gauge, Sparkline, StatusDot, connDot, Tip } from '../ds';
import { useLive } from '../stores/live';
import { RING_CAP, containersFromSample, ifacesFromSample, useNodeRings } from '../stores/nodeRings';
import { parseNum, pickSample } from './monShared';
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
   NodeCard — compact: dot·name·role, addr+collector, gpu gauge, mem bar
   (warn horizon), temp chip, net rx sparkline, docker-container chips.
   --------------------------------------------------------------------------- */

export function NodeCard({
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
  const sample = useLive((s) => s.lastSampleByNode[node.id]);
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
        <StatusDot state={connDot(state?.state ?? 'unknown')} size={8} title={`conn ${state?.state ?? 'unknown'}`} />
        <span className="truncate text-xs font-semibold text-hi group-hover:underline">{node.name}</span>
        <Chip
          variant={isHead ? 'accent' : 'neutral'}
          color={isHead ? accent : undefined}
          className="font-mono"
          title={`role ${node.role} · env_rank ${node.env_rank}`}
        >
          {isHead ? 'head' : `w${node.env_rank}`}
        </Chip>
        {node.enabled ? null : (
          <Chip variant="warn" title="node disabled in the topology">
            disabled
          </Chip>
        )}
        <span
          className="ml-auto min-w-0 truncate font-mono text-2xs text-low"
          title={`addr_used — the address this node was last reached on`}
        >
          {state?.addr_used ?? '—'}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <GpuGaugeMini nodeId={node.id} accent={accent} />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <MemBarMini nodeId={node.id} alerts={alertsv} />
          <div className="flex min-w-0 items-center gap-2">
            <TempChipMini nodeId={node.id} alerts={alertsv} />
            <NetSparkMini node={node} sample={sample} accent={accent} />
          </div>
        </div>
      </div>

      <DockerChips sample={sample} accent={accent} />

      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-t border-stroke pt-1.5">
        <Chip
          variant={COLLECTOR_TONE[state?.collector ?? 'unprobed'] as 'ok' | 'warn' | 'crit' | 'neutral'}
          title={`collector — pushes samples every tick (${state?.collector ?? 'unprobed'})`}
          className="font-mono"
        >
          collector: {state?.collector ?? 'unprobed'}
        </Chip>
        {state?.state === 'online' && state.conn_since !== null && (
          <span className="font-mono text-2xs text-low" title="connection established">
            {new Date(state.conn_since).toLocaleTimeString()}
          </span>
        )}
      </div>
    </Link>
  );
}

/* ---------------------------------------------------------------------------
   The meters — value reads from the latest sample frame; sparklines from the
   client ring buffers fed by the samples topic (60 points ≈ last minute).
   --------------------------------------------------------------------------- */

export function GpuGaugeMini({ nodeId, accent }: { nodeId: string; accent: string }): ReactNode {
  const sample = useLive((s) => s.lastSampleByNode[nodeId]);
  const util = parseNum(sample?.series['gpu.util']);
  return (
    <Gauge
      value={util}
      size={56}
      unit="%"
      color={accent}
      className="shrink-0"
      title={`gpu.util — ${util === null ? 'no sample yet' : `${util.toFixed(1)}%`}`}
    />
  );
}

export function MemBarMini({ nodeId, alerts }: { nodeId: string; alerts: Required<NodeAlerts> }): ReactNode {
  const sample = useLive((s) => s.lastSampleByNode[nodeId]);
  const used = parseNum(sample?.series['mem.used_gib']);
  // the bar is anchored to the REAL memory total — anchoring it to the used
  // value made the fill asymptote and stop moving (review + operator report)
  const total = parseNum(sample?.series['mem.total_gib']);
  const max = total !== null && total > 0 ? total : (used !== null ? used + 4 : 0);
  const { mem_warn_pct: warnPct, mem_crit_pct: critPct } = alerts;
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
      title={`mem.used_gib — ${used === null ? 'no sample' : `${fmtGiB(used)} of ${max > 0 ? fmtGiB(max) : '?'} (${pct === null ? '—' : pct.toFixed(1)}%)`}`}
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
  const sample = useLive((s) => s.lastSampleByNode[nodeId]);
  const temp = pickSample(sample?.series, 'gpu.temp');
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

/** net rx sparkline for the node's primary iface (interest_ifaces[0] first,
    else the currently busiest iface in the sample). */
export function NetSparkMini({
  node,
  sample,
  accent,
}: {
  node: NodeConfig;
  sample: { ts: number; series: Record<string, number | null> } | undefined;
  accent: string;
}): ReactNode {
  const digest = sample === undefined ? undefined : ifacesFromSample(sample.series);
  const rxId = useMemo(() => {
    const interest = node.interest_ifaces[0];
    if (interest !== undefined && interest !== '') return `net.${interest}.rx_kbps`;
    const busiest = digest !== undefined && digest.length > 0 ? digest[0] : undefined;
    return busiest !== undefined ? `net.${busiest.iface}.rx_kbps` : null;
  }, [node.interest_ifaces, digest]);

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
   Docker-aware container chips — swept from the live sample's docker series
   (ids like docker.<ctr>.cpu_pct / .mem_gib). Present == container alive as
   seen by the collector's docker stats tick.
   --------------------------------------------------------------------------- */

export function DockerChips({ sample, accent }: { sample: { ts: number; series: Record<string, number | null> } | undefined; accent: string }): ReactNode {
  const names = sample === undefined ? [] : containersFromSample(sample.series);
  if (names.length === 0) return null;
  const chips = names.map((ctr) => {
    const cpu = pickSample(sample?.series, `docker.${ctr}.cpu_pct`);
    const mem = pickSample(sample?.series, `docker.${ctr}.mem_gib`);
    return { ctr, cpu, mem };
  });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <Tip
          key={c.ctr}
          text={`docker kernels for ${c.ctr}: cpu_pct ${c.cpu === null ? '—' : c.cpu.toFixed(0)}% · mem_gib ${c.mem === null ? '—' : c.mem.toFixed(1)} (from the latest sample frame)`}
        >
          <Chip variant="ok" title={`container ${c.ctr} reported by the collector's docker tick`} className="font-mono">
            <Container size={10} aria-hidden style={{ color: accent }} />
            <span className="max-w-[150px] truncate">{c.ctr}</span>
            <span className="sd-num text-low">{c.cpu === null ? '—' : fmtNum(Math.round(c.cpu))}%</span>
            <span className="sd-num text-low">{c.mem === null ? '' : fmtGiB(c.mem)}</span>
          </Chip>
        </Tip>
      ))}
    </div>
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
