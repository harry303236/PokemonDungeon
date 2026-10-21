import { warnOnce, type Modifier } from './pipeline';

export interface TalentNode { id: string; name?: string; branch: string; tier: number; evoStage: number; effectType: string; value: number | string; maxRank: number; requires: string[]; exclusiveGroup: string | null; drawback?: string; desc?: string }
export interface TalentUi { drawPrereqLines?: boolean; keystonePinnedTop?: boolean; hideUnimplemented?: boolean; pointsMustEqualLevelMinus1?: boolean }
export interface TalentMechanics { comboResetSec: number; trailLifeSec: number; trailPerEnemyIcdSec: number }
export interface TalentMeta { ui?: TalentUi; mechanics?: TalentMechanics; pointsPerLevel: number; maxLevel: number; totalPoints: number; evoStageUnlock: Record<string, number>; socketsPerMoveByEvoStage: Record<string, number>; respec: { freeBeforeLevel: number; perNode: string; full: string } }
export interface TalentData { meta: TalentMeta; nodes: TalentNode[] }
export type Alloc = Record<string, number>;

/** Structural validation of the design file. Returns human-readable errors (empty = OK). */
export function validateTalentData(d: TalentData): string[] {
  const errs: string[] = []; const ids = new Set<string>();
  const stages = new Set(Object.keys(d.meta?.evoStageUnlock ?? {}).map(Number));
  for (const n of d.nodes) {
    if (ids.has(n.id)) errs.push(`duplicate id ${n.id}`); ids.add(n.id);
    if (!(n.maxRank >= 1)) errs.push(`${n.id}: maxRank must be >= 1`);
    if (!stages.has(n.evoStage)) errs.push(`${n.id}: evoStage ${n.evoStage} not in meta.evoStageUnlock`);
    if (n.effectType === 'keystone' && !n.exclusiveGroup) errs.push(`${n.id}: keystone without exclusiveGroup`);
  }
  for (const n of d.nodes) for (const r of n.requires) if (!ids.has(r)) errs.push(`${n.id}: requires unknown ${r}`);
  // cycles
  const byId = new Map(d.nodes.map((n) => [n.id, n])); const state = new Map<string, number>();
  const dfs = (id: string): boolean => { const s = state.get(id); if (s === 1) return true; if (s === 2) return false; state.set(id, 1);
    for (const r of byId.get(id)?.requires ?? []) if (dfs(r)) return true; state.set(id, 2); return false; };
  for (const n of d.nodes) if (dfs(n.id)) { errs.push(`cycle through ${n.id}`); break; }
  return errs;
}

export interface TalentCtx { level: number; /** 1-based evo stage as in the data (1 charmander, 2 charmeleon, 3 charizard) */ evoStage: number; bonusPoints?: number; /** debug mode: debug-granted points count */ debug?: boolean }
export const levelPoints = (d: TalentData, level: number): number => Math.min(d.meta.totalPoints, Math.max(0, level - 1) * d.meta.pointsPerLevel);
/** meta.ui.pointsMustEqualLevelMinus1: debug-granted points only count in debug mode (shown separately in UI). */
export const debugPoints = (d: TalentData, ctx: TalentCtx): number => (d.meta.ui?.pointsMustEqualLevelMinus1 && !ctx.debug ? 0 : ctx.bonusPoints ?? 0);
export const pointsTotal = (d: TalentData, ctx: TalentCtx): number => levelPoints(d, ctx.level) + debugPoints(d, ctx);
export const pointsSpent = (a: Alloc): number => Object.values(a).reduce((s, v) => s + v, 0);

export function canAllocate(d: TalentData, a: Alloc, id: string, ctx: TalentCtx): { ok: true } | { ok: false; reason: string } {
  const n = d.nodes.find((x) => x.id === id); if (!n) return { ok: false, reason: 'unknown' };
  if (d.meta.ui?.hideUnimplemented && !isImplemented(n)) return { ok: false, reason: 'unimplemented' };
  const r = a[id] ?? 0;
  if (r >= n.maxRank) return { ok: false, reason: 'maxRank' };
  if (pointsSpent(a) >= pointsTotal(d, ctx)) return { ok: false, reason: 'points' };
  if (ctx.evoStage < n.evoStage) return { ok: false, reason: 'evoStage' };
  // requires: ALL listed parents must have >= 1 rank (decision logged in docs/decisions.md)
  // hidden (unimplemented) parents are skipped so they never block a path
  if (effectiveRequires(d, n).some((p) => (a[p] ?? 0) < 1)) return { ok: false, reason: 'requires' };
  if (n.exclusiveGroup && d.nodes.some((o) => o.id !== id && o.exclusiveGroup === n.exclusiveGroup && (a[o.id] ?? 0) > 0)) return { ok: false, reason: 'exclusive' };
  return { ok: true };
}
/** A rank can be removed if the node won't drop to 0 while an allocated child still requires it. */
export function canRefund(d: TalentData, a: Alloc, id: string): { ok: true } | { ok: false; reason: string } {
  const r = a[id] ?? 0; if (r <= 0) return { ok: false, reason: 'notAllocated' };
  if (r === 1 && d.nodes.some((c) => (a[c.id] ?? 0) > 0 && effectiveRequires(d, c).includes(id))) return { ok: false, reason: 'hasDependents' };
  return { ok: true };
}

