/* Settings — one page, sections anchored in a sidebar (anchor nav):
   General · Clusters & nodes · Control · Bench · Alerts · Security · Data.
   The gate reads /api/settings once and hands it to the section forms. */

import { useEffect, useState } from 'react';
import { PageHeader } from '../../shell/PageShell';
import { Chip } from '../../ds';
import { errCopy, TokenGateHost } from '../../lib/pagekit';
import { useSettingsState } from './useSettingsState';
import { GeneralSection } from './sections/GeneralSection';
import { ClustersSection } from './sections/ClustersSection';
import { ControlSection } from './sections/ControlSection';
import { BenchSettingsSection } from './sections/BenchSettingsSection';
import { AlertsSection } from './sections/AlertsSection';
import { SecuritySection } from './sections/SecuritySection';
import { DataSection } from './sections/DataSection';
import { cn } from '../../lib/cn';

const SECTION_DEFS: ReadonlyArray<{ id: string; label: string; note: string }> = [
  { id: 'general', label: 'General', note: 'appearance · sampling · retention' },
  { id: 'clusters', label: 'Clusters & nodes', note: 'topology · accents · addresses' },
  { id: 'control', label: 'Control', note: 'serve paths · launcher · mapping' },
  { id: 'bench', label: 'Bench', note: 'tool/venv · defaults' },
  { id: 'alerts', label: 'Alerts', note: 'mem · temps · restarts · webhook' },
  { id: 'security', label: 'Security', note: 'bind · token state' },
  { id: 'data', label: 'Data', note: 'export · import' },
];

export default function SettingsPage() {
  const gate = useSettingsState();

  /* deep-link: /settings#security restores into the right section */
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (fromHash !== '' && SECTION_DEFS.some((s) => s.id === fromHash)) {
      window.setTimeout(() => document.getElementById(fromHash)?.scrollIntoView({ block: 'start' }), 60);
    }
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Settings"
        context="one page, anchored sections — values live on the controller (GET/PATCH /api/settings + /api/clusters CRUD)"
        actions={
          gate.data !== null ? (
            <Chip variant="ok" title="settings snapshot loaded from GET /api/settings">
              settings loaded
            </Chip>
          ) : gate.loading ? (
            <Chip variant="accent">loading…</Chip>
          ) : gate.error !== null ? (
            <Chip variant="crit" title={errCopy(gate.error)}>
              unreachable
            </Chip>
          ) : null
        }
      />

      <div className="flex min-h-0 min-w-0 flex-1 gap-8">
        <AnchorNav sections={SECTION_DEFS} />
        <div className="flex min-w-0 flex-1 flex-col gap-8 pb-16">
          <GeneralSection gate={gate} />
          <ClustersSection />
          <ControlSection />
          <BenchSettingsSection />
          <AlertsSection gate={gate} />
          <SecuritySection gate={gate} />
          <DataSection gate={gate} />
        </div>
      </div>

      <TokenGateHost
        onUnlocked={() => {
          gate.reload();
        }}
      />
    </div>
  );
}

/* ---------------------------------------------------------------------------
   AnchorNav — sticky section index; highlights the section in view.
   --------------------------------------------------------------------------- */

function AnchorNav({ sections }: { sections: ReadonlyArray<{ id: string; label: string; note: string }> }) {
  const [active, setActive] = useState(SECTION_DEFS[0]?.id ?? '');

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const onSeen: IntersectionObserverCallback = (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) setActive(e.target.id);
      }
    };
    const io = new IntersectionObserver(onSeen, {
      rootMargin: '-72px 0px -55% 0px',
      threshold: 0,
    });
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el !== null) io.observe(el);
    }
    return () => io.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Settings sections" className="sticky top-0 hidden h-fit w-[230px] shrink-0 flex-col gap-0.5 self-start py-1 2xl:block">
      <div className="sd-monolabel mb-1 px-2.5 text-low">sections</div>
      {sections.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          className={cn(
            'flex cursor-pointer items-baseline justify-between gap-2 rounded-inner px-2.5 py-1.5 text-left text-sm transition-colors duration-fast',
            active === s.id ? 'bg-accent/10 font-semibold text-accent' : 'text-mid hover:bg-bg2 hover:text-hi',
          )}
        >
          <span>{s.label}</span>
          <span className="truncate text-2xs text-low">{s.note}</span>
        </button>
      ))}
    </nav>
  );
}
