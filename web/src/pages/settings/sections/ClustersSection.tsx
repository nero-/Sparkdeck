/* Settings ▸ Clusters & nodes — cluster list (accent picker incl. GLM pair
   defaults cyan/violet), per-cluster nodes table + edit drawer, add-node /
   add-cluster flows, profiles tab. */

import { useEffect, useMemo, useState } from 'react';
import { Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { ClusterTopology, NodeConfig } from '../../../api/types';
import {
  createCluster,
  createNode as adminCreateNode,
  deleteCluster,
} from '../../../api/admin';
import { Btn, Chip, ConfirmDialog, Input, Modal, Select, Spinner, Tabs, toast } from '../../../ds';
import { cn } from '../../../lib/cn';
import { useQuery } from '../../../api/queries';
import { fetchClusters, patchCluster, patchNode, type NodeCreateVia } from '../../../api/admin';
import { DataTable, FieldMsg, Td, errCopy, offerAuthGate } from '../../../lib/pagekit';
import { SectionWrap } from '../SectionWrap';
import { NodeEditDrawer } from './NodeEditDrawer';
import { ProfilesPanel } from './ProfilesPanel';

/* GLM pair accent defaults — cyan (c1) / violet (c2) per docs/DESIGN.md */
export const GLM_ACCENTS = { c1: '#22d3ee', c2: '#a78bfa' } as const;

function isValidHex(hex: string): boolean {
  return /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.test(hex);
}

export function ClustersSection() {
  const clustersQ = useQuery(fetchClusters);
  const clusters = clustersQ.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if ((selectedId === null || !clusters.some((c) => c.id === selectedId)) && clusters.length > 0) {
      setSelectedId(clusters[0]?.id ?? null);
    }
  }, [clusters, selectedId]);

  const selected = clusters.find((c) => c.id === selectedId) ?? null;
  const [tab, setTab] = useState('nodes');

  const refresh = (): void => clustersQ.reload();

  return (
    <SectionWrap
      id="clusters"
      title="Clusters & nodes"
      sub="topology, accents, ssh targets, per-node addresses, profiles"
      right={
        <>
          <Btn size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={refresh} title="re-read /api/clusters">
            Refresh
          </Btn>
          <AddClusterModal onCreated={(id) => { refresh(); setSelectedId(id); }} />
        </>
      }
    >
      {clustersQ.error !== null ? (
        <div className="sd-panel p-6 text-sm text-crit">{errCopy(clustersQ.error)}</div>
      ) : clustersQ.loading && clusters.length === 0 ? (
        <div className="sd-panel flex items-center justify-center gap-2 p-10 text-mid">
          <Spinner size={14} /> loading topology…
        </div>
      ) : clusters.length === 0 ? (
        <div className="sd-panel p-6 text-sm text-mid">No clusters configured — create the first one.</div>
      ) : (
        <div className="grid min-w-0 gap-3 xl:grid-cols-[240px_minmax(0,1fr)]">
          {/* cluster list */}
          <div className="flex flex-col gap-1.5">
            {clusters.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'flex cursor-pointer items-center gap-2 rounded-inner border px-2.5 py-2 text-left transition-colors duration-fast',
                  c.id === selectedId ? 'border-stroke-strong bg-bg2' : 'border-stroke bg-transparent hover:bg-bg2/60',
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.accent_color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-sm text-hi">{c.name}</span>
                <span className="sd-num font-mono text-2xs text-low">{c.nodes.length}n</span>
              </button>
            ))}
          </div>

          {/* detail */}
          {selected !== null && (
            <div className="flex min-w-0 flex-col gap-3">
              <ClusterIdentity cluster={selected} onSaved={refresh} />
              <Tabs
                variant="chip"
                ariaLabel="cluster settings tabs"
                tabs={[
                  { id: 'nodes', label: `nodes (${selected.nodes.length})` },
                  { id: 'profiles', label: `profiles (${selected.profiles.length})` },
                ]}
                value={tab}
                onChange={setTab}
              />
              {tab === 'nodes' ? <NodesTab cluster={selected} onRefresh={refresh} /> : <ProfilesPanel cluster={selected} onRefresh={refresh} />}
              <DeleteCluster cluster={selected} onDeleted={() => { refresh(); setSelectedId(null); }} />
            </div>
          )}
        </div>
      )}
    </SectionWrap>
  );
}

