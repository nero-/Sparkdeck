/* Settings ▸ Data — export/import.

   Export: GET /api/settings/export → `{topology, settings}` blob download.
   Import: POST /api/settings/import exists in the backend (routes.py) but is
   NOT in docs/API.md — so when it answers as missing we fall back to a
   client-side dispatcher that enumerates the documented PATCH endpoints:
   PATCH /api/settings (per section) + PATCH /api/clusters/{id} (+ profiles
   verification) + PATCH /api/nodes/{id}. Nothing is ever deleted by import.
*/

import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import type { AppSettings, ClusterTopology } from '../../../api/types';
import {
  benchDefaultsOf,
  createCluster,
  downloadSettingsExport,
  fetchSettingsExport,
  importTopology,
  isMissingRoute,
  patchCluster,
  patchNode,
  patchSettings,
  saveProfiles,
} from '../../../api/admin';
import { Btn, Chip, toast } from '../../../ds';
import { DataTable, FieldMsg, Td, errCopy, offerAuthGate } from '../../../lib/pagekit';
import { SectionWrap } from '../SectionWrap';
import type { SettingsGate } from '../useSettingsState';

interface ImportPreview {
  fileName: string;
  topology: ClusterTopology[];
  settings: AppSettings | null;
  nodes: number;
  profiles: number;
}

interface ImportRun {
  target: string;
  action: string;
  status: 'ok' | 'skipped' | 'error';
  detail: string;
}

