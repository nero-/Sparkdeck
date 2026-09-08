/* Images — engine/image management, per cluster:
   • running-pair strip (service state: image, model, profile, health)
   • env-file table (SERVING_IMAGE per profile per node; drift/mismatch chips)
   • inventory matrix (repo_tag × node, sizes) — filtered local/vllm:*
   • actions: copy-to-peer, set SERVING_IMAGE w/ preview, build (builder env)
   • ops feed for image.* ops (REST) merged with the live WS op store  */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ClusterTopology, EnvImageRow, ID, ServiceState } from '../../api/types';
import { fetchClusters, fetchEnvImages, fetchNodeImages, type NodeImageState } from '../../api/admin';
import { api } from '../../api/client';
import { useQuery } from '../../api/queries';
import { PageHeader } from '../../shell/PageShell';
import { Btn, Chip, Panel, Spinner } from '../../ds';
import { cn } from '../../lib/cn';
import { DataTable, FieldMsg, OpDrawer, Td, errCopy, offerAuthGate } from '../../lib/pagekit';
import { fmtDuration } from '../../lib/format';
import { useServiceState } from '../../stores/live';
import { useUi } from '../../stores/ui';
import type { OpRecord } from '../../api/types';
import { BuildImageCard, CopyImageCard, SetServingCard } from './ImageActions';

const IMAGE_OP_KINDS = ['image.copy', 'image.set_serving', 'image.build'] as const;

export default function ImagesPage() {
  const clustersQ = useQuery(fetchClusters);
  const clusters = clustersQ.data ?? [];

  const [selectedId, setSelectedId] = useState<ID | null>(null);
  const activeClusterId = useUi((s) => s.activeClusterId);

  useEffect(() => {
    if ((selectedId === null || !clusters.some((c) => c.id === selectedId)) && clusters.length > 0) {
      const preferred = activeClusterId !== null && clusters.some((c) => c.id === activeClusterId) ? activeClusterId : (clusters[0]?.id ?? null);
      setSelectedId(preferred);
    }
  }, [clusters, selectedId, activeClusterId]);

  const cluster = clusters.find((c) => c.id === selectedId) ?? null;
  const service = useServiceState(selectedId);
  const [opDrawerId, setOpDrawerId] = useState<string | null>(null);
  const [opsTick, setOpsTick] = useState(0);

  const envFetcher = useCallback(
    () => (selectedId === null ? Promise.resolve([] as EnvImageRow[]) : fetchEnvImages(selectedId)),
    [selectedId],
  );
  const envQ = useQuery(envFetcher);

  /* per-node filtered image inventory (matrix) */
  const [imagesByNode, setImagesByNode] = useState<Record<ID, NodeImageState>>({});
  const [inventoryBusy, setInventoryBusy] = useState(false);

  const refreshInventory = useCallback(
    (nodes: { id: ID }[]) => {
      if (nodes.length === 0) {
        setImagesByNode({});
        return;
      }
      setInventoryBusy(true);
      Promise.all(
        nodes.map((n) =>
          fetchNodeImages(n.id).then(
            (r) => ({ id: n.id, r }),
            (err: unknown) => ({ id: n.id, r: { images: [], state: `error: ${err instanceof Error ? err.message : String(err)}` } }),
          ),
        ),
      )
        .then((rows) => {
          const next: Record<ID, NodeImageState> = {};
          for (const { id, r } of rows) next[id] = r;
          setImagesByNode(next);
        })
        .finally(() => setInventoryBusy(false));
    },
    [],
  );

  useEffect(() => {
    if (cluster !== null) refreshInventory(cluster.nodes);
  }, [cluster, refreshInventory]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Images"
        context="engine inventory · SERVING_IMAGE env rewrites · save|load copies · builders · image ops"
        actions={
          <>
            <Btn
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={12} />}
              loading={inventoryBusy}
              onClick={() => {
                clustersQ.reload();
                envQ.reload();
                if (cluster !== null) refreshInventory(cluster.nodes);
                setOpsTick((t) => t + 1);
              }}
            >
              Refresh
            </Btn>
          </>
        }
      />

      {clusters.length === 0 ? (
        <div className="sd-panel p-6 text-sm text-mid">No clusters configured — add one in Settings first.</div>
      ) : (
        <div className="flex min-w-0 flex-col gap-6 pb-16">
          <div className="flex flex-wrap items-center gap-1.5">
            {clusters.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-inner border px-2.5 font-mono text-2xs transition-colors duration-fast',
                  c.id === selectedId ? 'border-accent/40 bg-accent/10' : 'border-stroke text-mid hover:text-hi',
                )}
                style={c.id === selectedId ? { color: c.accent_color, borderColor: `color-mix(in srgb, ${c.accent_color} 40%, transparent)` } : undefined}
              >
                {c.name}
              </button>
            ))}
          </div>

          {cluster !== null && (
            <>
              <RunningPairStrip service={service} clusterName={cluster.name} />
              <EnvTable cluster={cluster} envs={envQ.data} loading={envQ.loading} error={envQ.error} runningImage={service?.image ?? null} onRetry={envQ.reload} />
              <InventoryMatrix cluster={cluster} imagesByNode={imagesByNode} busy={inventoryBusy} />
              <div className="grid min-w-0 gap-3 xl:grid-cols-3">
                <CopyImageCard cluster={cluster} imagesByNode={imagesByNode} service={service} onOp={setOpDrawerId} />
                <SetServingCard cluster={cluster} imagesByNode={imagesByNode} service={service} onOp={setOpDrawerId} />
                <BuildImageCard cluster={cluster} imagesByNode={imagesByNode} service={service} onOp={setOpDrawerId} />
              </div>
              <ImageOpsList clusterId={cluster.id} tick={opsTick} onOpen={setOpDrawerId} />
            </>
          )}
        </div>
      )}

      <OpDrawer opId={opDrawerId} onClose={() => setOpDrawerId(null)} />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Running pair strip — the image the live engine was launched from
   --------------------------------------------------------------------------- */

