/* Bench ▸ JobView — the live job: header chips, checkpoint progress bar,
   streaming console (WS `bench` topic w/ 3-s REST poll fallback), cancel
   (SIGINT semantics), and on completion: summary grids + full-JSON drawer +
   write run report. */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BenchJob } from '../../api/types';
import { cancelBenchJob, fetchBenchJob, fetchBenchResult, writeBenchReport } from '../../api/admin';
import { useWs } from '../../api/client';
import { Bar, Btn, Chip, ConfirmDialog, Panel, Spinner, Terminal, toast } from '../../ds';
import { cn } from '../../lib/cn';
import { CodeBlock, Drawer, FieldMsg, errCopy, offerAuthGate } from '../../lib/pagekit';
import { fmtClock, fmtDateTime, fmtDuration } from '../../lib/format';
import { parseSummary, progressFraction, type BenchSummaryView } from './summary';
import { SummaryGrids } from './SummaryGrids';

const STATE_VARIANT: Record<BenchJob['state'], 'neutral' | 'accent' | 'ok' | 'crit' | 'warn'> = {
  queued: 'neutral',
  running: 'accent',
  ok: 'ok',
  error: 'crit',
  cancelled: 'warn',
};

export function JobView({
  jobId,
  truthArgv,
  activeClusterName,
  onSettled,
  onDismiss,
}: {
  jobId: string | null;
  /** argv returned verbatim by POST /api/bench/jobs — the operator's truth */
  truthArgv: string[] | null;
  activeClusterName: string | null;
  /** history refresh hook-up (fires when the job reaches a terminal state) */
  onSettled: () => void;
  onDismiss: () => void;
}) {
  const job = useWs((s) => (jobId !== null ? s.benchById.get(jobId) : undefined)) ?? null;
  const [polled, setPolled] = useState<{ job: BenchJob | null; tail: string[] }>({ job: null, tail: [] });
  const [cancelOpen, setCancelOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const [resultJson, setResultJson] = useState<unknown>(null);
  const [resultBusy, setResultBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const wsState = job?.state ?? polled.job?.state ?? null;

  /* 3-s REST poll fallback while the job is queued/running (docs: job + tail) */
  useEffect(() => {
    if (jobId === null || (wsState !== 'queued' && wsState !== 'running')) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (delayMs: number): void => {
      timer = setTimeout(poll, delayMs);
    };
    const poll = (): void => {
      fetchBenchJob(jobId, 100)
        .then((d) => {
          if (!active) return;
          setPolled((cur) => ({ job: d.job ?? cur.job, tail: d.tail }));
          schedule(3000);
        })
        .catch(() => {
          if (active) schedule(5000);
        });
    };
    fetchBenchJob(jobId, 100)
      .then((d) => {
        if (!active) return;
        setPolled((cur) => ({ job: d.job ?? cur.job, tail: d.tail }));
      })
      .catch(() => undefined)
      .finally(() => schedule(3000));
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [jobId, wsState]);

  const running = wsState === 'running';

  /* ticking clock for the elapsed readout while running */
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  /* settle callbacks — once per job-id+state transition */
  const settledRef = useRef('');
  useEffect(() => {
    if (jobId === null || wsState === null || wsState === 'queued' || wsState === 'running') return;
    const stamp = `${jobId}:${wsState}`;
    if (settledRef.current === stamp) return;
    settledRef.current = stamp;
    if (wsState === 'ok') toast.ok(`Bench ${jobId} finished`, 'summary grids + report ready');
    else if (wsState === 'cancelled') toast.warn(`Bench ${jobId} cancelled`, 'partial results preserved (SIGINT checkpoint)');
    else toast.error(`Bench ${jobId} ended with error`);
    onSettled();
  }, [jobId, wsState, onSettled]);

  const wsTail = useWs((s) => (jobId !== null ? s.logTails.get(`bench:${jobId}`) : undefined)) ?? [];
  const effectiveJob = job ?? polled.job;
  const summary: BenchSummaryView = useMemo(() => parseSummary(effectiveJob?.summary ?? null), [effectiveJob?.summary]);

  if (jobId === null || effectiveJob === null) return null;

  const j = effectiveJob;
  const lines = wsTail.length > 0 ? wsTail : polled.tail;
  const frac = progressFraction(j, summary);
  const started = j.started ?? null;
  const elapsed =
    started !== null
      ? running
        ? (now - started) / 1000
        : typeof j.finished === 'number' && j.finished !== null
          ? (j.finished - started) / 1000
          : null
      : null;
  const summaryErr = (j.summary as Record<string, unknown> | null)?.error;

  return (
    <section className="sd-panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <h2 className="text-[13px] font-semibold text-hi">Job {j.id}</h2>
          <Chip variant={STATE_VARIANT[j.state]}>{j.state}</Chip>
          {activeClusterName !== null && <Chip variant="neutral">{activeClusterName}</Chip>}
          {j.profile_key != null && j.profile_key !== '' && <Chip variant="neutral">{j.profile_key}</Chip>}
          <Chip variant="neutral" className="font-mono">
            {j.host}:{j.port}
          </Chip>
          <Chip variant="neutral" className="truncate font-mono" title={j.model}>
            {j.model}
          </Chip>
          {j.label !== '' && <Chip variant="neutral">{j.label}</Chip>}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {running && (
            <Btn size="sm" variant="danger" onClick={() => setCancelOpen(true)}>
              Cancel (SIGINT)
            </Btn>
          )}
          {j.state === 'ok' && (
            <>
              <Btn
                size="sm"
                variant="ghost"
                loading={resultBusy}
                onClick={() => {
                  if (resultJson !== null) {
                    setResultOpen(true);
                    return;
                  }
                  setResultOpen(true);
                  setResultBusy(true);
                  fetchBenchResult(j.id)
                    .then((js) => setResultJson(js))
                    .catch((err) => {
                      offerAuthGate(err);
                      toast.error('Result fetch failed', errCopy(err));
                    })
                    .finally(() => setResultBusy(false));
                }}
              >
                Full result JSON
              </Btn>
              <Btn
                size="sm"
                variant="primary"
                onClick={() => {
                  writeBenchReport(j.id)
                    .then((r) => {
                      if (r.rc === 0) {
                        toast.ok(
                          'Run report written',
                          [r.path ?? '', r.repo_path !== null ? `repo: ${r.repo_path}` : '', r.repo_error !== null ? `repo error: ${r.repo_error}` : '']
                            .filter((x) => x !== '')
                            .join(' · ') || (r.path ?? ''),
                        );
                      } else {
                        toast.warn('Run report not written', r.error ?? 'no result file yet');
                      }
                    })
                    .catch((err) => {
                      offerAuthGate(err);
                      toast.error('Report write failed', errCopy(err));
                    });
                }}
              >
                Write run report
              </Btn>
            </>
          )}
          <Btn size="sm" variant="ghost" onClick={onDismiss} title="clear the live view — history keeps everything">
            Dismiss
          </Btn>
        </div>
      </div>

      <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-low">
        <span>
          created <span className="font-mono text-mid">{fmtDateTime(j.created)}</span>
        </span>
        {started !== null && (
          <span>
            started <span className="font-mono text-mid">{fmtClock(started)}</span>
          </span>
        )}
        {elapsed !== null && (
          <span>
            elapsed <span className="font-mono text-mid">{fmtDuration(elapsed)}</span>
          </span>
        )}
        {typeof j.finished === 'number' && !running && (
          <span>
            finished <span className="font-mono text-mid">{fmtClock(j.finished)}</span>
          </span>
        )}
        {j.exit !== null && j.exit !== undefined && (
          <span className={cn('font-mono', j.exit === 0 ? 'text-ok' : 'text-crit')}>exit {j.exit}</span>
        )}
        {j.result_path !== null && j.result_path !== undefined && j.result_path !== '' && (
          <span title={j.result_path} className="max-w-[360px] truncate font-mono text-low">
            → {j.result_path.split('/').slice(-2).join('/')}
          </span>
        )}
      </dl>

      {/* live checkpoint progress */}
      {running && (
        <div className="flex items-center gap-2">
          <Bar
            value={frac === null ? null : frac * 100}
            max={100}
            height={6}
            title={frac === null ? 'collecting checkpoints…' : `checkpoint cells: ${summary.grid.length}`}
          />
          <span className="sd-num shrink-0 font-mono text-2xs text-mid">
            {frac === null ? 'sampling…' : `${Math.round(frac * 100)}%`}
          </span>
          <Chip variant="accent" title="progress reads the per-cell checkpoint file the tool rewrites after each finished config">
            checkpoint-driven
          </Chip>
        </div>
      )}

      {truthArgv !== null && truthArgv.length > 0 && (
        <CodeBlock
          dense
          label="argv — server truth (POST /api/bench/jobs response)"
          lines={[truthArgv.map((a) => (/[\s"'\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a)).join(' ')]}
        />
      )}

      {summary.grid.length > 0 && (
        <div className="min-w-0">
          <SummaryGrids summary={summary} />
        </div>
      )}

      {typeof summaryErr === 'string' && (
        <FieldMsg tone="error">
          <span className="font-mono">{summaryErr}</span>
        </FieldMsg>
      )}

      {/* console */}
      <Panel
        title="console"
        className="flex min-h-[220px] flex-col p-0"
        actions={
          <Chip variant="neutral" title={wsTail.length > 0 ? 'streaming via the ws bench topic' : 'REST tail (100 lines) polled every 3 s'}>
            {wsTail.length > 0 ? 'ws' : 'poll'} · {lines.length} lines
          </Chip>
        }
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <Terminal
            lines={lines}
            className="min-h-[219px]"
            empty={
              <div className="flex items-center justify-center gap-2 py-10 text-low">
                {running ? <Spinner size={12} /> : null} waiting for tool output…
              </div>
            }
          />
        </div>
      </Panel>

      <ConfirmDialog
        open={cancelOpen}
        onClose={() => setCancelOpen(false)}
        title={`Cancel bench ${j.id}`}
        summary={
          <>
            Sends <span className="font-mono text-hi">SIGINT</span> to the bench process. The tool checkpoints every
            completed cell — <span className="text-ok">partial results are preserved</span> from{' '}
            <code className="font-mono">&lt;result&gt;.resume.json</code>. If the process ignores the interrupt, the
            runner escalates to SIGKILL after ~10 s (the last cell is lost in that path).
          </>
        }
        commands={[`POST /api/bench/jobs/${j.id}/cancel`]}
        confirmLabel="Cancel job"
        onConfirm={() => {
          cancelBenchJob(j.id)
            .then(({ ok }) => {
              if (ok) toast.ok('Cancel requested — SIGINT sent to the bench process');
              else toast.warn('Job is not running anymore', 'nothing to cancel');
              setCancelOpen(false);
            })
            .catch((err) => {
              offerAuthGate(err);
              toast.error('Cancel failed', errCopy(err));
            });
        }}
      />

      <Drawer
        open={resultOpen}
        onClose={() => setResultOpen(false)}
        title={`Result JSON — ${j.label}`}
        sub={`GET /api/bench/jobs/${j.id}/result`}
        width="min(780px, 94vw)"
      >
        <pre className="sd-raised max-h-full overflow-auto p-3 font-mono text-2xs leading-[1.5] text-hi">
          {resultJson === null ? <Spinner size={13} /> : JSON.stringify(resultJson, null, 2)}
        </pre>
      </Drawer>
    </section>
  );
}
