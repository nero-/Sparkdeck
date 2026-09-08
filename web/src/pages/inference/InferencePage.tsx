/* ============================================================================
   Inference — the LLM live surface (charts/monitoring wave).

   Sources: GET /api/llm/{cluster}/state (10 s poll) + the `service` WS topic
   for live tiles; GET /api/metrics/history (node = head, names = vllm.*) for
   the composited chart with WS ring append on live windows; chat streams via
   POST /api/llm/{cluster}/chat (SSE, api/chat.ts); the request log comes from
   GET /api/llm/{cluster}/requests.
   ========================================================================= */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import { Eraser, MessagesSquare, Pause, Send } from 'lucide-react';
import { cn } from '../../lib/cn';
import { useUi } from '../../stores/ui';
import { PageHeader } from '../../shell/PageShell';
import {
  Btn,
  Chip,
  Empty,
  Input,
  Panel,
  Select,
  Sparkline,
  Spinner,
  StatusDot,
  Tabs,
  TimeChart,
  Tip,
  healthDot,
  toast,
  type ChartSeriesData,
  type ChartSeriesDef,
} from '../../ds';
import { useClusters } from '../../api/queries';
import {
  HIST_WINDOWS,
  fetchLlmRequests,
  fetchLlmState,
  historyCurl,
  useHistory,
  usePollingQuery,
  windowIsLive,
  type HistWindow,
} from '../../api/monitoring';
import { streamChat } from '../../api/chat';
import type {
  ChatMsg,
  ChatRequest,
  ChatStatsFrame,
  ClusterTopology,
  ID,
  ServiceState,
} from '../../api/types';
import { isApiClientError, useServiceState } from '../../api/client';
import { useNodeRings, type RingSeries } from '../../stores/nodeRings';
import {
  LiveBadge,
  Skel,
  accentValid,
  copyText,
  fmtCtx,
  kvMultiplier,
  parseNum,
  seriesDataFor,
} from '../../components/monShared';
import { fmtClock, fmtDuration, fmtNum } from '../../lib/format';

/* =============================================================================
   Page — active-cluster pick / loading
   ========================================================================== */

export default function InferencePage(): ReactNode {
  const activeClusterId = useUi((s) => s.activeClusterId);
  const clustersQ = useClusters();
  const clusters = clustersQ.data ?? [];

  const cluster = useMemo((): ClusterTopology | null => {
    if (activeClusterId !== null) {
      const active = clusters.find((c) => c.id === activeClusterId);
      if (active !== undefined) return active;
    }
    return clusters[0] ?? null;
  }, [activeClusterId, clusters]);

  if (clustersQ.loading && clusters.length === 0) {
    return <InferenceSkeleton />;
  }
  if (cluster === null) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <PageHeader title="Inference" context="LLM service health, live metrics and the chat console" />
        <Panel className="flex flex-1 items-center justify-center">
          <Empty
            icon={<MessagesSquare />}
            title={clustersQ.error !== null ? 'Controller unreachable.' : 'No cluster selected.'}
            hint={
              clustersQ.error !== null
                ? isApiClientError(clustersQ.error)
                  ? `${clustersQ.error.code}: ${clustersQ.error.message}`
                  : String(clustersQ.error)
                : 'Pick a cluster in the top bar — this surface follows the active cluster.'
            }
            action={
              clustersQ.error !== null ? (
                <Btn variant="primary" size="sm" onClick={clustersQ.reload}>
                  Retry
                </Btn>
              ) : undefined
            }
          />
        </Panel>
      </div>
    );
  }

  return <InferenceSurface key={cluster.id} cluster={cluster} />;
}

function InferenceSkeleton(): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-hidden>
      <Skel className="mb-5 h-7 w-52" />
      <Skel className="mb-4 h-36 w-full" />
      <div className="sd-card-gap grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <Skel key={i} className="h-24" />
        ))}
      </div>
      <Skel className="mt-4 h-64 w-full" />
    </div>
  );
}

