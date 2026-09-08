/* Images ▸ actions — copy image to peer (docker save | ssh docker load),
   set SERVING_IMAGE (preview → sed rewrite of both rank files), build image
   (builder env profile, detached run + log follow). Each destructive step gets
   a ConfirmDialog with the EXACT commands the controller will run. */

import { useEffect, useState } from 'react';
import { ArrowLeftRight, Binoculars, Hammer } from 'lucide-react';
import type { ClusterTopology, ID, ImageInfo, ImageSetPreview, ServiceState } from '../../api/types';
import {
  copyImage,
  fetchBuildEnvs,
  fetchDeployPreview,
  deployImageSet,
  startImageBuild,
  type BuilderEnvRow,
  type NodeImageState,
} from '../../api/admin';
import { Btn, Chip, ConfirmDialog, Input, Select, toast } from '../../ds';
import { DataTable, FieldMsg, Td, errCopy, offerAuthGate } from '../../lib/pagekit';

/* image inventory union of a set of nodes (for pickers) */
export function inventoryOf(imagesByNode: Record<string, NodeImageState>): ImageInfo[] {
  const byPromo = new Map<string, ImageInfo>();
  for (const st of Object.values(imagesByNode)) {
    for (const im of st.images) {
      const existing = byPromo.get(im.repo_tag);
      if (existing === undefined) byPromo.set(im.repo_tag, im);
    }
  }
  return [...byPromo.values()].sort((a, b) => a.repo_tag.localeCompare(b.repo_tag));
}

interface ActionProps {
  cluster: ClusterTopology;
  imagesByNode: Record<string, NodeImageState>;
  service: ServiceState | undefined;
  /** opens the ops drawer for an op id */
  onOp: (opId: string) => void;
}

/* ---------------------------------------------------------------------------
   Copy image to peer — 24+ GB over the CX7 fabric, ~3–4 min
   --------------------------------------------------------------------------- */

