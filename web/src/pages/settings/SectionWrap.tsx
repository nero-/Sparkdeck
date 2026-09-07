/* SectionWrap — settings sections shell with an anchor id for the sidebar. */

import type { ReactNode } from 'react';
import { cn } from '../../lib/cn';

export function SectionWrap({
  id,
  title,
  sub,
  right,
  children,
  className,
}: {
  id: string;
  title: string;
  sub?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      data-sd-section={id}
      className={cn('flex min-w-0 scroll-mt-16 flex-col gap-3', className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-hi">{title}</h2>
          {sub !== undefined && <div className="text-xs text-low">{sub}</div>}
        </div>
        {right !== undefined && <div className="flex shrink-0 items-center gap-2">{right}</div>}
      </div>
      <div className="flex min-w-0 flex-col gap-3">{children}</div>
    </section>
  );
}
