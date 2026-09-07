/* Settings ▸ Control — per-cluster serve_dir / launcher / start_extra /
   health timeout + head and worker mapping. These strings run VERBATIM on the
   nodes via pairctl — the warning chip is the point of this section. */

import { useEffect, useMemo, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { ClusterControl, ClusterTopology } from '../../../api/types';
import { fetchClusters, patchCluster } from '../../../api/admin';
import { useQuery } from '../../../api/queries';
import { Btn, Chip, Input, Select, Spinner, toast } from '../../../ds';
import { cn } from '../../../lib/cn';
import { DirtySave, FieldMsg, NumField, offerAuthGate, errCopy } from '../../../lib/pagekit';
import { SectionWrap } from '../SectionWrap';

export function ControlSection() {
  const clustersQ = useQuery(fetchClusters);
  const clusters = clustersQ.data ?? [];
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    if ((selectedId === null || !clusters.some((c) => c.id === selectedId)) && clusters.length > 0) {
      setSelectedId(clusters[0]?.id ?? null);
    }
  }, [clusters, selectedId]);

  const cluster = clusters.find((c) => c.id === selectedId) ?? null;

  return (
    <SectionWrap
      id="control"
      title="Control"
      sub="serve paths, launcher, start-time flags, head/worker mapping (cluster body PATCH)"
    >
      {clustersQ.loading && clusters.length === 0 ? (
        <div className="sd-panel flex items-center justify-center gap-2 p-8 text-mid">
          <Spinner size={13} /> loading topology…
        </div>
      ) : clusters.length === 0 ? (
        <div className="sd-panel p-6 text-sm text-mid">No clusters configured yet.</div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {clusters.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedId(c.id)}
                className={cn(
                  'inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-inner border px-2.5 font-mono text-2xs transition-colors duration-fast',
                  c.id === selectedId ? 'border-accent/40 bg-accent/10 text-accent' : 'border-stroke text-mid hover:text-hi',
                )}
              >
                <span className="h-2 w-2 rounded-full" style={{ background: c.accent_color }} aria-hidden />
                {c.name}
              </button>
            ))}
          </div>
          {cluster !== null && <ControlForm key={cluster.id} cluster={cluster} />}
        </>
      )}
    </SectionWrap>
  );
}

function ControlForm({ cluster }: { cluster: ClusterTopology }) {
  const [d, setD] = useState<ClusterControl>(() => ({ ...cluster.control }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const workers = useMemo(() => cluster.nodes.filter((n) => n.id !== d.head_node_id), [cluster.nodes, d.head_node_id]);

  useEffect(() => {
    setD({ ...cluster.control });
  }, [cluster.id, cluster.control]);

  const patch = (p: Partial<ClusterControl>): void => setD((cur) => ({ ...cur, ...p }));

  const portNumOk = (v: number | null): boolean => v !== null && Number.isInteger(v) && v >= 1;

  const dirty = useMemo(
    () =>
      d.serve_dir !== cluster.control.serve_dir ||
      d.launcher !== cluster.control.launcher ||
      d.start_extra !== cluster.control.start_extra ||
      d.health_timeout_s !== cluster.control.health_timeout_s ||
      d.head_node_id !== cluster.control.head_node_id ||
      d.worker_node_id !== cluster.control.worker_node_id,
    [d, cluster.control],
  );
  const valid = d.serve_dir.trim() !== '' && d.launcher.trim() !== '' && portNumOk(d.health_timeout_s);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await patchCluster(cluster.id, {
        control: {
          ...d,
          serve_dir: d.serve_dir.trim(),
          launcher: d.launcher.trim(),
          start_extra: d.start_extra,
          health_timeout_s: d.health_timeout_s,
          head_node_id: d.head_node_id,
          worker_node_id: d.worker_node_id,
        },
      });
      toast.ok(`Control updated for ${cluster.name}`);
    } catch (err) {
      offerAuthGate(err);
      toast.error('Control update failed', errCopy(err));
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sd-panel p-4">
      <div className="mb-3 flex items-center gap-2">
        <Chip variant="warn" title="paths/scripts are passed to pairctl — they run verbatim on the nodes">
          <TriangleAlert size={11} /> these strings run verbatim on the nodes
        </Chip>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <Input
          label="serve_dir — node-side serve dir (launcher + env files)"
          value={d.serve_dir}
          className="col-span-full"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => patch({ serve_dir: e.currentTarget.value })}
        />
        <Input
          label="Launcher script"
          value={d.launcher}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => patch({ launcher: e.currentTarget.value })}
        />
        <NumField
          label="Health timeout"
          value={d.health_timeout_s}
          unit="seconds"
          integer
          min={1}
          max={3600}
          onChange={(v) => patch({ health_timeout_s: v ?? 0 })}
          hint="how long a fresh boot may stay 'starting' before the pairctl babysitter gives up"
        />
        <Input
          label="start_extra — pairctl EXTRA passthrough"
          value={d.start_extra}
          className="col-span-full"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => patch({ start_extra: e.currentTarget.value })}
          placeholder="e.g. --recurrent-checkpoint-policy request_boundaries"
        />
      </div>
      <div className="mt-3 grid gap-3 lg:grid-cols-2">
        <Select label="Head node" value={d.head_node_id} onChange={(e) => patch({ head_node_id: e.currentTarget.value })}>
          <option value="">— none —</option>
          {cluster.nodes.map((n) => (
            <option key={n.id} value={n.id}>
              {n.name} ({n.role})
            </option>
          ))}
        </Select>
        <Select label="Worker node" value={d.worker_node_id} onChange={(e) => patch({ worker_node_id: e.currentTarget.value })}>
          <option value="">— none —</option>
          {cluster.nodes.map((n) => (
            <option key={n.id} value={n.id} className={cn(n.id === d.head_node_id && 'hidden')}>
              {n.name} ({n.role}){workers.some((w) => w.id === n.id) ? '' : ' · same as head'}
            </option>
          ))}
        </Select>
      </div>

      {d.head_node_id === '' && (
        <div className="mt-2">
          <FieldMsg tone="hint">pick a head node — the controller pours connections through the head's address list</FieldMsg>
        </div>
      )}

      <DirtySave
        dirty={dirty}
        valid={valid}
        saving={saving}
        error={error}
        onSave={() => void save()}
        onReset={() => {
          setD({ ...cluster.control });
          setError(null);
        }}
        saveLabel="Save control"
      />
    </div>
  );
}