export function CopyImageCard({ cluster, imagesByNode, onOp }: ActionProps) {
  const [srcId, setSrcId] = useState<ID | null>(null);
  const [dstId, setDstId] = useState<ID | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const src = cluster.nodes.find((n) => n.id === srcId) ?? null;
  const dst = cluster.nodes.find((n) => n.id === dstId) ?? null;
  const srcState = srcId !== null ? imagesByNode[srcId] : undefined;
  const pickable = inventoryOf(imagesByNode).map((i) => i.repo_tag);

  useEffect(() => {
    if (cluster.nodes.length > 0) {
      setSrcId(cluster.nodes[0]?.id ?? null);
      setDstId(cluster.nodes[1]?.id ?? null);
    }
  }, [cluster.nodes]);

  const dstAddr = dst?.addresses[0]?.host ?? '—';

  const run = (): void => {
    if (srcId === null || dstId === null || image === null) return;
    setConfirmOpen(false);
    setBusy(true);
    copyImage({ cluster_id: cluster.id, src_node_id: srcId, dst_node_id: dstId, image })
      .then((ref) => {
        toast.ok('Image copy queued', ref.op_id !== null ? `op ${ref.op_id} · 24+ GB over the fabric, ~3–4 min` : undefined);
        if (ref.op_id !== null) onOp(ref.op_id);
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Image copy failed', errCopy(err));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="sd-panel flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <ArrowLeftRight size={14} style={{ color: 'var(--sd-accent)' }} />
        <h3 className="text-[13px] font-semibold text-hi">Copy image to peer</h3>
      </div>
      <FieldMsg tone="hint">
        docker save | ssh docker load — 24+ GB over the CX7 fabric, ~3–4 min. The pair keeps serving.
      </FieldMsg>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Src node" value={srcId ?? ''} onChange={(e) => { setSrcId(e.currentTarget.value); setImage(null); }} className="w-40">
          <option value="">— src —</option>
          {cluster.nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.name}{imagesByNode[n.id]?.state === 'offline' ? ' (offline)' : ''}</option>
          ))}
        </Select>
        <Select label="Dst node" value={dstId ?? ''} onChange={(e) => setDstId(e.currentTarget.value)} className="w-40">
          <option value="">— dst —</option>
          {cluster.nodes.map((n) =>
            n.id === srcId ? undefined : (
              <option key={n.id} value={n.id}>{n.name}{imagesByNode[n.id]?.state === 'offline' ? ' (offline)' : ''}</option>
            ),
          )}
        </Select>
        <Select label="Image (present on src)" value={image ?? ''} onChange={(e) => setImage(e.currentTarget.value)} className="min-w-0 flex-1">
          <option value="">— image —</option>
          {pickable.map((tag) => (
            <option key={tag} value={tag}>{tag}</option>
          ))}
        </Select>
        <Btn
          variant="primary"
          disabled={srcId === null || dstId === null || image === null || dstId === srcId}
          loading={busy}
          onClick={() => setConfirmOpen(true)}
        >
          Copy →
        </Btn>
      </div>
      {srcState !== undefined && srcState.images.length === 0 && srcState.state === 'online' && (
        <FieldMsg tone="hint">
          no filtered images reported on {src?.name} — the server filters by settings.images.filter_glob (default
          local/vllm:*); check Settings if the tag naming differs.
        </FieldMsg>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        busy={busy}
        title="Copy image to peer"
        summary={
          <>
            Streams <span className="font-mono text-hi">{image ?? ''}</span> from{' '}
            <span className="font-mono text-hi">{src?.name ?? ''}</span> to{' '}
            <span className="font-mono text-hi">{dst?.name ?? ''}</span> over the CX7 fabric. The stream is
            unthrottled — expect the ~25 GB to land in a few minutes; serving is unaffected.
          </>
        }
        commands={[
          `docker save ${image ?? ''} | ssh -4 -o BatchMode=yes -o ConnectTimeout=10 \\`,
          `  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/dev/null \\`,
          `  ${dst?.ssh_user ?? ''}@${dstAddr} docker load`,
          `docker image inspect ${image ?? ''} --format '{{.Id}}'   # on ${dst?.name ?? ''}`,
        ]}
        confirmLabel="Stream it"
        onConfirm={run}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Set SERVING_IMAGE — preview then deploy (sed rewrite, both rank files)
   --------------------------------------------------------------------------- */

export function SetServingCard({ cluster, imagesByNode, service, onOp }: ActionProps) {
  const [profileKey, setProfileKey] = useState('');
  const [image, setImage] = useState('');
  const [preview, setPreview] = useState<ImageSetPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [deployBusy, setDeployBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (cluster.profiles.length > 0 && profileKey === '') setProfileKey(cluster.profiles[0]?.key ?? '');
    if (cluster.profiles.length > 0 && !cluster.profiles.some((p) => p.key === profileKey)) {
      setProfileKey(cluster.profiles[0]?.key ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cluster.id]);

  const runningImage = service?.image ?? null;
  const loadPreview = (): void => {
    if (profileKey === '' || image.trim() === '') return;
    setPreviewBusy(true);
    setError(null);
    fetchDeployPreview(cluster.id, profileKey, image.trim())
      .then((rows) => setPreview(rows))
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Preview failed', errCopy(err));
        setError(err);
      })
      .finally(() => setPreviewBusy(false));
  };

  const deploy = (): void => {
    setConfirmOpen(false);
    setDeployBusy(true);
    deployImageSet({ cluster_id: cluster.id, profile_key: profileKey, image: image.trim() })
      .then((ref) => {
        toast.ok('SERVING_IMAGE deploy queued', ref.op_id !== null ? `op ${ref.op_id} — then restart the pair to move onto it` : 'then restart the pair → Control');
        if (ref.op_id !== null) onOp(ref.op_id);
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Deploy failed', errCopy(err));
      })
      .finally(() => setDeployBusy(false));
  };

  const ready = profileKey !== '' && image.trim() !== '' && image.trim() !== runningImage;

  return (
    <div className="sd-panel flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <Binoculars size={14} style={{ color: 'var(--sd-accent)' }} />
        <h3 className="text-[13px] font-semibold text-hi">Set SERVING_IMAGE</h3>
        {runningImage !== null && (
          <Chip variant="neutral" title="image the running pair was launched from">
            running: {runningImage}
          </Chip>
        )}
      </div>
      <FieldMsg tone="hint">
        Rewrites SERVING_IMAGE in rank-&lt;0|-1&gt;-… env files on head+worker, profile-scoped. Then restart the pair
        (Control ▸ start) to move onto the new image.
      </FieldMsg>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Profile" value={profileKey} onChange={(e) => { setProfileKey(e.currentTarget.value); setPreview(null); }} className="w-52">
          <option value="">— profile —</option>
          {cluster.profiles.map((p) => (
            <option key={p.key} value={p.key}>{p.key}</option>
          ))}
        </Select>
        <Input
          label="Image"
          value={image}
          placeholder={inventoryOf(imagesByNode)[0]?.repo_tag ?? 'local/vllm:...'}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => { setImage(e.currentTarget.value); setPreview(null); }}
          className="min-w-0 flex-1"
          hint={image === runningImage ? '== running image (no-op deploy)' : undefined}
        />
        <Btn variant="ghost" disabled={profileKey === '' || image.trim() === ''} loading={previewBusy} onClick={loadPreview}>
          Preview
        </Btn>
        <Btn variant="primary" disabled={!ready || preview === null} loading={deployBusy} onClick={() => setConfirmOpen(true)}>
          Deploy
        </Btn>
      </div>
      {preview !== null && (
        <DataTable
          columns={[
            { key: 'n', label: 'node' },
            { key: 'f', label: 'file' },
            { key: 'o', label: 'old' },
            { key: 'nw', label: 'new' },
          ]}
          minWidth={560}
          empty="—"
        >
          {preview.rows.map((r) => (
            <tr key={r.node_id}>
              <Td className="font-mono text-hi">{r.node_name}</Td>
              <Td className="font-mono text-2xs text-low" title={r.file}>
                {r.file.split('/').slice(-1)[0] ?? r.file}
              </Td>
              <Td className="font-mono text-2xs text-low">{r.old === '' ? '(empty)' : r.old}</Td>
              <Td className="font-mono text-2xs text-hi">{r.new}</Td>
            </tr>
          ))}
        </DataTable>
      )}
      {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        busy={deployBusy}
        title="Deploy SERVING_IMAGE"
        summary={
          <>
            sed-rewrites <code className="font-mono">SERVING_IMAGE</code> on both rank files for profile{' '}
            <span className="font-mono text-hi">{profileKey}</span> in {cluster.name}. The pair must be restarted after
            — the running engine doesn't see env changes.
          </>
        }
        commands={(preview?.rows ?? []).map((r) => `sed -i 's|^SERVING_IMAGE=.*|SERVING_IMAGE=${r.new}|' ${r.file} && grep -E '^SERVING_IMAGE=' ${r.file}`)}
        onConfirm={deploy}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Build image — builder env profiles on a node (build-*.env)
   --------------------------------------------------------------------------- */

export function BuildImageCard({ cluster, imagesByNode, onOp }: ActionProps) {
  const [nodeId, setNodeId] = useState<ID | null>(cluster.nodes[0]?.id ?? null);
  const [files, setFiles] = useState<BuilderEnvRow[] | null>(null);
  const [state, setState] = useState<string>('offline');
  const [file, setFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [fetchError, setFetchError] = useState<unknown>(null);

  useEffect(() => {
    setFiles(null);
    setFile(null);
    if (nodeId === null) return;
    let active = true;
    fetchBuildEnvs(nodeId)
      .then((r) => {
        if (!active) return;
        setFiles(r.files);
        setState(r.state);
      })
      .catch((err) => {
        setFetchError(err);
      });
    return () => {
      active = false;
    };
  }, [nodeId]);

  return (
    <div className="sd-panel flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Hammer size={14} style={{ color: 'var(--sd-accent)' }} />
          <h3 className="text-[13px] font-semibold text-hi">Build image</h3>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Select label="Builder node" value={nodeId ?? ''} onChange={(e) => setNodeId(e.currentTarget.value)} className="w-44">
          <option value="">— node —</option>
          {cluster.nodes.map((n) => (
            <option key={n.id} value={n.id}>{n.name}{imagesByNode[n.id]?.state === 'offline' ? ' (offline)' : ''}</option>
          ))}
        </Select>
        <Select
          label="Builder env profile (build-*.env)"
          value={file ?? ''}
          onChange={(e) => setFile(e.currentTarget.value === '' ? null : e.currentTarget.value)}
          className="min-w-0 flex-1"
          disabled={files === null || files.length === 0}
        >
          <option value="">— env file —</option>
          {(files ?? []).map((ff) => (
            <option key={ff.file} value={ff.file}>{ff.file}</option>
          ))}
        </Select>
        <Btn variant="primary" disabled={nodeId === null || file === null} loading={busy} onClick={() => setConfirmOpen(true)}>
          Build →
        </Btn>
      </div>
      <div className="flex items-center gap-1.5">
        <Chip variant="warn" title="peak build memory — the serving pair must be down on that cluster">
          pair must be DOWN (peak ~103 GiB)
        </Chip>
        {state === 'offline' && <Chip variant="crit" title="GET /api/images/builds/{node} reported the node offline">node offline</Chip>}
      </div>
      {fetchError !== null && <FieldMsg tone="error">{fetchError instanceof Error ? fetchError.message : String(fetchError)}</FieldMsg>}
      {files !== null && files.length === 0 && (
        <FieldMsg tone="hint">no build-*.env found in the builder dir — check the repo layout on {nodeId !== null ? (cluster.nodes.find((n) => n.id === nodeId)?.name ?? '') : '—'}</FieldMsg>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        busy={busy}
        title="Build image"
        summary={
          <>
            Runs the builder on <span className="font-mono text-hi">{nodeId !== null ? (cluster.nodes.find((n) => n.id === nodeId)?.name ?? '') : ''}</span> with{' '}
            <span className="font-mono text-hi">{file ?? ''}</span>. Detached: nohup + log follow (~40+ min normally).
            The serving pair on this cluster must be <span className="text-crit">down</span> while the build peaks.
          </>
        }
        commands={[
          `cd <repo>/builder/blackwell-llm-docker/dgx-spark-builder && \\`,
          `  setsid nohup bash build-spark-cu132.sh ${file ?? ''} > ~/.sparkdeck/build-<ts>.log 2>&1 &`,
          `tail -n +1 -f ~/.sparkdeck/build-<ts>.log        # ops stream this`,
        ]}
        confirmLabel="Start build"
        onConfirm={() => {
          if (nodeId === null || file === null) return;
          setConfirmOpen(false);
          setBusy(true);
          startImageBuild({ cluster_id: cluster.id, node_id: nodeId, file })
            .then((ref) => {
              toast.ok('Build queued', ref.op_id !== null ? `op ${ref.op_id}` : undefined);
              if (ref.op_id !== null) onOp(ref.op_id);
            })
            .catch((err) => {
              offerAuthGate(err);
              toast.error('Build failed to start', errCopy(err));
            })
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}

/* misc export kept local: shield icon for the reminders strip */
