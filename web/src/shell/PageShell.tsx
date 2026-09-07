/* ============================================================================
   shell/PageShell — page header (title + context + right-aligned actions)
   and the placeholder screen used by pages not yet wired.
   ========================================================================= */

import type { ReactNode } from 'react';
import { Empty } from '../ds';

export function PageHeader({
  title,
  context,
  actions,
  className,
}: {
  title: ReactNode;
  context?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cnHeader(className)}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <h1 className="truncate text-base font-semibold text-hi">{title}</h1>
        {context !== undefined && <div className="truncate text-xs text-mid">{context}</div>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

function cnHeader(className?: string): string {
  return [
    'mb-5 flex shrink-0 items-end justify-between gap-4',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

export function PagePlaceholder({
  title,
  context,
  icon,
  message = 'Wiring in progress.',
  hint,
}: {
  title: ReactNode;
  context?: ReactNode;
  icon?: ReactNode;
  message?: string;
  hint?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader title={title} context={context} />
      <div className="sd-panel flex min-h-[420px] flex-1 items-center justify-center">
        <Empty
          icon={icon}
          title={message}
          hint={hint ?? 'This surface arrives with the next build wave.'}
          className="min-h-[320px]"
        />
      </div>
    </div>
  );
}
