import { BALANCE } from '../balance';
import type { MoveData } from '../../data/schemas';
export function moveCooldown(m: MoveData, cdr = 0): number {
  const base = m.params.cooldownOverride ?? 40 / m.pp;
  return base * (1 - Math.min(BALANCE.cdrCap, cdr));
}
export function energyCost(m: MoveData): number {
  if (m.params.energy !== undefined) return m.params.energy;
  return m.category === 'status' ? 15 : Math.round(m.power / 5);
}
