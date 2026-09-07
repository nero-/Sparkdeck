/* ============================================================================
   LogsPage — follow container logs (docker logs -f equivalent).

   Live: SSE GET /api/logs/stream?node_id=&container=&lines=200 via the
   fetch-streaming helper in api/control (subscribeLogStream); the WS `logs`
   topic buffer (store key "node:container") is the fallback when the SSE
   channel is not available. Filter/gutter/download/copy operate client-side;
   selection + container facts come from GET /api/logs/containers/{node}.
   ========================================================================= */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import type { ClusterTopology, ContainerInfo } from '../../api/types';

const LINES_CAP = 8000;
const SSE_TAIL_LINES = 200;

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
            ? `${cluster.name} — docker logs -f (serving containers)`
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
   Console
   --------------------------------------------------------------------------- */

function LogsConsole({ cluster }: { cluster: ClusterTopology }) {
  const wsNodes = useLiveNodes().filter((n) => n.cluster_id === cluster.id);
  const head = cluster.nodes.find((n) => n.id === cluster.control.head_node_id) ?? cluster.nodes[0];

  const [nodeId, setNodeId] = useState<string>(head?.id ?? cluster.nodes[0]?.id ?? '');
  const [containerState, setContainerState] = useState<string | null>(null);

  useEffect(() => {
    if (
      cluster.nodes.length > 0 &&
      !cluster.nodes.some((n) => n.id === nodeId)
    ) {
      setNodeId(cluster.nodes.find((n) => n.role === 'head')?.id ?? cluster.nodes[0]?.id ?? '');
    }
  }, [cluster.nodes, nodeId]);

  /* containers of the selected node — includes Exited (backend: docker ps -a) */
  const containersFetcher = useCallback(
    (): Promise<{ containers: ContainerInfo[]; state: string }> => (nodeId === '' ? Promise.resolve({ containers: [], state: 'offline' }) : listLogContainers(nodeId)),
    [nodeId],
  );
  const containersQ = useQuery(containersFetcher);
  const containers = containersQ.data?.containers ?? [];

  useEffect(() => {
    if (containers.length === 0) return;
    if (containerState !== null && containers.some((c) => c.name === containerState)) return;
    setContainerState(containers.find((c) => c.state === 'running')?.name ?? containers[0]?.name ?? null);
  }, [containers, containerState]);

  /* ---- SSE follow ---- */
  const [epoch, setEpoch] = useState(0); // bump to reconnect
  const [sseStatus, setSseStatus] = useState<LogStreamStatus | 'idle'>('idle');
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    setLines([]);
    setFollow(true);
    if (nodeId === '' || containerState === null) {
      setSseStatus('idle');
      return undefined;
    }
    setSseStatus('connecting');
    const cancel = subscribeLogStream(
      nodeId,
      containerState,
      (frame) => {
        setLines((prev) => {
          const next = prev.concat(frame.lines.filter((l): l is string => typeof l === 'string'));
          return next.length > LINES_CAP ? next.slice(next.length - LINES_CAP) : next;
        });
      },
      { lines: SSE_TAIL_LINES, onStatus: setSseStatus },
    );
    return () => cancel();
  }, [nodeId, containerState, epoch]);

  /* WS `logs` topic fallback — same key ("node:container") in the store */
  const wsKey = nodeId !== '' && containerState !== null ? `${nodeId}:${containerState}` : null;
  const wsTail = useLogTail(wsKey);
  const sseLive = sseStatus === 'open' || sseStatus === 'connecting';
  const effective: string[] =
    sseLive || wsTail.length === 0 ? lines : wsTail;
  const source: 'sse' | 'ws' | 'none' =
    sseLive ? 'sse' : wsTail.length > 0 ? 'ws' : 'none';

  /* ---- view controls ---- */
  const [filter, setFilter] = useState('');
  const [filterCaseSensitive, setFilterCaseSensitive] = useState(false);
  const [showGutter, setShowGutter] = useState(true);

  const matcher = useMemo<{ re: RegExp } | null>(() => {
    if (filter.trim() === '') return null;
    try {
      return { re: new RegExp(filter, filterCaseSensitive ? '' : 'i') };
    } catch {
      return null; // invalid regex → fall back to unfiltered + hint
    }
  }, [filter, filterCaseSensitive]);

  const displayed = useMemo(
    () => (matcher === null ? effective : effective.filter((l) => matcher.re.test(l))),
    [effective, matcher],
  );

  const download = (): void => {
    if (effective.length === 0) return;
    const blob = new Blob([effective.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `${nodeId}-${containerState ?? 'container'}-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.ok('Log downloaded', `${effective.length} lines`);
  };

  const copyShown = (): void => {
    if (displayed.length === 0) return;
    const text = displayed.slice(-2000).join('\n');
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.ok('Copied', `${Math.min(2000, displayed.length)} lines to clipboard`))
      .catch((e: unknown) => {
        toast.error('Copy failed', e instanceof Error ? e.message : String(e));
      });
  };

  const selectedContainer = containers.find((c) => c.name === containerState) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[var(--sd-card-gap)]">
      {/* node + container selectors */}
      <Panel
        title="Source"
        sub={`node ${nodeId === '' ? '—' : cluster.nodes.find((n) => n.id === nodeId)?.name ?? nodeId} · containers from docker ps -a (name=glm53 filter)`}
        actions={
          <>
            <Chip variant={containersQ.data?.state === 'online' ? 'ok' : 'warn'} className="font-mono" title="node runtime state">
              {containersQ.data?.state ?? 'offline'}
            </Chip>
            <Btn size="sm" variant="ghost" loading={containersQ.loading} onClick={containersQ.reload} title="re-read container list">
              <RefreshCw size={12} />
              Refresh
            </Btn>
          </>
        }
      >
        <div className="flex flex-wrap items-end gap-3 px-4 pb-4">
          <Select label="node" value={nodeId} onChange={(e) => setNodeId(e.currentTarget.value)} className="w-64">
            {cluster.nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} · {n.role}
                {wsNodes.find((w) => w.node_id === n.id)?.state === 'online' ? '' : ' (offline)'}
              </option>
            ))}
          </Select>
          <Select label="container" value={containerState ?? ''} onChange={(e) => setContainerState(e.currentTarget.value)} className="w-72">
            {containers.length === 0 ? <option value="">(none reported)</option> : null}
            {containers.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name} — {c.state}
              </option>
            ))}
          </Select>
          {containersQ.error !== null && (
            <span className="font-mono text-2xs text-warn" title={isApiClientError(containersQ.error) ? containersQ.error.message : String(containersQ.error)}>
              containers: {isApiClientError(containersQ.error) ? containersQ.error.code : 'error'}
            </span>
          )}
        </div>
      </Panel>

      {/* container cards */}
      {containers.length > 0 ? (
        <div className="flex flex-wrap gap-[var(--sd-card-gap)]">
          {containers.map((c) => {
            const selected = c.name === containerState;
            return (
              <button
                key={c.name}
                type="button"
                onClick={() => setContainerState(c.name)}
                className={cn(
                  'flex min-w-[260px] max-w-[360px] cursor-pointer flex-col gap-1 rounded-inner border px-3 py-2 text-left transition-colors duration-fast',
                  selected ? 'border-accent/50 bg-accent/10' : 'border-stroke hover:border-stroke-strong hover:bg-bg2',
                )}
                title={`${c.image} · ${c.status}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate font-mono text-xs text-hi">{c.name}</span>
                  <Chip variant={containerChipVariant(c.state)} className="font-mono">
                    {c.state}
                  </Chip>
                </span>
                <span className="min-w-0 truncate font-mono text-2xs text-low" title={c.image}>
                  {c.image}
                </span>
                <span className="flex items-center gap-2">
                  <span className="sd-num truncate font-mono text-2xs text-low">{c.status}</span>
                  <Tip text="restart is not exposed yet — stop/start lives on the Control page">
                    <Chip variant="neutral" className="font-mono">
                      restart? — not yet
                    </Chip>
                  </Tip>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {/* toolbar + terminal */}
      <div className="sd-panel flex min-h-[380px] min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-stroke px-4 py-2.5">
          <TerminalIcon size={14} className="shrink-0 text-low" />
          <div className="min-w-0 flex-1">
            <Input
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              placeholder="grep filter (regex, mind the ^/… anchors)"
              aria-label="log grep filter"
              className="max-w-md font-mono"
              invalid={filter.trim() !== '' && matcher === null}
            />
          </div>
          {filter.trim() !== '' && matcher === null && (
            <span className="font-mono text-2xs text-warn" title="invalid regex — showing unfiltered">
              bad regex
            </span>
          )}
          {filter.trim() !== '' && matcher !== null && (
            <Chip variant="accent" className="font-mono">
              {displayed.length}/{effective.length} match
            </Chip>
          )}
          <Toggle checked={showGutter} onChange={setShowGutter} label={<span className="font-mono text-2xs">gutter</span>} title="line-number gutter (server lines carry their own timestamps)" />
          <Toggle
            checked={!filterCaseSensitive}
            onChange={(v) => setFilterCaseSensitive(!v)}
            label={<span className="font-mono text-2xs">Aa</span>}
            title="case-insensitive filter"
          />
          <div className="flex-1" />
          <Chip variant="neutral" className="sd-num font-mono" title="followed lines buffered">
            {effective.length} lines
          </Chip>
          <Chip variant={source === 'sse' ? 'ok' : source === 'ws' ? 'accent' : 'warn'} className="font-mono" title={`stream: ${source === 'sse' ? `GET /api/logs/stream (${sseStatus})` : source === 'ws' ? 'WS `logs` topic buffer' : 'no stream'}`}>
            {source === 'sse' ? `sse ${sseStatus}` : source === 'ws' ? 'ws tail' : `stream ${sseStatus}`}
          </Chip>
          <Btn size="sm" variant="ghost" onClick={() => setEpoch((e) => e + 1)} loading={sseStatus === 'connecting'} title="re-open the follow stream (--tail 200)">
            <RefreshCw size={12} />
            Reconnect
          </Btn>
          <Btn size="sm" variant="ghost" icon={<Copy size={12} />} onClick={copyShown} title="copy the filtered lines (cap 2000)">
            Copy
          </Btn>
          <Btn size="sm" variant="ghost" icon={<Download size={12} />} onClick={download} title="download the full buffer as .log">
            Download
          </Btn>
        </div>

        {selectedContainer !== null ? null : (
          <div className="px-4 pt-2 font-mono text-2xs text-warn">
            no container selected{containers.length === 0 ? ' — none reported by docker ps' : ''}
          </div>
        )}

        <div className="flex min-h-0 flex-1 flex-col p-2">
          {nodeId === '' || containerState === null ? (
            <div className="flex flex-1 items-center justify-center">
              <Empty title="No container selected." hint="Pick a node and a serving container above." className="py-8" />
            </div>
          ) : containersQ.loading && containersQ.data === null ? (
            <div className="flex flex-1 items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <Terminal
              lines={displayed}
              showLineNumbers={showGutter}
              follow={follow}
              onFollowChange={setFollow}
              maxLines={4000}
              className="sd-raised"
              empty={<Empty title="No log lines yet." hint="The stream opens with --tail 200; new lines append live." className="py-10" />}
            />
          )}
        </div>
      </div>
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
