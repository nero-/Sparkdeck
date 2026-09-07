# Sparkdeck — design language

Dark-first operator console. The look: **calm carbon glass over a live
instrument grid** — quiet chrome, dense readable data, one accent per cluster,
monospaced numerals that never jitter.

## Tokens

Color (dark is the primary theme; a light theme is token-swapped, not bespoke):

| token | dark | light |
|---|---|---|
| `bg0` page | `#0A0C10` | `#F4F5F7` |
| `bg1` panel | `#10131A` | `#FFFFFF` |
| `bg2` raised | `#151923` | `#FAFAFC` |
| `stroke` | `rgba(255,255,255,0.07)` | `rgba(15,23,42,0.10)` |
| `stroke-strong` | `rgba(255,255,255,0.14)` | `rgba(15,23,42,0.18)` |
| `text-hi` | `#E7ECF3` | `#0B1220` |
| `text-mid` | `#9AA4B2` | `#475569` |
| `text-low` | `#5B6572` | `#7C8BA1` |
| `accent` (app) | `#5EB1FF` | `#1668DC` |
| `ok` | `#4ADE80` | `#16A34A` |
| `warn` | `#FBBF24` | `#D97706` |
| `crit` | `#F87171` | `#DC2626` |
| cluster accents | c1 `#22D3EE` cyan, c2 `#A78BFA` violet (user-set in settings) | same |

Semantics: never rely on red/green alone — pair with icon + label. Health:
`ok` = filled dot + "Healthy", `warn` = triangle, `crit` = octagon, loss of
conn = hollow pulse.

Type: **Inter** (UI; system-ui fallback), **JetBrains Mono** for metrics,
timestamps, terminal/ops, table numerics with `font-variant-numeric: tabular-nums`.
Scale: 11/12/13/15/18/24 px; titles semibold 650; UI copy 13px; metric labels
11px uppercase tracking 0.08em; numerals 13–15px mono.

Space: 4px base; paddings 8/12/16/24; card gap 12; page gutters 24; card
radius 10px (inner elements 6px); NOT pill-shaped anywhere except status dots.

Elevation: subtle — `box-shadow: 0 1px 2px rgba(0,0,0,.4), inset 0 1px 0
rgba(255,255,255,.03)`. No neon glows; a *thin* 1px inner top highlight on
raised panels.

## Patterns

- **App frame**: left icon rail (72px, expandable to 200px) with sections
  Overview · Nodes · Control · Inference · Logs · Images · Bench · Events ·
  Settings; top bar 52px with cluster switcher (pills), global connection
  state, event bell, running-op banner slot. Content max-width fluid, page
  header = title + context + actions right-aligned.
- **Metric tile**: label (mono caps), big value (mono, tabular), delta arrow
  vs window start, 120px sparkline beneath, unit suffix small+low.
- **Series chart kit** (`<TimeChart>`): themes stroke colors from an ordered
  palette [#5EB1FF,#4ADE80,#FBBF24,#F87171,#A78BFA,#22D3EE,#FB923C,#E879F9];
  grid lines `rgba(255,255,255,.05)`; axis labels mono 10px; hover crosshair
  with floating legend chips (click chip to hide series); time axis with
  compact ticks; window switcher chips [5m 1h 6h 24h 7d]; "live" pulse when
  streaming; brush zoom drag + double-click reset.
- **Terminal & ops**: true ANSI rendering (colors from actual 256 palette),
  JetBrains Mono 12px, line gutter with timestamps toggle, autoscroll pause on
  user scroll, "Jump to live" pill, filter box (regex), download button.
- **Tables**: dense 13px rows, sticky header, right-aligned numerics, minimal
  row hover, sort affordances on monotone chevron.
- **Gauges**: 270° arc ring with value inside (mono), thresholds as arc tints.
  Used sparingly — GPU util, KV usage, mem envelope.
- **Node card**: name + role chip + status dot; GPU util ring; mem bar with
  KV-pin horizon line; temp chip; net kbps inline sparkline;下部 container chips.
  The card is one glance = "is this node healthy".
- **Confirmations**: anything destructive (stop pair, rewrite env, image
  copy, drop caches, cancel bench) → modal with typed action summary, list of
  remote commands in a code block, and explicit "Run" in accent/warning color.
- **Empty states**: line-art icon + one sentence + the action that fills it —
  never bare tables.
- **Motion**: 120–180ms ease-out for state changes, number transitions are
  instant (no tweening), charts append continuously; no parallax/gimmicks.

## Chart rules of thumb

- 1 chart = 1 question ("is GPU util trending up?"); tile title answers it.
- Multi-series lines get one visual family per chart (don't mix units).
- Interpolation: linear; never smooth-spline monitoring data.
- Every line sub-second sampled → decimate client-side (LTTB) beyond ~1500 pts.

## Window strategy

- Live view: 5m rolling default, other windows on demand.
- Long windows (6h/24h/7d) read rollups; the chart marks degraded resolution.
- Clocks: UTC internally; display in local tz with ISO-8601 on hover.
