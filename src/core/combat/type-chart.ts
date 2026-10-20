import chart from '../../data/generated/type-chart.json';
import { BALANCE } from '../balance';
import type { TypeId } from '../../data/schemas';
const C = chart as Record<string, Record<string, number>>;
export function typeMult(atk: TypeId, def: readonly TypeId[]): number {
  let m = 1;
  for (const d of def) { const v = C[atk]?.[d] ?? 1; m *= v === 0 ? BALANCE.immuneMult : v; }
  return m;
}
