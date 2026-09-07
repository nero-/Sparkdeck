/* ============================================================================
   ds/terminal — true ANSI log rendering.
   Supports SGR: bold/dim/italic/underline/strike, 16-color, 256-color
   (38;5;n) and 24-bit (38;2;r;g;b) fg+bg, resets (0, 22-29). Non-SGR CSI
   sequences and OSC are stripped. Colors come from the real 256 xterm palette.

   `Terminal` renders a monotone-follow log pane: autoscroll with pause on
   user scroll, "Jump to live" pill, optional line-number gutter. Used by
   Logs page + ops console.
   ========================================================================= */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { ArrowDownToLine } from 'lucide-react';
import { cn } from '../lib/cn';
import { Empty } from './primitives';

/* ---------------------------------------------------------------------------
   256-color palette (xterm defaults). Generated, not hardcoded 256 literals.
   --------------------------------------------------------------------------- */

const C16 = [
  '#000000', '#cd0000', '#00cd00', '#cdcd00', '#0000ee', '#cd00cd', '#00cdcd', '#e5e5e5',
  '#7f7f7f', '#ff0000', '#00ff00', '#ffff00', '#5c5cff', '#ff00ff', '#00ffff', '#ffffff',
] as const;

const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

function build256Palette(): string[] {
  const pal: string[] = C16.slice();
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        pal.push(`#${hex2(CUBE_LEVELS[r]!)}${hex2(CUBE_LEVELS[g]!)}${hex2(CUBE_LEVELS[b]!)}`);
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const v = hex2(8 + i * 10);
    pal.push(`#${v}${v}${v}`);
  }
  return pal;
}

function hex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

export const ANSI_PALETTE = build256Palette();

export function ansi256(index: number): string {
  return ANSI_PALETTE[index] ?? '#9AA4B2';
}

/* ---------------------------------------------------------------------------
   SGR parsing
   --------------------------------------------------------------------------- */

export interface AnsiToken {
  text: string;
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

interface Sgr {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
  reset: boolean;
}

const CSI_RE = /\x1b\[([0-9;:]*)([A-Za-z])/g;
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

function applySgr(paramsRaw: string, s: Sgr): void {
  if (paramsRaw === '') {
    Object.assign(s, { reset: true } satisfies Partial<Sgr>);
    return;
  }
  const params = paramsRaw.replace(/:/g, ';');
  const parts = params.split(';').map((p) => (p === '' ? 0 : Number.parseInt(p, 10)));
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] ?? 0;
    switch (p) {
      case 0:
        Object.assign(s, { reset: true } satisfies Partial<Sgr>);
        return;
      case 1:
        s.bold = true;
        s.dim = false;
        break;
      case 2:
        s.dim = true;
        break;
      case 3:
        s.italic = true;
        break;
      case 4:
        s.underline = true;
        break;
      case 9:
        s.strike = true;
        break;
      case 22:
        s.bold = false;
        s.dim = false;
        break;
      case 23:
        s.italic = false;
        break;
      case 24:
        s.underline = false;
        break;
      case 29:
        s.strike = false;
        break;
      case 39:
        s.fg = undefined;
        break;
      case 49:
        s.bg = undefined;
        break;
      case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37:
        s.fg = ansi256(p - 30);
        break;
      case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47:
        s.bg = ansi256(p - 40);
        break;
      case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
        s.fg = ansi256(p - 90 + 8);
        break;
      case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
        s.bg = ansi256(p - 100 + 8);
        break;
      case 38:
      case 48: {
        const mode = parts[i + 1];
        const target = p === 38 ? 'fg' : 'bg';
        if (mode === 5) {
          const idx = parts[i + 2] ?? 0;
          if (target === 'fg') s.fg = ansi256(idx);
          else s.bg = ansi256(idx);
          i += 2;
        } else if (mode === 2) {
          const r = parts[i + 2] ?? 0;
          const g = parts[i + 3] ?? 0;
          const b = parts[i + 4] ?? 0;
          const hex = `#${hex2(r)}${hex2(g)}${hex2(b)}`;
          if (target === 'fg') s.fg = hex;
          else s.bg = hex;
          i += 4;
        }
        break;
      }
      default:
        break;
    }
  }
}

