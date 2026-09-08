/* ============================================================================
   ds/chart — TimeChart (echarts/core, tree-shaken) + Sparkline (plain canvas).

   TimeChart: linear interpolation only, gaps as nulls, hover crosshair with
   floating legend chips (click a legend chip to hide its series), inside +
   slider dataZoom, double-click reset. Window chips live in the parent.
   Live-append friendly: setOption uses { replaceMerge: ['series'] } so the
   zoom state survives data updates; animation is off (numerals are instant).

   Spinner styling/theming reads live CSS tokens via ds/tokens.ts, so a light
   theme later re-themes charts without touching this file.
   ========================================================================= */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as echarts from 'echarts/core';
import { LineChart, type LineSeriesOption } from 'echarts/charts';
import {
  DataZoomComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  TooltipComponent,
  type DataZoomComponentOption,
  type GridComponentOption,
  type TooltipComponentOption,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ComposeOption } from 'echarts/core';
import { cn } from '../lib/cn';
import { chartTokens } from './tokens';
import { decimateSeries } from './lttb';
import { fmtCompact, fmtIso } from '../lib/format';
import { Empty } from './primitives';

echarts.use([
  LineChart,
  GridComponent,
  TooltipComponent,
  DataZoomComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  CanvasRenderer,
]);

type ECOption = ComposeOption<
  | LineSeriesOption
  | GridComponentOption
  | TooltipComponentOption
  | DataZoomComponentOption
>;

const DECIMATE_THRESHOLD = 1500;
const DECIMATE_TARGET = 1400;

export interface ChartSeriesDef {
  /** canonical series id (e.g. "gpu.util") — also the echarts series id */
  id: string;
  color: string;
  label: string;
  unit?: string;
}

export interface ChartSeriesData {
  /** series id this data belongs to */
  id: string;
  t: number[];
  v: Array<number | null>;
}

export interface TimeChartProps {
  series: ChartSeriesDef[];
  data: ChartSeriesData[];
  height?: number;
  /** show the streaming "live" pulse */
  live?: boolean;
  /** LTTB-decimate beyond ~1500 points (default true) */
  decimate?: boolean;
  /** window chips belong to the parent — this is only a hint label for empty state */
  emptyMessage?: string;
  /** controlled legend (optional; internal state used otherwise) */
  hiddenIds?: ReadonlySet<string>;
  onHiddenIdsChange?: (next: Set<string>) => void;
  valueFormatter?: (v: number) => string;
  onDoubleClickReset?: () => void;
  className?: string;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function defaultFormat(v: number, unit?: string): string {
  if (!Number.isFinite(v)) return '—';
  const body =
    Math.abs(v) >= 1000
      ? fmtCompact(v)
      : Number.isInteger(v)
        ? String(v)
        : v.toFixed(Math.abs(v) < 10 ? 2 : 1);
  return unit === undefined ? body : `${body}${unit === '%' ? '' : ' '}${unit}`;
}

export function TimeChart({
  series,
  data,
  height = 220,
  live = false,
  decimate = true,
  emptyMessage = 'No samples in this window yet.',
  hiddenIds,
  onHiddenIdsChange,
  valueFormatter,
  onDoubleClickReset,
  className,
}: TimeChartProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  const [internalHidden, setInternalHidden] = useState<ReadonlySet<string>>(new Set());
  const hidden = hiddenIds ?? internalHidden;

  const toggleHidden = (id: string): void => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (onHiddenIdsChange !== undefined) onHiddenIdsChange(next);
    else setInternalHidden(next);
  };

  const dataByKey = useMemo(() => {
    const m = new Map<string, ChartSeriesData>();
    for (const d of data) m.set(d.id, d);
    return m;
  }, [data]);

  const visibleSeries = useMemo(() => series.filter((s) => !hidden.has(s.id)), [series, hidden]);

