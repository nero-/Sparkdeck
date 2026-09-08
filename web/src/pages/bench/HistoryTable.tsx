/* Bench ▸ HistoryTable — stacked sparkdeck + repo runs (GET /api/bench/history,
   newest first). Columns: label, ts, engine, best tps, c1 tps, prefills, kv,
   source — plus a delta arrow vs the prior row of the same host. Row click →
   details drawer with the full summary grid. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BenchHistoryRow } from '../../api/types';
import { fetchBenchHistory } from '../../api/admin';
import { useQuery } from '../../api/queries';
import { Btn, Chip, Spinner } from '../../ds';
import { DataTable, Drawer, FieldMsg, Td, errCopy } from '../../lib/pagekit';
import { cn } from '../../lib/cn';
import { ArrowDownRight, ArrowUpRight, Minus, RefreshCw } from 'lucide-react';
import { fmtDateTime } from '../../lib/format';
import { parseSummary, type BenchSummaryView } from './summary';
import { SummaryGrids } from './SummaryGrids';

interface HistView extends BenchHistoryRow {
  view: BenchSummaryView;
  host: string | null;
}

function hostOf(v: BenchSummaryView): string | null {
  if (v.serverUrl === null) return null;
  try {
    const withoutScheme = v.serverUrl.replace(/^[a-z]+:\/\//i, '');
    return withoutScheme.split(':')[0] ?? withoutScheme.split('/')[0] ?? null;
  } catch {
    return null;
  }
}

export function HistoryTable({ refreshSignal }: { refreshSignal: number }) {
  const q = useQuery(fetchBenchHistory);
  const [open, setOpen] = useState<HistView | null>(null);
  const lastSignal = useRef(refreshSignal);
  const [onlySparkdeck, setOnlySparkdeck] = useState(false);

  const rows = useMemo<HistView[]>(() => {
    const list = q.data ?? [];
    const out: HistView[] = [];
    for (const r of list) {
      const view = parseSummary(r.summary);
      out.push({ ...r, view, host: hostOf(view) });
    }
    return onlySparkdeck ? out.filter((r) => r.source === 'sparkdeck') : out;
  }, [q.data, onlySparkdeck]);

  const deltaFor = (idx: number, best: number | null): { pct: number | null; better: boolean | null } => {
    const cur = rows[idx];
    if (cur === undefined || best === null) return { pct: null, better: null };
    for (let i = idx + 1; i < rows.length; i++) {
      const prior = rows[i];
      if (prior === undefined || prior.host !== cur.host) continue;
      const priorBest = prior.view.best?.tps ?? null;
      if (priorBest !== null && priorBest > 0) {
        return { pct: ((best - priorBest) / priorBest) * 100, better: best > priorBest };
      }
      return { pct: null, better: null };
    }
    return { pct: null, better: null };
  };

  useEffect(() => {
    if (lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void q.reload();
  }, [refreshSignal, q.reload]);

  return (
    <section className="sd-panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-hi">History</h2>
          <Chip variant="neutral" title="sparkdeck job rows + the repo's own *.json runs, newest first">
            sparkdeck + repo runs
          </Chip>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setOnlySparkdeck(false)}
              className={cn(
                'cursor-pointer rounded-inner px-1.5 py-0.5 font-mono text-2xs transition-colors duration-fast',
                !onlySparkdeck ? 'bg-accent/10 text-accent' : 'text-mid hover:text-hi',
              )}
            >
              all
            </button>
            <button
              type="button"
              onClick={() => setOnlySparkdeck(true)}
              className={cn(
                'cursor-pointer rounded-inner px-1.5 py-0.5 font-mono text-2xs transition-colors duration-fast',
                onlySparkdeck ? 'bg-accent/10 text-accent' : 'text-mid hover:text-hi',
              )}
            >
              sparkdeck only
            </button>
          </div>
        </div>
        <Btn size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={() => {
          void q.reload();
        }}>
          Refresh
        </Btn>
      </div>

      {q.error !== null ? (
        <div className="p-3">
          <FieldMsg tone="error">{errCopy(q.error)}</FieldMsg>
        </div>
      ) : q.loading && rows.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-8 text-mid">
          <Spinner size={13} /> loading history…
        </div>
      ) : (
        <DataTable
          columns={[
            { key: 'label', label: 'label' },
            { key: 'ts', label: 'ts' },
            { key: 'engine', label: 'engine' },
            { key: 'best', label: 'best tok/s', align: 'right' },
            { key: 'd', label: 'Δ', align: 'right', title: 'vs previous run of the same host (best tok/s)' },
            { key: 'c1', label: 'C=1 tok/s', align: 'right' },
            { key: 'pre', label: 'prefill tok/s', align: 'right' },
            { key: 'kv', label: 'kv', align: 'right' },
            { key: 'src', label: 'source', align: 'right' },
          ]}
          minWidth={840}
          empty="No runs yet — the first submission lands here."
        >
          {rows.map((r, idx) => {
            const delta = deltaFor(idx, r.view.best?.tps ?? null);
            const bestPre = r.view.prefill.reduce<number | null>((m, p) => (p.tokPerSec !== null && (m === null || p.tokPerSec > m) ? p.tokPerSec : m), null);
            return (
              <tr
                key={`${r.source}:${r.job_id ?? r.path}:${r.ts ?? idx}`}
                className="cursor-pointer transition-colors duration-fast hover:bg-bg2/60"
                onClick={() => setOpen(r)}
              >
                <Td className="font-mono text-hi" title={r.path}>
                  {r.label}
                </Td>
                <Td num className="text-2xs text-mid">
                  {r.ts !== null ? fmtDateTime(r.ts) : '—'}
                </Td>
                <Td className="text-2xs text-mid">{r.view.engine ?? '—'}</Td>
                <Td num align="right" className="text-hi">
                  {fmtNumSafe(r.view.best?.tps)}
                </Td>
                <Td num align="right">
                  <Delta pct={delta.pct} better={delta.better} />
                </Td>
                <Td num align="right" className="text-mid">
                  {fmtNumSafe(r.view.c1?.tps)}
                </Td>
                <Td num align="right" className="text-mid">
                  {fmtNumSafe(bestPre)}
                </Td>
                <Td num align="right" className="text-mid">
                  {r.view.kvBudget !== null ? r.view.kvBudget.toLocaleString('en-US') : '—'}
                </Td>
                <Td align="right">
                  <Chip variant={r.source === 'sparkdeck' ? 'accent' : 'neutral'}>{r.source}</Chip>
                </Td>
              </tr>
            );
          })}
        </DataTable>
      )}

      <Drawer
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open !== null ? open.label : ''}
        sub={open !== null ? `${open.source} · ${open.ts !== null ? fmtDateTime(open.ts) : 'no ts'} · ${open.host ?? 'host ?'}` : ''}
        width="min(820px, 94vw)"
      >
        {open !== null && (
          <div className="flex flex-col gap-3">
            <SummaryGrids summary={open.view} dense />
            <div className="min-w-0">
              <span className="sd-monolabel">path</span>
              <code className="font-mono text-2xs text-low break-all">{open.path || '—'}</code>
            </div>
          </div>
        )}
      </Drawer>
    </section>
  );
}

function fmtNumSafe(v: number | null | undefined): string {
  return v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: 1 });
}

function Delta({ pct, better }: { pct: number | null; better: boolean | null }) {
  if (pct === null) {
    return (
      <span className="inline-flex items-center gap-1 text-low" title="no prior run for this host">
        <Minus size={11} />
      </span>
    );
  }
  return (
    <span
      className={cn('inline-flex items-center gap-0.5 font-mono', better ? 'text-ok' : 'text-crit')}
      title={`${pct > 0 ? '+' : ''}${pct.toFixed(1)}% vs previous run of this host`}
    >
      {better ? <ArrowUpRight size={11} /> : <ArrowDownRight size={11} />}
      {`${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`}
    </span>
  );
}
