import talentJson from '../../data/build/charmander-talents.json';
import directorJson from '../../data/build/charmander-moves-gems.json';
import bindingsJson from '../../data/build/director-bindings.json';
import tagsJson from '../../data/build/move-tags.json';
import reactionsJson from '../../data/build/reactions.json';
import { opsModifier, warnOnce, compatible, STAGES, type Modifier, type Op, type OpsDef, type Stage, type StatusApply } from './pipeline';
import { canAllocate, canRefund, pointsSpent, pointsTotal, talentBonuses, validateTalentData, type Alloc, type PlayerBonuses, type TalentData } from './talents';

export const TALENTS = talentJson as unknown as TalentData;
for (const e of validateTalentData(TALENTS)) console.warn(`[talents] ${e}`);

// ---------- director content (moves x variants, support gems, reactions) + engine bindings ----------
export interface DirectorData {
  modifierOrder: string[];
  moves: { id: string; name: string; tags: string[]; variants: { id: string; name: string; effect: string; addTags: string[]; rules: string[] }[] }[];
  supportGems: { id: string; name: string; requiresAnyTags: string[]; excludesTags?: string[]; effect: string; note?: string }[];
  reactions: { id: string; trigger: string; effect: string }[];
  reactionRules?: { reactionGeneratedHitsCanTrigger: boolean; depthIncrementsPerReaction: boolean; maxDepth: number; oncePerObjectPerFrame: boolean };
}
interface Bindings {
  moveIdMap: Record<string, string>; stageMap: Record<string, string>;
  variants: Record<string, { vfx?: string; ops: Op[] }>;
  gems: Record<string, { stage: Stage; icon?: string; ops: Op[] }>;
  reactions: Record<string, Omit<ReactionRule, 'id' | 'name' | 'desc' | 'stub'>>;
}
export const DIRECTOR = directorJson as unknown as DirectorData;
const BIND = bindingsJson as unknown as Bindings;
export const engineMoveId = (directorId: string): string => BIND.moveIdMap[directorId] ?? directorId;

/** Validate director file against bindings + engine; returns problems (warned at load). */
export function validateDirector(d: DirectorData = DIRECTOR, b: Bindings = BIND): string[] {
  const errs: string[] = [];
  const order = d.modifierOrder.map((x) => b.stageMap[x.split('(')[0] ?? ''] ?? '?');
  if (order.join() !== STAGES.join()) errs.push(`modifierOrder ${d.modifierOrder.join(' > ')} does not map to engine STAGES ${STAGES.join(' > ')}`);
  const vIds = new Set<string>();
  for (const m of d.moves) for (const v of m.variants) { if (vIds.has(v.id)) errs.push(`duplicate variant ${v.id}`); vIds.add(v.id); if (!b.variants[v.id]) errs.push(`variant ${v.id}: no engine binding (stub)`); }
  for (const g of d.supportGems) { if (!b.gems[g.id]) errs.push(`gem ${g.id}: no engine binding (stub)`); if (!Array.isArray(g.requiresAnyTags)) errs.push(`gem ${g.id}: missing requiresAnyTags`); }
  for (const r of d.reactions) if (!b.reactions[r.id]) errs.push(`reaction ${r.id}: no engine binding (stub)`);
  for (const k of Object.keys(b.variants)) if (!vIds.has(k)) errs.push(`binding for unknown variant ${k}`);
  return errs;
}
for (const e of validateDirector()) console.warn(`[director] ${e}`);