/* ---------------------------------------------------------------------------
   Cluster identity strip — name + accent + notes → PATCH /api/clusters/{id}
   (the same PATCH body matches the Control section's control-slice updates)
   --------------------------------------------------------------------------- */

const SWATCHES = [GLM_ACCENTS.c1, GLM_ACCENTS.c2, '#5eb1ff', '#4ade80', '#fbbf24', '#f87171', '#fb923c', '#e879f9'];

function ClusterIdentity({ cluster, onSaved }: { cluster: ClusterTopology; onSaved: () => void }) {
  const [name, setName] = useState(cluster.name);
  const [accent, setAccent] = useState(cluster.accent_color);
  const [notes, setNotes] = useState(cluster.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setName(cluster.name);
    setAccent(cluster.accent_color);
    setNotes(cluster.notes ?? '');
  }, [cluster.id, cluster.name, cluster.accent_color, cluster.notes]);

  const dirty = name !== cluster.name || accent !== cluster.accent_color || notes !== (cluster.notes ?? '');
  const valid = name.trim().length > 0 && isValidHex(accent);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await patchCluster(cluster.id, {
        name: name.trim(),
        accent_color: accent.trim(),
        notes: notes.trim() === '' ? null : notes.trim(),
      });
      toast.ok(`Cluster ${name.trim()} saved`);
      onSaved();
    } catch (err) {
      offerAuthGate(err);
      toast.error('Cluster save failed', errCopy(err));
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sd-panel p-3">
      <div className="flex flex-wrap items-end gap-2">
        <Input
          label="Cluster name"
          className="w-56"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          label="Notes"
          className="min-w-0 flex-1"
          value={notes}
          placeholder="freeform"
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
        <div className="flex items-end gap-2">
          <div className="flex flex-col gap-1">
            <span className="sd-monolabel">accent</span>
            <div className="flex items-center gap-1">
              {SWATCHES.map((sw) => (
                <button
                  key={sw}
                  type="button"
                  aria-label={`accent ${sw}`}
                  title={sw === GLM_ACCENTS.c1 ? 'GLM c1 default (cyan)' : sw === GLM_ACCENTS.c2 ? 'GLM c2 default (violet)' : sw}
                  onClick={() => setAccent(sw)}
                  className={cn(
                    'h-5 w-5 cursor-pointer rounded-inner border transition-transform duration-fast',
                    accent.toLowerCase() === sw.toLowerCase() ? 'scale-110 border-hi' : 'border-stroke hover:scale-105',
                  )}
                  style={{ background: sw }}
                />
              ))}
              <input
                type="color"
                aria-label="custom accent color"
                value={isValidHex(accent) ? accent : GLM_ACCENTS.c1}
                onChange={(e) => setAccent(e.currentTarget.value)}
                className="h-5 w-5 cursor-pointer rounded-inner border border-stroke bg-transparent p-0"
                title="pick a color"
              />
              <input
                type="text"
                aria-label="accent hex"
                value={accent}
                spellCheck={false}
                onChange={(e) => setAccent(e.currentTarget.value)}
                className={cn(
                  'sd-raised h-5 w-24 px-1.5 font-mono text-2xs text-hi',
                  !isValidHex(accent) && 'border-crit/50 text-crit',
                )}
              />
            </div>
          </div>
          <Btn size="md" variant="primary" disabled={!dirty || !valid} loading={saving} onClick={() => void save()}>
            Save cluster
          </Btn>
        </div>
      </div>
      {!isValidHex(accent) ? (
        <div className="pt-2">
          <FieldMsg tone="error">accent must be a hex color like #22D3EE (3 or 6 digits)</FieldMsg>
        </div>
      ) : null}
      {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Nodes table + add-node
   --------------------------------------------------------------------------- */

function NodesTab({ cluster, onRefresh }: { cluster: ClusterTopology; onRefresh: () => void }) {
  const [editingNode, setEditingNode] = useState<NodeConfig | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const nodes = [...cluster.nodes].sort((a, b) => (a.role === b.role ? a.env_rank - b.env_rank : a.role === 'head' ? -1 : 1));

  const adopt = (_saved: NodeConfig): void => {
    onRefresh();
  };

  return (
    <div className="sd-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="sd-monolabel">nodes ({cluster.nodes.length})</div>
        <Btn size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setAddOpen(true)}>
          Add node
        </Btn>
      </div>
      <DataTable
        columns={[
          { key: 'name', label: 'name' },
          { key: 'role', label: 'role' },
          { key: 'ssh', label: 'ssh' },
          { key: 'alias', label: 'alias' },
          { key: 'rank', label: 'env rank', align: 'right' },
          { key: 'api', label: 'api port', align: 'right' },
          { key: 'addrs', label: 'addresses' },
          { key: 'on', label: 'on', align: 'right' },
          { key: 'acts', label: '', align: 'right' },
        ]}
        minWidth={860}
        empty="No nodes on this cluster yet — add the head first."
      >
        {nodes.map((n) => (
          <tr key={n.id} className={cn(!n.enabled && 'opacity-50')}>
            <Td className="font-mono text-hi">{n.name}</Td>
            <Td>
              <Chip variant={n.role === 'head' ? 'accent' : 'neutral'}>{n.role}</Chip>
            </Td>
            <Td className="font-mono text-2xs text-mid">
              {n.ssh_user}@{n.ssh_port}
            </Td>
            <Td className="font-mono text-2xs text-mid">{n.ssh_alias ?? '—'}</Td>
            <Td num align="right">
              {n.env_rank}
            </Td>
            <Td num align="right">
              {n.api_port}
            </Td>
            <Td>
              <span className="font-mono text-2xs text-mid" title={n.addresses.map((a) => `${a.kind}:${a.host}`).join('  |  ')}>
                {n.addresses.length > 0 ? `${n.addresses.length} · ${n.addresses[0]?.kind ?? ''} → ${truncate(n.addresses[0]?.host ?? '', 22)}` : '—'}
              </span>
            </Td>
            <Td align="right">
              <EnabledToggle node={n} onData={onRefresh} />
            </Td>
            <Td align="right">
              <Btn
                size="sm"
                variant="ghost"
                icon={<Pencil size={12} />}
                onClick={() => setEditingNode(n)}
                aria-label={`edit ${n.name}`}
              />
            </Td>
          </tr>
        ))}
      </DataTable>

      <NodeEditDrawer cluster={cluster} node={editingNode} open={editingNode !== null} onClose={() => setEditingNode(null)} onSaved={adopt} />
      <AddNodeModal cluster={cluster} open={addOpen} onClose={() => setAddOpen(false)} onCreated={onRefresh} />
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function EnabledToggle({ node, onData }: { node: NodeConfig; onData: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={node.enabled}
      disabled={busy}
      title='node participates in sampling + ws topics — toggle to detach/attach'
      onClick={() => {
        setBusy(true);
        patchNode(node.id, { enabled: !node.enabled })
          .then(() => {
            toast.ok(`${node.name} ${!node.enabled ? 'enabled' : 'disabled'}`);
            onData();
          })
          .catch((err) => {
            offerAuthGate(err);
            toast.error(`Could not ${!node.enabled ? 'enable' : 'disable'} ${node.name}`, errCopy(err));
          })
          .finally(() => setBusy(false));
      }}
      className={cn(
        'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-fast',
        node.enabled ? 'border-accent/50 bg-accent/25' : 'border-stroke bg-bg2',
        busy && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'absolute h-3 w-3 rounded-full transition-all duration-fast',
          node.enabled ? 'left-[16px] bg-accent' : 'left-[3px] bg-low',
        )}
      />
    </button>
  );
}

function AddNodeModal({
  cluster,
  open,
  onClose,
  onCreated,
}: {
  cluster: ClusterTopology;
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const nextRank = useMemo(() => cluster.nodes.reduce((m, n) => Math.max(m, n.env_rank + 1), 0), [cluster.nodes]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<'head' | 'worker'>('worker');
  const [sshUser, setSshUser] = useState('nero');
  const [sshPort, setSshPort] = useState('22');
  const [alias, setAlias] = useState('');
  const [rank, setRank] = useState(String(nextRank));
  const [apiPort, setApiPort] = useState('8000');
  const [host, setHost] = useState('');
  const [kind, setKind] = useState<'lan' | 'fabric' | 'tailscale' | 'custom'>('lan');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setRole('worker');
      setSshUser('nero');
      setSshPort('22');
      setAlias('');
      setRank(String(nextRank));
      setApiPort('8000');
      setHost('');
      setKind('lan');
      setError(null);
    }
  }, [open, nextRank]);

  const nameOk = name.trim().length > 0 && !cluster.nodes.some((n) => n.name === name.trim());
  const hostOk = host.trim().length > 0;
  const port = Number(sshPort);
  const apiPortN = Number(apiPort);
  const rankN = Number(rank);
  const valid =
    nameOk && hostOk && Number.isInteger(port) && port >= 1 && port <= 65535 &&
    Number.isInteger(apiPortN) && apiPortN >= 1 && apiPortN <= 65535 &&
    Number.isInteger(rankN) && rankN >= 0 && rankN <= 3;

  const submit = (): void => {
    setBusy(true);
    setError(null);
    adminCreateNode(cluster, {
      cluster_id: cluster.id,
      name: name.trim(),
      role,
      ssh_user: sshUser.trim() || 'root',
      ssh_port: port,
      ssh_alias: alias.trim() === '' ? null : alias.trim(),
      env_rank: rankN,
      api_port: apiPortN,
      interest_ifaces: [],
      enabled: true,
      addresses: [{ kind, host: host.trim() }],
    })
      .then(({ node, via }) => {
        if (node === null) throw new Error('node was accepted but did not appear in the topology');
        toast.ok(`Node ${node.name} added`, `via ${describeVia(via)}`);
        onCreated();
        onClose();
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Add node failed', errCopy(err));
        setError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      busy={busy}
      title={`Add node — ${cluster.name}`}
      width={560}
      actions={
        <>
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" disabled={!valid} loading={busy} onClick={submit}>
            Add node
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <Input label="Name" value={name} invalid={name.trim() !== '' && !nameOk} onChange={(e) => setName(e.currentTarget.value)} hint={nameOk ? 'unique on this cluster' : name.trim() === '' ? 'required' : 'name already in use'} spellCheck={false} autoComplete="off" />
          <Select label="Role" value={role} onChange={(e) => setRole(e.currentTarget.value as 'head' | 'worker')}>
            <option value="head">head</option>
            <option value="worker">worker</option>
          </Select>
          <Input label="SSH user" value={sshUser} onChange={(e) => setSshUser(e.currentTarget.value)} spellCheck={false} autoComplete="off" />
          <Input label="SSH port" value={sshPort} inputMode="numeric" onChange={(e) => setSshPort(e.currentTarget.value)} />
          <Input label="SSH alias" value={alias} placeholder="—" onChange={(e) => setAlias(e.currentTarget.value)} hint="optional ~/.ssh/config alias" spellCheck={false} autoComplete="off" />
          <Input label="Env rank" value={rank} inputMode="numeric" onChange={(e) => setRank(e.currentTarget.value)} hint="0..3" />
          <Input label="API port" value={apiPort} inputMode="numeric" onChange={(e) => setApiPort(e.currentTarget.value)} hint="8000 default" />
          <Select label="First address kind" value={kind} onChange={(e) => setKind(e.currentTarget.value as typeof kind)}>
            <option value="lan">lan</option>
            <option value="fabric">fabric</option>
            <option value="tailscale">tailscale</option>
            <option value="custom">custom</option>
          </Select>
        </div>
        <div className="grid gap-2">
          <Input label="First address host" value={host} invalid={!hostOk} placeholder="10.x.x.x or MagicDNS name" onChange={(e) => setHost(e.currentTarget.value)} className="w-full" spellCheck={false} autoComplete="off" hint="more addresses (failover order) can be added in the node editor afterwards" />
        </div>
        {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
        <FieldMsg tone="hint">
          no POST /api/nodes exists in the contract — add-node rides the bulk topology upsert (POST /api/settings/import); the id below the model is minted client-side.
        </FieldMsg>
      </div>
    </Modal>
  );
}

function describeVia(via: NodeCreateVia | null): string {
  return via === 'post-node' ? 'POST /api/nodes' : 'import upsert (POST /api/settings/import)';
}

/* ---------------------------------------------------------------------------
   Add cluster modal
   --------------------------------------------------------------------------- */

function AddClusterModal({ onCreated }: { onCreated: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [accent, setAccent] = useState<string>(GLM_ACCENTS.c1);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const valid = name.trim().length > 0 && isValidHex(accent);

  const submit = (): void => {
    setBusy(true);
    setError(null);
    createCluster({
      name: name.trim(),
      accent_color: accent.trim(),
      notes: notes.trim() === '' ? null : notes.trim(),
    })
      .then((created) => {
        toast.ok(`Cluster ${created.name} created`, 'profiles/head-mapping come via Save + Control next');
        onCreated(created.id);
        setOpen(false);
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Cluster create failed', errCopy(err));
        setError(err);
      })
      .finally(() => setBusy(false));
  };

  return (
    <>
      <Btn size="sm" variant="primary" icon={<Plus size={13} />} onClick={() => setOpen(true)}>
        Add cluster
      </Btn>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        busy={busy}
        title="Add cluster"
        width={480}
        actions={
          <>
            <Btn variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Btn>
            <Btn variant="primary" disabled={!valid} loading={busy} onClick={submit}>
              Create
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-2">
          <Input label="Name" value={name} invalid={name.trim() === '' && name.length > 0} onChange={(e) => setName(e.currentTarget.value)} autoComplete="off" spellCheck={false} hint="e.g. gx10-a / gx10-b" />
          <div className="flex items-center gap-2">
            <span className="sd-monolabel">accent</span>
            {SWATCHES.map((sw) => (
              <button
                key={sw}
                type="button"
                aria-label={`accent ${sw}`}
                title={sw === GLM_ACCENTS.c1 ? 'GLM c1 (cyan)' : sw === GLM_ACCENTS.c2 ? 'GLM c2 (violet)' : sw}
                onClick={() => setAccent(sw)}
                className={cn(
                  'h-5 w-5 cursor-pointer rounded-inner border transition-transform duration-fast',
                  accent.toLowerCase() === sw.toLowerCase() ? 'scale-110 border-hi' : 'border-stroke hover:scale-105',
                )}
                style={{ background: sw }}
              />
            ))}
            <input
              type="color"
              aria-label="custom accent"
              value={isValidHex(accent) ? accent : GLM_ACCENTS.c1}
              onChange={(e) => setAccent(e.currentTarget.value)}
              className="h-5 w-5 cursor-pointer rounded-inner border border-stroke bg-transparent p-0"
            />
            <input
              type="text"
              aria-label="accent hex"
              value={accent}
              onChange={(e) => setAccent(e.currentTarget.value)}
              spellCheck={false}
              className={cn('sd-raised h-5 w-24 px-1.5 font-mono text-2xs text-hi', !isValidHex(accent) && 'border-crit/50 text-crit')}
            />
          </div>
          <Input label="Notes" value={notes} onChange={(e) => setNotes(e.currentTarget.value)} placeholder="optional" />
          {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
          <FieldMsg tone="hint">
            POST /api/clusters — head/worker mapping + serve paths land in the Control section; profiles in this cluster's tab.
          </FieldMsg>
        </div>
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------------------
   Delete cluster (nodes must be gone first)
   --------------------------------------------------------------------------- */

function DeleteCluster({ cluster, onDeleted }: { cluster: ClusterTopology; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const blocked = cluster.nodes.length > 0;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-stroke pt-3">
      <div className="flex min-w-0 items-center gap-2 text-xs text-low">
        <span>DELETE /api/clusters/{cluster.id} — clusters refuse to go while nodes remain — clear the node rows first.</span>
      </div>
      <Btn size="sm" variant="danger" icon={<Trash2 size={12} />} onClick={() => setOpen(true)}>
        Delete cluster
      </Btn>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Delete cluster — ${cluster.name}`}
        confirmWord="DELETE"
        summary={
          blocked ? (
            <>
              <span className="text-crit">Blocked:</span> this cluster still has {cluster.nodes.length} node(s). Remove
              them in the nodes table first (the API refuses deletes for non-empty clusters).
            </>
          ) : (
            <>Removes the cluster configuration and its profiles. Live data and history stay in the controller db.</>
          )
        }
        commands={blocked ? undefined : [`DELETE /api/clusters/${cluster.id}`]}
        onConfirm={() => {
          deleteCluster(cluster.id)
            .then(() => {
              toast.ok(`Cluster ${cluster.name} deleted`);
              setOpen(false);
              onDeleted();
            })
            .catch((err) => {
              offerAuthGate(err);
              toast.error('Delete failed', errCopy(err));
            });
        }}
      />
    </div>
  );
}
