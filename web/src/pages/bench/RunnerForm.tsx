/* Bench ▸ RunnerForm — target/args with inline validation, argv preview
   (client mirror of the backend builder; the POST response argv is the truth),
   kv auto-fill from the boot log, submit → job id + argv truth. */

import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { AddressKind, ClusterTopology, ID, ServiceState } from '../../api/types';
import {
  createBenchJob,
  fetchLlmState,
  type BenchConfig,
  type BenchJobCreated,
  type BenchJobInput,
} from '../../api/admin';
import { Btn, Chip, Input, Select, Toggle, toast } from '../../ds';
import { cn } from '../../lib/cn';
import { CodeBlock, FieldMsg, NumField, errCopy, offerAuthGate } from '../../lib/pagekit';
import { formatArgv, mirrorArgv, parseBenchCsv } from '../../lib/benchArgs';

export interface RunnerSubmitSnapshot {
  clusterId: ID;
  label: string;
}

export function RunnerForm({
  clusters,
  config,
  configLoading,
  serviceOf,
  onSubmitted,
}: {
  clusters: ClusterTopology[];
  config: BenchConfig | null;
  configLoading: boolean;
  serviceOf: (clusterId: ID) => ServiceState | undefined;
  onSubmitted: (created: BenchJobCreated, snapshot: RunnerSubmitSnapshot) => void;
}) {
  const [f, setF] = useState<FormState>(emptyForm);
  const seededRef = useRef(false);
  const portDefaultRef = useRef('8000');
  const portTouched = useRef(false);
  const modelTouched = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [kvBusy, setKvBusy] = useState(false);

  const cluster = clusters.find((c) => c.id === f.clusterId) ?? null;
  const profile = cluster?.profiles.find((p) => p.key === f.profileKey) ?? null;
  const service = cluster !== null ? serviceOf(cluster.id) : undefined;

  /* seed once from bench defaults when they arrive (label + args sweep) */
  useEffect(() => {
    if (seededRef.current || config === null) return;
    seededRef.current = true;
    const d = config.defaults;
    setF((cur) => {
      if (d === null) {
        return { ...cur, clusterId: cur.clusterId ?? clusters[0]?.id ?? null };
      }
      return {
        ...cur,
        clusterId: cur.clusterId ?? clusters[0]?.id ?? null,
        label: d.label,
        args: {
          concurrency: d.args.concurrency,
          contexts: d.args.contexts,
          prefill_contexts: d.args.prefill_contexts,
          max_tokens: String(d.args.max_tokens),
          duration: String(d.args.duration),
          coding_peak: d.args.coding_peak,
          coding_peak_runs: optStr(d.args.coding_peak_runs),
          coding_peak_max_tokens: optStr(d.args.coding_peak_max_tokens),
          kv_budget: optStr(d.args.kv_budget),
          extra: d.args.extra ?? '',
        },
      };
    });
  }, [config, clusters]);

  /* retarget host/port/model when the cluster or profile moves; user-touched
     fields win (port/model keep their value only when they were edited) */
  useEffect(() => {
    if (cluster === null) return;
    const has = (k: AddressKind): boolean => headAddr(cluster, k) !== null;
    const wantedKind: AddressKind | 'custom' = pickKind(f.hostKind, has);
    const head = cluster.nodes.find((n) => n.id === cluster.control.head_node_id) ?? cluster.nodes.find((n) => n.role === 'head') ?? null;
    const anyPrimary = head?.addresses[0]?.host ?? ''; // last resort — first address in failover order
    const hostByKind = wantedKind === 'custom' ? f.host : (headAddr(cluster, wantedKind)?.host ?? '');
    const portDefault = String(service?.port ?? 8000);
    const portConsume = !portTouched.current && f.port === portDefaultRef.current;
    const modelDefault = profile !== null ? profile.served_model_name : (service?.model ?? cluster.profiles[0]?.served_model_name ?? '');
    setF((cur) => ({
      ...cur,
      hostKind: wantedKind,
      host: wantedKind === 'custom' ? cur.host : hostByKind !== '' ? hostByKind : anyPrimary,
      port: portConsume ? portDefault : cur.port,
      model: !modelTouched.current ? (modelDefault !== '' ? modelDefault : cur.model) : cur.model,
    }));
    portDefaultRef.current = portDefault;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster, profile, service]);

  const conC = parseBenchCsv(f.args.concurrency);
  const ctxC = parseBenchCsv(f.args.contexts, { allowSuffix: true });
  const preC = parseBenchCsv(f.args.prefill_contexts, { allowSuffix: true });
  const maxTokens = Number(f.args.max_tokens);
  const duration = Number(f.args.duration);
  const kvBudget = f.args.kv_budget.trim() === '' ? null : Number(f.args.kv_budget);
  const portN = Number(f.port);

  const valid =
    cluster !== null &&
    f.host.trim() !== '' &&
    Number.isInteger(portN) && portN >= 1 && portN <= 65535 &&
    f.model.trim() !== '' &&
    conC.ok && ctxC.ok && preC.ok &&
    Number.isInteger(maxTokens) && maxTokens > 0 &&
    Number.isInteger(duration) && duration > 0 &&
    (kvBudget === null || (Number.isFinite(kvBudget) && kvBudget > 0));

  const argvPreview = formatArgv(
    mirrorArgv({
      venvPython: config?.venv_python ?? null,
      tool: null,
      host: f.host,
      port: portN,
      model: f.model,
      label: f.label,
      outputHint: '<app-data>/bench/<job-id>/<label>-<id>.json',
      kvBudget,
      args: {
        concurrency: canonicalCsv(f.args.concurrency, false),
        contexts: canonicalCsv(f.args.contexts, true),
        prefill_contexts: canonicalCsv(f.args.prefill_contexts, true),
        max_tokens: Number.isInteger(maxTokens) ? maxTokens : 0,
        duration: Number.isInteger(duration) ? duration : 0,
        coding_peak: f.args.coding_peak,
        coding_peak_runs: optNum(f.args.coding_peak_runs),
        coding_peak_max_tokens: optNum(f.args.coding_peak_max_tokens),
        extra: f.args.extra.trim() === '' ? undefined : f.args.extra.trim(),
      },
    }),
  );

  const submit = (): void => {
    if (cluster === null || !valid) return;
    setSubmitting(true);
    setError(null);
    const input: BenchJobInput = {
      cluster_id: cluster.id,
      profile_key: f.profileKey === '' ? null : f.profileKey,
      host: f.host.trim(),
      port: portN,
      model: f.model.trim(),
      label: f.label.trim() || 'adhoc',
      kv_budget: kvBudget,
      args: {
        concurrency: canonicalCsv(f.args.concurrency, false),
        contexts: canonicalCsv(f.args.contexts, true),
        prefill_contexts: canonicalCsv(f.args.prefill_contexts, true),
        max_tokens: maxTokens,
        duration,
        coding_peak: f.args.coding_peak,
        coding_peak_runs: benchOpt(optNum(f.args.coding_peak_runs)),
        coding_peak_max_tokens: benchOpt(optNum(f.args.coding_peak_max_tokens)),
        extra: f.args.extra.trim() === '' ? undefined : f.args.extra.trim(),
      },
    };
    createBenchJob(input)
      .then((created) => {
        if (created.job_id === null) {
          toast.error('Bench job was not accepted', 'the POST response carried no job id (check controller logs)');
          setError(new Error('POST /api/bench/jobs returned no job id'));
          return;
        }
        toast.ok(`Bench run queued — job ${created.job_id}`, `${input.label} → ${input.host}:${input.port}`);
        onSubmitted(created, { clusterId: cluster.id, label: input.label });
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Bench submit failed', errCopy(err));
        setError(err);
      })
      .finally(() => setSubmitting(false));
  };

  const fillKvFromBoot = (): void => {
    if (cluster === null) return;
    setKvBusy(true);
    fetchLlmState(cluster.id)
      .then((st) => {
        const kv = typeof st.kv_tokens === 'number' && Number.isFinite(st.kv_tokens) && st.kv_tokens > 0 ? st.kv_tokens : null;
        if (kv !== null) {
          setF((cur) => ({ ...cur, args: { ...cur.args, kv_budget: String(kv) } }));
          toast.ok(`kv budget → ${kv.toLocaleString('en-US')} tokens`, "from the pair's boot log (kv_tokens)");
        } else {
          toast.warn('Service state has no kv tokens yet', 'boot the pair first (Control page) and retry');
        }
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Could not read service state', errCopy(err));
      })
      .finally(() => setKvBusy(false));
  };

  return (
    <section className="sd-panel flex min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-hi">Runner</h2>
        <div className="flex items-center gap-1.5">
          <Chip
            variant={config === null ? (configLoading ? 'accent' : 'neutral') : config.tool_present ? 'ok' : 'crit'}
            title={config === null ? 'GET /api/bench/config' : 'llm_decode_bench.py presence + venv deps from GET /api/bench/config'}
          >
            {config === null
              ? configLoading
                ? 'loading bench config…'
                : 'bench config unavailable'
              : config.tool_present
                ? 'bench tool ready'
                : 'bench tool missing'}
          </Chip>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select
          label="Cluster"
          value={f.clusterId ?? ''}
          onChange={(e) => {
            portTouched.current = false;
            modelTouched.current = false;
            setF((cur) => ({ ...cur, clusterId: e.currentTarget.value === '' ? null : e.currentTarget.value, profileKey: '', hostKind: 'lan' }));
          }}
        >
          <option value="">— select —</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
        <Select
          label="Profile"
          value={f.profileKey}
          onChange={(e) => setF((cur) => ({ ...cur, profileKey: e.currentTarget.value }))}
        >
          <option value="">— none (tool default) —</option>
          {(cluster?.profiles ?? []).map((p) => (
            <option key={p.key} value={p.key}>
              {p.label !== '' ? `${p.key} — ${p.label}` : p.key}
            </option>
          ))}
        </Select>
        <Select
          label="Host source (head node)"
          value={f.hostKind}
          onChange={(e) => setF((cur) => ({ ...cur, hostKind: e.currentTarget.value as FormState['hostKind'] }))}
        >
          {(['lan', 'fabric', 'tailscale', 'custom'] as const).map((k) => (
            <option key={k} value={k} disabled={k !== 'custom' && cluster !== null && headAddr(cluster, k) === null}>
              {k}
              {cluster !== null && k !== 'custom' && headAddr(cluster, k) === null ? ' · none' : ''}
            </option>
          ))}
        </Select>
        <Input
          label={f.hostKind === 'custom' ? 'Host (custom)' : 'Host'}
          value={f.host}
          placeholder="choose a source or type one"
          invalid={f.host.trim() === ''}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setF((cur) => ({ ...cur, hostKind: 'custom', host: e.currentTarget.value }))}
          hint={
            f.hostKind === 'custom'
              ? 'custom target wins — e.g. an LB or a relay'
              : service !== undefined && service.host !== null
                ? `service answering at ${service.host}:${service.port ?? '—'}`
                : 'head-node address in failover order'
          }
        />
        <Input
          label="Port"
          value={f.port}
          inputMode="numeric"
          invalid={!(Number.isInteger(portN) && portN >= 1 && portN <= 65535)}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            portTouched.current = true;
            setF((cur) => ({ ...cur, port: e.currentTarget.value }));
          }}
          hint={service?.port != null ? `service port: ${service.port}` : ''}
        />
        <Input
          label="Model (served name)"
          className="lg:col-span-2"
          value={f.model}
          invalid={f.model.trim() === ''}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            modelTouched.current = true;
            setF((cur) => ({ ...cur, model: e.currentTarget.value }));
          }}
        />
        <Input
          label="Label"
          value={f.label}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setF((cur) => ({ ...cur, label: e.currentTarget.value }))}
          hint="names the result JSON + run report"
        />
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <CsvField label="Concurrency (plain ints)" value={f.args.concurrency} check={conC} onChange={(v) => setArg(setF, 'concurrency', v)} />
        <CsvField label="Contexts (ints or 8k-style)" value={f.args.contexts} check={ctxC} onChange={(v) => setArg(setF, 'contexts', v)} />
        <CsvField label="Prefill contexts" value={f.args.prefill_contexts} check={preC} onChange={(v) => setArg(setF, 'prefill_contexts', v)} allowBlank />
        <NumField
          label="Max tokens"
          value={Number.isFinite(maxTokens) ? maxTokens : null}
          integer
          min={1}
          onChange={(v) => setArg(setF, 'max_tokens', v === null ? '2048' : String(v))}
          required
        />
        <NumField
          label="Duration / cell"
          value={Number.isFinite(duration) ? duration : null}
          integer
          min={1}
          unit="s"
          onChange={(v) => setArg(setF, 'duration', v === null ? '30' : String(v))}
          required
        />
        <div className="flex min-w-0 items-end gap-1.5">
          <Input
            label="KV budget"
            value={f.args.kv_budget}
            inputMode="numeric"
            invalid={kvBudget !== null && !(Number.isFinite(kvBudget) && kvBudget > 0)}
            spellCheck={false}
            autoComplete="off"
            className="min-w-0 flex-1"
            onChange={(e) => setArg(setF, 'kv_budget', e.currentTarget.value)}
            hint="tokens; blank = tool default"
          />
          <Btn size="sm" variant="ghost" loading={kvBusy} onClick={fillKvFromBoot} title="GET /api/llm/{cluster}/state → kv_tokens">
            from boot log
          </Btn>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <Toggle
          checked={f.args.coding_peak}
          onChange={(v) => setF((cur) => ({ ...cur, args: { ...cur.args, coding_peak: v } }))}
          label={<span className="text-xs text-low">coding-peak tail</span>}
        />
        <NumField
          label="Peak runs"
          value={optNum(f.args.coding_peak_runs)}
          integer
          min={1}
          disabled={!f.args.coding_peak}
          className="w-36"
          onChange={(v) => setArg(setF, 'coding_peak_runs', v === null ? '' : String(v))}
          required={!f.args.coding_peak}
        />
        <NumField
          label="Peak max tokens"
          value={optNum(f.args.coding_peak_max_tokens)}
          integer
          min={1}
          disabled={!f.args.coding_peak}
          className="w-40"
          onChange={(v) => setArg(setF, 'coding_peak_max_tokens', v === null ? '' : String(v))}
          required={!f.args.coding_peak}
        />
        <Input
          label="Extra args (shell line, appended last)"
          className="min-w-0 flex-1"
          value={f.args.extra}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setArg(setF, 'extra', e.currentTarget.value)}
          placeholder="--seed 7 …"
        />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="sd-monolabel">argv preview</span>
            <Chip variant="warn" title="client mirror of the backend argv builder (runner.py#_argv) — the truth is the argv the POST response returns">
              estimate — verify against POST argv
            </Chip>
          </div>
          <CodeBlock lines={[argvPreview]} dense />
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-stroke pt-3">
        <FieldMsg tone="hint">
          Submit queues the job; the live answer carries the exact argv, and the console keeps every check from the
          checkpoint resume file.
        </FieldMsg>
        <Btn variant="primary" disabled={!valid} loading={submitting} onClick={submit}>
          Run benchmark
        </Btn>
      </div>

      {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
    </section>
  );
}

