/* Settings ▸ Clusters — profiles editor.
   Profile CRUD rides the cluster PATCH body (whole `profiles` array) because
   no dedicated endpoints exist — and the current backend actually DROPS
   `profiles` from cluster PATCH (routes.apply_patch exclusion), so saving
   verifies and falls back to the POST /api/settings/import bulk upsert. */

import { useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { ClusterTopology, ProfileDef } from '../../../api/types';
import { clientNodeId, saveProfiles } from '../../../api/admin';
import { Btn, Chip, ConfirmDialog, Input, Select, toast } from '../../../ds';
import { Drawer, FieldMsg, NumField, errCopy } from '../../../lib/pagekit';
import { DataTable, Td } from '../../../lib/pagekit';

interface ProfileDraft {
  key: string;
  label: string;
  served_model_name: string;
  model_dir_hint: string;
  kv_pin_gib: number | null;
  context: number | null;
  speculator: string;
  quant: string;
  mm_images: number | null;
  mm_videos: number | null;
  notes: string;
}

function draftOf(p: ProfileDef | null): ProfileDraft {
  return p === null
    ? {
        key: '',
        label: '',
        served_model_name: 'zai-org/GLM-5.3-Flash',
        model_dir_hint: '',
        kv_pin_gib: null,
        context: null,
        speculator: '',
        quant: '',
        mm_images: null,
        mm_videos: null,
        notes: '',
      }
    : {
        key: p.key,
        label: p.label,
        served_model_name: p.served_model_name,
        model_dir_hint: p.model_dir_hint ?? '',
        kv_pin_gib: p.kv_pin_gib ?? null,
        context: p.context ?? null,
        speculator: p.speculator ?? '',
        quant: p.quant ?? '',
        mm_images: p.mm_images ?? null,
        mm_videos: p.mm_videos ?? null,
        notes: p.notes ?? '',
      };
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function ProfilesPanel({
  cluster,
  onRefresh,
}: {
  cluster: ClusterTopology;
  onRefresh: () => void;
}) {
  const [editing, setEditing] = useState<{ isNew: boolean; original: ProfileDef | null } | null>(null);
  const [deleting, setDeleting] = useState<ProfileDef | null>(null);
  const [applying, setApplying] = useState(false);

  const applyProfiles = (profiles: ProfileDef[], okMsg: string): void => {
    setApplying(true);
    saveProfiles(cluster, profiles)
      .then(({ applied, via }) => {
        if (applied) {
          toast.ok(okMsg, `applied via: ${via}`);
          onRefresh();
          return;
        }
        if (via === 'none') {
          toast.error(
            'Profile change could not be applied',
            'cluster PATCH drops the profiles array and POST /api/settings/import is not implemented on this backend — profile edits need a dedicated endpoint (contract gap).',
          );
        } else {
          toast.error('Profile change did not stick after the import upsert', 'verify on the next topology read');
        }
      })
      .catch((err) => {
        toast.error('Profile save failed', errCopy(err));
        offerAuth(err);
      })
      .finally(() => setApplying(false));
  };

  const deleteProfile = (p: ProfileDef): void => {
    setDeleting(null);
    const rest = cluster.profiles.filter((x) => x.id !== p.id);
    if (rest.length === cluster.profiles.length) return;
    applyProfiles(rest, `Profile '${p.key}' deleted`);
  };

  return (
    <div className="sd-panel p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="sd-monolabel">profiles ({cluster.profiles.length})</div>
          <Chip variant="neutral" title="no dedicated profile endpoints — edits ride the cluster PATCH body / bulk import upsert">
            rides cluster PATCH
          </Chip>
        </div>
        <Btn
          size="sm"
          variant="primary"
          icon={<Plus size={13} />}
          onClick={() => setEditing({ isNew: true, original: null })}
        >
          Add profile
        </Btn>
      </div>
      <DataTable
        columns={[
          { key: 'key', label: 'key' },
          { key: 'label', label: 'label' },
          { key: 'model', label: 'served model' },
          { key: 'kv', label: 'kv pin', align: 'right' },
          { key: 'ctx', label: 'context', align: 'right' },
          { key: 'specq', label: 'spec/quant' },
          { key: 'acts', label: '', align: 'right' },
        ]}
        minWidth={760}
        empty="No profiles yet — add one to expose boot targets."
      >
        {cluster.profiles.map((p) => (
          <tr key={p.id}>
            <Td className="font-mono text-hi">{p.key}</Td>
            <Td>{p.label}</Td>
            <Td className="font-mono text-2xs text-mid">{p.served_model_name}</Td>
            <Td num align="right">
              {p.kv_pin_gib ?? '—'}
            </Td>
            <Td num align="right">
              {p.context ?? '—'}
            </Td>
            <Td className="text-2xs text-mid">
              {[p.speculator ?? '—', p.quant ?? '—'].join(' · ')}
            </Td>
            <Td align="right">
              <div className="flex items-center justify-end gap-1">
                <Btn size="sm" variant="ghost" onClick={() => setEditing({ isNew: false, original: p })} icon={<Pencil size={12} />} aria-label={`edit ${p.key}`} />
                <Btn size="sm" variant="ghost" onClick={() => setDeleting(p)} icon={<Trash2 size={12} className="text-crit" />} aria-label={`delete ${p.key}`} />
              </div>
            </Td>
          </tr>
        ))}
      </DataTable>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        busy={applying}
        title={`Delete profile — ${deleting?.key ?? ''}`}
        confirmWord={deleting?.key}
        summary={
          <>
            Removes <span className="font-mono text-hi">{deleting?.key}</span> from{' '}
            <span className="font-mono text-hi">{cluster.name}</span> by re-submitting the cluster's profile array
            without it. The backend never deletes silently — if the API round-trip cannot confirm the removal you'll
            get an explicit failure instead of a lost profile.
          </>
        }
        commands={['PATCH /api/clusters/' + (cluster.id || '') + ' … profiles[] (whole array)']}
        onConfirm={() => deleting !== null && deleteProfile(deleting)}
      />

      <ProfileEditDrawer
        cluster={cluster}
        target={editing}
        busy={applying}
        onClose={() => setEditing(null)}
        onCommit={(profiles, okMsg) => {
          setEditing(null);
          applyProfiles(profiles, okMsg);
        }}
      />
    </div>
  );
}

function offerAuth(_e: unknown): void {
  /* profile offers go through toasts only — the 401 gate lives on page level */
}

/* ---------------------------- edit drawer --------------------------------- */

function ProfileEditDrawer({
  cluster,
  target,
  busy,
  onClose,
  onCommit,
}: {
  cluster: ClusterTopology;
  target: { isNew: boolean; original: ProfileDef | null } | null;
  busy: boolean;
  onClose: () => void;
  onCommit: (profiles: ProfileDef[], okMsg: string) => void;
}) {
  const [d, setD] = useState<ProfileDraft | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (target !== null) {
      setD(draftOf(target.original));
      setError(null);
    }
  }, [target]);

  const keyOk = d !== null && KEY_RE.test(d.key);
  const clashes =
    d !== null &&
    cluster.profiles.some((p) => p.key === d.key && p.id !== target?.original?.id);
  const ctxOk = d === null || d.context === null || (Number.isInteger(d.context) && d.context > 0);
  const kvOk = d === null || d.kv_pin_gib === null || (Number.isFinite(d.kv_pin_gib) && d.kv_pin_gib > 0);
  const modelOk = d !== null && d.served_model_name.trim().length > 0;
  const valid = keyOk && !clashes && ctxOk && kvOk && modelOk;
  const patch = (p: Partial<ProfileDraft>): void => setD((cur) => (cur === null ? cur : { ...cur, ...p }));

  const commit = (): void => {
    if (d === null || target === null) return;
    const id = target.isNew ? clientNodeId() : (target.original?.id ?? '');
    const next: ProfileDef = {
      id: target.original?.id ?? id,
      cluster_id: cluster.id,
      key: d.key.trim(),
      label: d.label.trim(),
      served_model_name: d.served_model_name.trim(),
      model_dir_hint: d.model_dir_hint.trim() === '' ? null : d.model_dir_hint.trim(),
      kv_pin_gib: d.kv_pin_gib,
      context: d.context,
      speculator: d.speculator.trim() === '' ? null : d.speculator.trim(),
      quant: d.quant.trim() === '' ? null : d.quant.trim(),
      mm_images: d.mm_images,
      mm_videos: d.mm_videos,
      notes: d.notes.trim() === '' ? null : d.notes.trim(),
    };
    const profiles = target.isNew
      ? [...cluster.profiles, next]
      : cluster.profiles.map((p) => (p.id === next.id ? next : p));
    onCommit(profiles, target.isNew ? `Profile '${next.key}' created` : `Profile '${next.key}' saved`);
  };

  if (target === null) return null;

  return (
    <Drawer
      open={true}
      onClose={onClose}
      title={target.isNew ? 'Add profile' : `Edit profile — ${target.original?.key ?? ''}`}
      sub={`${cluster.name} · profiles ride the cluster PATCH body (whole array)`}
      busy={busy}
      width="min(680px, 94vw)"
      actions={
        <>
          {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
          <Btn variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Btn>
          <Btn variant="primary" disabled={!valid} onClick={commit} loading={busy}>
            {target.isNew ? 'Create profile' : 'Save profile'}
          </Btn>
        </>
      }
    >
      {d === null ? null : (
        <div className="flex flex-col gap-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input
              label="Key"
              value={d.key}
              invalid={!keyOk || clashes}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ key: e.currentTarget.value })}
              hint="lowercase slug — becomes rank-<n>-<key>.env"
            />
            <Input
              label="Label"
              value={d.label}
              autoComplete="off"
              onChange={(e) => patch({ label: e.currentTarget.value })}
              hint="shown in switchers — make it human"
            />
            <Input
              label="Served model name"
              className="col-span-full"
              value={d.served_model_name}
              invalid={!modelOk}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ served_model_name: e.currentTarget.value })}
              hint="what vLLM registers (/v1/models)"
            />
            <Input
              label="Model dir hint"
              value={d.model_dir_hint}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => patch({ model_dir_hint: e.currentTarget.value })}
              placeholder="optional"
            />
            <NumField
              label="KV pin"
              value={d.kv_pin_gib}
              unit="GiB"
              min={0}
              max={1000}
              onChange={(v) => patch({ kv_pin_gib: v })}
              hint="kv_budget watermark for the boot env"
            />
            <NumField
              label="Context"
              value={d.context}
              unit="tokens"
              integer
              min={1}
              max={10**9}
              onChange={(v) => patch({ context: v })}
            />
            <Select
              label="Speculator"
              value={d.speculator}
              onChange={(e) => patch({ speculator: e.currentTarget.value })}
            >
              <option value="">— none —</option>
              <option value="mtp3-adaptive">mtp3-adaptive</option>
              <option value="dflash2">dflash2</option>
            </Select>
            <Select label="Quant" value={d.quant} onChange={(e) => patch({ quant: e.currentTarget.value })}>
              <option value="">— none —</option>
              <option value="spark">spark</option>
              <option value="nvfp4">nvfp4</option>
            </Select>
            <NumField
              label="Multimodal images"
              value={d.mm_images}
              integer
              min={0}
              onChange={(v) => patch({ mm_images: v })}
            />
            <NumField
              label="Multimodal videos"
              value={d.mm_videos}
              integer
              min={0}
              onChange={(v) => patch({ mm_videos: v })}
            />
          </div>
          <Input
            label="Notes"
            value={d.notes}
            onChange={(e) => patch({ notes: e.currentTarget.value })}
            hint="freeform — kept out of the boot env"
          />
          {clashes && <FieldMsg tone="error">profile key already exists on this cluster</FieldMsg>}
        </div>
      )}
    </Drawer>
  );
}
