/* ============================================================================
   ds/primitives — Panel, SectionHeader, Chip, StatusDot, Btn, Input, Select,
   Toggle, Kbd, KeyRow, Tooltip(Tip), Empty, Spinner.
   CSS-first: styling rides the tokens in src/index.css; components stay dumb.
   ========================================================================= */

import type {
  CSSProperties,
  ComponentPropsWithRef,
  ReactNode,
} from 'react';
import { OctagonAlert, TriangleAlert } from 'lucide-react';
import { cn } from '../lib/cn';

/* ---------------------------------------------------------------------------
   Panel + SectionHeader
   --------------------------------------------------------------------------- */

export function Panel({
  className,
  children,
  raised,
  title,
  sub,
  actions,
}: {
  className?: string;
  children?: ReactNode;
  raised?: boolean;
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className={cn(raised ? 'sd-raised' : 'sd-panel', 'min-w-0', className)}>
      {(title !== undefined || actions !== undefined) && (
        <SectionHeader title={title} sub={sub} actions={actions} />
      )}
      {children}
    </section>
  );
}

export function SectionHeader({
  title,
  sub,
  actions,
  className,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center justify-between gap-3 px-4 pt-3 pb-2',
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        {title !== undefined && (
          <h2 className="truncate text-[13px] font-semibold text-hi">{title}</h2>
        )}
        {sub !== undefined && <div className="truncate text-xs text-low">{sub}</div>}
      </div>
      {actions !== undefined && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   Chip — variants neutral/ok/warn/crit/accent; optional hex color override
   (used for per-cluster accents, which are runtime values, not theme slots).
   --------------------------------------------------------------------------- */

export type ChipVariant = 'neutral' | 'ok' | 'warn' | 'crit' | 'accent';

function chipStyle(variant: ChipVariant, color?: string): { style?: CSSProperties; cls: string } {
  if (color !== undefined) {
    return {
      style: {
        color: `${color}`,
        borderColor: `color-mix(in srgb, ${color} 34%, transparent)`,
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      },
      cls: '',
    };
  }
  switch (variant) {
    case 'ok':
      return { cls: 'bg-ok/10 text-ok border-ok/25' };
    case 'warn':
      return { cls: 'bg-warn/10 text-warn border-warn/25' };
    case 'crit':
      return { cls: 'bg-crit/10 text-crit border-crit/25' };
    case 'accent':
      return { cls: 'bg-accent/10 text-accent border-accent/25' };
    case 'neutral':
    default:
      return { cls: 'bg-bg2 text-mid border-stroke' };
  }
}

export function Chip({
  variant = 'neutral',
  color,
  children,
  className,
  title,
}: {
  variant?: ChipVariant;
  color?: string;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  const { style, cls } = chipStyle(variant, color);
  return (
    <span
      title={title}
      style={style}
      className={cn(
        'inline-flex items-center gap-1 rounded-inner border px-1.5 py-[1px] text-2xs font-medium whitespace-nowrap',
        cls,
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------------------
   StatusDot — health semantics from DESIGN.md:
     ok = filled dot · warn = triangle · crit = octagon · conn loss = hollow
     pulse. Colors never carry meaning alone — pair with a label/icon.
   --------------------------------------------------------------------------- */

export type DotState = 'ok' | 'warn' | 'crit' | 'degraded' | 'offline' | 'disabled' | 'unknown';

export function StatusDot({
  state,
  title,
  className,
  size = 8,
}: {
  state: DotState;
  title?: string;
  className?: string;
  size?: number;
}) {
  if (state === 'warn') {
    return (
      <Tip text={title} className={cn('inline-flex shrink-0 align-middle', className)}>
        <TriangleAlert
          aria-label={title ?? 'warning'}
          role="img"
          style={{ color: 'var(--sd-warn)', width: 12, height: 12 }}
        />
      </Tip>
    );
  }
  if (state === 'crit') {
    return (
      <Tip text={title} className={cn('inline-flex shrink-0 align-middle', className)}>
        <OctagonAlert
          aria-label={title ?? 'critical'}
          role="img"
          style={{ color: 'var(--sd-crit)', width: 12, height: 12 }}
        />
      </Tip>
    );
  }

  const colorVar =
    state === 'ok'
      ? 'var(--sd-ok)'
      : state === 'degraded'
        ? 'var(--sd-warn)'
        : state === 'offline'
          ? 'var(--sd-crit)'
          : 'var(--sd-low)';

  const filled = state === 'ok';
  const pulsing = state === 'degraded' || state === 'offline';

  return (
    <span
      title={title}
      aria-label={title}
      role="img"
      className={cn('relative inline-flex shrink-0 items-center justify-center align-middle', className)}
    >
      <span
        className={cn('relative inline-block rounded-full', pulsing && 'sd-dot-pulse')}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          border: filled ? undefined : `2px solid ${colorVar}`,
          background: filled ? colorVar : 'transparent',
          color: colorVar, /* feeds the pulse ring's ::after */
        }}
      />
    </span>
  );
}

/* Map the wire enums onto DotState. */
export function connDot(
  state: 'online' | 'degraded' | 'offline' | 'connecting' | 'disabled' | string,
): DotState {
  switch (state) {
    case 'online':
      return 'ok';
    case 'degraded':
      return 'degraded';
    case 'offline':
      return 'offline';
    case 'connecting':
      return 'degraded';
    case 'disabled':
      return 'disabled';
    default:
      return 'unknown';
  }
}

export function healthDot(state: 'up' | 'down' | 'degraded' | 'unknown'): DotState {
  switch (state) {
    case 'up':
      return 'ok';
    case 'degraded':
      return 'degraded';
    case 'down':
      return 'crit';
    default:
      return 'unknown';
  }
}

/* ---------------------------------------------------------------------------
   Btn — primary / ghost / danger, sizes sm/md.
   --------------------------------------------------------------------------- */

export type BtnVariant = 'primary' | 'ghost' | 'danger';

export type BtnProps = ComponentPropsWithRef<'button'> & {
  variant?: BtnVariant;
  size?: 'sm' | 'md';
  loading?: boolean;
  icon?: ReactNode;
};

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary:
    'bg-accent text-accent-ink border border-transparent hover:brightness-110 active:brightness-95',
  ghost:
    'bg-transparent text-mid border border-stroke hover:text-hi hover:border-stroke-strong hover:bg-bg2',
  danger: 'bg-crit/15 text-crit border border-crit/35 hover:bg-crit/25',
};

const BTN_SIZE = {
  sm: 'h-7 gap-1.5 px-2.5 text-2xs',
  md: 'h-9 gap-2 px-3.5 text-sm',
} as const;

export function Btn({
  variant = 'ghost',
  size = 'md',
  loading = false,
  icon,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: BtnProps) {
  return (
    <button
      type={type}
      disabled={disabled === true || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-inner font-medium whitespace-nowrap',
        'transition-colors duration-fast ease-out-soft select-none',
        'disabled:pointer-events-none disabled:opacity-45',
        BTN_VARIANT[variant],
        BTN_SIZE[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner size={size === 'sm' ? 11 : 13} /> : icon}
      {children}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Form controls
   --------------------------------------------------------------------------- */

export type InputProps = ComponentPropsWithRef<'input'> & {
  label?: string;
  hint?: string;
  invalid?: boolean;
};

export function Input({ label, hint, invalid, className, id, ...rest }: InputProps) {
  const inputId = id ?? rest.name;
  return (
    <label htmlFor={inputId} className={cn('flex min-w-0 flex-col gap-1', className)}>
      {label !== undefined && <FieldLabel>{label}</FieldLabel>}
      <input
        id={inputId}
        className={cn(
          'sd-raised h-9 px-2.5 text-sm text-hi placeholder:text-low',
          'transition-colors duration-fast outline-none',
          'focus:border-accent/60',
          invalid === true && 'border-crit/50 text-crit',
        )}
        {...rest}
      />
      {hint !== undefined && <span className="text-2xs text-low">{hint}</span>}
    </label>
  );
}

export type SelectProps = ComponentPropsWithRef<'select'> & {
  label?: string;
};

const SELECT_CHEVRON =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' fill='none' stroke='%239AA4B2' stroke-width='1.5'/%3E%3C/svg%3E\")";

export function Select({ label, className, id, children, ...rest }: SelectProps) {
  const selectId = id ?? rest.name;
  return (
    <label htmlFor={selectId} className={cn('flex min-w-0 flex-col gap-1', className)}>
      {label !== undefined && <FieldLabel>{label}</FieldLabel>}
      <select
        id={selectId}
        className={cn(
          'sd-raised h-9 cursor-pointer appearance-none px-2 pr-6 text-sm text-hi',
          'bg-[position:right_7px_center] bg-no-repeat transition-colors duration-fast',
          'focus:border-accent/60',
        )}
        style={{ backgroundImage: SELECT_CHEVRON }}
        {...rest}
      >
        {children}
      </select>
    </label>
  );
}

export function FieldLabel({
  children,
  className,
  htmlFor,
}: {
  children: ReactNode;
  className?: string;
  htmlFor?: string;
}) {
  // note: inside Input/Select wrappers (which are <label>s) this must stay a
  // <span> — nested <label> elements are invalid HTML. htmlFor is honored
  // only when rendered standalone.
  if (htmlFor === undefined) {
    return <span className={cn('sd-monolabel', className)}>{children}</span>;
  }
  return (
    <label htmlFor={htmlFor} className={cn('sd-monolabel', className)}>
      {children}
    </label>
  );
}

/* ---------------------------------------------------------------------------
   Toggle (switch)
   --------------------------------------------------------------------------- */

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
  title,
  className,
}: {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label?: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      title={title}
      onClick={() => onChange?.(!checked)}
      className={cn(
        'flex items-center gap-2 rounded-inner text-sm text-mid disabled:cursor-not-allowed disabled:opacity-45',
        'enabled:cursor-pointer enabled:hover:text-hi',
        className,
      )}
    >
      <span
        className={cn(
          'relative inline-flex h-[18px] w-8 shrink-0 items-center rounded-full border transition-colors duration-fast ease-out-soft',
          checked ? 'border-accent/50 bg-accent/25' : 'border-stroke bg-bg2',
        )}
      >
        <span
          className={cn(
            'absolute h-3 w-3 rounded-full transition-all duration-fast ease-out-soft',
            checked ? 'left-[16px] bg-accent' : 'left-[3px] bg-low',
          )}
        />
      </span>
      {label}
    </button>
  );
}

/* ---------------------------------------------------------------------------
   Kbd / KeyRow / Tooltip / Empty / Spinner
   --------------------------------------------------------------------------- */

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center border border-stroke bg-bg2 px-1 font-mono text-[10px] text-mid',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function KeyRow({
  label,
  value,
  mono = true,
  className,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={cn('flex min-w-0 items-baseline justify-between gap-3', className)}
      title={title}
    >
      <dt className="sd-monolabel shrink-0 truncate">{label}</dt>
      <dd
        className={cn(
          'sd-num min-w-0 truncate text-right text-[13px] text-hi',
          mono === true ? 'font-mono' : 'font-sans',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/** Tooltip — the native title attribute is enough for v1 (per spec). */
export function Tip({
  text,
  children,
  className,
}: {
  text: string | undefined;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span title={text} className={cn('inline-flex items-center', className)}>
      {children}
    </span>
  );
}

export function Empty({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  hint?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {icon !== undefined && <div className="text-low [&_svg]:h-9 [&_svg]:w-9">{icon}</div>}
      <div className="max-w-[46ch] text-sm font-medium text-mid">{title}</div>
      {hint !== undefined && <div className="max-w-[56ch] text-xs text-low">{hint}</div>}
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Spinner({
  size = 13,
  className,
}: {
  size?: number;
  className?: string;
}) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderStyle: 'solid',
    borderWidth: 1.5,
    borderColor: 'color-mix(in srgb, var(--sd-accent) 30%, transparent)',
    borderTopColor: 'var(--sd-accent)',
  };
  return (
    <span
      role="progressbar"
      aria-label="loading"
      style={style}
      className={cn(
        'inline-block animate-[sd-spin_0.8s_linear_infinite] rounded-full align-middle',
        className,
      )}
    />
  );
}
