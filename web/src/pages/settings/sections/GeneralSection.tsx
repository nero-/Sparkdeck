/* Settings ▸ General — appearance (client store + server mirror), sampling
   interval, retention windows. Sampling/retention take effect on the next
   collector connect; a server restart re-uses the db so values survive. */

import { useRef, useState, type ReactNode } from 'react';
import { Chip, toast } from '../../../ds';
import { cn } from '../../../lib/cn';
import { DirtySave, FieldMsg, NumField } from '../../../lib/pagekit';
import { useUi, type Density, type ThemeChoice } from '../../../stores/ui';
import { useDraftGate, type SettingsPatch, type SettingsGate } from '../useSettingsState';
import { SectionWrap } from '../SectionWrap';

/** Local aliases; the wire fields live in AppSettings.retention. */
interface RetLocal {
  rawHours: number;
  oneMinDays: number;
  tenMinDays: number;
}

export function GeneralSection({ gate }: { gate: SettingsGate }) {
  const s = gate.data;

  const uiTheme = useUi((st) => st.theme);
  const uiDensity = useUi((st) => st.density);
  const setTheme = useUi((st) => st.setTheme);
  const setDensity = useUi((st) => st.setDensity);

  const [srvTheme, setSrvTheme] = useState<ThemeChoice>('dark');
  const [srvDensity, setSrvDensity] = useState<Density>('comfortable');
  const [intervalS, setIntervalS] = useState<number | null>(null);
  const [ret, setRet] = useState<RetLocal>({ rawHours: 12, oneMinDays: 14, tenMinDays: 60 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const dirtyRef = useRef(false);
  useDraftGate(
    s !== null
      ? { theme: s.appearance.theme, density: s.appearance.density, interval: s.sampling_interval_s, ret: s.retention }
      : null,
    dirtyRef,
    (fresh) => {
      setSrvTheme(fresh.theme);
      setSrvDensity(fresh.density);
      setIntervalS(fresh.interval);
      setRet({ rawHours: fresh.ret.raw_hours, oneMinDays: fresh.ret.minute_days, tenMinDays: fresh.ret.decaminute_days });
    },
  );

  const setRetentionKey = (k: keyof RetLocal) => (v: number | null) =>
    setRet((cur) => ({ ...cur, [k]: v ?? cur[k] }));


  const intervalOk = intervalS !== null && Number.isFinite(intervalS) && intervalS >= 1 && intervalS <= 10;
  const retentionValid =
    Number.isInteger(ret.rawHours) && ret.rawHours > 0 &&
    Number.isInteger(ret.oneMinDays) && ret.oneMinDays > 0 &&
    Number.isInteger(ret.tenMinDays) && ret.tenMinDays > 0;

  const dirty =
    s !== null &&
    (srvTheme !== s.appearance.theme ||
      srvDensity !== s.appearance.density ||
      intervalS !== s.sampling_interval_s ||
      ret.rawHours !== s.retention.raw_hours ||
      ret.oneMinDays !== s.retention.minute_days ||
      ret.tenMinDays !== s.retention.decaminute_days);

  dirtyRef.current = dirty;

  const reset = (): void => {
    setSrvTheme(s?.appearance.theme ?? 'dark');
    setSrvDensity(s?.appearance.density ?? 'comfortable');
    setIntervalS(s?.sampling_interval_s ?? 2);
    if (s !== null) {
      setRet({ rawHours: s.retention.raw_hours, oneMinDays: s.retention.minute_days, tenMinDays: s.retention.decaminute_days });
    }
    setError(null);
  };

  const save = async (): Promise<void> => {
    if (!intervalOk || !retentionValid || intervalS === null) return;
    setSaving(true);
    setError(null);
    const patch: SettingsPatch = {
      appearance: { theme: srvTheme, density: srvDensity },
      sampling_interval_s: intervalS,
      retention: {
        raw_hours: ret.rawHours,
        minute_days: ret.oneMinDays,
        decaminute_days: ret.tenMinDays,
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

  const locallyDirty = srvTheme !== uiTheme || srvDensity !== uiDensity;

  return (
    <SectionWrap
      id="general"
      title="General"
      sub="appearance · sampling cadence · retention"
      right={
        <Chip
          variant="warn"
          title="the sampler re-reads interval + retention on its next connect; a server restart re-uses the db, so values survive"
        >
          applies on next connect
        </Chip>
      }
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="sd-panel flex flex-col gap-3 p-4">
          <div className="sd-monolabel">appearance</div>
          <div className="flex gap-2">
            {(['dark', 'light', 'system'] as const).map((t) => (
              <Choice key={t} active={srvTheme === t} onClick={() => setSrvTheme(t)}>{t}</Choice>
            ))}
          </div>
          <div className="flex gap-2">
            {(['comfortable', 'compact'] as const).map((d) => (
              <Choice key={d} active={srvDensity === d} onClick={() => setSrvDensity(d)}>{d}</Choice>
            ))}
          </div>
          {locallyDirty && (
            <>
              <FieldMsg tone="hint">
                choice differs from the live store — “apply locally” swaps tokens now; “Save” mirrors it into the
                controller.
              </FieldMsg>
              <div>
                <Chip variant="accent">
                  <button
                    type="button"
                    className="cursor-pointer underline decoration-dotted"
                    onClick={() => {
                      setTheme(srvTheme);
                      setDensity(srvDensity);
                      toast.info('Appearance applied locally.');
                    }}
                  >
                    apply locally
                  </button>
                </Chip>
              </div>
            </>
          )}
        </div>

        <div className="sd-panel flex flex-col gap-3 p-4">
          <div className="sd-monolabel">sampler & retention</div>
          <NumField
            label="Sampling interval"
            value={intervalS}
            unit="seconds (1–10)"
            min={1}
            max={10}
            onChange={setIntervalS}
            required
            hint="collector tick — tighter means a denser raw ring, a shorter live history"
          />
          <div className="grid grid-cols-3 gap-2">
            <NumField
              label="Raw keep"
              value={ret.rawHours}
              unit="hours"
              integer
              min={1}
              max={48}
              onChange={setRetentionKey('rawHours')}
              required
            />
            <NumField
              label="1m rollups"
              value={ret.oneMinDays}
              unit="days"
              integer
              min={1}
              max={365}
              onChange={setRetentionKey('oneMinDays')}
              required
            />
            <NumField
              label="10m rollups"
              value={ret.tenMinDays}
              unit="days"
              integer
              min={1}
              max={365}
              onChange={setRetentionKey('tenMinDays')}
              required
            />
          </div>
        </div>
      </div>

      <DirtySave
        dirty={dirty}
        valid={intervalOk && retentionValid}
        saving={saving}
        error={error}
        onSave={() => void save()}
        onReset={reset}
        saveLabel="Save general"
      />
    </SectionWrap>
  );
}

function Choice({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={active}
      aria-pressed={active}
      className={cn(
        'h-9 min-w-0 flex-1 cursor-pointer rounded-inner border px-3 text-sm transition-colors duration-fast',
        'disabled:cursor-default disabled:opacity-90',
        active
          ? 'border-accent/50 bg-accent/10 font-semibold text-accent'
          : 'border-stroke bg-bg2 text-mid hover:border-stroke-strong hover:text-hi',
      )}
    >
      {children}
    </button>
  );
}
