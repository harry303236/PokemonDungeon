import talentJson from '../../data/build/charmander-talents.json';
import gemsJson from '../../data/build/gems.json';
import tagsJson from '../../data/build/move-tags.json';
import upgradesJson from '../../data/build/skill-upgrades.json';
import reactionsJson from '../../data/build/reactions.json';
import { opsModifier, warnOnce, compatible, type Modifier, type OpsDef, type StatusApply } from './pipeline';
import { canAllocate, canRefund, pointsSpent, pointsTotal, talentBonuses, validateTalentData, type Alloc, type PlayerBonuses, type TalentData } from './talents';

export const TALENTS = talentJson as unknown as TalentData;
for (const e of validateTalentData(TALENTS)) console.warn(`[talents] ${e}`);
export interface GemDef extends OpsDef { name: string; desc: string }
export const GEMS: Record<string, GemDef> = Object.fromEntries((gemsJson as unknown as GemDef[]).map((g) => [g.id, g]));
export interface MoveTagDef { tags: string[]; applies?: StatusApply[] }
export const MOVE_TAGS = tagsJson as unknown as Record<string, MoveTagDef>;
export interface UpgradeOption extends OpsDef { name: string; desc: string }
export interface UpgradeGroup { group: string; options: UpgradeOption[] }
export const SKILL_UPGRADES: Record<string, UpgradeGroup[]> = Object.fromEntries(Object.entries(upgradesJson as Record<string, unknown>).filter(([k]) => !k.startsWith('_')) as [string, UpgradeGroup[]][]);
export interface ReactionRule { id: string; name: string; trigger: { tagsAll?: string[]; tagsAny?: string[] }; requires: string; consume: boolean; effect: { type: string; r: number; mult: number } }
export const STATUSES = (reactionsJson as { statuses: Record<string, { name: string; maxStacks: number; duration: number }> }).statuses;
export const REACTIONS = (reactionsJson as unknown as { reactions: ReactionRule[] }).reactions;

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
  constructor(public s: BuildSave, private ctx: () => { level: number; evoStage1: number }) {}
  private tctx() { const c = this.ctx(); return { level: c.level, evoStage: c.evoStage1, bonusPoints: this.s.bonusPoints }; }
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
  /** Socket a gem from the bag (swaps out any gem already there). */
  socket(moveId: string, idx: number, gemId: string, tags: string[]): { ok: boolean; reason?: string } {
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
