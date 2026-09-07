/* Settings ▸ Clusters — NodeEditDrawer: node config + ordered address editor
   (kind/host/label, reorder, per-address test via the node report) +
   collector deploy. */

import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Play,
  Plus,
  Rocket,
  Trash2,
} from 'lucide-react';
import type { AddressKind, ClusterTopology, NodeConfig, NodeRole } from '../../../api/types';
import {
  deployCollector,
  patchNode,
  testNode,
  type NodeTestReport,
} from '../../../api/admin';
import { Btn, Chip, Input, Select, Tip, toast } from '../../../ds';
import { cn } from '../../../lib/cn';
import { DataTable, Drawer, FieldMsg, OpDrawer, Td, errCopy } from '../../../lib/pagekit';
import { Spinner } from '../../../ds';

interface AddressDraft {
  kind: AddressKind;
  host: string;
  label: string;
}

interface NodeDraft {
  name: string;
  role: NodeRole;
  ssh_user: string;
  ssh_port: number | null;
  ssh_alias: string;
  env_rank: number | null;
  api_port: number | null;
  interest_ifaces: string;
  enabled: boolean;
  addresses: AddressDraft[];
}

function draftFrom(node: NodeConfig): NodeDraft {
  return {
    name: node.name,
    role: node.role,
    ssh_user: node.ssh_user,
    ssh_port: node.ssh_port,
    ssh_alias: node.ssh_alias ?? '',
    env_rank: node.env_rank,
    api_port: node.api_port,
    interest_ifaces: node.interest_ifaces.join(','),
    enabled: node.enabled,
    addresses: node.addresses.map((a) => ({ kind: a.kind, host: a.host, label: a.label ?? '' })),
  };
}

const EMPTY_ADDR: AddressDraft = { kind: 'lan', host: '', label: '' };