/* =============================================================================
   Surface
   ========================================================================== */

const MODEL_PREFIXES = ['zai-org/', 'org/', 'models/'];

function shortModel(model: string): string {
  for (const p of MODEL_PREFIXES) {
    if (model.startsWith(p)) return model.slice(p.length);
  }
  return model;
}

function InferenceSurface({ cluster }: { cluster: ClusterTopology }): ReactNode {
  const accent = accentValid(cluster.accent_color);
  const clusterId = cluster.id;
  const head = cluster.nodes.find((n) => n.role === 'head') ?? cluster.nodes[0] ?? null;

  const restState = usePollingQuery(useCallback(() => fetchLlmState(clusterId), [clusterId]), 10_000);
  const wsService = useServiceState(clusterId);

  /* live merge: the most recent frame carries health + live gauges; REST fills
     the identity fields (image / profile / kv tokens / age) */
  const svc: ServiceState | null = wsService ?? restState.data ?? null;
  const metrics: Record<string, number> = useMemo(
    () => ({ ...(restState.data?.metrics ?? {}), ...(wsService?.metrics ?? {}) }),
    [restState.data?.metrics, wsService?.metrics],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ServiceHeader cluster={cluster} accent={accent} svc={svc} restLoading={restState.loading} restError={restState.error} />

      <MetricSection headNodeId={head?.id ?? null} svc={svc} metrics={metrics} accent={accent} restLoading={restState.loading} />
      <CompositeChart clusterId={clusterId} head={head} accent={accent} svcUp={svc?.health === 'up'} />

      <InferenceConsole cluster={cluster} clusterId={clusterId} accent={accent} svc={svc} />
      <RequestsPanel clusterId={clusterId} accent={accent} />
    </div>
  );
}

/* -----------------------------------------------------------------------------
   header
   --------------------------------------------------------------------------- */

