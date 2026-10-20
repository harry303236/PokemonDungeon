import { BALANCE } from '../balance';
import type { TypeId } from '../../data/schemas';
import { typeMult } from './type-chart';
export interface DamageInput {
  level: number; power: number; atk: number; def: number; moveType: TypeId;
  attackerTypes: readonly TypeId[]; defenderTypes: readonly TypeId[];
  isCrit: boolean; roll: number; // roll in [0,1) -> rand(0.9,1.0)
  bonus?: number; mult?: number; burnedPhysical?: boolean; weatherMult?: number;
}
export function calcDamage(i: DamageInput): { dmg: number; typeEff: number } {
  const A = i.burnedPhysical ? i.atk * 0.5 : i.atk;
  const base = (((2 * i.level) / 5 + 2) * i.power * A) / i.def / 50 + 2;
  const stab = i.attackerTypes.includes(i.moveType) ? BALANCE.stab : 1;
  const typeEff = typeMult(i.moveType, i.defenderTypes);
  const crit = i.isCrit ? BALANCE.critMult : 1;
  const r = 0.9 + 0.1 * i.roll;
  const dmg = base * stab * typeEff * (i.weatherMult ?? 1) * crit * r * (1 + (i.bonus ?? 0)) * (i.mult ?? 1);
  return { dmg: Math.max(1, Math.round(dmg)), typeEff };
}