  /* data → echarts pairs [[t, v], …], decimated when huge */
  const built = useMemo(() => {
    return visibleSeries.map((s) => {
      const d = dataByKey.get(s.id);
      let points: Array<[number, number | null]> = [];
      if (d !== undefined) {
        const prepared =
          decimate && d.t.length > DECIMATE_THRESHOLD
            ? decimateSeries({ t: d.t, v: d.v }, DECIMATE_TARGET)
            : { t: d.t, v: d.v };
        points = prepared.t.map((t, i) => [t, prepared.v[i] ?? null] as [number, number | null]);
      }
      return { def: s, points };
    });
  }, [visibleSeries, dataByKey, decimate]);

  const hasAnyData = built.some((b) => b.points.length > 0);

  /* chart lifecycle --------------------------------------------------------- */
  useEffect(() => {
    const el = wrapRef.current;
    if (el === null) return;
    const chart = echarts.init(el, undefined, { renderer: 'canvas' });
    chartRef.current = chart;

    const onDbl = () => {
      chart.dispatchAction({ type: 'dataZoom', start: 0, end: 100 });
      onDoubleClickReset?.();
    };
    chart.on('dblclick', onDbl);

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        chart.resize({ animation: { duration: 0 } });
      });
    });
    ro.observe(el);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      chart.off('dblclick', onDbl);
      chart.dispose();
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* time-axis tick format depends on the visible span */
  const [spanMs, setSpanMs] = useState<number>(0);
  const axisFormatter = useMemo(() => {
    return (ts: number): string => {
      const d = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      if (spanMs > 24 * 3600_000) {
        return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
  }, [spanMs]);

  /* option build + live-friendly update ------------------------------------- */
  const optionJson = useMemo(() => JSON.stringify([built, series.length]), [built, series.length]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;

    // update span for the axis formatter
    let minT = Number.POSITIVE_INFINITY;
    let maxT = Number.NEGATIVE_INFINITY;
    for (const b of built) {
      for (const p of b.points) {
        if (p[0] < minT) minT = p[0];
        if (p[0] > maxT) maxT = p[0];
      }
    }
    const span = Number.isFinite(minT) ? maxT - minT : 0;
    setSpanMs(span);

    const fmtV = valueFormatter === undefined ? undefined : (v: number) => String(valueFormatter(v));

    const tooltipTime = (ts: number): string => {
      const d = new Date(ts);
      const pad = (n: number) => String(n).padStart(2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    };

    const option: ECOption = {
      animation: false,
      grid: { left: 8, right: 12, top: 10, bottom: 40, containLabel: true },
      tooltip: {
        trigger: 'axis',
        transitionDuration: 0,
        backgroundColor: chartTokens.tooltipBg(),
        borderColor: chartTokens.strokeStrong(),
        borderWidth: 1,
        padding: [6, 10],
        textStyle: {
          color: chartTokens.textMid(),
          fontSize: 11,
          fontFamily: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', monospace",
        },
        extraCssText: 'border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,.4);backdrop-filter:blur(6px);',
        axisPointer: {
          type: 'line',
          lineStyle: { color: chartTokens.crosshair(), width: 1 },
          label: { show: false },
        },
        formatter: (params: unknown) => {
          const arr = (Array.isArray(params) ? params : [params]) as Array<{
            seriesId?: unknown;
            value?: unknown;
          }>;
          const rows = arr
            .map((p) => {
              const pair = Array.isArray(p.value) ? (p.value as unknown[]) : undefined;
              const raw = pair !== undefined ? (pair[1] as number | null) : undefined;
              const sid = typeof p.seriesId === 'string' ? p.seriesId : '';
              const def = series.find((s) => s.id === sid);
              const shown =
                typeof raw === 'number' && Number.isFinite(raw)
                  ? (fmtV !== undefined ? fmtV(raw) : defaultFormat(raw, def?.unit))
                  : '—';
              const dot = `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${def?.color ?? chartTokens.accent()};margin-right:6px;vertical-align:middle;"></span>`;
              return `<div style="display:flex;align-items:center;gap:6px;line-height:18px;">${dot}<span style="color:var(--sd-mid,#9AA4B2);">${escapeHtml(def?.label ?? sid)}</span><span style="color:var(--sd-hi,#E7ECF3);font-weight:600;margin-left:auto;padding-left:10px;">${escapeHtml(shown)}</span></div>`;
            })
            .join('');
          const t0 =
            arr.length > 0 && Array.isArray(arr[0]?.value)
              ? ((arr[0]!.value as unknown[])[0] as number)
              : Date.now();
          const head = `<div style="font-size:10px;letter-spacing:.06em;color:var(--sd-low,#5B6572);margin-bottom:2px;" title="${escapeHtml(fmtIso(t0))}">${escapeHtml(tooltipTime(t0))}</div>`;
          return `${head}${rows || '<div style="line-height:18px;">—</div>'}`;
        },
      },
      xAxis: {
        type: 'time',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: chartTokens.axis(),
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          hideOverlap: true,
          formatter: axisFormatter,
          margin: 10,
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { color: chartTokens.grid() } },
        axisLabel: {
          color: chartTokens.axis(),
          fontSize: 10,
          fontFamily: "'JetBrains Mono', monospace",
          formatter: (v: number) => fmtCompact(v),
          margin: 8,
        },
      },
      dataZoom: [
        { type: 'inside', throttle: 60, filterMode: 'none', zoomOnMouseWheel: true, moveOnMouseWheel: false },
        {
          type: 'slider',
          height: 18,
          bottom: 8,
          borderColor: 'transparent',
          backgroundColor: chartTokens.stroke(),
          fillerColor: 'rgba(94,177,255,0.12)',
          handleStyle: { color: chartTokens.accent(), borderColor: 'transparent', opacity: 0.7 },
          moveHandleStyle: { color: chartTokens.strokeStrong() },
          dataBackground: {
            lineStyle: { color: chartTokens.strokeStrong() },
            areaStyle: { color: chartTokens.stroke() },
          },
          selectedDataBackground: {
            lineStyle: { color: chartTokens.accent() },
            areaStyle: { color: 'rgba(94,177,255,0.10)' },
          },
          textStyle: { color: chartTokens.textLow(), fontSize: 9 },
          brushSelect: false,
        },
      ],
      series: built.map(({ def, points }) => ({
        id: def.id,
        name: def.label,
        type: 'line' as const,
        showSymbol: false,
        symbol: 'circle',
        symbolSize: 5,
        connectNulls: false,
        lineStyle: { width: 1.5, color: def.color },
        itemStyle: { color: def.color },
        emphasis: { lineStyle: { width: 2 } },
        tooltip: { show: true },
        data: points,
      })),
    };

    // replaceMerge keeps dataZoom/axis state intact while series may change;
    // lazyUpdate defers the heavy rebuild to the next frame for smooth appends.
    chart.setOption(option, { replaceMerge: ['series'], lazyUpdate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [optionJson, built, axisFormatter, valueFormatter, series]);

  const legendChips: ReactNode[] = series.map((s) => {
    const isHidden = hidden.has(s.id);
    return (
      <button
        key={s.id}
        type="button"
        aria-pressed={!isHidden}
        onClick={() => toggleHidden(s.id)}
        className={cn(
          'inline-flex cursor-pointer items-center gap-1.5 rounded-inner border px-1.5 py-[1px] font-mono text-[10px] transition-opacity duration-fast',
          isHidden
            ? 'border-stroke bg-transparent text-low opacity-60'
            : 'border-stroke bg-bg2 text-mid hover:text-hi',
        )}
        title={isHidden ? 'Show series' : 'Hide series'}
      >
        <span
          className="inline-block h-1.5 w-1.5 rounded-full"
          style={{ background: s.color, opacity: isHidden ? 0.35 : 1 }}
        />
        {s.label}
      </button>
    );
  });

  return (
    <div className={cn('relative flex min-w-0 flex-col', className)}>
      {(series.length > 0 || live) && (
        <div className="mb-1.5 flex min-h-[22px] flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">{legendChips}</div>
          {live && (
            <span
              title="Streaming live"
              className="inline-flex items-center gap-1.5 font-mono text-[10px] tracking-[0.08em] text-low uppercase"
            >
              <span
                className="sd-dot-pulse inline-block h-1.5 w-1.5 rounded-full"
                style={{ color: 'var(--sd-accent)', background: 'var(--sd-accent)' }}
              />
              live
            </span>
          )}
        </div>
      )}
      {/* host div is ALWAYS mounted (echarts binds to it at init; conditional
          rendering would detach the instance when data swings 0 → N → 0) */}
      <div ref={wrapRef} style={{ height }} className="w-full min-w-0" />
      {!hasAnyData && (
        <div className="pointer-events-none absolute inset-0 flex w-full items-center justify-center">
          <Empty title={emptyMessage} className="py-2" />
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Sparkline — tiny inline canvas sparkline (echarts-free), 120px default.
   `Spark` is an alias for discoverability.
   --------------------------------------------------------------------------- */

export interface SparklineProps {
  values: Array<number | null>;
  color?: string;
  width?: number;
  height?: number;
  strokeWidth?: number;
  area?: boolean;
  dot?: boolean;
  title?: string;
  className?: string;
}

/** Normalize a color for canvas painting: '#abc' → '#aabbcc' (others kept —
    callers must pass concrete colors, never var() names). */
function canvasColor(c: string): string {
  let s = c;
  if (s.startsWith('var(')) s = chartTokens.accent();
  if (s.startsWith('#') && s.length === 4) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  return s;
}

export function Sparkline({
  values,
  color,
  width = 120,
  height = 28,
  strokeWidth = 1.5,
  area = true,
  dot = true,
  title,
  className,
}: SparklineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const line = canvasColor(color ?? chartTokens.accent());

    // collect finite points; nulls split segments
    const segs: Array<Array<{ x: number; y: number }>> = [];
    let cur: Array<{ x: number; y: number }> = [];
    let minV = Number.POSITIVE_INFINITY;
    let maxV = Number.NEGATIVE_INFINITY;
    for (const v of values) {
      if (v === null || !Number.isFinite(v)) {
        if (cur.length > 0) {
          segs.push(cur);
          cur = [];
        }
        continue;
      }
      minV = Math.min(minV, v);
      maxV = Math.max(maxV, v);
      cur.push({ x: 0, y: v }); // x filled after we know n
    }
    if (cur.length > 0) segs.push(cur);

    const n = values.length;
    if (n === 0 || !Number.isFinite(minV) || !Number.isFinite(maxV)) return;
    if (minV === maxV) {
      minV -= 1;
      maxV += 1;
    }

    const pad = strokeWidth + 1;
    const innerH = height - pad * 2;
    const span = maxV - minV;
    let idx = 0;
    for (const seg of segs) {
      for (const p of seg) {
        p.x = (idx / Math.max(1, n - 1)) * (width - pad);
        p.y = pad + (1 - (p.y - minV) / span) * innerH;
        idx++;
      }
    }

    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    for (const seg of segs) {
      if (seg.length === 0) continue;
      // build path
      ctx.beginPath();
      ctx.moveTo(seg[0]!.x, seg[0]!.y);
      for (const p of seg.slice(1)) ctx.lineTo(p.x, p.y);

      if (area) {
        const fillPath = new Path2D();
        fillPath.moveTo(seg[0]!.x, height - pad);
        for (const p of seg) fillPath.lineTo(p.x, p.y);
        fillPath.lineTo(seg[seg.length - 1]!.x, height - pad);
        fillPath.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, height);
        grad.addColorStop(0, `${line}29`); // ~16% alpha
        grad.addColorStop(1, `${line}00`);
        ctx.fillStyle = grad;
        ctx.fill(fillPath);
      }

      ctx.strokeStyle = line;
      ctx.lineWidth = strokeWidth;
      ctx.stroke();
    }

    if (dot) {
      const all = segs.flat();
      if (all.length > 0) {
        ctx.beginPath();
        ctx.arc(all[all.length - 1]!.x, all[all.length - 1]!.y, strokeWidth + 0.5, 0, Math.PI * 2);
        ctx.fillStyle = line;
        ctx.fill();
      }
    }
  }, [values, color, width, height, strokeWidth, area, dot]);

  return (
    <canvas
      ref={canvasRef}
      title={title}
      role="img"
      aria-label={title ?? 'sparkline'}
      style={{ width, height }}
      className={cn('inline-block', className)}
    />
  );
}
