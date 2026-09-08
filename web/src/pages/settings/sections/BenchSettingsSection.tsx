/* Settings ▸ Bench — repo dir + tool/venv state (+ bootstrap), write-repo-runs
   toggle, and the bench defaults (label + BenchArgs) form. These defaults
   prefill the runner form on the Bench page and merge with submitted args
   server-side (defaults win for absent keys). */

import { useRef, useState } from 'react';
import { Activity, RotateCcw } from 'lucide-react';
import {
  bootstrapBenchVenv,
  fetchBenchConfig,
  patchBenchConfig,
  type BenchConfigPatch,
} from '../../../api/admin';
import { useQuery } from '../../../api/queries';
import { Btn, Chip, Input, Toggle, toast } from '../../../ds';
import { DirtySave, Drawer, FieldMsg, NumField, offerAuthGate, errCopy } from '../../../lib/pagekit';
import { Terminal } from '../../../ds';
import { parseBenchCsv } from '../../../lib/benchArgs';
import { SectionWrap } from '../SectionWrap';
import { useDraftGate } from '../useSettingsState';

export function BenchSettingsSection() {
  const cfgQ = useQuery(fetchBenchConfig);
  const cfg = cfgQ.data;

  const [repoDir, setRepoDir] = useState('');
  const [writeRuns, setWriteRuns] = useState(false);
  const [label, setLabel] = useState('adhoc');
  const [args, setArgs] = useState({
    concurrency: '1,2,3,4',
    contexts: '0,8192,32768',
    prefill_contexts: '8k,32k',
    max_tokens: 2048,
    duration: 30,
    coding_peak: false,
    coding_peak_runs: null as number | null,
    coding_peak_max_tokens: null as number | null,
    kv_budget: null as number | null,
    extra: '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [bootLog, setBootLog] = useState<{ rc: number | null; log: string[] } | null>(null);

  const dirtyRef = useRef(false);
  useDraftGate(
    cfg !== null ? { repo: cfg.bench_repo_dir ?? '', runs: cfg.write_repo_runs ?? false, defaults: cfg.defaults } : null,
    dirtyRef,
    (fresh) => {
      setRepoDir(fresh.repo);
      setWriteRuns(fresh.runs);
      if (fresh.defaults !== null) {
        setLabel(fresh.defaults.label);
        const a = fresh.defaults.args;
        setArgs({
          concurrency: a.concurrency,
          contexts: a.contexts,
          prefill_contexts: a.prefill_contexts,
          max_tokens: a.max_tokens,
          duration: a.duration,
          coding_peak: a.coding_peak,
          coding_peak_runs: a.coding_peak_runs ?? null,
          coding_peak_max_tokens: a.coding_peak_max_tokens ?? null,
          kv_budget: a.kv_budget ?? null,
          extra: a.extra ?? '',
        });
      }
    },
  );

  const cCsv = parseBenchCsv(args.concurrency);
  const xCsv = parseBenchCsv(args.contexts, { allowSuffix: true });
  const pCsv = parseBenchCsv(args.prefill_contexts, { allowSuffix: true });

  const dirty =
    cfg !== null &&
    (repoDir !== (cfg.bench_repo_dir ?? '') ||
      writeRuns !== (cfg.write_repo_runs ?? false) ||
      (cfg.defaults === null
        ? true
        : label !== cfg.defaults.label ||
          args.concurrency !== cfg.defaults.args.concurrency ||
          args.contexts !== cfg.defaults.args.contexts ||
          args.prefill_contexts !== cfg.defaults.args.prefill_contexts ||
          args.max_tokens !== cfg.defaults.args.max_tokens ||
          args.duration !== cfg.defaults.args.duration ||
          args.coding_peak !== cfg.defaults.args.coding_peak ||
          (args.coding_peak_runs ?? undefined) !== cfg.defaults.args.coding_peak_runs ||
          (args.coding_peak_max_tokens ?? undefined) !== cfg.defaults.args.coding_peak_max_tokens ||
          (args.kv_budget ?? null) !== (cfg.defaults.args.kv_budget ?? null) ||
          args.extra !== (cfg.defaults.args.extra ?? '')));

  dirtyRef.current = dirty;

  const valid = cCsv.ok && xCsv.ok && pCsv.ok && args.max_tokens > 0 && args.duration > 0 && label.trim().length > 0;

  const reset = (): void => {
    if (cfg !== null) {
      cfgQ.reload();
    }
    setError(null);
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const patch: BenchConfigPatch = {
      bench_repo_dir: repoDir.trim() === '' ? null : repoDir.trim(),
      write_repo_runs: writeRuns,
      defaults: {
        label: label.trim() || 'adhoc',
        args: {
          concurrency: args.concurrency,
          contexts: args.contexts,
          prefill_contexts: args.prefill_contexts,
          max_tokens: args.max_tokens,
          duration: args.duration,
          coding_peak: args.coding_peak,
          coding_peak_runs: args.coding_peak_runs ?? undefined,
          coding_peak_max_tokens: args.coding_peak_max_tokens ?? undefined,
          kv_budget: args.kv_budget,
          extra: args.extra === '' ? undefined : args.extra,
        },
      },
    };
    try {
      const next = await patchBenchConfig(patch);
      cfgQ.reload();
      toast.ok('Bench settings saved', `tool: ${next.tool_present ? 'present' : 'missing'} · venv deps: ${next.venv_deps_ok === null ? 'untested' : next.venv_deps_ok ? 'ok' : 'broken'}`);
    } catch (err) {
      offerAuthGate(err);
      toast.error('Bench settings save failed', errCopy(err));
      setError(err);
    }
  };

  const bootstrap = (): void => {
    setSaving(true);
    bootstrapBenchVenv()
      .then(({ rc, log }) => {
        setBootLog({ rc, log });
        if (rc === 0) toast.ok('Bench venv bootstrapped');
        else toast.warn('Bench venv bootstrap finished nonzero', `rc=${rc ?? '—'}`);
        cfgQ.reload();
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Bench venv bootstrap failed', errCopy(err));
      })
      .finally(() => setSaving(false));
  };

  return (
    <SectionWrap
      id="bench"
      title="Bench"
      sub="tool/venv status, default sweep geometry — prefills the Bench runner"
      right={
        <Btn size="sm" variant="ghost" icon={<Activity size={12} />} onClick={() => void cfgQ.reload()} title="GET /api/bench/config">
          Check status
        </Btn>
      }
    >
      <div className="sd-panel flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Chip variant={cfg?.tool_present === true ? 'ok' : cfg === null ? 'neutral' : 'crit'} title="llm_decode_bench.py must exist in bench_repo_dir">
            tool: {cfg === null ? '—' : cfg.tool_present ? 'present' : 'missing'}
          </Chip>
          <Chip
            variant={cfg === null ? 'neutral' : cfg.venv_deps_ok === true ? 'ok' : cfg.venv_deps_ok === false ? 'crit' : 'warn'}
            title="venv Python + httpx/rich importable (runner probes `import httpx, rich`)"
          >
            venv deps: {cfg === null ? '—' : cfg.venv_deps_ok === null ? 'untested' : cfg.venv_deps_ok ? 'ok' : 'broken'}
          </Chip>
          {cfg?.venv_python !== null && cfg?.venv_python !== undefined && (
            <span className="font-mono text-2xs text-low" title="resolved venv python (settings → auto-detected in repo)">
              {cfg.venv_python}
            </span>
          )}
        </div>

        <div className="flex items-end gap-2">
          <Input
            label="Bench repo dir"
            className="min-w-0 flex-1"
            value={repoDir}
            placeholder="/home/…/glm53-flash-dgx-spark-tp2/bench"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setRepoDir(e.currentTarget.value)}
            hint="contains llm_decode_bench.py; venv lives at <dir>/.venv/bin/python"
          />
          <Btn size="md" variant="primary" loading={saving} onClick={bootstrap} title="POST /api/bench/bootstrap-venv — creates .venv + installs httpx/rich (synchronous)">
            Bootstrap venv
          </Btn>
          <Btn size="md" variant="ghost" onClick={reset} icon={<RotateCcw size={13} />} title="discard local edits and re-read">
            Reset
          </Btn>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-stroke pt-3">
          <div className="min-w-0">
            <div className="text-sm text-hi">write_repo_runs</div>
            <div className="text-xs text-low">
              run reports also land in the glm repo's <code className="font-mono">runs/</code> directory (run-NN markdown).
            </div>
          </div>
          <Toggle
            checked={writeRuns}
            onChange={(v) => setWriteRuns(v)}
            title="bench.write_repo_runs"
          />
        </div>

        <div className="border-t border-stroke pt-3">
          <div className="sd-monolabel mb-2">bench defaults</div>
          <div className="grid gap-3 lg:grid-cols-3">
            <Input label="Default label" value={label} onChange={(e) => setLabel(e.currentTarget.value)} hint="prefills the runner label" spellCheck={false} autoComplete="off" />
            <CsvBox label="Concurrency (plain ints)" value={args.concurrency} check={cCsv} onChange={(v) => setArgs((a) => ({ ...a, concurrency: v }))} />
            <CsvBox label="Contexts (ints or 8k-style)" value={args.contexts} check={xCsv} onChange={(v) => setArgs((a) => ({ ...a, contexts: v }))} />
            <CsvBox label="Prefill contexts" value={args.prefill_contexts} check={pCsv} onChange={(v) => setArgs((a) => ({ ...a, prefill_contexts: v }))} allowBlank />
            <NumField
              label="Max tokens"
              value={args.max_tokens}
              integer
              min={1}
              onChange={(v) => setArgs((a) => ({ ...a, max_tokens: v ?? 0 }))}
              required
            />
            <NumField
              label="Duration per cell"
              value={args.duration}
              unit="seconds"
              integer
              min={1}
              onChange={(v) => setArgs((a) => ({ ...a, duration: v ?? 0 }))}
              required
            />
            <NumField
              label="KV budget"
              value={args.kv_budget}
              unit="tokens"
              integer
              min={1}
              onChange={(v) => setArgs((a) => ({ ...a, kv_budget: v }))}
              hint="empty = tool default"
            />
          </div>

          <div className="mt-3 grid gap-3 lg:grid-cols-2">
            <div className="sd-raised flex items-center justify-between gap-3 p-2.5">
              <div className="min-w-0">
                <div className="text-sm text-hi">coding-peak mode</div>
                <div className="text-xs text-low">small-context decode burst in the sweep tail</div>
              </div>
              <Toggle checked={args.coding_peak} onChange={(v) => setArgs((a) => ({ ...a, coding_peak: v }))} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <NumField
                label="Coding-peak runs"
                value={args.coding_peak_runs}
                integer
                min={1}
                disabled={!args.coding_peak}
                onChange={(v) => setArgs((a) => ({ ...a, coding_peak_runs: v }))}
              />
              <NumField
                label="Coding-peak max tokens"
                value={args.coding_peak_max_tokens}
                integer
                min={1}
                disabled={!args.coding_peak}
                onChange={(v) => setArgs((a) => ({ ...a, coding_peak_max_tokens: v }))}
              />
            </div>
            <Input
              label="Extra args (one shell line, appended last)"
              value={args.extra}
              className="col-span-full"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setArgs((a) => ({ ...a, extra: e.currentTarget.value }))}
              placeholder="--seed 7"
            />
          </div>
        </div>

        <DirtySave
          dirty={dirty}
          valid={valid}
          saving={saving}
          error={error}
          onSave={() => void save()}
          onReset={reset}
          saveLabel="Save bench settings"
        />
      </div>

      <Drawer
        open={bootLog !== null}
        onClose={() => setBootLog(null)}
        title="Bench venv bootstrap"
        sub={bootLog === null ? '' : bootLog.rc === 0 ? 'ok — venv + httpx/rich installed' : `finished with rc ${bootLog.rc ?? '—'}`}
        width="min(640px, 90vw)"
      >
        <div className="flex min-h-[240px] flex-col">
          <Terminal lines={bootLog?.log ?? []} className="min-h-[239px]" />
        </div>
      </Drawer>
    </SectionWrap>
  );
}

function CsvBox({
  label,
  value,
  check,
  onChange,
  allowBlank = false,
}: {
  label: string;
  value: string;
  check: ReturnType<typeof parseBenchCsv>;
  onChange: (v: string) => void;
  allowBlank?: boolean;
}) {
  const blankOk = allowBlank && value.trim() === '';
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Input
        label={label}
        value={value}
        invalid={!check.ok && !blankOk}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => onChange(e.currentTarget.value)}
      />
      {!check.ok && !blankOk ? (
        <FieldMsg tone="error">{check.error}</FieldMsg>
      ) : check.items.length > 0 ? (
        <FieldMsg tone="ok">
          {check.items.map((i) => (i.suffix === 'plain' ? String(i.expanded) : `${i.raw}≈${i.expanded.toLocaleString('en-US')}`)).join(' · ')}
        </FieldMsg>
      ) : (
        <FieldMsg tone="hint">blank ok — tool default kicks in</FieldMsg>
      )}
    </div>
  );
}