/* ------------------------------- helpers ---------------------------------- */

function headAddr(cluster: ClusterTopology, kind: AddressKind): { host: string; label: string | null } | null {
  const head = cluster.nodes.find((n) => n.id === cluster.control.head_node_id) ?? cluster.nodes.find((n) => n.role === 'head') ?? null;
  if (head === null) return null;
  const a = head.addresses.find((x) => x.kind === kind);
  return a !== undefined ? { host: a.host, label: a.label ?? null } : null;
}

function pickKind(current: FormState['hostKind'], has: (k: AddressKind) => boolean): AddressKind | 'custom' {
  if (current === 'custom') return 'custom';
  if (has(current)) return current;
  if (has('lan')) return 'lan';
  if (has('fabric')) return 'fabric';
  if (has('tailscale')) return 'tailscale';
  return 'custom';
}

function optStr(v: number | null | undefined): string {
  return v === null || v === undefined ? '' : String(v);
}

/** pinned BenchArgs wants `?: number` — null collapses to undefined on the wire */
function benchOpt(v: number | null): number | undefined {
  return v === null || !Number.isFinite(v) ? undefined : v;
}

function optNum(s: string): number | null {
  return s.trim() === '' ? null : Number(s);
}

function canonicalCsv(input: string, allowSuffix: boolean): string {
  const check = parseBenchCsv(input, { allowSuffix });
  return check.ok ? check.items.map((i) => i.raw).join(',') : input;
}