export function DataSection({ gate }: { gate: SettingsGate }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [exportInfo, setExportInfo] = useState<{ clusters: number; nodes: number; profiles: number; hasSettings: boolean } | null>(null);
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState<'' | 'downloading' | 'applying'>('');
  const [runs, setRuns] = useState<ImportRun[] | null>(null);

  const doExport = (): void => {
    setBusy('downloading');
    fetchSettingsExport()
      .then(async (parsed) => {
        const blob = await downloadSettingsExport(); // GET /api/settings/export (bearer-auth fetch)
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:T]/g, '').slice(0, 15);
        a.href = URL.createObjectURL(blob);
        a.download = `sparkdeck-export-${stamp}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        const nodes = parsed.topology.reduce((n, c) => n + c.nodes.length, 0);
        const profiles = parsed.topology.reduce((n, c) => n + c.profiles.length, 0);
        setExportInfo({ clusters: parsed.topology.length, nodes, profiles, hasSettings: parsed.settings !== null });
        toast.ok('Export downloaded', `${parsed.topology.length} clusters · ${nodes} nodes · ${profiles} profiles`);
      })
      .catch((err) => {
        offerAuthGate(err);
        toast.error('Export failed', errCopy(err));
      })
      .finally(() => setBusy(''));
  };

  const onFile = (f: File | undefined): void => {
    if (f === undefined) return;
    void f
      .text()
      .then((txt) => {
        const parsed = parseImportPayload(JSON.parse(txt));
        const nodes = parsed.topology.reduce((n, c) => n + c.nodes.length, 0);
        const profiles = parsed.topology.reduce((n, c) => n + c.profiles.length, 0);
        setImportPreview({
          fileName: f.name,
          topology: parsed.topology,
          settings: parsed.settings,
          nodes,
          profiles,
        });
        setRuns(null);
      })
      .catch((err) => {
        toast.error('Import file unreadable', err instanceof Error ? err.message : String(err));
      });
  };

  const applyImport = async (): Promise<ImportRun[]> => {
    const preview = importPreview;
    if (preview === null) return [];
    const out: ImportRun[] = [];

    /* Preferred path: the bulk upsert endpoint (backend implements it; docs
       gap). Upserts by id, never deletes. */
    const bulk = await importTopology(preview.topology).catch((err) => {
      if (!isMissingRoute(err)) throw err;
      return null;
    });

    if (bulk !== null) {
      if (bulk.ok) {
        out.push({ target: '(bulk)', action: 'POST /api/settings/import', status: 'ok', detail: `upserted ${bulk.clusters ?? preview.topology.length} clusters + nodes + profiles` });
      } else {
        out.push({ target: '(bulk)', action: 'POST /api/settings/import', status: 'error', detail: 'endpoint answered but did not confirm success' });
      }
    } else {
      /* Fallback: enumerate the documented PATCH endpoints cluster-by-cluster. */
      for (const cl of preview.topology) {
        try {
          await patchCluster(cl.id, {
            name: cl.name,
            accent_color: cl.accent_color,
            notes: cl.notes ?? null,
            control: cl.control,
          });
          out.push({ target: cl.name, action: 'PATCH /api/clusters/' + cl.id, status: 'ok', detail: 'name/accent/notes/control' });
        } catch (err) {
          if (isMissingRoute(err)) {
            try {
              await createCluster({ name: cl.name, accent_color: cl.accent_color, notes: cl.notes ?? null, control: cl.control });
              out.push({ target: cl.name, action: 'POST /api/clusters', status: 'ok', detail: 'cluster unknown here — created (new server-minted id; nodes below may be skipped)' });
            } catch (err2) {
              out.push({ target: cl.name, action: 'POST /api/clusters', status: 'error', detail: errCopy(err2) });
              offerAuthGate(err2);
              continue;
            }
          } else {
            out.push({ target: cl.name, action: 'PATCH /api/clusters/' + cl.id, status: 'error', detail: errCopy(err) });
            offerAuthGate(err);
            continue;
          }
        }

        /* profiles ride the cluster body; the backend drops them from PATCH →
           saveProfiles verifies and uses the import upsert when available. In
           dispatch mode the import endpoint is missing, so profile upserts
           genuinely cannot be expressed with documented verbs. */
        const prof = await saveProfiles(cl, cl.profiles).catch((err) => {
          offerAuthGate(err);
          return null;
        });
        if (prof === null) {
          out.push({ target: cl.name, action: 'profiles', status: 'error', detail: errCopy(new Error('profile PATCH failed')) });
        } else if (prof.applied) {
          out.push({ target: cl.name, action: 'profiles[]', status: 'ok', detail: `via ${prof.via}` });
        } else {
          out.push({ target: cl.name, action: 'profiles[]', status: 'skipped', detail: 'no profile write path on this backend (cluster PATCH drops profiles; import endpoint missing)' });
        }

        for (const node of cl.nodes) {
          try {
            await patchNode(node.id, {
              name: node.name,
              role: node.role,
              ssh_user: node.ssh_user,
              ssh_port: node.ssh_port,
              ssh_alias: node.ssh_alias,
              env_rank: node.env_rank,
              api_port: node.api_port,
              interest_ifaces: node.interest_ifaces,
              enabled: node.enabled,
              addresses: node.addresses,
            });
            out.push({ target: node.name, action: 'PATCH /api/nodes/' + node.id, status: 'ok', detail: 'config' });
          } catch (err) {
            offerAuthGate(err);
            out.push({
              target: node.name,
              action: 'PATCH /api/nodes/' + node.id,
              status: isMissingRoute(err) ? 'skipped' : 'error',
              detail: isMissingRoute(err) ? 'node unknown to this controller and no create-node endpoint exists' : errCopy(err),
            });
          }
        }
      }
    }

    /* app settings slice — partial-capable per section; send complete
       sub-objects so merge semantics can't leave stale keys. */
    if (preview.settings !== null) {
      try {
        await patchSettings(settingsPatchFrom(preview.settings));
        out.push({ target: '(app)', action: 'PATCH /api/settings', status: 'ok', detail: 'alerts/appearance/bench/images/security + sampling + retention' });
      } catch (err) {
        offerAuthGate(err);
        out.push({ target: '(app)', action: 'PATCH /api/settings', status: 'error', detail: errCopy(err) });
      }
    }

    const okCount = out.filter((r) => r.status === 'ok').length;
    if (okCount > 0) {
      toast.ok(`Import applied — ${okCount}/${out.length} items`, 'topology + settings; nothing deleted');
      gate.reload();
    } else {
      toast.warn('Import completed with nothing applied — see the run list');
    }
    return out;
  };

  return (
    <SectionWrap
      id="data"
      title="Data"
      sub="export the full config (topology + settings) or restore from a file"
    >
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="sd-panel flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <Download size={14} style={{ color: 'var(--sd-accent)' }} />
            <span className="text-sm font-medium text-hi">Export</span>
          </div>
          <p className="text-xs text-low">
            GET /api/settings/export → a single JSON blob: <code className="font-mono">{'{ topology, settings }'}</code>.
            Keeps accents, addresses, profiles, control paths, bench + alert thresholds.
          </p>
          {exportInfo !== null && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip variant="neutral">{exportInfo.clusters} clusters</Chip>
              <Chip variant="neutral">{exportInfo.nodes} nodes</Chip>
              <Chip variant="neutral">{exportInfo.profiles} profiles</Chip>
              <Chip variant={exportInfo.hasSettings ? 'ok' : 'warn'}>settings {exportInfo.hasSettings ? 'included' : 'missing'}</Chip>
            </div>
          )}
          <div>
            <Btn variant="primary" size="sm" loading={busy === 'downloading'} onClick={doExport} icon={<Download size={12} />}>
              Download export
            </Btn>
          </div>
        </div>

        <div className="sd-panel flex flex-col gap-2 p-4">
          <div className="flex items-center gap-2">
            <Upload size={14} style={{ color: 'var(--sd-accent)' }} />
            <span className="text-sm font-medium text-hi">Import</span>
          </div>
          <p className="text-xs text-low">
            Restores by id — upserts, never deletes. Prefers the bulk endpoint; falls back to enumerating
            PATCH /api/settings + clusters + nodes item-by-item (with explicit skips where the contract has no write
            path).
          </p>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          <Btn variant="ghost" size="sm" icon={<Upload size={12} />} onClick={() => fileRef.current?.click()}>
            Choose file…
          </Btn>
          {importPreview !== null && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip variant="neutral">{importPreview.fileName}</Chip>
              <Chip variant="neutral">{importPreview.topology.length} clusters</Chip>
              <Chip variant="neutral">{importPreview.nodes} nodes</Chip>
              <Chip variant="neutral">{importPreview.profiles} profiles</Chip>
              <Chip variant={importPreview.settings !== null ? 'ok' : 'warn'}>
                settings {importPreview.settings !== null ? 'included' : 'not in file'}
              </Chip>
              <Btn size="sm" variant="primary" loading={busy === 'applying'} onClick={() => { setBusy('applying'); applyImport().then((rs) => { setRuns(rs); setBusy(''); }).catch(() => setBusy('')); setImportPreview(null); }}>
                Apply import
              </Btn>
            </div>
          )}
        </div>
      </div>

      {runs !== null && (
        <div className="sd-panel p-3">
          <div className="sd-monolabel mb-2">import run — last {Math.min(runs.length, 40)} of {runs.length}</div>
          <DataTable
            columns={[
              { key: 't', label: 'target' },
              { key: 'a', label: 'action' },
              { key: 's', label: 'status', align: 'right' },
              { key: 'd', label: 'detail' },
            ]}
            minWidth={640}
            empty="—"
          >
            {runs.slice(-40).map((r, i) => (
              <tr key={i}>
                <Td className="font-mono text-2xs text-hi">{r.target}</Td>
                <Td className="font-mono text-2xs text-mid">{r.action}</Td>
                <Td align="right">
                  <Chip variant={r.status === 'ok' ? 'ok' : r.status === 'skipped' ? 'warn' : 'crit'}>{r.status}</Chip>
                </Td>
                <Td className="text-2xs text-low">{r.detail}</Td>
              </tr>
            ))}
          </DataTable>
        </div>
      )}

      <div className="sd-panel p-3 text-xs text-low">
        <FieldMsg tone="hint">
          Gaps baked into this flow: there is no documented profile-upsert verb (the backend's cluster PATCH silently
          drops <code className="font-mono">profiles</code>), and no create-node verb — the fallback dispatcher already
          flags those items as <span className="font-mono">skipped</span> instead of inventing endpoints. The bulk
          route (POST /api/settings/import) exists in the backend source but is missing from docs/API.md.
        </FieldMsg>
      </div>
    </SectionWrap>
  );
}

/* -------- local helpers ---------------------------------------------------- */

function parseImportPayload(json: unknown): { topology: ClusterTopology[]; settings: AppSettings | null } {
  const raw = json as { topology?: unknown; clusters?: unknown; settings?: unknown } | null;
  const rawTopo = raw?.topology ?? raw?.clusters;
  const topology: ClusterTopology[] = Array.isArray(rawTopo)
    ? rawTopo.filter((c): c is ClusterTopology => typeof (c as ClusterTopology) === 'object' && c !== null && typeof (c as ClusterTopology).id === 'string')
    : [];
  const settings =
    raw !== null &&
    typeof raw === 'object' &&
    raw.settings !== null &&
    typeof raw.settings === 'object' &&
    typeof (raw.settings as AppSettings).sampling_interval_s === 'number'
      ? (raw.settings as AppSettings)
      : null;
  return { topology, settings };
}

/** Whole-section patch from an export payload (no stale partial keys). */
function settingsPatchFrom(s: AppSettings): Parameters<typeof patchSettings>[0] {
  return {
    sampling_interval_s: s.sampling_interval_s,
    retention: { ...s.retention },
    alerts: { ...s.alerts },
    appearance: { ...s.appearance },
    bench: (() => {
      // defaults ride the backend's nested {label, args} shape (pinned type is
      // flat `BenchArgs & {label?}`) — normalize so both layouts work.
      const d = benchDefaultsOf(s.bench.defaults);
      return {
        bench_repo_dir: s.bench.bench_repo_dir,
        venv_python: s.bench.venv_python,
        write_repo_runs: s.bench.write_repo_runs,
        ...(d !== null
          ? { defaults: { label: d.label, args: { ...d.args } } }
          : { defaults: undefined }),
      };
    })(),
    images: { ...s.images },
    security: { bind_host: s.security.bind_host, port: s.security.port },
  };
}
