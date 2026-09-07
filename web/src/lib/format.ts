/* Formatting helpers — monospaced numerals that never jitter.
   All formatters are pure; UI copy is 13px-mid by convention. */

const nf = new Intl.NumberFormat('en-US');
const nf1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** Thousands-separated integer. */
export function fmtNum(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : nf.format(v);
}

/** 1-decimal number without unit. */
export function fmtDec(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : nf1.format(v);
}

/** Fixed-decimals number. */
export function fmtFixed(v: number | null | undefined, digits: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return digits >= 2 ? nf2.format(v) : nf1.format(v);
}

/** Percent 0–100: "71.2%". */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${nf1.format(v)}%`;
}

/** Compact for axes: 1.2k / 3.4M / 5.6G. */
export function fmtCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${nf1.format(abs / 1e9)}G`;
  if (abs >= 1e6) return `${sign}${nf1.format(abs / 1e6)}M`;
  if (abs >= 1e3) return `${sign}${nf1.format(abs / 1e3)}k`;
  return `${sign}${nf.format(Math.abs(v))}`;
}

/** GiB: "118.4 GiB". */
export function fmtGiB(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf1.format(v)} GiB`;
}

/** MB/s style rates. */
export function fmtRateMb(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf1.format(v)} MB/s`;
}

export function fmtTokensPerSec(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : `${nf1.format(v)} tok/s`;
}

/** Seconds → "3d 4h", "12m 30s", "45s". */
export function fmtDuration(totalS: number | null | undefined): string {
  if (totalS === null || totalS === undefined || !Number.isFinite(totalS) || totalS < 0) return '—';
  if (totalS < 60) return `${Math.round(totalS)}s`;
  const s = Math.floor(totalS);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m ${s % 60}s`;
}

const hhmmss = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const datetime = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

/** Local clock "14:02:11". */
export function fmtClock(ts: number): string {
  return hhmmss.format(ts);
}

/** Local "Mar 03 14:02:11". */
export function fmtDateTime(ts: number): string {
  return datetime.format(ts);
}

/** ISO-8601 with local offset — for titles/hover per DESIGN (clocks rule). */
export function fmtIso(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(off) / 60));
  const offM = pad(Math.abs(off) % 60);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${offH}:${offM}`
  );
}

/** "12s ago" / "3m ago" — coarse only. */
export function fmtAgo(ts: number, now = Date.now()): string {
  const delta = Math.max(0, Math.floor((now - ts) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
