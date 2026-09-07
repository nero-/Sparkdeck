/* ============================================================================
   ds/Tabs — underline tab strip + chip variants (the chip variant doubles as
   the TimeChart window switcher: [5m 1h 6h 24h 7d]).
   Keyboard: roving focus, ArrowLeft/Right/Home/End.
   ========================================================================= */

import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface TabDef {
  id: string;
  label: ReactNode;
  badge?: ReactNode;
  title?: string;
}

export function Tabs({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
  variant = 'underline',
}: {
  tabs: TabDef[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel?: string;
  className?: string;
  variant?: 'underline' | 'chip';
}) {
  const btnRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const moveFocus = (dir: 1 | -1 | 'home' | 'end'): void => {
    const idx = tabs.findIndex((t) => t.id === value);
    if (idx < 0) return;
    const next =
      dir === 'home'
        ? 0
        : dir === 'end'
          ? tabs.length - 1
          : ((idx + dir) % tabs.length + tabs.length) % tabs.length;
    const target = tabs[next];
    if (target === undefined) return;
    onChange(target.id);
    btnRefs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      moveFocus(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      moveFocus(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus('home');
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus('end');
    }
  };

  if (variant === 'chip') {
    return (
      <div
        role="tablist"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className={cn('flex flex-wrap items-center gap-1', className)}
      >
        {tabs.map((t) => {
          const active = t.id === value;
          return (
            <button
              key={t.id}
              ref={(el) => {
                btnRefs.current[tabs.indexOf(t)] = el;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              title={t.title}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(t.id)}
              className={cn(
                'sd-num inline-flex h-6 cursor-pointer items-center gap-1 rounded-inner border px-2 font-mono text-2xs',
                'transition-colors duration-fast ease-out-soft select-none',
                active
                  ? 'border-accent/40 bg-accent/10 text-accent'
                  : 'border-stroke bg-transparent text-mid hover:border-stroke-strong hover:text-hi',
              )}
            >
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn('flex min-w-0 items-end gap-4 border-b border-stroke', className)}
    >
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              btnRefs.current[tabs.indexOf(t)] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            title={t.title}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={cn(
              '-mb-px cursor-pointer border-b-2 pb-1.5 text-sm whitespace-nowrap',
              'transition-colors duration-fast ease-out-soft select-none',
              active
                ? 'border-accent font-semibold text-hi'
                : 'border-transparent text-mid hover:text-hi',
            )}
          >
            <span className="inline-flex items-center gap-1.5">
              {t.label}
              {t.badge}
            </span>
          </button>
        );
      })}
    </div>
  );
}
