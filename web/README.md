# Sparkdeck web

Dark-first operator console for a DGX Spark cluster controller. Vite + **React
19** + **TypeScript (strict)** + **Tailwind CSS v4** (CSS-first `@theme`
tokens, no `tailwind.config.js`).

```
npm install          # node ≥ 22.12 (built with node 26.7.0)
npm run dev          # vite dev server, proxies /api → http://127.0.0.1:8936 (ws: true)
npm run build        # tsc --noEmit && vite build → dist/
npm run typecheck    # tsc --noEmit only
npm run preview      # serve dist/ (no proxy — set window.__SPARKDECK_API__ if API is remote)
```

- API base: `window.__SPARKDECK_API__ ?? ''` (same-origin default). Bearer
  token is read from `localStorage['sparkdeck.token']` (`setAuthToken()` in
  `src/api/client.ts`); on the WebSocket it is passed as `?token=` (browsers
  can't set headers on WS handshakes).
- The pinned API contract lives in `src/api/types.ts` — **do not modify**.
  Backend mirror: `docs/API.md`.

## File map

```
src/
├── main.tsx               entry: mounts <AppRouter/> in StrictMode
├── App.tsx                 app frame (rail + top bar + routed content), ws connect,
│                           theme/density attributes, <Toaster/>
├── router.tsx              createBrowserRouter routes + NAV_ITEMS (shared w/ rail & g-chord)
├── index.css               Tailwind v4 entry: --sd-* tokens → @theme inline, base chrome,
│                           focus ring, scrollbar, keyframes, .sd-panel/.sd-monolabel/.sd-num
├── api/
│   ├── types.ts            *** PINNED contract (never edit) ***
│   ├── client.ts           typed fetch client (ApiClientError), api.{get,post,…} + named
│   │                       endpoints; useWs() zustand store: /api/ws subscribe
│   │                       [nodes,samples,service,ops,events,bench,logs], reconnect w/
│   │                       backoff + jitter, REST seeding on (re)connect, buffers:
│   │                       lastSampleByNode, liveNodes, serviceByCluster, opsById (Map),
│   │                       eventsRing (≤500, newest-first), benchById (Map), logTails
│   │                       (Map key→lines); selector hooks (useWsStatus, useNodeState,
│   │                       useLastSample, useServiceState, useLogTail)
│   └── queries.ts          useQuery + useClusters/useSystemInfo/useSystemStatus
│                           (topology/systemInfo cached behind a 15/30 s TTL promise)
├── ds/                     design system (barrel: src/ds/index.ts)
│   ├── tokens.ts           runtime tokens: SERIES_PALETTE, SPACING, DURATION, cssToken(),
│   │                       chartTokens() (theme-aware reads of --sd-chart-*)
│   ├── primitives.tsx      Panel, SectionHeader, Chip (neutral/ok/warn/crit/accent + hex
│   │                       override), StatusDot (+ connDot/healthDot mappers), Btn
│   │                       (primary/ghost/danger, sm/md), Input, Select, FieldLabel,
│   │                       Toggle, Kbd, KeyRow, Tip (title-attr tooltip), Empty, Spinner
│   ├── Modal.tsx           Modal (portal, Esc, scrim, focus restore) + ConfirmDialog
│   │                       (summary + remote-command code block + optional typed
│   │                       confirmWord — DESIGN "Confirmations" pattern)
│   ├── Toast.tsx           useToasts store + Toaster host (bottom-right, 4 s auto-dismiss,
│   │                       error sticky w/ dismiss) + imperative `toast.{info,ok,warn,error}`
│   ├── Tabs.tsx            underline tabs + chip variant (doubles as TimeChart window
│   │                       chips); roving keyboard nav (Arrows/Home/End)
│   ├── meters.tsx          Gauge (270° arc, threshold tints, mono value inside) and Bar
│   │                       (meter + dashed threshold horizon line, e.g. KV-pin)
│   ├── chart.tsx           TimeChart (echarts/core, tree-shaken: LineChart, Grid,
│   │                       Tooltip, DataZoom inside+slider, Canvas) — linear interpolation,
│   │                       gaps as null, hover crosshair + floating legend chips
│   │                       (click chip to hide series), live pulse, LTTB decimation,
│   │                       replaceMerge: dataZoom survives updates, dblclick resets zoom;
│   │                       Sparkline — canvas sparkline (echarts-free), `Spark` alias
│   ├── lttb.ts             decimateSeries(t, v, maxPoints) — LTTB w/ null-gap handling;
│   │                       lttbSelfTest() for QA
│   └── terminal.tsx        ANSI parser (16/256/24-bit SGR, bold/dim/underline/italic/
│   │                       strike/inverse) → AnsiLine + Terminal pane: autoscroll w/
│   │                       pause-on-user-scroll, "Jump to live" pill, line numbers,
│   │                       render cap (maxLines)
├── stores/
│   ├── ui.ts               useUi: theme ('dark'|'light'|'system'), density
│   │                       ('comfortable'|'compact'), activeClusterId (persisted
│   │                       localStorage 'sparkdeck.ui'), railExpanded
│   ├── live.ts             useLive (= useWs) + domain selectors: useLiveNodes,
│   │                       useOnlineCount, useClusterOnlineCount, useSampleMap,
│   │                       useSampleValue(nodeId, seriesId), useServiceByCluster,
│   │                       useUnackedEventCount, useEventsRing
│   └── ops.ts              useOps (= live store handle) + useActiveOps, useCurrentOp
│                           (running-op banner), useRecentOps, useOpById, useOpsBusy
├── shell/
│   ├── Rail.tsx            72px icon rail (expandable to 200px, collapsed default),
│   │                       logo, active states, g-digit hint, collapse toggle
│   ├── TopBar.tsx          52px: cluster switcher (alert pills w/ accent dot + overflow
│   │                       menu w/ "Add cluster…"), running-op banner slot, ws status
│   │                       (dot + online/total nodes), event bell w/ unacked badge, clock
│   ├── PageShell.tsx       PageHeader (title + context + actions) + PagePlaceholder
│   └── hotkeys.ts          g-1…g-9 navigation chord (suppressed in inputs; Esc-safe)
└── pages/
    ├── overview/OverviewPage.tsx    live: GET /api/clusters + /api/system/info,
    │                                cluster cards (accent, node chips w/ StatusDot,
    │                                gpu.util Sparkline streaming from lastSampleByNode)
    └── nodes/nodes·NodeDetail, control, inference, logs, images, bench, events,
        settings …                   placeholders (PageHeader + Empty "wiring in progress")
```

Routes: `/` Overview · `/nodes` · `/nodes/:nodeId` · `/control` · `/inference` ·
`/logs` · `/images` · `/bench` · `/events` · `/settings` (unknown → redirect to `/`).

## Design-system rules (docs/DESIGN.md kept by construction)

- Surfaces/strokes/text ride `--sd-*` CSS variables; **dark is default**; a
  light theme is a token swap under `[data-theme="light"]` (already written in
  `index.css`). Never hardcode text/icon colors — use tokens
  (`text-hi/mid/low`, `--sd-accent`, …). Per-cluster accents are runtime
  values (inline `style`), never theme slots.
- Type: system stack for UI; `"JetBrains Mono", "SF Mono", "Cascadia Code",
  monospace` for metrics/terminal/numerals (`.sd-num` tabular numerals, no
  jitter). No webfonts are downloaded.
- Focus: everything interactive is keyboard reachable with a 2px accent
  outline (global `:focus-visible`).
- Motion: 120–180 ms ease-out (`duration-fast/med/slow`); numerals never
  tween; charts animate off and append continuously.
- Charts re-theme themselves by reading `--sd-chart-*` at option-build time
  (`chartTokens()`); echarts tree-shaken imports only.

## Notes / deviations

- `typescript` pinned to ~5.9.3 (the 7.x line is the new native compiler — too
  fresh to pin an integration on). Latest majors otherwise: vite 8
  (rolldown-based, required by @vitejs/plugin-react@6), tailwind 4.3, zustand
  5, react-router 7, echarts 6, lucide 1.x — at install time.
- `ds/index.ts` re-exports `chart.tsx`, so importing page components from the
  barrel pulls echarts into the chunk graph (~285 KB gzip total). Fine for the
  console; prefer deep imports (`../ds/chart`) if later waves want code
  splitting.
- The overview sparkline accumulates a client-side 120-point ring from the
  `samples` topic (a single `lastSampleByNode` frame can't draw a line);
  history-grade charts should use `api.metricsHistory` (+LTTB via `TimeChart`).
- `Terminal` renders up to `maxLines` (default 2500) rows; the WS store caps
  each log tail at 4000 lines. Virtualization is a future upgrade, not needed
  at these caps.
- build emits a rolldown/tailwind sourcemap warning for the CSS transform
  (cosmetic upstream warning; output unaffected).
- Verified: `npm install` ✓, `tsc --noEmit` ✓ (strict, noUncheckedIndexedAccess),
  `vite build` ✓.
