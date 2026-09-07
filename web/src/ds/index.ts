/* Design system barrel — the canonical import surface:
   import { Panel, Btn, TimeChart, useWs? } from '../ds'
   (useWs lives in src/api/client.ts; stores re-export from src/stores/). */

export * from './tokens';
export * from './primitives';
export * from './Modal';
export * from './Toast';
export * from './Tabs';
export * from './meters';
export * from './lttb';
export * from './chart';
export * from './terminal';

/** `Spark` — the spec'd name for the tiny inline sparkline; same component
    as `Sparkline` (canvas, echarts-free). */
export { Sparkline as Spark } from './chart';

/* ---------------------------------------------------------------------------
   Import guide for page waves
   - Everything design-system: `import { … } from '../ds'` (this barrel).
   - Charts: `TimeChart`, `Sparkline`/`Spark` (deep import `../ds/chart` is
     equivalent).
   - The live store: `import { useLive, useSampleValue, … } from '../stores/live'`.
   - The API surface: `import { api } from '../api/client'` (+ types from
     '../api/types', which is pinned — never edit it).
   - Formatting: `import { fmtGiB, fmtClock, … } from '../lib/format'`.
   --------------------------------------------------------------------------- */

