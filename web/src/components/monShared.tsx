/* ============================================================================
   components/monShared — building blocks shared by the monitoring wave
   (Overview / Nodes / Node detail / Inference). Charts+pages wave-local;
   the design-system primitives themselves live in src/ds and stay untouched.
   ========================================================================= */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowDownRight, ArrowUpRight, Copy } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  SERIES_PALETTE,
  Sparkline,
  toast,
  Tip,
  type ChartSeriesData,
  type ChartSeriesDef,
  type DotState,
} from '../ds';
import { fmtCompact, fmtNum } from '../lib/format';
import type { HistorySeries, SampleFrame } from '../api/types';
import { WINDOW_MS, windowIsLive, type HistWindow } from '../api/monitoring';
import { EMPTY_RING, type RingSeries } from '../stores/nodeRings';

/* ---------------------------------------------------------------------------
   colors / palette
   --------------------------------------------------------------------------- */

/** Stagger-safe palette pick — stable per index. */
export function paletteAt(i: number): string {
  return SERIES_PALETTE[((i % SERIES_PALETTE.length) + SERIES_PALETTE.length) % SERIES_PALETTE.length] as string;
}

/** Theme-varying semantics for plain-string consumers (lists with stars). */
export const TONE_HEX = {
  warn: '#FBBF24',
  crit: '#F87171',
  ok: '#4ADE80',
} as const;

/** Validate a runtime accent: `#rgb`/`#rrggbb` else the app accent token. */
export function accentValid(color: string | null | undefined): string {
  if (color !== undefined && color !== null && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)) {
    return color;
  }
  return '#5EB1FF';
}

/** conn/live state → DotState (for wire enums, incl. unknown strings). */
export function connDotState(state: string | null | undefined): DotState {
  switch (state) {
    case 'online':
      return 'ok';
    case 'degraded':
    case 'connecting':
      return 'degraded';
    case 'offline':
      return 'offline';
    case 'disabled':
      return 'disabled';
    default:
      return 'unknown';
  }
}

/* ---------------------------------------------------------------------------
   numerics
   --------------------------------------------------------------------------- */

export function parseNum(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function pickSample(series: SampleFrame['series'] | undefined, id: string): number | null {
  if (series === undefined) return null;
  return parseNum(series[id]);
}

/** "524288" → "512k" (context tokens). */
export function fmtCtx(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens <= 0) return null;
  if (tokens >= 1_048_576) {
    const m = tokens / 1_048_576;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1024 && tokens % 1024 === 0) return `${tokens / 1024}k`;
  return fmtCompact(tokens);
}

/** "1,466,929 tokens ≈ 2.8× 512k" — the pieces the header composes. */
export function kvMultiplier(tokens: number, contextTokens: number | null): number | null {
  if (contextTokens === null || !Number.isFinite(contextTokens) || contextTokens <= 0) return null;
  return tokens / contextTokens;
}

/* ---------------------------------------------------------------------------
   clipboard
   --------------------------------------------------------------------------- */

