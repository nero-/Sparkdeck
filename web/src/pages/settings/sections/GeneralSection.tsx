/* Settings ▸ General — appearance (client store, server-mirrored), sampling
   interval, retention. Sampling/retention only apply on the next collector
   connect; a server restart re-uses the db, so values survive. */

import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../api/types';
import { Chip, FieldLabel, Select, Toggle, toast, useToasts } from '../../../ds';
import { DirtySave, FieldMsg, NumField } from '../../../lib/pagekit';
import { useUi, type Density, type ThemeChoice } from '../../../stores/ui';
import type { SettingsPatch, SettingsGate } from '../useSettingsState';

export function GeneralSection({ gate }: { gate: SettingsGate }) {
  const s = gate.data;

  /* server-mirrored copy of the ui store (dirty tracking against the store) */
  const uiTheme = useUi((st) => st.theme);
  const uiDensity = useUi((st) => st.density);
  const setTheme = useUi((st) => st.setTheme);
  const setDensity = useUi((st) => st.setDensity);

  const [srvTheme, setSrvTheme] = useState<ThemeChoice>('dark');
  const [srvDensity, setSrvDensity] = useState<Density>('comfortable');
  const [interval, setIntervalS] = useState<number | null>(null);
  const [retention, setRetention] = useState({ raw_hours: 12, minute_days: 14, decaminute_days: 60 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (s === null) return;
    setSrvTheme(s.appearance.theme);
    setSrvDensity(s.appearance.density);
    setIntervalS(s.sampling_interval_s);
    setRetention({ ...s.retention });
  }, [s]);

  const duoDirty = srvTheme !== uiTheme || srvDensity !== uiDensity;
  const retentionDirty =
    interval !== (s?.sampling_interval_s ?? null) ||
    retention.raw_hours !== (s?.retention.raw_hours ?? -1) ||
    retention.minute_days !== (s?.retention.minute_days ?? -1) ||
    retention.decaminue !== (s?.retention.decaminue ?? -1);
  void retentionDirty;

  const poll = 1 <= (interval ?? 0) && (interval ?? 0) <= 10;

  const applyUiNow = (): void => {
    setTheme(srvTheme);
    setDensity(srvDensity);
    toast.info('Appearance applied locally — mirrored to the controller on save.');
  };

  const saveAll = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const patch: SettingsPatch = {
      appearance: { theme: srvTheme, density: srvDensity },
      sampling_interval_s: interval ?? 2,
      retention: {
        raw_hours: retention.raw_hours,
        minute_days: retention.minute_days,
        decaminute_days: retention.decaminue,
      },
    };
    try {
      await gate.save(patch);
      setTheme(srvTheme);
      setDensity(srvDensity);
      toast.ok('General settings saved');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PanelShell>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-3">
          <FieldLabel>Appearance</FieldLabel>
          <Select
            label="Theme"
            value={srvTheme}
            onChange={(e) => setSrvTheme(e.currentTarget.value as ThemeChoice)}
          >
            <option value="dark">dark</option>
            <option value="light">light</option>
            <option value="system">system</option>
          </Select>
          <Select
            label="Density"
            value={srvDensity}
            onChange={(e) => setSrvDensity(e.currentTarget.value as Density)}
          >
            <option value="comfortable">comfortable</option>
            <option value="compact">compact</option>
          </Select>
          {duoDirty && (
            <FieldMsg tone="hint">
              local appearance differs — “apply locally” swaps tokens now; “save” mirrors to the controller.
            </FieldMsg>
          )}
          <div className="flex gap-2">
            {duoDirty && (
              <Chip variant="accent" title="writes localStorage 'sparkdeck.ui' instantly">
                <button
                  type="button"
                  className="cursor-pointer underline decoration-dotted"
                  onClick={applyUiNow}
                >
                  apply locally
                </button>
              </Chip>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <FieldLabel>Sampler & retention</FieldLabel>
          <NumField
            label="Sampling interval"
            unit="seconds · 1–10"
            value={interval}
            min={1}
            max={10}
            onChange={setIntervalS}
            required
            hint="collector tick; tighter = denser raw ring, shorter history"
          />
          <div className="grid grid-cols-3 gap-2">
            <NumField
              label="Raw keep"
              unit="hours"
              integer
              min={1}
              max={48}
              value={retention.raw_hours}
              onChange={(v) => setRetention((r) => ({ ...r, raw_hours: v ?? 0 }))}
              required
            />
            <NumField
              label="1m rollups"
              unit="days"
              integer
              min={1}
              max={90}
              value={retention.minute_days}
              onChange={(v) => setRetention((r) => ({ ...r, minute_days: v ?? 0 }))}
              required
            />
            <NumField
              label="10m rollups"
              unit="days"
              integer
              min={1}
              max={365}
              value={retention.decaminue}
              onChange={(v) => setRetention((r) => ({ ...r, decaminue: v ?? 0 }))}
              required
            />
          </div>
          <Chip variant="warn">
            applies on next connect — a server restart re-uses the db, values survive
          </Chip>
          <Toggle
            checked={useToasts.getState().items.length > 0}
            label={<span className="text-2xs text-low">toast preview of retention changes is not needed</span>}
            disabled
          />
        </div>
      </div>

      <DirtySave
        dirty={duoDirty || (s !== null && (interval !== s.sampling_interval_s || JSON.stringify(retention) !== JSON.stringify(s.retention)))}
        valid={poll && retention.raw_hours > 0 && retention.minute_days > 0 && retention.decaminue > 0}
        saving={saving}
        error={error}
        onSave={() => void saveAll()}
        onReset={() => {
          if (s !== null) {
            setSrvTheme(s.appearance.theme);
            setSrvDensity(s.appearance.density);
            setIntervalS(s.sampling_interval_s);
            setRetention({ ...s.retention });
          }
        }}
        saveLabel="Save general"
      />
    </PanelShell>
  );
}

export function PanelShell({ children }: { children: React.ReactNode }) {
  return <section className="sd-panel p-4">{children}</section>;
}

export type { AppSettings };