/** Parse `\x1b[...m` sequences (et al.) into styled token runs. */
export function parseAnsi(line: string): AnsiToken[] {
  const clean = line
    .replaceAll('\r', '')
    .replaceAll(OSC_RE, '');

  const tokens: AnsiToken[] = [];
  let cur: AnsiToken | null = null;
  let sgr: Sgr = { reset: false };
  let lastIndex = 0;

  CSI_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CSI_RE.exec(clean)) !== null) {
    // text before this sequence
    if (match.index > lastIndex) {
      const text = clean.slice(lastIndex, match.index);
      cur = pushText(tokens, cur, text, sgr);
    }
    const [, paramsRaw, cmd] = match;
    if (cmd === 'm') {
      sgr = { reset: false };
      applySgr(paramsRaw ?? '', sgr);
      cur = null; // force a fresh token run with new style
    }
    lastIndex = match.index + match[0].length;
    // other CSI commands (cursor moves, erases) are ignored/stripped
  }
  if (lastIndex < clean.length) {
    pushText(tokens, cur, clean.slice(lastIndex), sgr);
  }

  // strip trailing empty token
  while (tokens.length > 0 && tokens[tokens.length - 1]!.text === '') tokens.pop();
  return tokens;
}

type AnsiStyle = Omit<AnsiToken, 'text'>;

function stylesOf(sgr: Sgr): AnsiStyle {
  const out: AnsiStyle = {};
  if (sgr.fg !== undefined) out.fg = sgr.fg;
  if (sgr.bg !== undefined) out.bg = sgr.bg;
  if (sgr.bold === true) out.bold = true;
  if (sgr.dim === true) out.dim = true;
  if (sgr.italic === true) out.italic = true;
  if (sgr.underline === true) out.underline = true;
  if (sgr.strike === true) out.strike = true;
  if (sgr.inverse === true) out.inverse = true;
  return out;
}

function keyOf(style: AnsiStyle): string {
  return JSON.stringify(style);
}

function pushText(
  tokens: AnsiToken[],
  cur: AnsiToken | null,
  text: string,
  sgr: Sgr,
): AnsiToken {
  const nextStyle = stylesOf(sgr);
  const wanted = keyOf(nextStyle);
  if (cur !== null && keyOf(withoutText(cur)) === wanted) {
    cur.text += text;
    return cur;
  }
  cur = { text, ...nextStyle };
  tokens.push(cur);
  return cur;
}

function withoutText(t: AnsiToken): AnsiStyle {
  const { text: _text, ...rest } = t;
  return rest;
}

/* token → inline style (theme-aware bg surfacing for readability) */
function tokenStyle(t: AnsiToken): CSSProperties {
  const style: CSSProperties = {};
  const dimAlpha = t.dim === true ? 0.66 : 1;
  if (t.inverse === true) {
    style.color = t.bg ?? '#e5e5e5';
    if (t.fg !== undefined) style.background = t.fg;
  } else {
    if (t.fg !== undefined) style.color = t.fg;
    else style.color = 'var(--sd-mid)';
    if (t.bg !== undefined) style.background = t.bg;
  }
  if (t.bold === true) style.fontWeight = 650;
  if (t.dim === true) style.opacity = dimAlpha;
  if (t.italic === true) style.fontStyle = 'italic';
  if (t.underline === true || t.strike === true) {
    style.textDecoration = [t.underline === true ? 'underline' : '', t.strike === true ? 'line-through' : '']
      .filter(Boolean)
      .join(' ');
  }
  return style;
}

