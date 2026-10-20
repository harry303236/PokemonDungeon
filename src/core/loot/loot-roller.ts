import type { Rng } from '../rng';
import { AFFIXES } from '../../data/registry';
import type { AffixData } from '../../data/schemas';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
export const RARITY_WEIGHTS: Record<Rarity, number> = { common: 60, uncommon: 28, rare: 10, epic: 1.8, legendary: 0.2 };
export type ItemSlot = 'held' | 'tm-ember' | 'tm-flamethrower';
export interface AffixRoll { id: string; value: number }
export interface Item { uid: number; slot: ItemSlot; rarity: Rarity; affixes: AffixRoll[] }

export function rollRarity(rng: Rng, tier = 1): Rarity {
  const w = { ...RARITY_WEIGHTS };
  const boost = 1.25 ** (tier - 1);
  w.rare *= boost; w.epic *= boost; w.legendary *= boost;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let r = rng.next() * total;
  for (const k of Object.keys(w) as Rarity[]) { r -= w[k]; if (r < 0) return k; }
  return 'common';
}

const SLOT_MOVE: Record<ItemSlot, string | undefined> = { held: undefined, 'tm-ember': 'ember', 'tm-flamethrower': 'flamethrower' };
const fits = (a: AffixData, slot: ItemSlot): boolean => a.requiresMove === undefined || a.requiresMove === SLOT_MOVE[slot];

export function rollItem(rng: Rng, uid: number, tier = 1): Item {
  const rarity = rollRarity(rng, tier);
  const slot = rng.pick<ItemSlot>(['held', 'tm-ember', 'tm-flamethrower']);
  const pool = Object.values(AFFIXES).filter((a) => fits(a, slot));
  const stats = pool.filter((a) => a.kind === 'stat');
  const quals = pool.filter((a) => a.kind === 'shape' || a.kind === 'trigger' || a.kind === 'reaction');
  const costs = pool.filter((a) => a.kind === 'cost');
  const picks: AffixData[] = [];
  const take = (from: AffixData[]): void => {
    const c = from.filter((a) => !picks.includes(a));
    if (c.length) picks.push(rng.pick(c));
  };
  if (rarity === 'uncommon') take(stats);
  if (rarity === 'rare') { take(stats); take(quals); }
  if (rarity === 'epic' || rarity === 'legendary') { take(stats); take(quals); take(costs.length ? costs : stats); }
  if (rarity === 'legendary') take(stats);
  const affixes = picks.map((a) => ({ id: a.id, value: a.min !== undefined && a.max !== undefined ? +rng.range(a.min, a.max).toFixed(3) : 1 }));
  return { uid, slot, rarity, affixes };
}

/** Equip rules: at most 1 shape affix per item, at most 1 cost affix across all equipped. */
export function canEquip(item: Item, equipped: Item[]): { ok: true } | { ok: false; reason: 'shape-limit' | 'cost-limit' } {
  const kind = (r: AffixRoll): string | undefined => AFFIXES[r.id]?.kind;
  if (item.affixes.filter((r) => kind(r) === 'shape').length > 1) return { ok: false, reason: 'shape-limit' };
  const others = equipped.filter((e) => e.slot !== item.slot);
  const costs = [...others, item].flatMap((e) => e.affixes).filter((r) => kind(r) === 'cost').length;
  if (costs > 1) return { ok: false, reason: 'cost-limit' };
  return { ok: true };
}
