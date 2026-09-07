/* ============================================================================
   shell/Rail — left icon rail, 72px collapsed (default) / 200px expanded.
   NAV order matches routes; digits power the g-1..g-9 chord.
   ========================================================================= */

import { NavLink } from 'react-router-dom';
import { PanelLeftClose, PanelLeftOpen, Zap } from 'lucide-react';
import { NAV_ITEMS } from '../router';
import { RAIL_WIDTH, useUi } from '../stores/ui';
import { cn } from '../lib/cn';
import { Tip } from '../ds';

export function Rail() {
  const expanded = useUi((s) => s.railExpanded);
  const toggleRail = useUi((s) => s.toggleRail);

  return (
    <nav
      aria-label="Primary"
      style={{ width: expanded ? RAIL_WIDTH.expanded : RAIL_WIDTH.collapsed }}
      className={cn(
        'z-20 flex h-dvh shrink-0 flex-col border-r border-stroke bg-bg1',
        'transition-[width] duration-med ease-out-soft',
      )}
    >
      {/* logo row */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 px-3.5">
        <NavLink to="/" aria-label="Sparkdeck home" className="flex items-center gap-2 rounded-inner">
          <Zap size={17} style={{ color: 'var(--sd-accent)' }} strokeWidth={2.2} />
          {expanded && <span className="truncate text-sm font-semibold tracking-wide text-hi">Sparkdeck</span>}
        </NavLink>
      </div>

      {/* items */}
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto overflow-x-hidden px-2 py-1.5">
        {NAV_ITEMS.map((item) => (
          <RailItem key={item.path} item={item} expanded={expanded} />
        ))}
      </div>

      {/* collapse toggle */}
      <div className="shrink-0 border-t border-stroke p-2">
        <button
          type="button"
          aria-label={expanded ? 'Collapse navigation' : 'Expand navigation'}
          onClick={toggleRail}
          className={cn(
            'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-inner px-2.5 text-mid',
            'transition-colors duration-fast hover:bg-bg2 hover:text-hi',
            !expanded && 'justify-center px-0',
          )}
        >
          {expanded ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          {expanded && <span className="text-sm">Collapse</span>}
        </button>
      </div>
    </nav>
  );
}

function RailItem({ item, expanded }: { item: (typeof NAV_ITEMS)[number]; expanded: boolean }) {
  const Icon = item.icon;
  const link = (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      title={expanded ? undefined : item.label}
      className={({ isActive }) =>
        cn(
          'flex h-9 min-w-0 items-center gap-2.5 rounded-inner px-2.5 text-sm',
          'transition-colors duration-fast select-none',
          !expanded && 'justify-center px-0 text-center',
          isActive
            ? 'bg-accent/12 font-medium text-accent'
            : 'text-mid hover:bg-bg2 hover:text-hi',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon size={17} strokeWidth={isActive ? 2 : 1.75} className="shrink-0" />
          {expanded && <span className="truncate">{item.label}</span>}
          {expanded && (
            <span className="sd-num ml-auto pr-0.5 font-mono text-[10px] text-low select-none">
              {item.digit}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
  return expanded ? link : <Tip text={item.label}>{link}</Tip>;
}