/** One ANSI-colored line. */
export function AnsiLine({
  line,
  lineNumber,
  className,
}: {
  line: string;
  lineNumber?: number;
  className?: string;
}) {
  const tokens = parseAnsiCached(line);
  return (
    <span className={cn('sd-num', className)}>
      {lineNumber !== undefined && (
        <span
          aria-hidden
          className="mr-3 inline-block w-9 shrink-0 text-right select-none"
          style={{ color: 'var(--sd-low)', opacity: 0.8 }}
        >
          {lineNumber}
        </span>
      )}
      {tokens.length === 0 ? (
        <span>&nbsp;</span>
      ) : (
        tokens.map((t, i) => (
          <span key={i} style={tokenStyle(t)}>
            {t.text}
          </span>
        ))
      )}
    </span>
  );
}

/* parse cache — log lines re-render frequently with identical strings */
const parsedCache = new Map<string, AnsiToken[]>();
const PARSED_CACHE_MAX = 8000;

function parseAnsiCached(line: string): AnsiToken[] {
  const hit = parsedCache.get(line);
  if (hit !== undefined) return hit;
  const parsed = parseAnsi(line);
  if (parsedCache.size >= PARSED_CACHE_MAX) {
    const firstKey = parsedCache.keys().next().value;
    if (firstKey !== undefined) parsedCache.delete(firstKey);
  }
  parsedCache.set(line, parsed);
  return parsed;
}

/* ---------------------------------------------------------------------------
   Terminal pane — autoscroll w/ pause on user scroll + Jump-to-live pill.
   --------------------------------------------------------------------------- */

export function Terminal({
  lines,
  showLineNumbers = false,
  follow = true,
  onFollowChange,
  maxLines = 2500,
  className,
  empty,
}: {
  lines: string[];
  showLineNumbers?: boolean;
  /** auto-follow the tail (default); pauses when the user scrolls up */
  follow?: boolean;
  onFollowChange?: (follow: boolean) => void;
  maxLines?: number;
  className?: string;
  empty?: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [auto, setAuto] = useState(follow);
  const followRef = useRef(follow);
  followRef.current = auto;

  // NOTE: `follow` prop is *controlled* when passed; `auto` mirrors it.
  useEffect(() => {
    setAuto(follow);
  }, [follow]);

  // trim for rendering
  const view = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;
  const firstIndex = lines.length - view.length;

  // autoscroll when new lines arrive and we're following
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el === null || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 28;
    if (atBottom !== followRef.current) {
      setAuto(atBottom);
      onFollowChange?.(atBottom);
    }
  };

  const jumpToLive = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    setAuto(true);
    onFollowChange?.(true);
    el.scrollTop = el.scrollHeight;
  };

  if (lines.length === 0) {
    return (
      <div className={cn('sd-raised flex min-h-0 flex-1 items-center justify-center p-0', className)}>
        {empty ?? <Empty title="No log lines yet." className="py-8" />}
      </div>
    );
  }

  return (
    <div className={cn('relative min-h-0 flex-1', className)}>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={cn(
          'h-full overflow-auto bg-[var(--sd-term-bg)] p-2 font-mono text-xs text-[var(--sd-mid)]',
          '[&::-webkit-scrollbar-thumb]:bg-[var(--sd-scrollbar)]',
        )}
        role="log"
        aria-live="off"
        tabIndex={0}
      >
        {view.map((line, i) => (
          <div key={firstIndex + i} className="flex w-full items-start whitespace-pre">
            {showLineNumbers && (
              <span
                aria-hidden
                className="sd-num mr-3 w-9 shrink-0 text-right text-[10px] leading-[18px] select-none"
                style={{ color: 'var(--sd-low)' }}
              >
                {firstIndex + i + 1}
              </span>
            )}
            <span className="min-w-0 break-all leading-[18px]">
              <AnsiLine line={line} />
            </span>
          </div>
        ))}
      </div>

      {!auto && (
        <button
          type="button"
          onClick={jumpToLive}
          className="absolute bottom-4 left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-1.5 rounded-full border border-accent/40 bg-bg1 px-3 py-1 font-mono text-2xs text-accent shadow-[0_2px_8px_rgba(0,0,0,0.5)] transition-colors duration-fast hover:bg-accent/15"
        >
          <ArrowDownToLine size={12} />
          Jump to live
        </button>
      )}
    </div>
  );
}