function ServiceHeader({
  cluster,
  accent,
  svc,
  restLoading,
  restError,
}: {
  cluster: ClusterTopology;
  accent: string;
  svc: ServiceState | null;
  restLoading: boolean;
  restError: unknown;
}): ReactNode {
  const profile =
    svc?.profile_key !== null && svc?.profile_key !== undefined
      ? (cluster.profiles.find((p) => p.key === svc.profile_key) ?? null)
      : null;
  const kv = svc?.kv_tokens ?? null;
  const ctxTok = profile?.context ?? null;
  const ctxLabel = fmtCtx(ctxTok);
  const mult = kv !== null && ctxTok !== null ? kvMultiplier(kv, ctxTok) : null;
  const health = svc?.health ?? 'unknown';
  const stateVariant = restError !== null ? 'warn' : 'neutral';

  return (
    <Panel className="mb-4 p-4">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: accent }} aria-hidden />
            <h2 className="truncate text-[15px] font-semibold text-hi">
              {svc?.model !== null && svc?.model !== undefined && svc.model !== '' ? svc.model : 'inference service'}
            </h2>
            <Chip
              variant={health === 'up' ? 'ok' : health === 'down' ? 'crit' : health === 'degraded' ? 'warn' : 'neutral'}
              title={`service health — ${health}`}
            >
              <StatusDot state={healthDot(health)} size={7} />
              {health}
            </Chip>
            {svc?.profile_key !== null && svc?.profile_key !== undefined && svc.profile_key !== '' && (
              <Chip color={accent} title="active serving profile (from the last start op)">
                {svc.profile_key}
              </Chip>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 font-mono text-2xs text-mid">
            {svc?.host !== null && svc?.host !== undefined && svc.host !== '' && (
              <span className="sd-num" title="serving endpoint (head host + port)">
                {svc.host}:{svc.port ?? '?'}
              </span>
            )}
            {svc?.image !== null && svc?.image !== undefined && svc.image !== '' && (
              <span className="min-w-0 truncate text-low" title={`serving image — ${svc.image}`}>
                img <span className="sd-num text-mid">{svc.image}</span>
              </span>
            )}
            {svc?.age_s !== null && svc !== null && svc.age_s !== undefined && svc.age_s !== null && health === 'up' && (
              <span title="uptime since the service turned healthy">up {fmtDuration(svc.age_s)}</span>
            )}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {(svc?.served_models ?? []).map((m) => (
              <Chip key={m} variant="neutral" className="font-mono" title={`served model — ${m}`}>
                <span className="max-w-[240px] truncate">{shortModel(m)}</span>
              </Chip>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          <Chip
            variant={stateVariant}
            title={restError !== null ? 'the last /llm/state poll failed — live ws frames still flow' : 'GET /api/llm/{id}/state — 10 s poll'}
          >
            {restLoading && svc === null ? 'loading state…' : restError !== null ? 'state poll error' : 'state polls 10s'}
          </Chip>
          {kv !== null ? (
            <div className="text-right" title={`kv_tokens — KV pool capacity in tokens${ctxTok !== null ? ` · profile context ${fmtNum(ctxTok)}` : ''}`}>
              <span className="sd-monolabel">kv pool</span>
              <div className="sd-num font-mono text-[15px] font-semibold text-hi">
                {fmtNum(kv)} <span className="text-low">tokens</span>
              </div>
              {mult !== null && ctxLabel !== null && (
                <div
                  className="sd-num font-mono text-2xs text-mid"
                  title="pool size relative to the model context window"
                >
                  ≈ {(Math.round(mult * 10) / 10).toFixed(1)}× {ctxLabel}
                </div>
              )}
            </div>
          ) : (
            <span className="font-mono text-2xs text-low" title="KV pool size unknown — verified on the next verify/check op">
              kv pool unknown
            </span>
          )}
          {svc?.errors !== undefined && svc.errors.length > 0 && (
            <Tip text={svc.errors.join(' — ')}>
              <Chip variant="warn" title="service probe errors">
                {svc.errors.length} probe error{svc.errors.length === 1 ? '' : 's'}
              </Chip>
            </Tip>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* -----------------------------------------------------------------------------
   live metric tiles (service topic + samples ring fallback)
   --------------------------------------------------------------------------- */

interface TileCfg {
  key: string;
  label: string;
  unit: string;
  seriesId: string;
  digits?: number;
}

const TILES: TileCfg[] = [
  { key: 'decode_tok_s', label: 'decode tok/s', unit: 'tok/s', seriesId: 'vllm.decode_tok_s' },
  { key: 'prompt_tok_s', label: 'prefill tok/s', unit: 'tok/s', seriesId: 'vllm.prompt_tok_s' },
  { key: 'ttft_ms_p50', label: 'ttft p50', unit: 'ms', seriesId: 'vllm.ttft_ms_p50', digits: 0 },
  { key: 'ttft_ms_p95', label: 'ttft p95', unit: 'ms', seriesId: 'vllm.ttft_ms_p95', digits: 0 },
  { key: 'tpot_ms_avg', label: 'tpot avg', unit: 'ms', seriesId: 'vllm.tpot_ms_avg' },
  { key: 'spec_accept', label: 'spec accept len', unit: '×', seriesId: 'vllm.spec_accept', digits: 2 },
  { key: 'num_running', label: 'running', unit: 'ct', seriesId: 'vllm.num_running', digits: 0 },
  { key: 'num_waiting', label: 'waiting', unit: 'ct', seriesId: 'vllm.num_waiting', digits: 0 },
  { key: 'kv_usage', label: 'kv usage', unit: '%', seriesId: 'vllm.kv_usage_perc' },
  { key: 'preemptions', label: 'preemptions', unit: 'ct', seriesId: 'vllm.preemptions_total', digits: 0 },
];

function MetricSection({
  headNodeId,
  svc,
  metrics,
  accent,
  restLoading,
}: {
  headNodeId: ID | null;
  svc: ServiceState | null;
  metrics: Record<string, number>;
  accent: string;
  restLoading: boolean;
}): ReactNode {
  if (svc === null && restLoading) {
    return (
      <div className="sd-card-gap mb-4 grid min-w-0 grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5" aria-hidden>
        {TILES.map((t) => (
          <Skel key={t.key} className="h-28" />
        ))}
      </div>
    );
  }
  const up = svc?.health === 'up';
  return (
    <div
      className={
        'sd-card-gap mb-4 grid min-w-0 grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5' +
        (up ? '' : ' opacity-80')
      }
      aria-busy={restLoading}
    >
      {TILES.map((t, idx) => (
        <LiveMetricTile key={t.key} cfg={t} headNodeId={headNodeId} metrics={metrics} accent={accent} idx={idx} />
      ))}
    </div>
  );
}

function LiveMetricTile({
  cfg,
  headNodeId,
  metrics,
  accent,
  idx,
}: {
  cfg: TileCfg;
  headNodeId: ID | null;
  metrics: Record<string, number>;
  accent: string;
  idx: number;
}): ReactNode {
  const rings = useNodeRings(headNodeId, [cfg.seriesId]);
  const ring = rings[0];
  const svcVal = metrics[cfg.key];
  const sparkLen = ring?.v.length ?? 0;
  const sparkLast = sparkLen > 0 ? (ring?.v[sparkLen - 1] ?? null) : null;
  const value = typeof svcVal === 'number' && Number.isFinite(svcVal) ? svcVal : parseNum(sparkLast);
  const digits = cfg.digits ?? 1;

  return (
    <div className="sd-panel relative flex min-w-0 flex-col gap-1 p-3">
      <Tip text={`${cfg.seriesId} — service topic key: ${cfg.key}`}>
        <span className="sd-monolabel max-w-full truncate">{cfg.label}</span>
      </Tip>
      <div className="flex items-baseline gap-1.5">
        <span className="sd-num truncate font-mono text-[19px] leading-tight font-semibold text-hi">
          {value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits)}
        </span>
        {cfg.unit !== '' && <span className="text-2xs text-low">{cfg.unit}</span>}
      </div>
      <Sparkline values={ring?.v ?? []} color={accent} width={120} height={22} title={`${cfg.seriesId} — last ${sparkLen} live samples`} />
      {/* per-cluster accent stripe (subtle) */}
      <span
        className="absolute top-0 right-0 h-full w-[2px] rounded-l"
        style={{ background: accent, opacity: idx % 5 === 0 ? 0.45 : 0.16 }}
        aria-hidden
      />
    </div>
  );
}

/* -----------------------------------------------------------------------------
   composited chart
   --------------------------------------------------------------------------- */

const CHART_SERIES: ChartSeriesDef[] = [
  { id: 'vllm.decode_tok_s', color: '#5EB1FF', label: 'decode', unit: 'tok/s' },
  { id: 'vllm.prompt_tok_s', color: '#4ADE80', label: 'prefill', unit: 'tok/s' },
  { id: 'vllm.num_running', color: '#FBBF24', label: 'running', unit: 'ct' },
  { id: 'vllm.kv_usage_perc', color: '#E879F9', label: 'kv%', unit: '%' },
];

function CompositeChart({
  head,
  accent,
  svcUp,
}: {
  clusterId: ID;
  head: ClusterTopology['nodes'][number] | null;
  accent: string;
  svcUp: boolean;
}): ReactNode {
  void accent;
  const [window, setWindow] = useState<HistWindow>('15m');
  const chartNames = CHART_SERIES.map((s) => s.id);
  const histQ = useHistory(head !== null ? { nodeId: head.id, names: chartNames, window, maxPoints: 800 } : null);
  const liveOn = windowIsLive(window);
  const rings = useNodeRings(head !== null ? head.id : null, head !== null ? chartNames : []);

  const data: ChartSeriesData[] = useMemo(
    () =>
      CHART_SERIES.map((s, i) => {
        const h = histQ.data?.series[s.id];
        const ring = rings[i];
        return liveOn ? seriesDataFor(s.id, h, ring, true, window, Date.now()) : { id: s.id, t: h?.t ?? [], v: h?.v ?? [] };
      }),
    [histQ.data, rings, liveOn, window],
  );

  const curl = head !== null ? historyCurl({ nodeId: head.id, names: chartNames, window, maxPoints: 800 }) : '';

  return (
    <Panel
      className="mb-4 p-3"
      title="Engine — composited live view"
      sub={`node = ${head?.name ?? '—'} · ${CHART_SERIES.map((s) => s.id).join(' · ')}`}
      actions={
        <>
          <LiveBadge on={liveOn} />
          <Tabs
            variant="chip"
            tabs={HIST_WINDOWS.map((w) => ({ id: w, label: w }))}
            value={window}
            onChange={(id) => setWindow(id as HistWindow)}
            ariaLabel="Composited chart window"
          />
          {head !== null && (
            <Btn
              size="sm"
              variant="ghost"
              title="Copy the exact GET /api/metrics/history request as curl"
              onClick={() => void copyText(curl, 'history query as curl')}
            >
              copy as curl
            </Btn>
          )}
        </>
      }
    >
      {svcUp ? (
        <TimeChart
          height={220}
          series={CHART_SERIES}
          data={data}
          live={liveOn}
          emptyMessage={
            head === null
              ? 'No head node configured for this pair — no per-node vllm.* history.'
              : 'No vllm.* samples yet — the engine publishes these right after serving starts.'
          }
        />
      ) : (
        <Empty
          icon={<MessagesSquare />}
          title="Serving is down — the engine chart is idle."
          hint="vllm.* gauges publish only while the pair serves. Start a profile from Control; the chart fills within seconds."
          className="py-8"
        />
      )}
      {liveOn && (
        <span className="mt-1 block font-mono text-2xs text-low">
          live · ws ring tail merged between REST polls (15 s ≤1 h · 60 s on rollups)
        </span>
      )}
    </Panel>
  );
}

/* -----------------------------------------------------------------------------
   inference console
   --------------------------------------------------------------------------- */

type Turn =
  | { kind: 'user'; id: string; content: string; ts: number }
  | {
      kind: 'assistant';
      id: string;
      content: string;
      ts: number;
      streaming: boolean;
      model?: string;
      stats?: ChatStatsFrame['stats'];
      error?: string;
    };

const SESSION_LIMIT = 14; // how many session messages ride back to the model

function InferenceConsole({
  cluster,
  clusterId,
  accent,
  svc,
}: {
  cluster: ClusterTopology;
  clusterId: ID;
  accent: string;
  svc: ServiceState | null;
}): ReactNode {
  const up = svc !== null && svc.health === 'up';
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<string>('');
  const [temperature, setTemperature] = useState('0.7');
  const [maxTokens, setMaxTokens] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const turnsRef = useRef<Turn[]>(turns);
  turnsRef.current = turns;

  // abort any in-flight chat stream on unmount / route change (SSE leak guard)
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const served = svc?.served_models ?? [];
  const servedKey = served.join('|');
  const fallbackModel = cluster.profiles[0]?.served_model_name ?? '';

  useEffect(() => {
    if (served.length === 0) return;
    if (model === '' || !served.includes(model)) setModel(served[0] ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servedKey]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null || !pinnedRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [turns]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (text === '' || streaming) return;
    const nowTs = Date.now();
    const asstId = `a-${nowTs}-${Math.random().toString(36).slice(2, 7)}`;
    const modelChosen = model !== '' ? model : fallbackModel !== '' ? fallbackModel : undefined;

    /* past conversation → chat messages (assistant turns only when settled) */
    const historyMsgs: ChatMsg[] = [];
    for (const t of turnsRef.current.slice(-SESSION_LIMIT)) {
      if (t.kind === 'user') historyMsgs.push({ role: 'user', content: t.content });
      else if (t.kind === 'assistant' && t.error === undefined && !t.streaming && t.content !== '') {
        historyMsgs.push({ role: 'assistant', content: t.content });
      }
    }
    while (historyMsgs.length > 0 && historyMsgs[0]?.role === 'assistant') {
      historyMsgs.shift();
    }
    const msgs: ChatMsg[] = [...historyMsgs, { role: 'user', content: text }];

    const req: ChatRequest = {
      messages: msgs,
      model: modelChosen ?? null,
      max_tokens: clampInt(maxTokens, 1, 65536),
      temperature: clampFloat(temperature, 0, 2),
    };

    setTurns((prev) => [
      ...prev,
      { kind: 'user', id: `u-${nowTs}`, content: text, ts: nowTs },
      { kind: 'assistant', id: asstId, content: '', ts: nowTs, streaming: true, model: modelChosen },
    ]);
    setInput('');
    setStreaming(true);
    const ac = new AbortController();
    abortRef.current = ac;

    const finish = (patch?: { error?: string }): void => {
      setTurns((prev) =>
        prev.map((t) => (t.id === asstId && t.kind === 'assistant' ? { ...t, streaming: false, error: patch?.error ?? t.error } : t)),
      );
    };

    try {
      await streamChat({
        clusterId,
        body: req,
        signal: ac.signal,
        handlers: {
          onDelta: (d) => setTurns((prev) => prev.map((t) => (t.id === asstId && t.kind === 'assistant' ? { ...t, content: t.content + d } : t))),
          onStats: (st) => setTurns((prev) => prev.map((t) => (t.id === asstId && t.kind === 'assistant' ? { ...t, stats: st } : t))),
          onError: (m) => {
            finish({ error: m });
            toast.error('Chat error', m);
          },
        },
      });
    } catch (e) {
      const msg = isApiClientError(e) ? `${e.code}: ${e.message}` : String(e);
      toast.error('Chat stream failed', msg);
      finish({ error: msg });
    } finally {
      finish();
      setStreaming(false);
      abortRef.current = null;
    }
  }, [input, streaming, model, fallbackModel, temperature, maxTokens, clusterId]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <Panel className="mb-4 flex min-h-[280px] flex-col p-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 pt-3 pb-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-[13px] font-semibold text-hi">Inference console</h2>
          <span className="truncate text-xs text-low">POST /api/llm/{clusterId}/chat — SSE passthrough · TTFT/TPS measured by the relay</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {streaming && (
            <Chip variant="accent" color={accent}>
              <Spinner size={10} /> streaming
            </Chip>
          )}
          <Btn
            size="sm"
            variant="ghost"
            icon={<Eraser size={12} />}
            onClick={() => setTurns([])}
            disabled={turns.length === 0}
            title="Clear the console session (client-side only)"
          >
            clear
          </Btn>
        </div>
      </div>

      {up ? (
        <>
          <div
            ref={scrollRef}
            onScroll={onScroll}
            className="max-h-[440px] min-h-[140px] flex-1 overflow-y-auto border-y border-stroke px-4 py-3"
          >
            {turns.length === 0 ? (
              <Empty
                title="Session is empty."
                hint="Ask the served model anything — every request is timed (TTFT, tok/s, tokens) and lands in the request log below."
                className="py-8"
              />
            ) : (
              turns.map((t) => <TurnRow key={t.id} turn={t} />)
            )}
          </div>

          <div className="flex flex-col gap-2 px-4 py-3">
            <textarea
              value={input}
              onChange={(e) => setInput(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              rows={2}
              placeholder={streaming ? 'streaming… press Stop to cut the response' : 'Ask the model — Enter sends, Shift+Enter breaks a line'}
              className="sd-raised min-h-[52px] w-full resize-y px-3 py-2 text-sm text-hi outline-none transition-colors duration-fast placeholder:text-low focus:border-accent/60"
              aria-label="Prompt"
            />
            <div className="flex min-w-0 flex-wrap items-end gap-2">
              <Select
                label="model"
                className="w-[220px]"
                value={model}
                onChange={(e) => setModel(e.currentTarget.value)}
                disabled={streaming}
              >
                {served.length === 0 && fallbackModel !== '' ? (
                  <option value={fallbackModel}>{shortModel(fallbackModel)}</option>
                ) : (
                  served.map((m) => (
                    <option key={m} value={m}>
                      {shortModel(m)}
                    </option>
                  ))
                )}
              </Select>
              <Input
                label="temperature"
                type="number"
                step="0.1"
                min="0"
                max="2"
                className="w-[116px]"
                value={temperature}
                onChange={(e) => setTemperature(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
              />
              <Input
                label="max tokens"
                type="number"
                min="1"
                max="65536"
                placeholder="server default"
                className="w-[150px]"
                value={maxTokens}
                onChange={(e) => setMaxTokens(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
              />
              <div className="ml-auto flex items-center gap-2">
                {streaming ? (
                  <Btn size="sm" variant="danger" icon={<Pause size={12} />} onClick={() => abortRef.current?.abort()}>
                    Stop
                  </Btn>
                ) : (
                  <Btn size="sm" variant="primary" icon={<Send size={12} />} onClick={() => void send()} disabled={input.trim() === ''}>
                    Send
                  </Btn>
                )}
              </div>
            </div>
            <span className="font-mono text-2xs text-low" title="TTFT = time to first delta · TPS = output tokens / total seconds">
              Enter sends · Shift+Enter newline · TTFT/TPS appear under each response once it completes
            </span>
          </div>
        </>
      ) : (
        <Empty
          icon={<MessagesSquare />}
          title="Inference API is down."
          hint="Start a profile from Control — the console opens as soon as vLLM reports healthy."
          className="py-10"
          action={
            <Link to="/control">
              <Btn variant="primary" size="sm">
                Open Control
              </Btn>
            </Link>
          }
        />
      )}
    </Panel>
  );
}

function TurnRow({ turn }: { turn: Turn }): ReactNode {
  if (turn.kind === 'user') {
    return (
      <div className="mb-3 flex flex-col items-end gap-0.5">
        <span className="sd-monolabel text-low">you · {fmtClock(turn.ts)}</span>
        <div className="max-w-[86%] whitespace-pre-wrap rounded-inner border border-stroke bg-bg2 px-3 py-2 text-sm text-hi">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="mb-3 flex flex-col gap-1">
      <span className="sd-monolabel text-low" title={turn.model !== undefined ? `model ${turn.model}` : undefined}>
        assistant · {turn.model !== undefined ? shortModel(turn.model) : '—'} · {fmtClock(turn.ts)}
      </span>
      <div
        className={cn(
          'max-w-[92%] whitespace-pre-wrap rounded-inner border border-stroke bg-bg1 px-3 py-2 text-sm text-hi',
          turn.error !== undefined && 'border-crit/40',
        )}
      >
        {turn.content === '' && turn.streaming && turn.error === undefined ? (
          <span className="inline-flex items-center gap-2 text-low">
            <Spinner size={11} /> waiting for first token…
          </span>
        ) : (
          turn.content
        )}
        {turn.error !== undefined && (
          <div className="mt-2 border-t border-crit/30 pt-2 font-mono text-2xs text-crit break-words" title={turn.error}>
            ⚠ {turn.error}
          </div>
        )}
      </div>
      {turn.stats !== undefined && (
        <span className="sd-num font-mono text-2xs text-mid" title="terminal SSE stats frame (server-measured)">
          ttft <b className="text-hi">{fmtNum(Math.round(turn.stats.ttft_ms))} ms</b> · tps <b className="text-hi">{turn.stats.tps.toFixed(1)}</b> · out{' '}
          <b className="text-hi">{fmtNum(turn.stats.output_tokens)}</b> tok
          {turn.stats.prompt_tokens !== null && turn.stats.prompt_tokens !== undefined ? ` · prompt ${fmtNum(turn.stats.prompt_tokens)}` : ''} · total{' '}
          {fmtDuration(turn.stats.total_ms / 1000)}
        </span>
      )}
    </div>
  );
}

function clampInt(raw: string, lo: number, hi: number): number | null {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function clampFloat(raw: string, lo: number, hi: number): number | null {
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

/* -----------------------------------------------------------------------------
   request log
   --------------------------------------------------------------------------- */

function RequestsPanel({ clusterId, accent }: { clusterId: ID; accent: string }): ReactNode {
  const req = usePollingQuery(useCallback(() => fetchLlmRequests(clusterId, 12), [clusterId]), 15_000);
  const rows = req.data ?? [];

  return (
    <Panel className="p-0">
      <div className="flex min-w-0 items-center justify-between gap-3 px-4 pt-3 pb-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="truncate text-[13px] font-semibold text-hi">Request log</h2>
          <span className="truncate text-xs text-low">GET /api/llm/{clusterId}/requests · relay-measured stats per request</span>
        </div>
        <LiveBadge on={req.error === null} />
      </div>
      {req.loading && rows.length === 0 ? (
        <div className="flex flex-col gap-2 p-4" aria-hidden>
          {[0, 1, 2].map((i) => (
            <Skel key={i} className="h-5 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <Empty
          title="No requests logged yet."
          hint="Send a prompt above — TTFT and tok/s are measured by the relay per request."
          className="py-6"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse font-mono text-2xs">
            <thead>
              <tr className="sd-monolabel border-b border-stroke text-left">
                <th className="px-4 py-2 font-medium">time</th>
                <th className="px-2 py-2 font-medium">model</th>
                <th className="px-2 py-2 text-right font-medium">ttft</th>
                <th className="px-2 py-2 text-right font-medium">tok/s</th>
                <th className="px-2 py-2 text-right font-medium">out</th>
                <th className="px-2 py-2 text-right font-medium">prompt</th>
                <th className="px-2 py-2 text-right font-medium">total</th>
                <th className="px-4 py-2 font-medium">error</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.ts}-${i}`} className="border-b border-stroke last:border-b-0 hover:bg-bg2/60">
                  <td className="sd-num px-4 py-1.5 text-low" title={new Date(r.ts).toISOString()}>
                    {fmtClock(r.ts)}
                  </td>
                  <td className="px-2 py-1.5" title={r.model}>
                    <span className="block max-w-[220px] truncate text-mid">{shortModel(r.model !== '' ? r.model : '—')}</span>
                  </td>
                  <td className="sd-num px-2 py-1.5 text-right text-hi">{r.ttft_ms !== null ? `${fmtNum(Math.round(r.ttft_ms))} ms` : '—'}</td>
                  <td className="sd-num px-2 py-1.5 text-right text-hi">{r.tps !== null ? r.tps.toFixed(1) : '—'}</td>
                  <td className="sd-num px-2 py-1.5 text-right">{r.output_tokens > 0 ? fmtNum(r.output_tokens) : '—'}</td>
                  <td className="sd-num px-2 py-1.5 text-right text-mid">
                    {r.prompt_tokens !== null && r.prompt_tokens !== undefined ? fmtNum(r.prompt_tokens) : '—'}
                  </td>
                  <td className="sd-num px-2 py-1.5 text-right text-mid">{r.total_ms > 0 ? `${(r.total_ms / 1000).toFixed(1)}s` : '—'}</td>
                  <td className="px-4 py-1.5">
                    {r.error !== null && r.error !== undefined ? (
                      <span className="text-crit" title={r.error}>
                        {r.error.length > 40 ? `${r.error.slice(0, 39)}…` : r.error}
                      </span>
                    ) : (
                      <span style={{ color: accent }}>ok</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {req.error !== null && rows.length === 0 && (
        <p className="px-4 pb-3 font-mono text-2xs text-warn" title="GET /api/llm/{id}/requests failed — requests log is in-memory">
          request log unavailable — {isApiClientError(req.error) ? req.error.message : 'fetch failed'}
        </p>
      )}
    </Panel>
  );
}

export type { RingSeries };
