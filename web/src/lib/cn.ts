/** Small classname joiner (no dep). Falsey parts are skipped. */
export function cn(
  ...parts: Array<string | false | null | undefined>
): string {
  const out: string[] = [];
  for (const p of parts) {
    if (p) out.push(p);
  }
  return out.length > 0 ? out.join(' ') : '';
}
