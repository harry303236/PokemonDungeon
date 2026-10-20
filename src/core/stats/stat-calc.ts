import type { SpeciesData } from '../../data/schemas';
export interface Stats { maxHp: number; atk: number; def: number; spa: number; spd: number; moveSpeed: number }
const statHp = (b: number, l: number): number => Math.floor(((2 * b + 15) * l) / 100) + l + 10;
const statX = (b: number, l: number): number => Math.floor(((2 * b + 15) * l) / 100) + 5;
export function calcStats(sp: SpeciesData, level: number, hpMult = 1): Stats {
  const b = sp.baseStats;
  return {
    maxHp: Math.round(statHp(b.hp, level) * 4 * hpMult),
    atk: statX(b.atk, level), def: statX(b.def, level), spa: statX(b.spa, level), spd: statX(b.spd, level),
    moveSpeed: Math.min(320, 140 + statX(b.spe, level) * 0.6),
  };
}
export const xpToNext = (level: number): number => Math.round(20 * level ** 1.5); // TUNE
