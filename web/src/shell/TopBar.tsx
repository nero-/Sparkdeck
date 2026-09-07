/* ============================================================================
   shell/TopBar — 52px chrome: cluster switcher (pills + menu w/ "Add
   cluster"), global connection state, running-op banner slot, event bell
   (unacked badge), clock.
   ========================================================================= */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Bell, ChevronDown, Plus, Check } from 'lucide-react';
import { cn } from '../lib/cn';
import { fmtClock, fmtIso } from '../lib/format';
import { StatusDot, Spinner, type DotState } from '../ds';
import { useClusters } from '../api/queries';
import { useUnackedEventCount, useOnlineCount, useLiveNodes, useWsStatus } from '../stores/live';
import { useCurrentOp } from '../stores/ops';
import { useUi } from '../stores/ui';
import type { ClusterTopology } from '../api/types';

export function TopBar() {
  return (
    <header
      className="z-30 flex h-[52px] shrink-0 items-center gap-3 border-b border-stroke bg-bg1 px-4"
      role="banner"
    >
      <ClusterSwitcher />
      <div className="min-w-0 flex-1" />
      <RunningOpBanner />
      <ConnStatus />
      <EventBell />
      <Clock />
    </header>
  );
}

/* ---------------------------------------------------------------------------
   Cluster switcher
   --------------------------------------------------------------------------- */

function validAccent(color: string | undefined | null): string {
  return color !== undefined && color !== null && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(color)
    ? color
    : 'var(--sd-accent)';
}