// ---------- effect handlers ----------
export interface PlayerBonuses {
  fireCritPct: number; critDmgPct: number; burnConsumeMultPct: number; stunDurPct: number; projSpeedPct: number; flameChargeHits: number; comboStack: number; trailIgnite: number; trailDmgPct: number;
  atkPct: number; spAtkPct: number; defPct: number; speedPct: number; critPct: number; burnChancePct: number; burnDmgPct: number;
  ppRegenPct: number; dodgeCdPct: number; evasionPct: number; meleeLifestealPct: number; burnSpread: number;
  keystones: Set<string>; /** move-pipeline modifiers contributed by talents */ moveMods: Modifier[];
}
export const emptyBonuses = (): PlayerBonuses => ({ fireCritPct: 0, critDmgPct: 0, burnConsumeMultPct: 0, stunDurPct: 0, projSpeedPct: 0, flameChargeHits: 0, comboStack: 0, trailIgnite: 0, trailDmgPct: 0, atkPct: 0, spAtkPct: 0, defPct: 0, speedPct: 0, critPct: 0, burnChancePct: 0, burnDmgPct: 0, ppRegenPct: 0,
  dodgeCdPct: 0, evasionPct: 0, meleeLifestealPct: 0, burnSpread: 0, keystones: new Set(), moveMods: [] });

type Handler = (b: PlayerBonuses, total: number, n: TalentNode, rank: number) => void;
const pct = (k: keyof PlayerBonuses): Handler => (b, total) => { (b as unknown as Record<string, number>)[k] = ((b as unknown as Record<string, number>)[k] ?? 0) + total; };
/** effectType registry. Add a handler here to make a new effectType live; unknown types warn once and are ignored. */
export const TALENT_EFFECTS: Record<string, Handler> = {
  none: () => {},
  atkPct: pct('atkPct'), spAtkPct: pct('spAtkPct'), defPct: pct('defPct'), speedPct: pct('speedPct'), critPct: pct('critPct'),
  burnChancePct: (b, total) => { b.burnChancePct += total; b.moveMods.push({ source: 'talent:burnChance', stage: 'status', tagsAny: ['fire'], apply: (s) => { s.burnChance += total / 100; } }); },
  burnDmgPct: pct('burnDmgPct'), ppRegenPct: pct('ppRegenPct'), dodgeCdPct: pct('dodgeCdPct'), evasionPct: pct('evasionPct'), meleeLifestealPct: pct('meleeLifestealPct'),
  flamethrowerWidth: (b, total) => { b.moveMods.push({ source: 'talent:flamethrowerWidth', stage: 'numeric', moveId: 'flamethrower', apply: (s) => { s.areaPct += total * 100; } }); },
  burnSpread: (b, total) => { b.burnSpread += total; },
  fireCritPct: pct('fireCritPct'), critDmgPct: pct('critDmgPct'), burnConsumeMultPct: pct('burnConsumeMultPct'), stunDurPct: pct('stunDurPct'), projSpeedPct: pct('projSpeedPct'),
  flameChargeHits: pct('flameChargeHits'), comboStack: pct('comboStack'), trailIgnite: pct('trailIgnite'), trailDmgPct: pct('trailDmgPct'),
  /** movement never blocks casting in this prototype, so 'cast while moving' is inherent */ moveCast: () => {},
};
/** Keystones with gameplay handlers in sim.ts (value = keystone id). */
export const KNOWN_KEYSTONES = new Set(['ks_solarPower', 'ks_blaze', 'ks_skyGlide']);
export const isImplemented = (n: TalentNode): boolean => (n.effectType === 'keystone' ? KNOWN_KEYSTONES.has(String(n.value)) : !!TALENT_EFFECTS[n.effectType]);
export const effectiveRequires = (d: TalentData, n: TalentNode): string[] =>
  d.meta.ui?.hideUnimplemented ? n.requires.filter((id) => { const p = d.nodes.find((x) => x.id === id); return !p || isImplemented(p); }) : n.requires;
/** effectTypes that are recognised by the registry but have no gameplay yet (listed for the report / UI). */
export const unhandledEffectTypes = (d: TalentData): string[] => [...new Set(d.nodes.filter((n) => !isImplemented(n)).map((n) => (n.effectType === 'keystone' ? `keystone:${n.value}` : n.effectType)))];

export function talentBonuses(d: TalentData, a: Alloc): PlayerBonuses {
  const b = emptyBonuses();
  for (const n of d.nodes) {
    const r = a[n.id] ?? 0; if (r <= 0) continue;
    if (n.effectType === 'keystone') { b.keystones.add(String(n.value)); if (!KNOWN_KEYSTONES.has(String(n.value))) warnOnce(`[talents] keystone '${n.value}' has no gameplay handler yet`); continue; }
    const h = TALENT_EFFECTS[n.effectType];
    if (!h) { warnOnce(`[talents] unhandled effectType '${n.effectType}' (${n.id})`); continue; }
    h(b, (typeof n.value === 'number' ? n.value : 0) * r, n, r);
  }
  return b;
}

export const MECH_DEFAULTS: TalentMechanics = { comboResetSec: 2, trailLifeSec: 2, trailPerEnemyIcdSec: 0.5 };
export const mechanics = (d: TalentData): TalentMechanics => ({ ...MECH_DEFAULTS, ...(d.meta.mechanics ?? {}) });