export function NodeEditDrawer({
  cluster,
  node,
  open,
  onClose,
  onSaved,
}: {
  cluster: ClusterTopology;
  node: NodeConfig | null;
  open: boolean;
  onClose: () => void;
  onSaved: (node: NodeConfig) => void;
}) {
  const [draft, setDraft] = useState<NodeDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [test, setTest] = useState<NodeTestReport | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testFocus, setTestFocus] = useState<string | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const [opId, setOpId] = useState<string | null>(null);

  useEffect(() => {
    if (open && node !== null) {
      setDraft(draftFrom(node));
      setTest(null);
      setTestError(null);
      setTestFocus(null);
      setError(null);
    }
  }, [open, node]);

  if (node === null) return null;

  const portOk = (v: number | null): boolean => v !== null && Number.isFinite(v) && Number.isInteger(v) && v >= 1 && v <= 65535;
  const rankOk = (v: number | null): boolean => v !== null && Number.isInteger(v) && v >= 0 && v <= 3;
  const addressesOk: boolean =
    draft !== null &&
    draft.addresses.length > 0 &&
    draft.addresses.every((a) => a.host.trim().length > 0);

  const patch = (p: Partial<NodeDraft>): void => setDraft((d) => (d === null ? d : { ...d, ...p }));

  const moveAddr = (i: number, dir: -1 | 1): void => {
    setDraft((d) => {
      if (d === null) return d;
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.addresses.length) return d;
      const list = [...d.addresses];
      const tmp = list[i];
      if (tmp === undefined) return d;
      const other = list[j];
      if (other === undefined) return d;
      list[i] = other;
      list[j] = tmp;
      return { ...d, addresses: list };
    });
  };

  const runTest = (focusHost: string | null): void => {
    if (node === null) return;
    setTestBusy(true);
    setTestError(null);
    setTestFocus(focusHost);
    testNode(node.id)
      .then((r) => {
        setTest(r);
        if (r.ok === false) toast.warn('Node test finished — not reachable', r.message ?? 'see the attempt rows');
        else toast.ok('Node test finished');
      })
      .catch((err) => {
        setTestError(err);
        toast.error('Node test failed', errCopy(err));
      })
      .finally(() => setTestBusy(false));
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    setError(null);
    try {
      const addresses = draft.addresses
        .filter((a) => a.host.trim() !== '')
        .map((a) => ({ kind: a.kind, host: a.host.trim(), label: a.label.trim() === '' ? undefined : a.label.trim() }));
      const body = {
        name: draft.name.trim(),
        role: draft.role,
        ssh_user: draft.ssh_user.trim() || 'root',
        ssh_port: draft.ssh_port ?? 22,
        ssh_alias: draft.ssh_alias.trim() === '' ? null : draft.ssh_alias.trim(),
        env_rank: draft.env_rank ?? 0,
        api_port: draft.api_port ?? 8000,
        interest_ifaces: draft.interest_ifaces
          .split(',')
          .map((x) => x.trim())
          .filter((x) => x !== ''),
        enabled: draft.enabled,
        addresses,
      };
      await patchNode(node.id, body);
      const saved: NodeConfig = {
        ...node,
        name: body.name,
        role: body.role,
        ssh_user: body.ssh_user,
        ssh_port: body.ssh_port,
        ssh_alias: body.ssh_alias,
        env_rank: body.env_rank,
        api_port: body.api_port,
        interest_ifaces: body.interest_ifaces,
        enabled: body.enabled,
        addresses: body.addresses,
      };
      onSaved(saved);
      toast.ok(`Node ${saved.name} saved`);
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return draft === null ? null : (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Edit node — ${node.name}`}
      sub={`${cluster.name} · ${node.id}`}
      width="min(760px, 94vw)"
      actions={
        <>
          {error !== null && <FieldMsg tone="error">{errCopy(error)}</FieldMsg>}
          <Btn variant="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            loading={saving}
            disabled={
              draft.name.trim().length === 0 ||
              !portOk(draft.ssh_port) ||
              !portOk(draft.api_port) ||
              !rankOk(draft.env_rank) ||
              !addressesOk
            }
            onClick={() => void save()}
          >
            Save node
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
          <Input
            label="Name"
            value={draft.name}
            onChange={(e) => patch({ name: e.currentTarget.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <Select label="Role" value={draft.role} onChange={(e) => patch({ role: e.currentTarget.value as NodeRole })}>
            <option value="head">head</option>
            <option value="worker">worker</option>
          </Select>
          <Input
            label="SSH user"
            value={draft.ssh_user}
            onChange={(e) => patch({ ssh_user: e.currentTarget.value })}
            autoComplete="off"
            spellCheck={false}
          />
          <Input
            label="SSH port"
            value={draft.ssh_port === null ? '' : String(draft.ssh_port)}
            inputMode="numeric"
            invalid={draft.ssh_port !== null && !portOk(draft.ssh_port)}
            onChange={(e) => patch({ ssh_port: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
            hint="1–65535"
          />
          <Input
            label="SSH alias (~/.ssh/config)"
            value={draft.ssh_alias}
            onChange={(e) => patch({ ssh_alias: e.currentTarget.value })}
            placeholder="—"
            hint="optional; alias overrides the host list"
          />
          <Input
            label="Env rank"
            value={draft.env_rank === null ? '' : String(draft.env_rank)}
            inputMode="numeric"
            invalid={draft.env_rank !== null && !rankOk(draft.env_rank)}
            onChange={(e) => patch({ env_rank: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
            hint="rank-<N>-<profile>.env (0..3)"
          />
          <Input
            label="API port"
            value={draft.api_port === null ? '' : String(draft.api_port)}
            inputMode="numeric"
            invalid={draft.api_port !== null && !portOk(draft.api_port)}
            onChange={(e) => patch({ api_port: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })}
            hint="health checks run node-local"
          />
          <Input
            label="Interest ifaces"
            value={draft.interest_ifaces}
            placeholder="auto-detect"
            onChange={(e) => patch({ interest_ifaces: e.currentTarget.value })}
            hint="CSV — empty = auto"
            className="col-span-2"
          />
        </div>

        <div className="sd-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="sd-monolabel">addresses — ordered failover</div>
            <Chip variant="neutral" title="the pool probes the alias then up to four hosts, in order">
              probed in order
            </Chip>
          </div>
          <div className="flex flex-col gap-1.5">
            {draft.addresses.map((a, i) => (
              <div key={i} className="flex items-end gap-1.5">
                <Select
                  aria-label={`address ${i} kind`}
                  className="w-[110px] shrink-0"
                  value={a.kind}
                  onChange={(e) => {
                    const kind = e.currentTarget.value as AddressKind;
                    setDraft((d) =>
                      d === null
                        ? d
                        : { ...d, addresses: d.addresses.map((x, j) => (j === i ? { ...x, kind } : x)) },
                    );
                  }}
                >
                  <option value="lan">lan</option>
                  <option value="fabric">fabric</option>
                  <option value="tailscale">tailscale</option>
                  <option value="custom">custom</option>
                </Select>
                <Input
                  aria-label={`address ${i} host`}
                  value={a.host}
                  placeholder="host or MagicDNS name"
                  invalid={a.host.trim() === ''}
                  onChange={(e) => {
                    const host = e.currentTarget.value;
                    setDraft((d) =>
                      d === null
                        ? d
                        : { ...d, addresses: d.addresses.map((x, j) => (j === i ? { ...x, host } : x)) },
                    );
                  }}
                  className="min-w-0 flex-1"
                />
                <Input
                  aria-label={`address ${i} label`}
                  value={a.label}
                  placeholder="label"
                  onChange={(e) => {
                    const label = e.currentTarget.value;
                    setDraft((d) =>
                      d === null
                        ? d
                        : { ...d, addresses: d.addresses.map((x, j) => (j === i ? { ...x, label } : x)) },
                    );
                  }}
                  className="w-28 shrink-0"
                />
                <div className="flex shrink-0 gap-1">
                  <Tip text={i === 0 ? 'already first' : 'move up'}>
                    <Btn size="sm" variant="ghost" disabled={i === 0} onClick={() => moveAddr(i, -1)} aria-label="move address up">
                      <ArrowUp size={13} />
                    </Btn>
                  </Tip>
                  <Tip text={i === draft.addresses.length - 1 ? 'already last' : 'move down'}>
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={i === draft.addresses.length - 1}
                      onClick={() => moveAddr(i, 1)}
                      aria-label="move address down"
                    >
                      <ArrowDown size={13} />
                    </Btn>
                  </Tip>
                  <Tip text="probe reachability (reports every address + collector state + versions)">
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={testBusy}
                      onClick={() => runTest(a.host)}
                      aria-label={`test address ${a.host || i + 1}`}
                      className={cn(testFocus === a.host && a.host !== '' && 'border-accent/60 text-accent')}
                    >
                      {testBusy ? <Spinner size={11} /> : <Play size={13} />}
                    </Btn>
                  </Tip>
                  <Tip text="remove address">
                    <Btn
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        setDraft((d) => (d === null ? d : { ...d, addresses: d.addresses.filter((_, j) => j !== i) }))
                      }
                      aria-label="remove address"
                      className="text-crit"
                    >
                      <Trash2 size={13} />
                    </Btn>
                  </Tip>
                </div>
              </div>
            ))}
            <Btn
              size="sm"
              variant="ghost"
              icon={<Plus size={13} />}
              onClick={() => setDraft((d) => (d === null ? d : { ...d, addresses: [...d.addresses, { ...EMPTY_ADDR }] }))}
            >
              Add address
            </Btn>
            {draft.addresses.length > 4 && (
              <FieldMsg tone="hint">more than 4 entries — the SSH pool records the last 4 attempts only</FieldMsg>
            )}
          </div>
        </div>

        {/* node test report */}
        <div className="sd-panel p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="sd-monolabel">node test</div>
            <Btn size="sm" variant="ghost" loading={testBusy} onClick={() => runTest(null)} icon={<Play size={12} />}>
              Run test
            </Btn>
          </div>
          {testError !== null && <FieldMsg tone="error">{errCopy(testError)}</FieldMsg>}
          {test === null ? (
            <FieldMsg tone="hint">
              runs POST /api/nodes/{'{id}'}/test — reachability attempts per address, collector state + python/docker/nvidia probes.
            </FieldMsg>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip variant={test.ok === true ? 'ok' : test.ok === false ? 'crit' : 'neutral'}>
                  {test.ok === null ? 'unknown' : test.ok ? 'reachable' : 'unreachable'}
                </Chip>
                {test.used_addr !== null && <Chip variant="neutral">via {test.used_addr}</Chip>}
                <Chip
                  variant={
                    test.collector === 'healthy' ? 'ok' : test.collector === 'stale' ? 'warn' : test.collector === 'down' ? 'crit' : 'neutral'
                  }
                >
                  collector: {test.collector}
                </Chip>
                {test.unverified && <Chip variant="warn">unverified</Chip>}
                <Chip variant="neutral">python: {test.python ?? '—'}</Chip>
                <Chip variant={test.docker === 'ok' ? 'ok' : test.docker === null ? 'neutral' : 'crit'}>
                  docker: {test.docker ?? '—'}
                </Chip>
                <Chip variant={test.nvidia === 'ok' ? 'ok' : test.nvidia === null ? 'neutral' : 'crit'}>
                  nvidia: {test.nvidia ?? '—'}
                </Chip>
              </div>
              <DataTable columns={[{ key: 'addr', label: 'address' }, { key: 'result', label: 'result', align: 'right' }]} minWidth={420}>
                {test.attempts.map((a, i) => (
                  <tr
                    key={i}
                    className={cn(testFocus === a.addr && a.addr !== '' && 'bg-accent/5')}
                  >
                    <Td num className="font-mono">
                      {a.addr}
                    </Td>
                    <Td align="right">
                      {a.ok === true ? (
                        <Chip variant="ok">ok</Chip>
                      ) : a.error !== null ? (
                        <span className="font-mono text-2xs text-crit">{a.error}</span>
                      ) : (
                        <Chip variant="neutral">failed</Chip>
                      )}
                    </Td>
                  </tr>
                ))}
                <tr>
                  <Td colSpan={2} className="!py-0.5 text-left text-2xs text-low">
                    {test.attempts.length} attempt{test.attempts.length === 1 ? '' : 's'} reported —
                    addresses probe in failover order (alias first when set)
                  </Td>
                </tr>
              </DataTable>
            </div>
          )}
        </div>

        {/* collector deploy */}
        <div className="sd-panel flex flex-wrap items-center justify-between gap-2 p-3">
          <div className="min-w-0">
            <div className="sd-monolabel">collector</div>
            <div className="text-xs text-low">
              pushes collector.py over SSH; op streams in the ops feed. Run again to refresh.
            </div>
          </div>
          <Btn
            size="sm"
            variant="primary"
            icon={<Rocket size={13} />}
            onClick={() => {
              deployCollector(node.id)
                .then((ref) => {
                  if (ref.op_id !== null) {
                    setOpId(ref.op_id);
                    toast.ok('Collector deploy queued', `op ${ref.op_id}`);
                  } else {
                    toast.warn('Collector deploy accepted without an op id');
                  }
                })
                .catch((err) => toast.error('Collector deploy failed', errCopy(err)));
            }}
          >
            Deploy / refresh collector
          </Btn>
        </div>
      </div>

      <OpDrawer opId={opId} onClose={() => setOpId(null)} />
    </Drawer>
  );
}

