import type { Progress } from '../sim';
export const SAVE_VERSION = 1;
export const SAVE_KEY = `pokedungeon.save.v${SAVE_VERSION}`;
export const BAK_KEY = 'pokedungeon.save.bak';
export interface SaveData { version: number; progress: Progress }
export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

type Migration = (d: Record<string, unknown>) => Record<string, unknown>;
/** v0 (hypothetical: flat progress) -> v1 */
export const MIGRATIONS: Record<number, Migration> = { 0: (d) => ({ version: 1, progress: d }) };

export function migrate(raw: Record<string, unknown>): SaveData {
  let d = raw; let v = typeof d.version === 'number' ? d.version : 0;
  while (v < SAVE_VERSION) { const m = MIGRATIONS[v]; if (!m) throw new Error(`no migration from v${v}`); d = m(d); v++; }
  return d as unknown as SaveData;
}
const isSave = (d: SaveData): boolean => typeof d.progress?.level === 'number' && Array.isArray(d.progress.inventory);
export function save(kv: KV, p: Progress): void {
  const prev = kv.getItem(SAVE_KEY); if (prev) kv.setItem(BAK_KEY, prev);
  kv.setItem(SAVE_KEY, JSON.stringify({ version: SAVE_VERSION, progress: p } satisfies SaveData));
}
export function load(kv: KV): Progress | null {
  for (const key of [SAVE_KEY, BAK_KEY]) {
    const s = kv.getItem(key); if (!s) continue;
    try { const d = migrate(JSON.parse(s) as Record<string, unknown>); if (isSave(d)) return d.progress; } catch { /* try backup */ }
  }
  return null;
}