function ClusterSwitcher() {
  const { data: clusters, error, loading } = useClusters();
  const activeClusterId = useUi((s) => s.activeClusterId);
  const setActiveClusterId = useUi((s) => s.setActiveClusterId);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuWrapRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (menuWrapRef.current !== null && !menuWrapRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const list = clusters ?? [];

  const pick = (id: string): void => {
    setActiveClusterId(id);
    setMenuOpen(false);
  };

  return (
    <div className="flex min-w-0 items-center gap-1.5" role="group" aria-label="Cluster switcher">
      {list.length === 0 && loading !== false && error === null && (
        <span className="font-mono text-2xs text-low">loading clusters…</span>
      )}
      {list.length === 0 && error !== null && (
        <span className="font-mono text-2xs text-warn" title="controller unreachable">
          controller unreachable
        </span>
      )}
      {list.map((c) => {
        const active = c.id === activeClusterId;
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => pick(c.id)}
            title={c.notes ?? c.name}
            aria-pressed={active}
            className={cn(
              'inline-flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-inner border px-2 text-xs font-medium',
              'transition-colors duration-fast select-none',
              active ? 'bg-bg2 text-hi' : 'border-stroke bg-transparent text-mid hover:text-hi hover:border-stroke-strong',
            )}
            style={active ? { borderColor: validAccent(c.accent_color) } : undefined}
          >
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{ background: validAccent(c.accent_color) }}
              aria-hidden
            />
            <span className="max-w-[160px] truncate">{c.name}</span>
          </button>
        );
      })}

      {/* menu: all clusters + add cluster */}
      <div className="relative shrink-0" ref={menuWrapRef}>
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Cluster menu"
          onClick={() => setMenuOpen((o) => !o)}
          className={cn(
            'flex h-7 w-6 cursor-pointer items-center justify-center rounded-inner border border-stroke text-mid',
            'transition-colors duration-fast hover:text-hi hover:border-stroke-strong',
            menuOpen && 'bg-bg2 text-hi',
          )}
        >
          <ChevronDown size={13} className={cn('transition-transform duration-fast', menuOpen && 'rotate-180')} />
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="sd-panel absolute top-full left-0 z-40 mt-1.5 w-52 overflow-hidden p-1"
            style={{ background: 'var(--sd-bg2)' }}
          >
            {list.length === 0 && <div className="px-2 py-1.5 text-xs text-low">No clusters yet.</div>}
            {list.map((c) => (
              <MenuCluster
                key={c.id}
                cluster={c}
                active={c.id === activeClusterId}
                onPick={() => pick(c.id)}
              />
            ))}
            <div className="my-1 border-t border-stroke" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                void navigate('/settings');
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-inner px-2 py-1.5 text-xs text-mid transition-colors duration-fast hover:bg-bg1 hover:text-hi"
            >
              <Plus size={13} />
              Add cluster…
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function MenuCluster({
  cluster,
  active,
  onPick,
}: {
  cluster: ClusterTopology;
  active: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-inner px-2 py-1.5 text-xs',
        'transition-colors duration-fast hover:bg-bg1 hover:text-hi',
        active ? 'text-hi' : 'text-mid',
      )}
    >
      <span
        className="inline-block h-2 w-2 shrink-0 rounded-full"
        style={{ background: validAccent(cluster.accent_color) }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-left">{cluster.name}</span>
      {active && <Check size={13} className="text-accent" />}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Running-op banner slot
   --------------------------------------------------------------------------- */

function RunningOpBanner() {
  const op = useCurrentOp();
  if (op === undefined) {
    return (
      <span className="font-mono text-2xs text-low" title="No operation running">
        <span className="sr-only">No running op</span>
      </span>
    );
  }
  return (
    <Link
      to="/control"
      title={`Op ${op.id} — ${op.state}. Click to open Control.`}
      className={cn(
        'inline-flex h-7 items-center gap-2 rounded-inner border px-2 font-mono text-2xs',
        'animate-[sd-fade-in_150ms_cubic-bezier(0.22,0.61,0.36,1)_both]',
        op.state === 'running'
          ? 'border-accent/40 bg-accent/10 text-accent'
          : 'border-stroke bg-bg2 text-mid',
      )}
    >
      {op.state === 'running' ? <Spinner size={11} /> : <span className="sd-num">queued</span>}
      <span className="max-w-[220px] truncate">{op.kind}</span>
    </Link>
  );
}

/* ---------------------------------------------------------------------------
   Connection status + event bell + clock
   --------------------------------------------------------------------------- */

function wsDotState(status: string): DotState {
  switch (status) {
    case 'online':
      return 'ok';
    case 'connecting':
    case 'reconnecting':
      return 'degraded';
    case 'offline':
      return 'offline';
    default:
      return 'unknown';
  }
}

function ConnStatus() {
  const status = useWsStatus();
  const online = useOnlineCount();
  const liveNodes = useLiveNodes();
  const { data: clusters } = useClusters();

  const total = useMemo(() => {
    const fromTopology = (clusters ?? []).reduce((n, c) => n + c.nodes.length, 0);
    return fromTopology > 0 ? fromTopology : liveNodes.length;
  }, [clusters, liveNodes]);

  const label =
    status === 'online' ? 'live' : status === 'connecting' ? 'connecting' : status === 'reconnecting' ? 'reconnecting' : status;

  return (
    <div
      className="inline-flex h-7 shrink-0 items-center gap-2 rounded-inner border border-stroke bg-bg2 px-2"
      title={`WebSocket: ${status} · ${online}/${total} nodes online`}
    >
      <StatusDot state={wsDotState(status)} title={label} />
      <span className="sd-num font-mono text-2xs text-mid">
        {online}/{total} nodes
      </span>
    </div>
  );
}

function EventBell() {
  const unacked = useUnackedEventCount();
  return (
    <Link
      to="/events"
      title={unacked > 0 ? `${unacked} unacked event${unacked === 1 ? '' : 's'}` : 'Events'}
      aria-label={`Events${unacked > 0 ? ` (${unacked} unacked)` : ''}`}
      className={cn(
        'relative flex h-8 w-8 shrink-0 items-center justify-center rounded-inner',
        'text-mid transition-colors duration-fast hover:bg-bg2 hover:text-hi',
      )}
    >
      <Bell size={16} />
      {unacked > 0 && (
        <span
          className={cn(
            'sd-num absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full border',
            'border-bg1 bg-crit px-1 font-mono text-[9px] leading-none font-semibold text-accent-ink',
          )}
        >
          {unacked > 99 ? '99+' : unacked}
        </span>
      )}
    </Link>
  );
}

function Clock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <time
      dateTime={new Date(now).toISOString()}
      title={fmtIso(now)}
      className="sd-num hidden shrink-0 font-mono text-2xs text-mid md:inline"
    >
      {fmtClock(now)}
    </time>
  );
}
