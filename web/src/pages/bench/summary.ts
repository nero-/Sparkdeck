/* bench summary normalization — mirrors what backend/sparkdeck/bench/runner.py
   `summarize()` emits (final) and `checkpoint_summary()` (live partial):
     final:      {engine, model, server_url, concurrency_levels, context_lengths,
                  kv_budget, grid:[{ctx,conc,tps}], best, c1, prefill:[{ctx,
                  tok_per_sec, ttft_s, prompt_tokens}], spec_accept_avg,
                  coding_peak:{mean_generation_tok_s, max_generation_tok_s,
                               runs_ok,…}, cells}
     checkpoint: {engine:"partial", model, grid:[{ctx,conc,tps,ttft_p50,
                  capacity_limited,loop_detected}], cells, best, partial:true}
   Anything missing normalizes to null/[] — never crash on schema drift. */

import type { BenchJob } from '../../api/types';

export interface GridCell {
  ctx: string;
  conc: number;
  tps: number | null;
  ttftP50: number | null;
  flagged: 'capacity_limited' | 'loop_detected' | null;
}

export interface PrefillRow {
  ctx: string;
  tokPerSec: number | null;
  ttftS: number | null;
  promptTokens: number | null;
}

export interface BenchSummaryView {
  engine: string | null;
  model: string | null;
  serverUrl: string | null;
  concurrencyLevels: number[];
  contextLengths: string[];
  kvBudget: number | null;
  grid: GridCell[];
  best: GridCell | null;
  c1: GridCell | null;
  prefill: PrefillRow[];
  specAcceptAvg: number | null;
  codingPeak: { meanTps: number | null; maxTps: number | null; runsOk: number | null } | null;
  cells: number | null;
  partial: boolean;
}

const NULL_SUMMARY: BenchSummaryView = {
  engine: null,
  model: null,
  serverUrl: null,
  concurrencyLevels: [],
  contextLengths: [],
  kvBudget: null,
  grid: [],
  best: null,
  c1: null,
  prefill: [],
  specAcceptAvg: null,
  codingPeak: null,
  cells: null,
  partial: false,
};

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseCell(r: unknown): GridCell | null {
  if (!isRec(r)) return null;
  const conc = num(r.conc) ?? num(r.concurrency);
  if (conc === null) return null;
  const rawCtx = r.ctx ?? r.context ?? r.token_ctx;
  const ctx = rawCtx === undefined || rawCtx === null ? '—' : String(rawCtx);
  const flagged =
    (r.capacity_limited === true && ('capacity_limited' as const)) ||
    (r.loop_detected === true && ('loop_detected' as const)) ||
    null;
  return {
    ctx,
    conc,
    tps: num(r.tps) ?? num(r.aggregate_tps) ?? num(r.tok_per_sec),
    ttftP50: num(r.ttft_p50) ?? num(r.ttft_s),
    flagged: typeof flagged === 'string' ? flagged : null,
  };
}

function cellFromDict(ctx: string, concStr: string, tpsVal: unknown): GridCell {
  const tps = num(tpsVal);
  return { ctx, conc: num(concStr) ?? parseInt(concStr, 10), tps: tps === null || tps <= 0 ? null : tps, ttftP50: null, flagged: null };
}

