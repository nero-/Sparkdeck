/* ============================================================================
   lib/benchArgs — bench CSV parsing + client-side argv mirror.

   The backend tool owns the authoritative argv (POST /api/bench/jobs returns
   it); this module only VALIDATES exactly the way the tool parses, and
   builds a *preview* argv for review before submitting.
   ========================================================================= */

export interface ParsedCsvItem {
  raw: string;
  suffix: 'plain' | 'k' | 'K' | 'm' | 'mi';
  /** suffix-expanded value (display only — backend owns the truth) */
  expanded: number;
}

export interface CsvCheck {
  ok: boolean;
  error: string | null;
  items: ParsedCsvItem[];
}

const ITEM_RE = /^\d+(k|K|mi?)?$/;

/** Suffix expansion for the *validation chip only*
 *  (k → ×1024, m → ×1024², mi → ×1024² "mib"-style; plain stays an integer). */
function expandItem(mantissa: string, suffix: ParsedCsvItem['suffix']): number {
  const base = Number(mantissa);
  if (!Number.isFinite(base)) return NaN;
  switch (suffix) {
    case 'k':
    case 'K':
      return base * 1024;
    case 'm':
    case 'mi':
      return base * 1024 * 1024;
    case 'plain':
    default:
      return base;
  }
}

/**
 * Parse a bench CSV the way the tool would: split on commas, strip
 * whitespace, validate each item against `^\s*\d+(k|K|mi?)?\s*$`.
 * `allowSuffix=false` (concurrency) requires plain ints.
 */
export function parseBenchCsv(
  input: string,
  opts: { allowSuffix?: boolean; maxLength?: number } = {},
): CsvCheck {
  const { allowSuffix = false } = opts;
  const items = input
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (items.length === 0) {
    return { ok: false, error: 'empty — one or more values required', items: [] };
  }
  const seen = new Set<string>();
  const parsed: ParsedCsvItem[] = [];
  for (const item of items) {
    const m = ITEM_RE.exec(item);
    if (m === null) {
      return {
        ok: false,
        error: `“${item}” is not ${allowSuffix ? 'an int or <int>k/K/m/mi value' : 'a plain int'}`,
        items: [],
      };
    }
    if (seen.has(item)) {
      return { ok: false, error: `duplicate value “${item}”`, items: [] };
    }
    seen.add(item);
    const suffixChar = m[1];
    const suffix: ParsedCsvItem['suffix'] =
      suffixChar === undefined ? 'plain' : suffixChar === 'm' || suffixChar === 'mi' ? suffixChar : 'k';
    parsed.push({
      raw: item,
      suffix,
      expanded: expandItem(item.replace(/[kKmi]+$/i, ''), suffix),
    });
  }
  return { ok: true, error: null, items: parsed };
}

/** Amplitude labels for suffix tokens — display only. */
export function describeCsv(check: CsvCheck): string {
  return check.items.map((i) => (i.suffix === 'plain' ? i.expanded.toLocaleString('en-US') : `${i.raw} → ${i.expanded.toLocaleString('en-US')}`)).join(' · ');
}

/* ---------------------------------------------------------------------------
   Argv mirror — ESTIMATE. Mirrors the typical build order from the pinned
   POST body (economy: flags before values, extra passthrough last). The
   truth is the `argv` the server returns once the job is submitted.
   --------------------------------------------------------------------------- */

export interface ArgvMirrorInput {
  /** bench tool path from GET /api/bench/config (null → placeholder) */
  tool: string | null;
  /** venv python from GET /api/bench/config (null → placeholder) */
  venvPython: string | null;
  host: string;
  port: number;
  model: string;
  label: string | null;
  kvBudget: number | null;
  args: {
    concurrency: string;
    contexts: string;
    prefill_contexts: string;
    max_tokens: number;
    duration: number;
    coding_peak: boolean;
    coding_peak_runs?: number;
    coding_peak_max_tokens?: number;
    extra?: string;
  };
}

export function mirrorArgv(input: ArgvMirrorInput): string[] {
  const argv: string[] = [
    input.venvPython ?? '<venv python>',
    input.tool ?? '<bench tool>',
    '--host', input.host.trim() || '<host>',
    '--port', String(input.port),
    '--model', input.model.trim() || '<model>',
  ];
  if (input.label !== null && input.label.trim() !== '') {
    argv.push('--label', input.label.trim());
  }
  argv.push('--concurrency', input.args.concurrency.trim() || '<concurrency>');
  if (input.args.contexts.trim() !== '') argv.push('--context', input.args.contexts.trim());
  if (input.args.prefill_contexts.trim() !== '') {
    argv.push('--prefill-contexts', input.args.prefill_contexts.trim());
  }
  argv.push('--max-tokens', String(input.args.max_tokens));
  argv.push('--duration', String(input.args.duration));
  if (input.kvBudget !== null && Number.isFinite(input.kvBudget) && input.kvBudget > 0) {
    argv.push('--kv-budget', String(input.kvBudget));
  }
  if (input.args.coding_peak) {
    argv.push('--coding-peak');
    if (input.args.coding_peak_runs !== undefined) argv.push('--coding-peak-runs', String(input.args.coding_peak_runs));
    if (input.args.coding_peak_max_tokens !== undefined) {
      argv.push('--coding-peak-max-tokens', String(input.args.coding_peak_max_tokens));
    }
  }
  const extra = input.args.extra ?? '';
  if (extra.trim() !== '') argv.push(...extra.trim().split(/\s+/));
  return argv;
}

/** Quote-aware single-line rendering for a mono preview block. */
export function formatArgv(argv: string[]): string {
  return argv.map((a) => (/[\s"'\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ');
}
