/* ============================================================================
   LogsPage — follow serving container logs (docker logs -f equivalent).

   Picker: two columns — head / worker — listing that node's containers
   (GET /api/logs/containers/{node}, reported state-chipped). Multi-select:
   pick one container per column (2 parallel streams max); each selection
   opens its own SSE follow into a ds Terminal pane.

   Live: SSE GET /api/logs/stream?node_id=&container=&lines=200 via the
   fetch-streaming reader in api/control (subscribeLogStream). The WS `logs`
   topic buffer (store key "node:container") is the fallback when SSE is not
   available. Filter/copy/download operate client-side; nothing invented
   beyond the contract.
   ========================================================================= */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, RefreshCw, ServerCrash, Terminal as TerminalIcon } from 'lucide-react';
import { PageHeader } from '../../shell/PageShell';
import {
  Btn,
  Chip,
  Empty,
  Input,
  Panel,
  Select,
  Spinner,
  Tip,
  Toggle,
  toast,
} from '../../ds';
import { Terminal } from '../../ds/terminal';
import { isApiClientError, useLogTail } from '../../api/client';
import { useClusters, useQuery } from '../../api/queries';
import { listLogContainers, subscribeLogStream, type LogStreamStatus } from '../../api/control';
import { useLiveNodes } from '../../stores/live';
import { useUi } from '../../stores/ui';
import { cn } from '../../lib/cn';
import type { ClusterTopology, ContainerInfo, NodeConfig } from '../../api/types';

const LINES_CAP = 8000;
const SSE_TAIL_LINES = 200;
const MAX_STREAMS = 2;
const COPY_TAIL_CHOICES = [200, 500, 2000] as const;

/** "nodeId::container" — stable selection key. */
function streamKey(nodeId: string, container: string): string {
  return `${nodeId}::${container}`;
}

/* ---------------------------------------------------------------------------
   Page
   --------------------------------------------------------------------------- */