function RunningPairStrip({ service, clusterName }: { service: ServiceState | undefined; clusterName: string }) {
  return (
    <Panel
      title={`Running pair — ${clusterName}`}
      className="p-3"
      actions={
        service !== undefined ? (
          <Chip
            variant={service.health === 'up' ? 'ok' : service.health === 'degraded' ? 'warn' : service.health === 'down' ? 'crit' : 'neutral'}
          >
            {service.health}
          </Chip>
        ) : (
          <Chip variant="neutral">service state not streaming</Chip>
        )
      }
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-1 px-1 pb-1 text-xs text-low">
        <span className="min-w-0">
          image{' '}
          <span className="font-mono text-hi" title={service?.image ?? undefined}>
            {service?.image ?? '—'}
          </span>
        </span>
        <span>
          model{' '}
          <span className="font-mono text-mid" title={service?.model ?? undefined}>
            {service?.model ?? '—'}
          </span>
        </span>
        <span>
          profile{' '}
          <span className="font-mono text-mid">{service?.profile_key ?? '—'}</span>
        </span>
        <span>
          age{' '}
          <span className="sd-num font-mono text-mid">{service?.age_s !== null && service?.age_s !== undefined ? fmtDuration(service.age_s) : '—'}</span>
        </span>
        <span>
          kv{' '}
          <span className="sd-num font-mono text-mid">{service?.kv_tokens !== null && service?.kv_tokens !== undefined ? service.kv_tokens.toLocaleString('en-US') : '—'}</span>
        </span>
      </div>
      {service !== undefined && service.errors.length > 0 && (
        <div className="pt-1.5">
          <FieldMsg tone="error">{service.errors.join(' · ')}</FieldMsg>
        </div>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   Env table — SERVING_IMAGE per profile × node (GET /api/images/envs/{cluster})
   highlighted against drift between nodes and against the running pair.
   --------------------------------------------------------------------------- */

function EnvTable({
  cluster,
  envs,
  loading,
  error,
  runningImage,
  onRetry,
}: {
  cluster: ClusterTopology;
  envs: EnvImageRow[] | null;
  loading: boolean;
  error: unknown;
  runningImage: string | null;
  onRetry: () => void;
}) {
  const nodeName = (id: ID): string => cluster.nodes.find((n) => n.id === id)?.name ?? id;
  return (
    <Panel
      title="Env files — SERVING_IMAGE per profile"
      sub="reading rank env files over SSH per node; offline nodes read as '—'"
      className="p-3"
      actions={
        <Btn size="sm" variant="ghost" onClick={onRetry} icon={<RefreshCw size={11} />}>
          Re-read
        </Btn>
      }
    >
      {error !== null ? (
        <FieldMsg tone="error">{errCopy(error)}</FieldMsg>
      ) : loading && envs === null ? (
        <div className="flex items-center justify-center gap-2 py-8 text-mid">
          <Spinner size={13} /> reading env files…
        </div>
      ) : (envs ?? []).length === 0 ? (
        <FieldMsg tone="hint">no profiles with env files (or no reachable node to read from).</FieldMsg>
      ) : (
        <DataTable
          columns={[
            { key: 'p', label: 'profile' },
            { key: 'n', label: 'node' },
            { key: 'f', label: 'env file' },
            { key: 'i', label: 'SERVING_IMAGE' },
            { key: 's', label: 'state', align: 'right' },
          ]}
          minWidth={720}
          empty="—"
        >
          {(envs ?? []).flatMap((row) => (
            row.clusters.map((c) => {
              const unread = c.file === '' || c.image === '';
              const drifted =
                !unread &&
                row.clusters.some((o) => o.file !== '' && o.node_id !== c.node_id && o.image !== c.image);
              const mismatch = !unread && runningImage !== null && c.image !== runningImage;
              return (
                <tr key={`${row.profile_key}:${c.node_id}`}>
                  <Td className={cn('font-mono text-hi', row.clusters.length > 1 && '[&:first-child]:border-b-0')}>
                    {row.profile_key}
                  </Td>
                  <Td className="font-mono text-2xs text-mid">{nodeName(c.node_id)}</Td>
                  <Td className="max-w-[280px] truncate font-mono text-2xs text-low" title={c.file}>
                    {c.file === '' ? '—' : c.file}
                  </Td>
                  <Td className={cn('max-w-[300px] truncate font-mono text-2xs', unread ? 'text-low' : 'text-hi')} title={c.image}>
                    {unread ? '—' : c.image}
                  </Td>
                  <Td align="right">
                    {unread ? (
                      <Chip variant="neutral" title="node offline or env file unreadable">unread</Chip>
                    ) : drifted ? (
                      <Chip variant="crit" title="nodes of this profile disagree on SERVING_IMAGE">drift</Chip>
                    ) : mismatch ? (
                      <Chip variant="warn" title={`${c.image} ≠ running ${runningImage}`}>≠ running</Chip>
                    ) : (
                      <Chip variant="ok" title="matches the pair + peer node">aligned</Chip>
                    )}
                  </Td>
                </tr>
              );
            })
          ))}
        </DataTable>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   Inventory matrix — repo_tag rows × node cols (filtered local/vllm:*)
   --------------------------------------------------------------------------- */

function InventoryMatrix({
  cluster,
  imagesByNode,
  busy,
}: {
  cluster: ClusterTopology;
  imagesByNode: Record<ID, NodeImageState>;
  busy: boolean;
}) {
  const rows = useMemo(() => {
    const tags = new Set<string>();
    for (const st of Object.values(imagesByNode)) for (const im of st.images) tags.add(im.repo_tag);
    return [...tags].sort();
  }, [imagesByNode]);

  return (
    <Panel
      title="Inventory — filtered images per node"
      sub="docker images --filter reference=<settings.images.filter_glob> (default local/vllm:*)"
      className="p-3"
      actions={busy ? <Spinner size={12} /> : undefined}
    >
      {cluster.nodes.length === 0 ? (
        <FieldMsg tone="hint">no nodes on this cluster yet.</FieldMsg>
      ) : rows.length === 0 && !busy ? (
        <FieldMsg tone="hint">
          nothing reported — nodes offline, or the filter glob matched nothing.
        </FieldMsg>
      ) : (
        <DataTable
          columns={[
            { key: 'img', label: 'image' },
            ...cluster.nodes.map((n) => ({ key: n.id, label: n.name, align: 'right' as const })),
          ]}
          minWidth={560}
          empty="—"
        >
          {rows.map((tag) => (
            <tr key={tag}>
              <Td className="max-w-[320px] truncate font-mono text-2xs text-hi" title={tag}>
                {tag}
              </Td>
              {cluster.nodes.map((n) => {
                const st = imagesByNode[n.id];
                const im = st?.images.find((i) => i.repo_tag === tag);
                return (
                  <Td key={n.id} num align="right" className="text-2xs" title={im !== undefined ? `${im.image_id} · created ${im.created_label}` : undefined}>
                    {st === undefined ? (
                      <Spinner size={10} />
                    ) : im === undefined ? (
                      '—'
                    ) : (
                      <span className="text-mid">
                        {im.size_mb >= 1024 ? `${(im.size_mb / 1024).toFixed(1)} GB` : `${im.size_mb.toFixed(0)} MB`}
                        <span className="ml-1.5 text-low">{im.image_id.slice(0, 8)}</span>
                      </span>
                    )}
                  </Td>
                );
              })}
            </tr>
          ))}
        </DataTable>
      )}
      <div className="flex flex-wrap gap-1.5 pt-2">
        {cluster.nodes.map((n) => {
          const st = imagesByNode[n.id];
          return (
            <Chip
              key={n.id}
              variant={st === undefined ? 'neutral' : st.state === 'online' ? 'ok' : 'warn'}
              title={`docker probe state: ${st?.state ?? 'loading'}`}
            >
              {n.name}: {st?.state ?? 'loading'}
            </Chip>
          );
        })}
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   Ops list — image.* ops (REST audit + live WS overlay)
   --------------------------------------------------------------------------- */

const IMAGE_OP_KINDS_LIST: readonly string[] = IMAGE_OP_KINDS;

function ImageOpsList({
  clusterId,
  tick,
  onOpen,
}: {
  clusterId: ID;
  tick: number;
  onOpen: (opId: string) => void;
}) {
  const [rest, setRest] = useState<OpRecord[]>([]);
  const [error, setError] = useState<unknown>(null);
  const opsMap = useWsLive((s) => s.opsById);

  const load = useCallback(() => {
    Promise.all(
      IMAGE_OP_KINDS_LIST.map((kind) =>
        api.ops({ kind, limit: 25 }).catch(() => [] as OpRecord[]),
      ),
    )
      .then((groups) => {
        const merged = groups.flat();
        merged.sort((a, b) => b.created - a.created);
        setRest(merged);
        setError(null);
      })
      .catch((err) => {
        offerAuthGate(err);
        setError(err);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load, tick, clusterId]);

  const merged = useMemo(() => {
    const byId = new Map<string, OpRecord>();
    for (const op of rest) byId.set(op.id, op);
    for (const op of opsMap.values()) {
      if (IMAGE_OP_KINDS_LIST.some((k) => op.kind === k)) byId.set(op.id, op);
    }
    return [...byId.values()].sort((a, b) => b.created - a.created).slice(0, 30);
  }, [rest, opsMap]);

  return (
    <Panel title="Image ops" sub="copy / SERVING_IMAGE deploys / builds — click for steps + log" className="p-3">
      {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
      {merged.length === 0 ? (
        <FieldMsg tone="hint">no image ops yet — copies, deploys and builds stream here (WS ops topic) + REST audit.</FieldMsg>
      ) : (
        <DataTable
          columns={[
            { key: 'id', label: 'op' },
            { key: 'kind', label: 'kind' },
            { key: 'st', label: 'state', align: 'right' },
            { key: 'msg', label: 'message' },
            { key: 'ts', label: 'created', align: 'right' },
          ]}
          minWidth={640}
          empty="—"
        >
          {merged.map((op) => (
            <tr
              key={op.id}
              className="cursor-pointer transition-colors duration-fast hover:bg-bg2/60"
              onClick={() => onOpen(op.id)}
            >
              <Td className="font-mono text-2xs text-mid">{op.id}</Td>
              <Td className="font-mono text-2xs text-hi">{op.kind}</Td>
              <Td align="right">
                <Chip variant={op.state === 'ok' ? 'ok' : op.state === 'error' ? 'crit' : op.state === 'running' ? 'accent' : op.state === 'cancelled' ? 'warn' : 'neutral'}>
                  {op.state}
                </Chip>
              </Td>
              <Td className="max-w-[320px] truncate text-2xs text-low" title={op.message ?? undefined}>
                {op.message ?? '—'}
              </Td>
              <Td num align="right" className="text-2xs text-mid">
                {fmtDateTime(op.created)}
              </Td>
            </tr>
          ))}
        </DataTable>
      )}
      <FieldMsg tone="hint">
        GET /api/ops is keyed by an exact kind — the list merges three queries (image.copy, image.set_serving,
        image.build) plus any live op frames from the socket.
      </FieldMsg>
    </Panel>
  );
}

import { useWs as useWsLive } from '../../api/client';
import { fmtDateTime } from '../../lib/format';
