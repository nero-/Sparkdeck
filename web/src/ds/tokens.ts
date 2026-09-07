/* Design tokens for runtime consumers (echarts, canvas).
   Hex literals here mirror the *dark* theme (docs/DESIGN.md); when a light
   theme lands, prefer cssToken() which reads the live --sd-* variables. */

/** Chart series stagger — ordered palette from DESIGN.md. */
export const SERIES_PALETTE = [
  '#5EB1FF',
  '#4ADE80',
  '#FBBF24',
  '#F87171',
  '#A78BFA',
  '#22D3EE',
  '#FB923C',
  '#E879F9',
] as const;

/** Layout rhythm (4px base; paddings 8/12/16/24, card gap 12, gutters 24). */
export const SPACING = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, cardGap: 12, pagePad: 24 } as const;

/** Motion (120–180ms ease-out). */
export const DURATION = { fast: 120, med: 150, slow: 180 } as const;

export const RADIUS = { card: 10, inner: 6 } as const;

/** Read a live CSS token (custom property) from the document root. */
export function cssToken(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  const raw = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw || fallback;
}

/* Token helpers for charts (theme-aware at call time). */
export const chartTokens = {
  grid: () => cssToken('--sd-chart-grid', 'rgba(255,255,255,0.05)'),
  axis: () => cssToken('--sd-chart-axis', 'rgba(154,164,178,0.9)'),
  crosshair: () => cssToken('--sd-chart-crosshair', 'rgba(255,255,255,0.22)'),
  area: () => cssToken('--sd-chart-area', 'rgba(255,255,255,0.035)'),
  tooltipBg: () => cssToken('--sd-tooltip-bg', 'rgba(21,25,35,0.97)'),
  stroke: () => cssToken('--sd-stroke', 'rgba(255,255,255,0.07)'),
  strokeStrong: () => cssToken('--sd-stroke-strong', 'rgba(255,255,255,0.14)'),
  textLow: () => cssToken('--sd-low', '#5B6572'),
  textMid: () => cssToken('--sd-mid', '#9AA4B2'),
  accent: () => cssToken('--sd-accent', '#5EB1FF'),
};
