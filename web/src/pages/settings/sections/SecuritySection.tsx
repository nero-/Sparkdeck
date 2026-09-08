/* Settings ▸ Security — bind host/port (applies on restart) + browse-token
   state. Deliberately NO set-token control: a wrong move here locks the console
   out of the controller. When token_set goes live, 401 answers open the unlock
   modal (TokenGateHost on the settings page stores localStorage['sparkdeck.token']). */

import { useRef, useState } from 'react';
import { TOKEN_STORAGE_KEY, getAuthToken } from '../../../api/client';
import { Chip, KeyRow, toast } from '../../../ds';
import { DirtySave, FieldMsg, NumField } from '../../../lib/pagekit';
import { SectionWrap } from '../SectionWrap';
import { useDraftGate, type SettingsGate } from '../useSettingsState';

export function SecuritySection({ gate }: { gate: SettingsGate }) {
  const s = gate.data;
  const [bindHost, setBindHost] = useState('127.0.0.1');
  const [port, setPort] = useState<number | null>(8936);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const dirtyRef = useRef(false);
  useDraftGate(
    s !== null ? { host: s.security.bind_host, port: s.security.port } : null,
    dirtyRef,
    (fresh) => { setBindHost(fresh.host); setPort(fresh.port); },
  );

  const tokenSet = s?.security.token_set === true;
  const localToken = getAuthToken();

  const portOk = port !== null && Number.isInteger(port) && port >= 1 && port <= 65535;
  const hostOk = bindHost.trim().length > 0;
  const dirty = s !== null && (port !== s.security.port || bindHost !== s.security.bind_host);
  dirtyRef.current = dirty;
  const valid = portOk && hostOk;

  const save = async (): Promise<void> => {
    if (!valid || port === null) return;
    setSaving(true);
    setError(null);
    try {
      await gate.save({ security: { bind_host: bindHost.trim(), port } });
      toast.ok('Security saved — applies on next controller restart');
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionWrap
      id="security"
      title="Security"
      sub="bind address + port · browse-token state"
      right={
        <Chip variant="warn" title="bind/token state is read at server startup — a restart rebinds the socket">
          applies on restart
        </Chip>
      }
    >
      <div className="sd-panel flex flex-col gap-3 p-4">
        <div className="grid items-start gap-3 lg:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <input
              aria-label="Bind host"
              className="sd-raised h-9 px-2.5 text-sm text-hi outline-none transition-colors duration-fast focus:border-accent/60"
              value={bindHost}
              placeholder="127.0.0.1"
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setBindHost(e.currentTarget.value)}
              style={!hostOk ? { borderColor: 'var(--sd-crit)' } : undefined}
            />
            <span className="sd-monolabel">bind host</span>
            <span className="text-2xs text-low">
              127.0.0.1 keeps the controller loopback-only; 0.0.0.0 exposes the API — only behind a VPN.
            </span>
          </div>
          <NumField
            label="Port"
            value={port}
            min={1}
            max={65535}
            integer
            onChange={setPort}
            hint="default 8936"
            required
          />
        </div>

        {tokenSet === true ? (
          <div className="sd-raised flex flex-col gap-1.5 p-2.5">
            <div className="flex items-center gap-2">
              <KeyRow label="browse token" value="required by the controller (token_set)" />
            </div>
            <FieldMsg tone="hint">
              This console has no “set token” control on purpose — a wrong move locks every other browser out. Set/clear
              it server-side (config file or CLI). On this device{' '}
              <code className="font-mono">localStorage['{TOKEN_STORAGE_KEY}']</code> is{' '}
              {localToken !== null ? (
                <span className="text-ok">present — requests carry the Bearer header (ws ?token=)</span>
              ) : (
                <span className="text-crit">
                  absent — every request will answer 401 until you unlock (the modal appears on first failure)
                </span>
              )}
              .
            </FieldMsg>
          </div>
        ) : (
          <div className="sd-raised flex flex-col gap-1.5 p-2.5">
            <KeyRow label="browse token" value="not required (token_set = false)" />
            <FieldMsg tone="hint">open instance — bind host/port is the only gate; keep it loopback.</FieldMsg>
          </div>
        )}

        <DirtySave
          dirty={dirty}
          valid={valid}
          saving={saving}
          error={error}
          onSave={() => void save()}
          onReset={() => {
            if (s !== null) {
              setBindHost(s.security.bind_host);
              setPort(s.security.port);
            }
            setError(null);
          }}
          saveLabel="Save security"
        />
      </div>
    </SectionWrap>
  );
}