export function parseSummary(raw: unknown): BenchSummaryView {
  if (!isRec(raw)) return NULL_SUMMARY;
  const grid: GridCell[] = [];
  for (const cell of (Array.isArray(raw.grid) ? raw.grid : []).values()) {
    const c = parseCell(cell);
    if (c !== null) grid.push(c);
  }
  /* fallback: nested summary_table {ctxStr: {concStr: tps}} — tool artifact shape */
  if (grid.length === 0 && isRec(raw.summary_table)) {
    for (const [ctxKey, per] of Object.entries(raw.summary_table)) {
      if (!isRec(per)) continue;
      for (const [concKey, tpsVal] of Object.entries(per)) grid.push(cellFromDict(ctxKey, concKey, tpsVal));
    }
  }
  const best = parseCell(raw.best);
  const c1 = parseCell(raw.c1);
  const coding = isRec(raw.coding_peak) ? raw.coding_peak : null;
  const prefillRows: PrefillRow[] = [];
  for (const pr of (Array.isArray(raw.prefill) ? raw.prefill : []).values()) {
    if (!isRec(pr)) continue;
    prefillRows.push({
      ctx: String(pr.ctx ?? '—'),
      tokPerSec: num(pr.tok_per_sec) ?? num(pr.tps),
      ttftS: num(pr.ttft_s) ?? num(pr.ttft_seconds),
      promptTokens: num(pr.prompt_tokens),
    });
  }
  if (prefillRows.length === 0 && isRec(raw.prefill)) {
    /* tool artifact shape: {ctx: {tok_per_sec, ttft_seconds, prompt_tokens}} */
    for (const [ctxKey, pr] of Object.entries(raw.prefill)) {
      if (!isRec(pr)) continue;
      prefillRows.push({
        ctx: ctxKey,
        tokPerSec: num(pr.tok_per_sec) ?? num(pr.tps),
        ttftS: num(pr.ttft_seconds) ?? num(pr.ttft_s),
        promptTokens: num(pr.prompt_tokens),
      });
    }
  }
  return {
    engine: str(raw.engine) === 'partial' ? null : str(raw.engine),
    model: str(raw.model),
    serverUrl: str(raw.server_url),
    concurrencyLevels: (Array.isArray(raw.concurrency_levels) ? raw.concurrency_levels : []).map(num).filter((n): n is number => n !== null),
    contextLengths: (Array.isArray(raw.context_lengths) ? raw.context_lengths : []).map((x) => (x === null || x === undefined ? '' : String(x))),
    kvBudget: num(raw.kv_budget),
    grid: grid.sort((a, b) => (ctxNum(a.ctx) - ctxNum(b.ctx) !== 0 ? ctxNum(a.ctx) - ctxNum(b.ctx) : a.conc - b.conc)),
    best: best !== null && best.tps !== null ? best : null,
    c1: c1 !== null && c1.tps !== null ? c1 : null,
    prefill: prefillRows,
    specAcceptAvg: num(raw.spec_accept_avg),
    codingPeak:
      coding !== null
        ? {
            meanTps: num(coding.mean_generation_tok_s) ?? num(coding.mean_tps) ?? num(coding.mean),
            maxTps: num(coding.max_generation_tok_s) ?? num(coding.max_tps) ?? num(coding.max),
            runsOk: num(coding.runs_ok) ?? num(coding.runs) ?? num(coding.n_runs),
          }
        : null,
    cells: num(raw.cells),
    partial: raw.partial === true,
  };
}

function ctxNum(ctx: string): number {
  const m = /^(\d+)(k|K|m|mi)?$/i.exec(ctx);
  if (m === null) return Number.MAX_SAFE_INTEGER;
  const base = Number(m[1] ?? 0);
  const suffix = (m[2] ?? '').toLowerCase();
  if (suffix === 'm' || suffix === 'mi') return base * 1024 * 1024;
  if (suffix === 'k') return base * 1024;
  return base;
}

/** Expected cell count from job args (for live progress fraction). */
export function expectedCells(job: BenchJob): number | null {
  const conc = csvCount(job.args.concurrency);
  const ctx = csvCount(job.args.contexts);
  const prefill = csvCount(job.args.prefill_contexts);
  return conc * ctx < 1 ? prefill : conc * ctx;
}

function csvCount(s: string): number {
  return s.split(',').filter((x) => x.trim() !== '').length;
}

/** Fraction (0..1) of finished sweep cells for the live progress bar. */
export function progressFraction(job: BenchJob | null, summary: BenchSummaryView | null): number | null {
  if (job === null || summary === null || job.state !== 'running') return null;
  const expected = expectedCells(job);
  if (expected === null || expected <= 0) return null;
  const valid = summary.grid.length;
  return Math.min(1, valid / expected);
}
