/** Compact HUD number: 999, 1.2K, 12K, 1M, 3.4B. */
export function fmtNum(n: number): string {
  const v = Math.round(n); const a = Math.abs(v);
  const u: [number, string][] = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  if (a < 1000) return String(v);
  for (const [d, s] of u) if (a >= d) { const q = v / d; return (Math.abs(q) < 10 ? Math.floor(q * 10) / 10 : Math.floor(q)).toString() + s; }
  return String(v);
}