export interface GemDef extends OpsDef { name: string; desc: string; icon?: string; stub: boolean }
export const GEMS: Record<string, GemDef> = Object.fromEntries(DIRECTOR.supportGems.map((g) => {
  const b = BIND.gems[g.id];
  return [g.id, { id: g.id, name: g.name, desc: g.effect, icon: b?.icon, stub: !b, stage: b?.stage ?? 'onhit', ops: b?.ops ?? [],
    tagsAny: g.requiresAnyTags?.length ? g.requiresAnyTags : undefined, tagsNone: g.excludesTags } satisfies GemDef];
}));
export interface MoveTagDef { tags: string[]; applies?: StatusApply[] }
const LOCAL_TAGS = tagsJson as unknown as Record<string, MoveTagDef>;
export const MOVE_TAGS: Record<string, MoveTagDef> = { ...LOCAL_TAGS, ...Object.fromEntries(DIRECTOR.moves.map((m) => [engineMoveId(m.id), { ...LOCAL_TAGS[engineMoveId(m.id)], tags: m.tags }])) };
export interface UpgradeOption extends OpsDef { name: string; desc: string; rules: string[]; vfx?: string; stub: boolean }
export interface UpgradeGroup { group: string; options: UpgradeOption[] }
/** D4-style per-skill upgrades: the director's 2-choice variants are the 'variant' group; more groups can be added in data. */
export const SKILL_UPGRADES: Record<string, UpgradeGroup[]> = Object.fromEntries(DIRECTOR.moves.map((m) => [engineMoveId(m.id), [{ group: 'variant', options: m.variants.map((v) => {
  const b = BIND.variants[v.id];
  const ops: Op[] = [...v.addTags.map((t): Op => ({ op: 'addTag', value: t })), ...(b?.ops ?? [])];
  return { id: v.id, name: v.name, desc: v.effect, rules: v.rules, vfx: b?.vfx, stub: !b, stage: 'variant' as Stage, ops };
}) }]]));
export interface ReactionRule { id: string; name: string; desc: string; stub: boolean; hook: 'hit' | 'dash' | 'chain' | 'ground'; trigger: { tagsAll?: string[]; tagsAny?: string[]; variantAny?: string[]; moveAny?: string[] }; requires: string; effect: { type: string; [k: string]: number | string }; vfx?: string }
export const STATUSES = (reactionsJson as unknown as { statuses: Record<string, { name: string; maxStacks: number; duration: number }> }).statuses;
export const REACTIONS: ReactionRule[] = DIRECTOR.reactions.map((r) => { const b = BIND.reactions[r.id];
  return { id: r.id, name: r.trigger, desc: r.effect, stub: !b, hook: b?.hook ?? 'hit', trigger: b?.trigger ?? {}, requires: b?.requires ?? 'never', effect: b?.effect ?? { type: 'none' }, vfx: b?.vfx }; });
/** Director reaction-chain rules (defaults if absent). */
export const REACTION_RULES = { reactionGeneratedHitsCanTrigger: true, depthIncrementsPerReaction: true, maxDepth: 3, oncePerObjectPerFrame: true, ...(DIRECTOR.reactionRules ?? {}) };
export const reactionsFor = (hook: ReactionRule['hook']): ReactionRule[] => REACTIONS.filter((r) => !r.stub && r.hook === hook);
export function triggerMatches(t: ReactionRule['trigger'], tags: Set<string>, moveId: string, variant: string | null): boolean {
  if (t.variantAny && !(variant && t.variantAny.includes(variant))) return false;
  if (t.moveAny && !t.moveAny.includes(moveId)) return false;
  return compatible({ tagsAll: t.tagsAll, tagsAny: t.tagsAny }, tags, moveId);
}
export const variantVfx = (variant: string | null | undefined): string | undefined => (variant ? BIND.variants[variant]?.vfx : undefined);

/** Tags for a move: data, else derived from shape so new moves work without a tag entry. */
export function moveTags(id: string, shape?: string, type?: string): string[] {
  const d = MOVE_TAGS[id]; if (d) return d.tags;
  const byShape: Record<string, string[]> = { projectile: ['projectile'], beam: ['beam'], zone: ['area', 'zone'], 'aoe-target': ['area'], dash: ['melee', 'movement'], 'arc-melee': ['melee'] };
  return [...(byShape[shape ?? ''] ?? []), ...(type ? [type] : [])];
}

/** Persistent build state (stored on Progress). */
export interface BuildSave {
  talents: Alloc;
  gems: string[]; // bag
  sockets: Record<string, (string | null)[]>; // keyed by MOVE id -> sockets travel with the move across slot rebinding
  upgrades: Record<string, Record<string, string>>; // moveId -> group -> option id
  gold: number; ashShards: number; bonusPoints: number;
}
export const newBuildSave = (): BuildSave => ({ talents: {}, gems: [], sockets: {}, upgrades: {}, gold: 0, ashShards: 0, bonusPoints: 0 });
export function ensureBuild(b: Partial<BuildSave> | undefined): BuildSave { return { ...newBuildSave(), ...(b ?? {}) }; }

export const RESPEC_FREE_BEFORE = (): number => TALENTS.meta.respec.freeBeforeLevel;
export const fullResetCost = (level: number): number => level < RESPEC_FREE_BEFORE() ? 0 : level * 100; // TUNE: gold
export const socketCount = (evoStage1: number): number => TALENTS.meta.socketsPerMoveByEvoStage[String(evoStage1)] ?? 1;

export const gemFits = (gemId: string, moveId: string, tags: string[]): boolean => { const g = GEMS[gemId]; return !!g && compatible(g, new Set(tags), moveId); };