export async function copyText(text: string, what?: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.ok(what === undefined ? 'Copied to clipboard' : `${what} copied`);
    return;
  } catch {
    /* clipboard API unavailable/file:// — fall through to the legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast.ok(what === undefined ? 'Copied to clipboard' : `${what} copied`);
  } catch {
    toast.error('Clipboard blocked — the value is logged in the console');
    // eslint-disable-next-line no-console
    console.log(`[sparkdeck] ${what ?? 'value'}:\n${text}`);
  }
}

/* ---------------------------------------------------------------------------
   ticker — for "3s ago" age chips (cheap, single instance per consumer)
   --------------------------------------------------------------------------- */

export function useTicker(ms = 1000): number {
  const [ts, setTs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setTs(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return ts;
}

/* ---------------------------------------------------------------------------
   skeletons (subtle pulse, no shimmer dependency)
   --------------------------------------------------------------------------- */

export function Skel({ className }: { className?: string }): ReactNode {
  return (
    <div
      aria-hidden
      className={cn('animate-pulse rounded-inner bg-bg2/70 border border-stroke/50', className)}
    />
  );
}

export function SkelLines({ lines, className }: { lines: number; className?: string }): ReactNode {
  return (
    <div className={cn('flex flex-col gap-2', className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skel key={i} className={cn('h-3', i === lines - 1 ? 'w-2/5' : 'w-full')} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   MetricTile — DESIGN "Metric tile": mono caps label, big tabular value,
   unit suffix small+low, 120px sparkline beneath, optional delta arrow.
   `id` is shown in the label tooltip (copy-friendly metric ids).
   --------------------------------------------------------------------------- */

export interface MetricTileProps {
  label: string;
  value: number | null;
  unit?: string;
  /** numerals ≤1000 show `digits` decimals (default 1) */
  digits?: number;
  /** canonical series id — shown as a tooltip so it can be copied */
  id?: string;
  hint?: string;
  /** 120×26 sparkline of the same series (ring data) */
  spark?: Array<number | null>;
  sparkColor?: string;
  delta?: number | null;
  /** value text overrides auto-format (e.g. preformatted strings) */
  text?: string;
  accent?: string;
  footer?: ReactNode;
  className?: string;
  loading?: boolean;
}

function tileValue(v: number | null, digits: number, text: string | undefined): string {
  if (text !== undefined) return text;
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return fmtCompact(v);
  if (Number.isInteger(v)) return fmtNum(v);
  return v.toFixed(digits);
}

export function MetricTile({
  label,
  value,
  unit,
  digits = 1,
  id,
  hint,
  spark,
  sparkColor,
  delta,
  text,
  accent,
  footer,
  className,
  loading = false,
}: MetricTileProps): ReactNode {
  const color = accent ?? 'var(--sd-accent)';
  const deltaColor =
    delta === null || delta === undefined || Math.abs(delta) < 1e-9
      ? 'var(--sd-low)'
      : delta > 0
        ? 'var(--sd-ok)'
        : 'var(--sd-crit)';
  const shown = tileValue(value, digits, text);
  return (
    <div
      className={cn(
        'sd-panel flex min-w-0 flex-col gap-2 p-3 animate-[sd-fade-in_150ms_cubic-bezier(0.22,0.61,0.36,1)_both]',
        className,
      )}
    >
      <Tip text={id ?? undefined}>
        <span className="sd-monolabel max-w-full truncate">{label}</span>
      </Tip>
      {loading ? (
        <Skel className="h-7 w-24" />
      ) : (
        <div className="flex items-baseline gap-1.5">
          <span className="sd-num truncate font-mono text-[19px] leading-tight font-semibold text-hi" style={accent === undefined ? undefined : { color }}>
            {shown}
          </span>
          {unit !== undefined && <span className="text-2xs text-low">{unit}</span>}
          {delta !== null && delta !== undefined && Math.abs(delta) >= 1e-9 && (
            <span
              className="ml-1 inline-flex items-center gap-0.5 font-mono text-2xs text-low"
              title="vs window start"
            >
              {delta > 0 ? (
                <ArrowUpRight size={11} style={{ color: deltaColor }} />
              ) : (
                <ArrowDownRight size={11} style={{ color: deltaColor }} />
              )}
              <span className="sd-num" style={{ color: deltaColor }}>
                {delta > 0 ? '+' : ''}
                {fmtCompact(delta)}
              </span>
            </span>
          )}
        </div>
      )}
      {spark !== undefined && spark.length > 0 && (
        <Sparkline values={spark} color={sparkColor ?? color} width={120} height={24} title={id} />
      )}
      {hint !== undefined && <span className="truncate text-2xs text-low">{hint}</span>}
      {footer}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Chart data plumbing — REST history + live ring tail merge.
   --------------------------------------------------------------------------- */

export interface ChartWindow {
  window: HistWindow;
  live: boolean;
}

/** Build TimeChart data for one canonical series.
    `hist.series[name]` holds the polled REST history (or nothing); when the
    window is live (5m/15m) the client ring tail is stitched after the last
    REST point so the chart appends continuously between polls. */
export function seriesDataFor(
  name: string,
  hist: HistorySeries | undefined,
  ring: RingSeries | undefined,
  live: boolean,
  window: HistWindow,
  now = Date.now(),
): ChartSeriesData {
  if (!live) {
    if (hist === undefined) return { id: name, t: [], v: [] };
    return { id: name, t: hist.t, v: hist.v };
  }

  const winStart = now - WINDOW_MS[window];
  const ringP = ring !== undefined && ring !== EMPTY_RING ? ring : undefined;

  if (hist === undefined || hist.t.length === 0) {
    if (ringP === undefined) return { id: name, t: [], v: [] };
    const lo = ringP.t.findIndex((t) => t >= winStart);
    const s = lo < 0 ? ringP.t.length : lo;
    return { id: name, t: ringP.t.slice(s), v: ringP.v.slice(s) };
  }

  const lastT = hist.t[hist.t.length - 1]!;
  if (ringP === undefined) return { id: name, t: hist.t, v: hist.v };
  const cut = ringP.t.length > 0 && ringP.t[ringP.t.length - 1]! <= lastT;
  if (cut) return { id: name, t: hist.t, v: hist.v };
  // stitch: REST slice up to lastT, then ring points strictly after it
  let i = ringP.t.findIndex((t) => t > lastT);
  if (i < 0) i = ringP.t.length;
  const tailT: number[] = [];
  const tailV: Array<number | null> = [];
  for (; i < ringP.t.length; i++) {
    tailT.push(ringP.t[i]!);
    tailV.push(ringP.v[i] ?? null);
  }
  return { id: name, t: [...hist.t, ...tailT], v: [...hist.v, ...tailV] };
}

/** One constant "alert horizon" line across the visible window. */
export function horizonSeries(
  startMs: number,
  endMs: number,
  value: number,
  id: string,
  label: string,
  color: string,
): { def: ChartSeriesDef; data: ChartSeriesData } {
  return {
    def: { id, color, label, unit: 'GiB' },
    data: { id, t: [startMs, endMs], v: [value, value] },
  };
}

/* ---------------------------------------------------------------------------
   Live chart tile state helper — value + ring + delta in one.
   --------------------------------------------------------------------------- */

export function deltaFromStart(d: ChartSeriesData | undefined): number | null {
  if (d === undefined || d.v.length < 2) return null;
  let first: number | null = null;
  for (const v of d.v) {
    if (typeof v === 'number') {
      first = v;
      break;
    }
  }
  let last: number | null = null;
  for (let i = d.v.length - 1; i >= 0; i--) {
    const v = d.v[i];
    if (typeof v === 'number') {
      last = v;
      break;
    }
  }
  if (first === null || last === null) return null;
  return last - first;
}

/** Hook-side memo helper: value+delta for a metric tile from current data. */
export function useMetricValue(d: ChartSeriesData | undefined): { value: number | null; delta: number | null } {
  return useMemo(() => {
    if (d === undefined) return { value: null, delta: null };
    const n = d.v.length;
    let last: number | null = null;
    for (let i = n - 1; i >= 0; i--) {
      const v = d.v[i];
      if (typeof v === 'number') {
        last = v;
        break;
      }
    }
    return { value: last, delta: deltaFromStart(d) };
    // d identity changes when its arrays change — enough for useMemo
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d]);
}

/* ---------------------------------------------------------------------------
   Window/live chips + copy affordance for the composited chart tiles
   --------------------------------------------------------------------------- */

export function LiveBadge({ on }: { on: boolean }): ReactNode {
  return (
    <span
      title={on ? 'Streaming live from the samples topic' : 'Polled snapshot'}
      className={cn(
        'inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] uppercase',
        on ? 'text-accent' : 'text-low',
      )}
    >
      <span
        className={cn('inline-block h-1.5 w-1.5 rounded-full', on && 'sd-dot-pulse')}
        style={on ? { background: 'var(--sd-accent)', color: 'var(--sd-accent)' } : { background: 'var(--sd-low)' }}
        aria-hidden
      />
      {on ? 'live' : 'polled'}
    </span>
  );
}

/* chart interop edge — echarts option is built inside ds/chart; this helper
   only times the latest mergeable (number | null) point. */
export function lastPoint(d: ChartSeriesData | undefined): [number, number] | null {
  if (d === undefined) return null;
  for (let i = d.v.length - 1; i >= 0; i--) {
    const v = d.v[i];
    if (typeof v === 'number') return [d.t[i] ?? Date.now(), v];
  }
  return null;
}

/** Copy helper for tile headers (e.g. the exact metrics query as curl). */
export function CopyBtn({
  text,
  what,
  title,
  size = 12,
  className,
}: {
  text: string;
  what?: string;
  title?: string;
  size?: number;
  className?: string;
}): ReactNode {
  return (
    <button
      type="button"
      title={title ?? `Copy (${what ?? 'text'})`}
      aria-label={title ?? 'Copy to clipboard'}
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text, what);
      }}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1 rounded-inner p-1 text-low transition-colors duration-fast hover:bg-bg2 hover:text-hi',
        className,
      )}
    >
      <Copy size={size} />
    </button>
  );
}