export default function LogsPage() {
  const clustersQ = useClusters();
  const activeId = useUi((s) => s.activeClusterId);
  const clusters = clustersQ.data ?? [];
  const cluster = useMemo(
    () => clusters.find((c) => c.id === activeId) ?? clusters[0] ?? null,
    [clusters, activeId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Logs"
        context={
          cluster !== null
            ? `${cluster.name} — docker logs -f (serving containers, head/worker)`
            : 'container logs (no active cluster)'
        }
        actions={
          cluster !== null ? (
            <Chip variant="neutral" className="font-mono">
              {cluster.kind}
            </Chip>
          ) : undefined
        }
      />

      {cluster === null ? (
        <div className="sd-panel flex min-h-[420px] flex-1 items-center justify-center">
          <Empty
            icon={<ServerCrash />}
            title={clustersQ.error !== null ? 'Controller unreachable.' : 'No clusters configured yet.'}
            hint={
              clustersQ.error !== null
                ? isApiClientError(clustersQ.error)
                  ? `${clustersQ.error.code}: ${clustersQ.error.message}`
                  : String(clustersQ.error)
                : 'Pick a cluster in the top bar (or configure one in Settings) to browse container logs.'
            }
            action={
              <Btn variant="primary" size="sm" onClick={clustersQ.reload}>
                Retry
              </Btn>
            }
          />
        </div>
      ) : (
        <LogsConsole key={cluster.id} cluster={cluster} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Console — node pair columns + follow panes
   --------------------------------------------------------------------------- */

interface StreamTarget {
  nodeId: string;
  nodeName: string;
  container: string;
}

function headNodeOf(cluster: ClusterTopology): NodeConfig | null {
  return (
    cluster.nodes.find((n) => n.id === cluster.control.head_node_id) ??
    cluster.nodes.find((n) => n.role === 'head') ??
    cluster.nodes[0] ??
    null
  );
}

function workerNodeOf(cluster: ClusterTopology): NodeConfig | null {
  return (
    cluster.nodes
      .filter((n) => n !== headNodeOf(cluster))
      .find((n) => n.id === cluster.control.worker_node_id) ??
    cluster.nodes.find((n) => n.role === 'worker' && n !== headNodeOf(cluster)) ??
    cluster.nodes.find((n) => n !== headNodeOf(cluster)) ??
    null
  );
}

function LogsConsole({ cluster }: { cluster: ClusterTopology }) {
  const head = headNodeOf(cluster);
  const worker = workerNodeOf(cluster);

  const [sel, setSel] = useState<string[]>([]); // stream keys, oldest first
  const autoDoneRef = useRef(false);

  const toggleSel = useCallback((key: string): void => {
    setSel((prev) => {
      if (prev.includes(key)) return prev.filter((k) => k !== key);
      if (prev.length >= MAX_STREAMS) return prev; // at cap — card is disabled
      return [...prev, key];
    });
  }, []);

  /** Head column reports its first running container once — auto-follow it. */
  const onFirstRunning = useCallback(
    (key: string | null): void => {
      if (autoDoneRef.current || key === null) return;
      autoDoneRef.current = true;
      setSel((prev) => (prev.length === 0 ? [key] : prev));
    },
    [],
  );

  const atCap = sel.length >= MAX_STREAMS;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--sd-card-gap)]">
      <Panel
        title="Containers"
        sub="docker ps -a per node — pick up to two streams, one click per card"
        actions={
          <Chip variant={atCap ? 'accent' : 'neutral'} className="font-mono" title="parallel follow streams">
            {sel.length}/{MAX_STREAMS} streams
          </Chip>
        }
      >
        <div className={`grid grid-cols-1 gap-4 px-4 pb-4 ${worker !== null ? 'md:grid-cols-2' : ''}`}>
          {head !== null && (
            <ContainerColumn node={head} selected={sel} atCap={atCap} onToggle={toggleSel} onFirstRunning={onFirstRunning} />
          )}
          {worker !== null && (
            <ContainerColumn node={worker} selected={sel} atCap={atCap} onToggle={toggleSel} />
          )}
        </div>
      </Panel>

      <FollowArea
        targets={sel.flatMap((key) => {
          const [nodeId, container] = key.split('::');
          if (nodeId === undefined || container === undefined) return [];
          const node = cluster.nodes.find((n) => n.id === nodeId);
          return [{ nodeId, container, nodeName: node?.name ?? nodeId }];
        })}
        atCap={atCap}
        onDeselect={(key) => toggleSel(key)}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   ContainerColumn — one node's containers with status chips
   --------------------------------------------------------------------------- */

function ContainerColumn({
  node,
  selected,
  atCap,
  onToggle,
  onFirstRunning,
}: {
  node: NodeConfig;
  selected: readonly string[];
  atCap: boolean;
  onToggle: (key: string) => void;
  onFirstRunning?: (key: string | null) => void;
}) {
  const fetcher = useCallback(
    () => listLogContainers(node.id),
    [node.id],
  );
  const q = useQuery(fetcher);
  const wsNodes = useLiveNodes();
  const live = wsNodes.find((n) => n.node_id === node.id)?.state ?? null;

  const containers = useMemo(() => {
    const list = q.data?.containers ?? [];
    return [...list].sort(
      (a, b) =>
        (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1) ||
        a.name.localeCompare(b.name),
    );
  }, [q.data]);

  /* once-per-load: first running container keyed for auto-follow */
  const reportedRef = useRef(false);
  const firstRunning = containers.find((c) => c.state === 'running');
  useEffect(() => {
    if (q.data === null || reportedRef.current) return;
    const pick = firstRunning ?? containers[0];
    if (pick === undefined) return; // docker returned nothing yet — wait for containers
    reportedRef.current = true;
    onFirstRunning?.(streamKey(node.id, pick.name));
  }, [q.data, containers, firstRunning, node.id, onFirstRunning]);

  return (
    <section className="flex min-w-0 flex-col gap-1.5 rounded-inner border border-stroke p-2">
      <div className="flex items-center gap-2">
        <Chip variant={node.role === 'head' ? 'accent' : 'neutral'} className="font-mono">
          {node.role}
        </Chip>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-hi" title={node.id}>
          {node.name}
        </span>
        <Tip text={live !== null ? `node connection: ${live}` : 'node not probed yet'}>
          <Chip variant={live === 'online' ? 'ok' : live === null ? 'neutral' : 'warn'} className="font-mono">
            {live ?? 'unknown'}
          </Chip>
        </Tip>
        <Chip
          variant={q.data?.state === 'online' ? 'ok' : 'warn'}
          className="font-mono"
          title="docker runtime state on the node"
        >
          {q.data?.state ?? '—'}
        </Chip>
        <Btn size="sm" variant="ghost" loading={q.loading} onClick={q.reload} title="re-read container list (docker ps -a)">
          <RefreshCw size={12} />
        </Btn>
      </div>

      {q.error !== null && (
        <div className="font-mono text-2xs text-warn" title={isApiClientError(q.error) ? q.error.message : String(q.error)}>
          containers: {isApiClientError(q.error) ? q.error.code : 'error'}
        </div>
      )}
      {q.loading && q.data === null && <Spinner className="self-center py-3" />}

      {q.data !== null && containers.length === 0 && (
        <div className="py-3 text-center text-2xs text-low">no serving containers reported by docker ps -a</div>
      )}

      <div className="flex flex-col gap-1">
        {containers.map((c) => (
          <ContainerCard
            key={c.name}
            info={c}
            selected={selected.includes(streamKey(node.id, c.name))}
            disabled={atCap && !selected.includes(streamKey(node.id, c.name))}
            onToggle={() => onToggle(streamKey(node.id, c.name))}
          />
        ))}
      </div>
    </section>
  );
}

function ContainerCard({
  info,
  selected,
  disabled,
  onToggle,
}: {
  info: ContainerInfo;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={selected}
      title={`${info.image} · ${info.status}${disabled ? ' — max 2 parallel streams, deselect one first' : ''}`}
      className={cn(
        'flex min-w-[240px] cursor-pointer flex-col gap-0.5 rounded-inner border px-2.5 py-1.5 text-left transition-colors duration-fast',
        'disabled:cursor-not-allowed disabled:opacity-45',
        selected
          ? 'border-accent/60 bg-accent/10'
          : 'border-stroke hover:border-stroke-strong hover:bg-bg2',
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-hi">{info.name}</span>
        <Chip variant={containerChipVariant(info.state)} className="font-mono">
          {info.state}
        </Chip>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-low" title={info.image}>
          {info.image}
        </span>
        <span className="sd-num shrink-0 truncate font-mono text-2xs text-low">{info.status}</span>
      </span>
    </button>
  );
}

/* ---------------------------------------------------------------------------
   FollowArea — toolbar + one pane per selected stream
   --------------------------------------------------------------------------- */

function FollowArea({
  targets,
  atCap,
  onDeselect,
}: {
  targets: StreamTarget[];
  atCap: boolean;
  onDeselect: (key: string) => void;
}) {
  const [filter, setFilter] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [gutter, setGutter] = useState(true);

  const matcher = useMemo<{ re: RegExp } | null>(() => {
    if (filter.trim() === '') return null;
    try {
      return { re: new RegExp(filter, caseSensitive ? '' : 'i') };
    } catch {
      return null; // invalid regex → unfiltered + bad-regex hint
    }
  }, [filter, caseSensitive]);

  return (
    <div className="sd-panel flex min-h-[420px] min-w-0 flex-1 flex-col">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-stroke px-4 py-2.5">
        <TerminalIcon size={14} className="shrink-0 text-low" />
        <div className="min-w-0 max-w-md flex-1">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            placeholder="grep filter (regex, applied to both panes)"
            aria-label="log grep filter"
            className="font-mono"
            invalid={filter.trim() !== '' && matcher === null}
          />
        </div>
        {filter.trim() !== '' && matcher === null && (
          <span className="font-mono text-2xs text-warn" title="invalid regex — showing unfiltered">
            bad regex
          </span>
        )}
        <Toggle
          checked={!caseSensitive}
          onChange={(v) => setCaseSensitive(!v)}
          label={<span className="font-mono text-2xs">Aa</span>}
          title="case-insensitive filter"
        />
        <Toggle
          checked={gutter}
          onChange={setGutter}
          label={<span className="font-mono text-2xs">gutter</span>}
          title="line-number gutter (server lines carry their own timestamps)"
        />
        <div className="flex-1" />
        {targets.length > 0 && (
          <span className="sd-num font-mono text-2xs text-low" title="deselection frees the pane immediately">
            {targets.map((t) => `${t.nodeName}/${t.container}`).join(' · ')}
          </span>
        )}
      </div>

      {/* panes */}
      {targets.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <Empty
            icon={<TerminalIcon />}
            title="No stream selected."
            hint={
              atCap
                ? 'Two parallel streams are the limit — deselect one of the cards above to follow something else.'
                : 'Pick a container in the head or worker column above; the SSE follow opens with --tail 200.'
            }
            className="py-10"
          />
        </div>
      ) : targets.length === 1 ? (
        <div className="flex min-h-0 flex-1 flex-col p-2">
          <FollowPane
            target={targets[0]!}
            filterRe={matcher?.re ?? null}
            showGutter={gutter}
            onDeselect={() => onDeselect(streamKey(targets[0]!.nodeId, targets[0]!.container))}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-2">
          {targets.map((t) => (
            <FollowPane
              key={`${t.nodeId}::${t.container}`}
              target={t}
              filterRe={matcher?.re ?? null}
              showGutter={gutter}
              onDeselect={() => onDeselect(streamKey(t.nodeId, t.container))}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   FollowPane — one SSE stream → Terminal
   --------------------------------------------------------------------------- */

function FollowPane({
  target,
  filterRe,
  showGutter,
  onDeselect,
}: {
  target: StreamTarget;
  filterRe: RegExp | null;
  showGutter: boolean;
  onDeselect: () => void;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<LogStreamStatus | 'idle' | 'eof'>('idle');
  const [follow, setFollow] = useState(true);
  const [epoch, setEpoch] = useState(0); // bump → re-open the stream
  /* auto-reconnect with backoff on stream drop (NOT on eof — that means the
     container ended); honest: the backend keeps no WS logs feed, so the SSE
     channel is the only live source */
  const triesRef = useRef(0);
  const [tailN, setTailN] = useState<number>(COPY_TAIL_CHOICES[1]);

  const wsKey = `${target.nodeId}:${target.container}`;
  const wsTail = useLogTail(wsKey);
  const sseLive = status === 'open' || status === 'connecting';

  useEffect(() => {
    let cancelCurrent: (() => void) | null = null;
    setLines([]);
    setFollow(true);
    setStatus('connecting');
    const cancel = subscribeLogStream(
      target.nodeId,
      target.container,
      (frame) => {
        const clean = frame.lines.filter((l): l is string => typeof l === 'string');
        if (clean.length > 0) {
          setLines((prev) => {
            const next = prev.concat(clean);
            return next.length > LINES_CAP ? next.slice(next.length - LINES_CAP) : next;
          });
        }
        if (frame.eof === true) {
          setStatus('eof');
          cancelCurrent?.(); // server signalled end-of-follow — stop the stream
        }
      },
      { lines: SSE_TAIL_LINES, onStatus: (s) => setStatus(s) },
    );
    cancelCurrent = cancel;
    return () => {
      cancelCurrent = null;
      cancel();
    };
  }, [target.nodeId, target.container, epoch]);

  useEffect(() => {
    if (status !== 'error' && status !== 'closed') {
      triesRef.current = 0;
      return;
    }
    const n = Math.min(triesRef.current, 4);
    const t = window.setTimeout(() => {
      triesRef.current += 1;
      setEpoch((e) => e + 1);
    }, 1800 * (2 ** n)); // 1.8s, 3.6s, 7.2s, capped 28.8s
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, epoch]);

  /* SSE is the fast path; the WS `logs` topic buffer is the fallback when the
     stream channel is unavailable (status chip tells the operator which) */
  const effective: string[] = sseLive || wsTail.length === 0 ? lines : wsTail;
  const displayed = useMemo(
    () => (filterRe === null ? effective : effective.filter((l) => filterRe.test(l))),
    [effective, filterRe],
  );

  const download = (): void => {
    if (effective.length === 0) return;
    const blob = new Blob([effective.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `${target.nodeName}-${target.container}-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.ok('Log downloaded', `${effective.length} lines`);
  };

  const copyTail = (): void => {
    const text = displayed.slice(-tailN).join('\n');
    if (text === '') return;
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.ok('Copied', `last ${Math.min(tailN, displayed.length)} lines to clipboard`))
      .catch((e: unknown) => {
        toast.error('Copy failed', e instanceof Error ? e.message : String(e));
      });
  };

  const statusVariant =
    status === 'open' ? 'ok' : status === 'connecting' ? 'accent' : status === 'eof' ? 'warn' : status === 'error' ? 'crit' : 'neutral';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* pane header */}
      <div className="flex flex-wrap items-center gap-2 pb-1.5">
        <button
          type="button"
          onClick={onDeselect}
          title="close this stream"
          className="min-w-0 max-w-[46%] cursor-pointer truncate rounded-inner border border-transparent px-1 py-0.5 font-mono text-xs text-hi transition-colors duration-fast hover:border-stroke hover:bg-bg2"
        >
          {target.nodeName} <span className="text-low">/</span> {target.container}
        </button>
        <Chip variant={statusVariant} className="font-mono" title="SSE GET /api/logs/stream (auto-reconnect on drop)">
          {status}
        </Chip>
        <Chip variant="neutral" className="sd-num font-mono" title="followed lines buffered (cap 8000)">
          {effective.length} lines
        </Chip>
        <div className="flex-1" />
        <Select
          aria-label="copy tail size"
          className="w-28"
          value={String(tailN)}
          onChange={(e) => setTailN(Number(e.currentTarget.value))}
        >
          {COPY_TAIL_CHOICES.map((n) => (
            <option key={n} value={n}>
              last {n}
            </option>
          ))}
        </Select>
        <Btn size="sm" variant="ghost" icon={<Copy size={12} />} onClick={copyTail} title={`copy the last ${tailN} shown lines`}>
          Copy
        </Btn>
        <Btn size="sm" variant="ghost" icon={<Download size={12} />} onClick={download} title="download the full buffer as .log" />
        <Btn
          size="sm"
          variant="ghost"
          onClick={() => setEpoch((e) => e + 1)}
          loading={status === 'connecting'}
          title="re-open the follow stream (docker logs -f --tail 200)"
        >
          Reconnect
        </Btn>
      </div>

      <Terminal
        lines={displayed}
        showLineNumbers={showGutter}
        follow={follow}
        onFollowChange={setFollow}
        maxLines={4000}
        className="sd-raised"
        empty={
          <Empty
            title="No log lines yet."
            hint={
              status === 'error' || status === 'closed'
                ? 'The stream dropped — the pane auto-reconnects with backoff; use Reconnect to force it now.'
                : 'The follow opens with --tail 200; new lines append live.'
            }
            className="py-10"
          />
        }
      />
    </div>
  );
}

function containerChipVariant(state: string | undefined): 'ok' | 'warn' | 'neutral' {
  switch (state) {
    case 'running':
      return 'ok';
    case 'exited':
    case 'dead':
      return 'warn';
    default:
      return 'neutral';
  }
}
