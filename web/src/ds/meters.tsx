/* ============================================================================
   ds/meters — Gauge (270° arc ring with threshold tints) and Bar (horizontal
   meter with threshold horizon line, e.g. KV-pin). Pure SVG/CSS, no deps.
   Colors are passed as plain strings so per-cluster accents stay runtime
   values, not theme slots.
   ========================================================================= */

import { cn } from '../lib/cn';

export interface Threshold {
  /** value where this color starts to apply (ascending) */
  at: number;
  color: string;
}

const A0 = 135; // degrees; gauge opens toward the bottom
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, fromDeg: number, toDeg: number): string {
  if (toDeg - fromDeg <= 0.001) return '';
  const [x0, y0] = polar(cx, cy, r, fromDeg);
  const [x1, y1] = polar(cx, cy, r, toDeg);
  const large = toDeg - fromDeg > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function zoneColor(value: number, thresholds: Threshold[]): string | undefined {
  let color: string | undefined;
  for (const th of thresholds) {
    if (value >= th.at) color = th.color;
  }
  return color;
}

export function Gauge({
  value,
  min = 0,
  max = 100,
  thresholds,
  label,
  unit = '%',
  size = 116,
  color,
  title,
  className,
}: {
  value: number | null;
  min?: number;
  max?: number;
  /** ascending danger zones: [warnAt,critAt) tinted warn-color, [critAt,max] crit */
  thresholds?: Threshold[];
  label?: string;
  unit?: string;
  size?: number;
  /** explicit progress color; overrides threshold zone pick */
  color?: string;
  title?: string;
  className?: string;
}) {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 9;
  const frac =
    value === null || !Number.isFinite(value) || max === min
      ? 0
      : Math.min(1, Math.max(0, (value - min) / (max - min)));

  // tinted danger zones: each threshold starts a zone that extends to the
  // next threshold (or to max for the last one)
  const ths = (thresholds ?? []).filter((t) => t.at > min && t.at < max).sort((a, b) => a.at - b.at);
  const zones = ths.map((th, i) => ({
    from: th.at,
    to: i < ths.length - 1 ? (ths[i + 1]!.at) : max,
    color: th.color,
  }));

  const zonePick = (() => {
    let picked: Threshold | undefined;
    for (const th of ths) if (value !== null && value >= th.at) picked = th;
    return picked;
  })();

  const valueColor: string =
    color ??
    (value === null || !Number.isFinite(value)
      ? 'var(--sd-low)'
      : (zonePick?.color ?? 'var(--sd-accent)'));

  const progress = frac > 0.004 ? arcPath(cx, cy, r, A0, A0 + SWEEP * frac) : '';
  const full = arcPath(cx, cy, r, A0, A0 + SWEEP);
  const valueText =
    value === null || !Number.isFinite(value)
      ? '—'
      : Math.abs(value) >= 100
        ? Math.round(value).toString()
        : value.toFixed(1);

  return (
    <figure
      className={cn('inline-flex flex-col items-center', className)}
      title={title ?? (label !== undefined ? `${label}: ${value ?? '—'}${unit}` : undefined)}
    >
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          {/* track */}
          {full !== '' && (
            <path d={full} fill="none" stroke="var(--sd-stroke)" strokeWidth={7} strokeLinecap="butt" />
          )}
          {/* threshold tints */}
          {zones.map((z, i) => {
            const f0 = (z.from - min) / (max - min || 1);
            const f1 = (z.to - min) / (max - min || 1);
            const d = arcPath(cx, cy, r, A0 + SWEEP * f0, A0 + SWEEP * f1);
            if (d === '') return null;
            return (
              <path key={i} d={d} fill="none" stroke={z.color} strokeOpacity={0.3} strokeWidth={7} strokeLinecap="butt" />
            );
          })}
          {/* progress */}
          {progress !== '' && (
            <path d={progress} fill="none" stroke={valueColor} strokeWidth={7} strokeLinecap="butt" />
          )}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center pt-1">
          <span className="sd-num font-mono text-[19px] leading-none font-semibold text-hi">
            {valueText}
          </span>
          <span className="mt-0.5 font-mono text-[10px] text-low">{unit}</span>
        </div>
      </div>
      {label !== undefined && <figcaption className="sd-monolabel mt-1">{label}</figcaption>}
    </figure>
  );
}

/* ---------------------------------------------------------------------------
   Bar — horizontal meter, thresholds color the fill, optional horizon line
   (KV-pin style marker rendered as a dashed `` stroke above the fill).
   --------------------------------------------------------------------------- */

export function Bar({
  value,
  min = 0,
  max = 100,
  thresholds,
  horizon,
  height = 6,
  title,
  className,
}: {
  value: number | null;
  min?: number;
  max?: number;
  thresholds?: Threshold[];
  /** fraction (0–1) — draws the dashed horizon marker, e.g. KV-pin */
  horizon?: number | null;
  height?: number;
  title?: string;
  className?: string;
}) {
  const frac =
    value === null || !Number.isFinite(value) || max === min
      ? 0
      : Math.min(1, Math.max(0, (value - min) / (max - min)));
  const fill =
    value === null
      ? 'var(--sd-low)'
      : (zoneColor(value, thresholds ?? []) ?? 'var(--sd-accent)');
  const horizonPct = horizon === null || horizon === undefined ? null : Math.min(100, Math.max(0, horizon * 100));

  return (
    <div
      className={cn('relative w-full min-w-0', className)}
      title={title}
      style={{ height }}
    >
      <div
        className="absolute inset-0 rounded-[2px] border border-stroke bg-bg2/60"
        aria-hidden
      />
      <div
        className="absolute inset-y-0 left-0 rounded-[2px] transition-[width] duration-med ease-out-soft"
        style={{ width: `${frac * 100}%`, background: fill, opacity: 0.75 }}
        aria-hidden
      />
      {horizonPct !== null && (
        <div
          className="absolute top-[-3px] bottom-[-3px] w-0 border-l border-dashed"
          style={{ left: `${horizonPct}%`, borderColor: 'var(--sd-warn)' }}
          aria-hidden
        />
      )}
      <span className="sr-only" role="status">
        {value === null ? 'no data' : `${(frac * 100).toFixed(0)}%`}
      </span>
    </div>
  );
}
