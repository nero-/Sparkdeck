/* ============================================================================
   Overview extras — the "little bit of every tab" slice: engine/inference
   chips, last bench run, ring image state, log quick-links. Each panel is a
   compact, neutral summary that links into its tab; no new endpoints (all
   data from the existing contract + WS buffers).
   ========================================================================= */

import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { ClusterTopology, ContainerInfo, ServiceState } from '../../api/types';
import { useLastSample } from '../../api/client';
import { fetchBenchHistory, fetchEnvImages } from '../../api/admin';
import { listLogContainers } from '../../api/control';
import { useQuery } from '../../api/queries';
import { Chip, Panel, StatusDot } from '../../ds';
import { fmtDuration, fmtNum } from '../../lib/format';

export function headOf(cluster: ClusterTopology): ClusterTopology['nodes'][number] | null {
  return cluster.nodes.find((n) => n.role === 'head') ?? cluster.nodes[0] ?? null;
}

function val(s: Record<string, number | null> | undefined, id: string): number | null {
  const v = s?.[id];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function chip(label: string, v: number | null, unitFmt: (x: number) => string, tip: string): ReactNode {
  return (
    <span className="min-w-0" title={tip}>
      <span className="sd-monolabel mr-1.5 inline-block align-middle text-2xs text-low">{label}</span>
      <span className="sd-num align-middle font-mono text-2xs text-hi">{v === null ? '—' : unitFmt(v)}</span>
    </span>
  );
}

/* ----------------------------------------------------------- engine mini */
export function EngineMini({ cluster, service }: { cluster: ClusterTopology; service: ServiceState | undefined }): ReactNode {
  const head = headOf(cluster);
  const sample = useLastSample(head?.id ?? null);
  const s = sample?.series;
  const lv = service?.liveness ?? null;

  const decode = val(s, 'vllm.decode_tok_s');
  const prefill = val(s, 'vllm.prompt_tok_s');
  const ttft = val(s, 'vllm.ttft_ms_p50');
  const accept = val(s, 'vllm.spec_accept');
  const running = val(s, 'vllm.num_running');
  const waiting = val(s, 'vllm.num_waiting');
  const kvPct = lv?.kv_cache_usage !== undefined && lv?.kv_cache_usage !== null
    ? lv.kv_cache_usage * 100
    : val(s, 'vllm.kv_usage_perc');

  const up = service?.health === 'up';
  return (
    <Panel
      title={`Engine — ${cluster.name}`}
      sub="live serving gauges · API on the head rank"
      actions={
        <span className="flex items-center gap-2">
          <Chip variant={up ? 'ok' : 'neutral'} className="font-mono">
            <StatusDot state={up ? 'ok' : 'unknown'} size={6} /> {service?.health ?? '—'}
          </Chip>
          <Link className="font-mono text-2xs text-accent hover:underline" to="/inference">inference <ArrowRight size={10} className="inline" /></Link>
        </span>
      }
    >
      {!up ? (
        <p className="px-1 py-2 text-2xs text-low">
          {service?.health === undefined ? 'service state unknown — waiting for the first poll' : 'model not serving (control ▸ start)'}
        </p>
      ) : (
        <div className="flex min-w-0 flex-wrap gap-x-6 gap-y-1.5 px-1 py-1 font-mono">
          {chip('model', null, () => service?.model ?? '—', 'served model id')}
          {chip('uptime', service?.age_s ?? null, (x) => fmtDuration(x), 'engine uptime (probe / liveness)')}
          {chip('decode', decode, (x) => `${x.toFixed(1)} tok/s`, 'vllm.decode_tok_s')}
          {chip('prefill', prefill, (x) => (x >= 1000 ? `${(x / 1000).toFixed(1)}k tok/s` : `${x.toFixed(0)} tok/s`), 'vllm.prompt_tok_s')}
          {chip('ttft p50', ttft, (x) => `${Math.round(x)} ms`, 'vllm.ttft_ms_p50')}
          {chip('spec', accept, (x) => `${x.toFixed(2)}×`, 'spec-decode accepted tokens per step')}
          {chip('kv', kvPct, (x) => `${x.toFixed(0)}% of pool`, 'KV cache usage (liveness)')}
          {service?.kv_tokens !== null && service?.kv_tokens !== undefined && (
            <span className="min-w-0" title='design KV pool (tokens)'>
              <span className="sd-monolabel mr-1.5 inline-block align-middle text-2xs text-low">pool</span>
              <span className="sd-num align-middle font-mono text-2xs text-mid">{service.kv_tokens.toLocaleString('en-US')} tk</span>
            </span>
          )}
          {chip('running', running, (x) => String(x), 'requests running now')}
          {chip('waiting', waiting, (x) => String(x), 'requests queued')}
          {lv !== null && typeof lv.blocked_seconds === 'number' && lv.blocked_seconds > 0 && (
            <span title="liveness.blocked_seconds — scheduler stalls; watch if it grows">
              <Chip variant="warn" className="font-mono">blocked {lv.blocked_seconds.toFixed(1)}s</Chip>
            </span>
          )}
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------------- bench last run mini */
export function BenchMini(): ReactNode {
  const q = useQuery(fetchBenchHistory);
  const rows = q.data ?? [];
  const last = rows[0];
  /* JobView-safe read of the summary (it is bench tool JSON-lite) */
  const summary = (last?.summary ?? {}) as Record<string, unknown>;
  const best = summary.best as { ctx?: number; conc?: number; tps?: number | null } | undefined;
  const c1 = summary.c1 as { ctx?: number; conc?: number; tps?: number | null } | undefined;
  const prefill = Array.isArray(summary.prefill)
    ? (summary.prefill as Array<{ ctx?: number; tok_per_sec?: number | null }>)
    : [];
  const bestPrefill = prefill
    .filter((r) => typeof r.tok_per_sec === 'number' && r.tok_per_sec !== null)
    .sort((a, b) => (b.tok_per_sec ?? 0) - (a.tok_per_sec ?? 0))[0];
  const cells = typeof summary.cells === 'number' ? summary.cells : null;
  const spec = typeof summary.spec_accept_avg === 'number' ? summary.spec_accept_avg : null;

  return (
    <Panel
      title="Bench — last run"
      sub="llm-inference-bench · newest first"
      actions={
        <Link className="font-mono text-2xs text-accent hover:underline" to="/bench">bench <ArrowRight size={10} className="inline" /></Link>
      }
    >
      {last === undefined ? (
        <p className="px-1 py-2 text-2xs text-low">no runs yet — submit one in Bench (checkpointed, resumable, ships a summary grid).</p>
      ) : (
        <div className="px-1 py-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            <span className="min-w-0 truncate font-mono text-2xs text-hi" title={last.path}>{last.label || '(unlabeled)'}</span>
            <Chip variant={last.source === 'repo' ? 'neutral' : 'ok'} className="font-mono">{last.source}</Chip>
            {last.ts !== null && (
              <span className="sd-num font-mono text-2xs text-low">{new Date(last.ts).toLocaleString()}</span>
            )}
          </div>
          <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-6 gap-y-1.5 font-mono">
            {best?.tps != null && (
              <Chip variant="ok" className="sd-num font-mono" title="best cell in the grid (ctx × concurrency)">
                best {best.tps?.toFixed(1)} tok/s <span className="text-low">@ctx{best.ctx}·C{best.conc}</span>
              </Chip>
            )}
            {c1?.tps != null && (
              <Chip variant="neutral" className="sd-num font-mono" title="C1 (single-stream) decode">
                C1 {c1.tps?.toFixed(1)} tok/s <span className="text-low">@ctx{c1.ctx}</span>
              </Chip>
            )}
            {bestPrefill?.tok_per_sec != null && (
              <Chip variant="neutral" className="sd-num font-mono" title="best prefill scout result">
                prefill {fmtNum(Math.round(bestPrefill.tok_per_sec / 100) / 10)}k tok/s
                {bestPrefill.ctx !== undefined ? <span className="text-low"> @ctx{bestPrefill.ctx > 1024 ? `${Math.round(bestPrefill.ctx / 1024)}k` : bestPrefill.ctx}</span> : null}
              </Chip>
            )}
            {spec !== null && <span className="sd-num font-mono text-2xs text-mid" title="average spec-decode acceptance">spec {spec.toFixed(2)}×</span>}
            {cells !== null && <span className="sd-num font-mono text-2xs text-low">{cells} cells</span>}
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ------------------------------------------- image state + logs quick links */
export function RingStateMini({ cluster, service }: { cluster: ClusterTopology; service: ServiceState | undefined }): ReactNode {
  const head = headOf(cluster);
  const isRing = (cluster.control.launcher || '').toLowerCase().includes('sparkring');
  const envsQ = useQuery(() => (isRing ? Promise.resolve([]) : fetchEnvImages(cluster.id)));
  const ctrQ = useQuery(
    head !== null
      ? async () => listLogContainers(head.id)
      : async () => ({ containers: [], state: 'offline' } as unknown as { containers: ContainerInfo[]; state: string }),
  );

  const driftRows = useMemo(() => (envsQ.data ?? []).length, [envsQ.data]);
  const containers = ctrQ.data?.containers ?? [];
  const running = containers.filter((c) => c.state === 'running');

  return (
    <Panel
      title="Images & logs"
      sub={isRing ? 'managed receipt deployment (suite-runbook updates)' : 'env-file SERVING_IMAGE state'}
      actions={
        <Link className="font-mono text-2xs text-accent hover:underline" to="/images">images <ArrowRight size={10} className="inline" /></Link>
      }
    >
      <div className="px-1 py-1">
        {service?.image ? (
          <div className="mb-1.5 flex min-w-0 items-center gap-2" title={`live container image: ${service.image}`}>
            <Chip variant="ok" className="font-mono">running</Chip>
            <span className="min-w-0 truncate font-mono text-2xs text-hi">
              {service.image.includes('@sha256:') ? `${service.image.split('@')[0]}@${service.image.split('@')[1]?.slice(0, 22)}…` : service.image}
            </span>
          </div>
        ) : (
          <div className="mb-1.5 text-2xs text-low">no running image reported (model not serving)</div>
        )}
        {!isRing && (
          <div className="text-2xs text-low">
            env rows: {driftRows} · check SERVING_IMAGE drift in Images
          </div>
        )}
        {containers.length > 0 && (
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="sd-monolabel text-2xs text-low">logs</span>
            {running.map((c) => (
              <Link
                key={c.id}
                to="/logs"
                className="inline-flex cursor-pointer items-center gap-1 rounded-inner border border-stroke bg-bg2 px-1.5 py-[1px] font-mono text-[10px] text-mid transition-colors duration-fast hover:text-hi"
                title={`${c.image} — follow in Logs (autoscroll, filters, download)`}
              >
                <StatusDot state="ok" size={6} /> {c.name}
              </Link>
            ))}
            {running.length === 0 && <span className="text-2xs text-low">no running containers on the head</span>}
          </div>
        )}
        {head !== null && (
          <div className="mt-2 text-2xs text-low">
            <Link to={`/nodes/${encodeURIComponent(head.id)}`} className="text-accent hover:underline">
              node dashboard → {head.name}
            </Link>
          </div>
        )}
      </div>
    </Panel>
  );
}
