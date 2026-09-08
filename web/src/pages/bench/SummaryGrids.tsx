/* bench summary rendering — shared by the live job card and the history
   detail drawer: aggregate tok/s grid (ctx × conc), prefill table, best
   cells, spec-accept avg, coding peak. Pure normalization + display. */

import type { BenchSummaryView, GridCell } from './summary';
import { Chip, Panel } from '../../ds';
import { cn } from '../../lib/cn';
import { DataTable, FieldMsg, Td } from '../../lib/pagekit';
import { fmtDec, fmtFixed, fmtNum } from '../../lib/format';

/** Unique sorted context + concurrency axes from the summary grid. */
export function gridAxes(s: BenchSummaryView): { rows: string[]; cols: number[] } {
  const rows = [...new Set(s.grid.map((c) => c.ctx))].sort(
    (a, b) => ctxValue(a) - ctxValue(b),
  );
  const cols = [...new Set(s.grid.map((c) => c.conc))].sort((a, b) => a - b);
  return { rows, cols };
}

function ctxValue(ctx: string): number {
  const m = /^(\d+)(k|K|m|mi)?$/i.exec(ctx);
  if (m === null) return Number.MAX_SAFE_INTEGER;
  const base = Number(m[1] ?? 0);
  const suffix = (m[2] ?? '').toLowerCase();
  return suffix === 'm' || suffix === 'mi' ? base * 1024 * 1024 : suffix === 'k' ? base * 1024 : base;
}

export function SummaryGrids({ summary, dense = false }: { summary: BenchSummaryView; dense?: boolean }) {
  const { rows, cols } = gridAxes(summary);
  const pick = (ctx: string, conc: number): GridCell | null =>
    summary.grid.find((c) => c.ctx === ctx && c.conc === conc) ?? null;

  return (
    <div className="flex flex-col gap-3">
      {(summary.partial || summary.engine === null && summary.grid.length > 0) && (
        <Chip variant="accent" title="checkpoint-based cells (results.resume.json read every ~8 s while running)">
          partial — checkpoint view
        </Chip>
      )}

      <Panel title="Aggregate decode tok/s (ctx × concurrency)" className="p-3">
        <DataTable
          columns={[{ key: 'ctx', label: 'ctx \\ conc' }, ...cols.map((c) => ({ key: `c${c}`, label: `C=${c}`, align: 'right' as const }))]}
          minWidth={Math.max(360, 90 + cols.length * 90)}
        >
          {rows.map((ctx) => (
            <tr key={ctx}>
              <Td num className="font-mono text-hi">
                {ctx}
              </Td>
              {cols.map((conc) => {
                const cell = pick(ctx, conc);
                const isBest = summary.best !== null && summary.best.ctx === ctx && summary.best.conc === conc;
                return (
                  <Td
                    key={`${ctx}:${conc}`}
                    num
                    align="right"
                    className={cn(
                      isBest && 'font-semibold text-ok',
                      cell !== null && cell.flagged !== null && 'text-warn',
                    )}
                    title={cell === null ? 'no data' : [cell.ttftP50 !== null ? `ttft_p50 ${fmtFixed(cell.ttftP50, 2)} s` : null, cell.flagged].filter((x) => x !== null).join(' · ')}
                  >
                    {cell === null || cell.tps === null
                      ? '—'
                      : `${fmtDec(cell.tps)}${cell.flagged !== null ? ' ⚠' : ''}`}
                  </Td>
                );
              })}
            </tr>
          ))}
        </DataTable>
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          {summary.best !== null && (
            <Chip variant="ok" title="highest aggregate tok/s in the sweep">
              best {(summary.best.tps ?? 0).toLocaleString('en-US')} tok/s @ ctx {summary.best.ctx} · C={summary.best.conc}
            </Chip>
          )}
          {summary.c1 !== null && (
            <Chip variant="accent" title="best C=1 cell — the per-stream decode ceiling">
              C=1 {fmtDec(summary.c1.tps)} tok/s @ ctx {summary.c1.ctx}
            </Chip>
          )}
          {summary.specAcceptAvg !== null && <Chip variant="neutral">spec accept avg {summary.specAcceptAvg}</Chip>}
          {summary.codingPeak !== null && (
            <Chip variant="warn" title="small-context decode burst summary">
              coding peak mean {fmtDec(summary.codingPeak.meanTps)} · max {fmtDec(summary.codingPeak.maxTps)} tok/s
              {summary.codingPeak.runsOk !== null ? ` · ${summary.codingPeak.runsOk} ok` : ''}
            </Chip>
          )}
          {summary.kvBudget !== null && <Chip variant="neutral">kv {fmtNum(summary.kvBudget)}</Chip>}
        </div>
      </Panel>

      {summary.prefill.length > 0 && (
        <Panel title="Prefill (prefill_contexts sweep)" className="p-3">
          <DataTable
            columns={[
              { key: 'ctx', label: 'ctx' },
              { key: 'tps', label: 'tok/s', align: 'right' },
              { key: 'ttft', label: 'TTFT s', align: 'right' },
              { key: 'pt', label: 'prompt tokens', align: 'right' },
            ]}
            minWidth={380}
            empty="—"
          >
            {summary.prefill.map((p) => (
              <tr key={p.ctx}>
                <Td num className="font-mono text-hi">
                  {p.ctx}
                </Td>
                <Td num align="right">
                  {fmtNum(p.tokPerSec)}
                </Td>
                <Td num align="right">
                  {p.ttftS !== null ? fmtFixed(p.ttftS, 2) : '—'}
                </Td>
                <Td num align="right">
                  {p.promptTokens !== null ? fmtNum(p.promptTokens) : '—'}
                </Td>
              </tr>
            ))}
          </DataTable>
        </Panel>
      )}

      {dense && summary.engine !== null && (
        <div className="flex gap-1.5">
          <Chip variant="neutral">engine {summary.engine}</Chip>
          {summary.model !== null && <Chip variant="neutral">{summary.model}</Chip>}
          {summary.serverUrl !== null && <Chip variant="neutral">{summary.serverUrl}</Chip>}
          {summary.cells !== null && <Chip variant="neutral">{summary.cells} cells</Chip>}
        </div>
      )}

      {summary.grid.length === 0 && summary.prefill.length === 0 && (
        <FieldMsg tone="hint">summary didn't carry a grid yet — cells appear as the tool checkpoints each config.</FieldMsg>
      )}
    </div>
  );
}