/** Build operations. evoStage1 is 1-based (data convention). */
export class Build {
  /** debug mode (set by the scene: dev build or ?debug); debug-granted talent points only count here */
  debug = false;
  constructor(public s: BuildSave, private ctx: () => { level: number; evoStage1: number }) {}
  tctx() { const c = this.ctx(); return { level: c.level, evoStage: c.evoStage1, bonusPoints: this.s.bonusPoints, debug: this.debug }; }
  pointsLeft(): number { return pointsTotal(TALENTS, this.tctx()) - pointsSpent(this.s.talents); }
  allocate(id: string): { ok: boolean; reason?: string } {
    const r = canAllocate(TALENTS, this.s.talents, id, this.tctx()); if (!r.ok) return r;
    this.s.talents[id] = (this.s.talents[id] ?? 0) + 1; return { ok: true };
  }
  /** Per-node refund: free before freeBeforeLevel, else costs 1 ash shard. */
  refund(id: string): { ok: boolean; reason?: string } {
    const r = canRefund(TALENTS, this.s.talents, id); if (!r.ok) return r;
    const paid = this.ctx().level >= RESPEC_FREE_BEFORE();
    if (paid && this.s.ashShards < 1) return { ok: false, reason: 'ashShard' };
    if (paid) this.s.ashShards--;
    const v = (this.s.talents[id] ?? 0) - 1; if (v <= 0) delete this.s.talents[id]; else this.s.talents[id] = v;
    return { ok: true };
  }
  fullReset(): { ok: boolean; reason?: string } {
    const cost = fullResetCost(this.ctx().level); if (this.s.gold < cost) return { ok: false, reason: 'gold' };
    this.s.gold -= cost; this.s.talents = {}; return { ok: true };
  }
  bonuses(): PlayerBonuses { return talentBonuses(TALENTS, this.s.talents); }

  sockets(moveId: string): (string | null)[] {
    const n = socketCount(this.ctx().evoStage1); const cur = this.s.sockets[moveId] ?? [];
    return Array.from({ length: n }, (_, i) => cur[i] ?? null);
  }
  /** Base move tags + tags added by the currently chosen upgrades/variant (e.g. ft_spread adds 'area' -> aoe gem fits). */
  effectiveTags(moveId: string, base = moveTags(moveId)): string[] {
    const t = new Set(base);
    for (const g of SKILL_UPGRADES[moveId] ?? []) { const o = g.options.find((x) => x.id === this.s.upgrades[moveId]?.[g.group]); for (const op of o?.ops ?? []) if (op.op === 'addTag') t.add(op.value); else if (op.op === 'removeTag') t.delete(op.value); }
    return [...t];
  }
  /** Socket a gem from the bag (swaps out any gem already there). Compatibility uses effective (variant-modified) tags. */
  socket(moveId: string, idx: number, gemId: string): { ok: boolean; reason?: string } {
    const tags = this.effectiveTags(moveId);
    if (idx < 0 || idx >= socketCount(this.ctx().evoStage1)) return { ok: false, reason: 'socket' };
    const bi = this.s.gems.indexOf(gemId); if (bi < 0) return { ok: false, reason: 'notInBag' };
    if (!gemFits(gemId, moveId, tags)) return { ok: false, reason: 'incompatible' };
    const arr = [...(this.s.sockets[moveId] ?? [])]; while (arr.length <= idx) arr.push(null);
    if (arr.includes(gemId)) return { ok: false, reason: 'duplicate' };
    const prev = arr[idx]; this.s.gems.splice(bi, 1); if (prev) this.s.gems.push(prev);
    arr[idx] = gemId; this.s.sockets[moveId] = arr; return { ok: true };
  }
  unsocket(moveId: string, idx: number): void {
    const arr = this.s.sockets[moveId]; const g = arr?.[idx]; if (!arr || !g) return; arr[idx] = null; this.s.gems.push(g);
  }
  chooseUpgrade(moveId: string, group: string, optionId: string | null): boolean {
    const g = SKILL_UPGRADES[moveId]?.find((x) => x.group === group); if (!g) return false;
    const m = (this.s.upgrades[moveId] ??= {});
    if (optionId === null) { delete m[group]; return true; }
    if (!g.options.some((o) => o.id === optionId)) return false;
    m[group] = optionId; return true;
  }

  /** All pipeline modifiers for a move: chosen upgrades/variant + socketed gems (active sockets only) + talents + extra (equipment). */
  modifiersFor(moveId: string, extra: Modifier[] = [], bonuses = this.bonuses()): Modifier[] {
    const out: Modifier[] = [];
    for (const g of SKILL_UPGRADES[moveId] ?? []) {
      const pick = this.s.upgrades[moveId]?.[g.group]; const o = g.options.find((x) => x.id === pick);
      if (o) out.push(opsModifier(o, `upgrade:${o.id}`));
    }
    for (const gid of this.sockets(moveId)) {
      if (!gid) continue; const g = GEMS[gid];
      if (!g) { warnOnce(`[build] unknown gem ${gid}`); continue; }
      out.push(opsModifier(g, `gem:${g.id}`));
    }
    return [...out, ...bonuses.moveMods, ...extra];
  }
}