type ArgKey = Exclude<keyof FormState['args'], 'coding_peak'>;

function setArg<K extends ArgKey>(setF: Dispatch<SetStateAction<FormState>>, key: K, v: string): void {
  setF((cur) => ({ ...cur, args: { ...cur.args, [key]: v } }));
}

interface FormState {
  clusterId: ID | null;
  profileKey: string;
  hostKind: AddressKind | 'custom';
  host: string;
  port: string;
  model: string;
  label: string;
  args: {
    concurrency: string;
    contexts: string;
    prefill_contexts: string;
    max_tokens: string;
    duration: string;
    coding_peak: boolean;
    coding_peak_runs: string;
    coding_peak_max_tokens: string;
    kv_budget: string;
    extra: string;
  };
}

function emptyForm(): FormState {
  return {
    clusterId: null,
    profileKey: '',
    hostKind: 'lan',
    host: '',
    port: '8000',
    model: '',
    label: 'adhoc',
    args: {
      concurrency: '1,2,3,4',
      contexts: '0,8192,32768',
      prefill_contexts: '8k,32k',
      max_tokens: '2048',
      duration: '30',
      coding_peak: false,
      coding_peak_runs: '',
      coding_peak_max_tokens: '',
      kv_budget: '',
      extra: '',
    },
  };
}

function CsvField({
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
    <div className={cn('flex min-w-0 flex-col gap-1')}>
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
          {check.items.length} value{check.items.length === 1 ? '' : 's'} ·{' '}
          {check.items
            .map((i) => (i.suffix === 'plain' ? String(i.expanded) : `${i.raw} → ${i.expanded.toLocaleString('en-US')}`))
            .join(' · ')}
        </FieldMsg>
      ) : (
        <FieldMsg tone="hint">{allowBlank ? 'values optional (blank = skip)' : 'integers, comma-separated'}</FieldMsg>
      )}
    </div>
  );
}
