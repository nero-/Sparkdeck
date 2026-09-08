/* Settings ▸ Alerts — mem envelope (GiB), GPU temp thresholds, container
   restarts/h, webhook url. Applied on save; the alert engine re-reads on the
   next sampler tick. */

import { useRef, useState } from 'react';
import type { AppSettings } from '../../../api/types';
import { Chip } from '../../../ds';
import { DirtySave, FieldMsg, NumField } from '../../../lib/pagekit';
import { SectionWrap } from '../SectionWrap';
import { useDraftGate, type SettingsGate } from '../useSettingsState';

type Alerts = AppSettings['alerts'];

export function AlertsSection({ gate }: { gate: SettingsGate }) {
  const [d, setD] = useState<Alerts>({
    mem_warn_gib: 121,
    mem_crit_gib: 121.4,
    gpu_temp_warn_c: 86,
    gpu_temp_crit_c: 94,
    container_restarts: 3,
    webhook_url: null,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const dirtyRef = useRef(false);
  useDraftGate(gate.data ? gate.data.alerts : null, dirtyRef, (alerts) => setD({ ...alerts }));

  const webhookDraft = d.webhook_url ?? '';
  const webhookOk = webhookDraft === '' || /^https?:\/\//.test(webhookDraft);
  const memOk = d.mem_warn_gib < d.mem_crit_gib;
  const tempOk = d.gpu_temp_warn_c < d.gpu_temp_crit_c;
  const restartsOk = Number.isInteger(d.container_restarts) && d.container_restarts >= 0;
  const valid = webhookOk && memOk && tempOk && restartsOk;

  const patch = (p: Partial<Alerts>): void => setD((cur) => ({ ...cur, ...p }));

  const dirty = gate.data !== null && JSON.stringify(fieldView(d)) !== JSON.stringify(fieldView(gate.data.alerts));
  dirtyRef.current = dirty;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      await gate.save({ alerts: { ...d, webhook_url: webhookDraft === '' ? null : webhookDraft.trim() } });
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionWrap
      id="alerts"
      title="Alerts"
      sub="mem envelope, gpu temps, container restarts, webhook"
      right={
        <Chip variant="neutral" title="the alert engine evaluates against sampled frames on every sampler tick">
          evaluated every tick
        </Chip>
      }
    >
      <div className="sd-panel grid gap-3 p-4 lg:grid-cols-3">
        <NumField
          label="Memory warn"
          value={d.mem_warn_gib}
          unit="GiB"
          min={0}
          max={128}
          onChange={(v) => v !== null && patch({ mem_warn_gib: v })}
          hint="120.5 GiB ≈ the envelope; keep warn below it"
          required
        />
        <NumField
          label="Memory crit"
          value={d.mem_crit_gib}
          unit="GiB"
          min={0}
          max={128}
          onChange={(v) => v !== null && patch({ mem_crit_gib: v })}
          required
        />
        <NumField
          label="Container restarts"
          value={d.container_restarts}
          integer
          min={0}
          max={100}
          onChange={(v) => v !== null && patch({ container_restarts: v })}
          hint="alerts at N restarts per hour"
          required
        />
        {!memOk && <FieldMsg tone="error">mem warn must stay below mem crit</FieldMsg>}
        <NumField
          label="GPU temp warn"
          value={d.gpu_temp_warn_c}
          unit="°C"
          min={20}
          max={120}
          onChange={(v) => v !== null && patch({ gpu_temp_warn_c: v })}
          required
        />
        <NumField
          label="GPU temp crit"
          value={d.gpu_temp_crit_c}
          unit="°C"
          min={30}
          max={130}
          onChange={(v) => v !== null && patch({ gpu_temp_crit_c: v })}
          required
        />
        {!tempOk && <FieldMsg tone="error">gpu temp warn must stay below crit</FieldMsg>}
        <label className="col-span-full flex min-w-0 flex-col gap-1">
          <span className="sd-monolabel">webhook url</span>
          <input
            className="sd-raised h-9 px-2.5 text-sm text-hi outline-none transition-colors duration-fast focus:border-accent/60"
            style={webhookOk ? undefined : { borderColor: 'var(--sd-crit)' }}
            value={webhookDraft}
            placeholder="https://hooks.example/…"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => patch({ webhook_url: e.currentTarget.value === '' ? null : e.currentTarget.value })}
          />
          <span className="text-2xs text-low">
            POST with a compact event payload on warn/crit — empty disables.
          </span>
          {!webhookOk && <FieldMsg tone="error">must start with http:// or https://</FieldMsg>}
        </label>
      </div>

      <DirtySave
        dirty={dirty}
        valid={valid}
        saving={saving}
        error={error}
        onSave={() => void save()}
        onReset={() => {
          if (gate.data !== null) setD({ ...gate.data.alerts });
          setError(null);
        }}
        saveLabel="Save alerts"
      />
    </SectionWrap>
  );
}

/** normalized view for dirty-checking (null webhook → same view) */
function fieldView(a: Alerts): Alerts {
  return { ...a, webhook_url: a.webhook_url === '' ? null : a.webhook_url };
}
