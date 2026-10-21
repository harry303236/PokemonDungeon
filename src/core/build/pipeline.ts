/**
 * Move modifier pipeline. Every cast builds a MoveSpec from the move's base data, then applies modifiers
 * from all sources (skill-upgrade variants, gems, talents, equipment) in a FIXED stage order:
 *   1 variant   - D4-style move variants / per-skill upgrades; may add/remove tags
 *   2 shape     - projectile count / spread / fork / extra beams
 *   3 prehit    - pierce
 *   4 onhit     - chain, ignite (burn chance), applied statuses
 *   5 reaction  - consume/detonate statuses (rules in reactions.json; resolved at hit time)
 *   6 numeric   - % increases / more multipliers (talents, gems)
 * Compatibility is checked against the spec's tags *at the time the modifier's stage runs*, so a stage-1 variant that
 * adds a tag (e.g. 'area') unlocks later-stage modifiers that need it.
 */
export const STAGES = ['variant', 'shape', 'prehit', 'onhit', 'reaction', 'numeric'] as const;
export type Stage = (typeof STAGES)[number];

export interface StatusApply { status: string; chance: number; duration: number }
export interface MoveSpec {
  moveId: string;
  tags: Set<string>;
  variant: string | null;
  params: Record<string, number>;
  projectiles: number; spreadDeg: number; fork: number;
  beams: number; beamSpreadDeg: number;
  pierce: number;
  chain: number; chainRange: number;
  burnChance: number;
  applies: StatusApply[];
  /** reaction rule ids this cast may trigger (stage 5 can add/remove; default: all) */
  reactionsOff: Set<string>;
  areaPct: number; incDmgPct: number; moreDmg: number;
  widenOverLife: number;
  endExplosion: { r: number; mult: number } | null;
  leech: number;
}

export interface Modifier {
  source: string; stage: Stage;
  tagsAny?: string[]; tagsAll?: string[]; tagsNone?: string[]; moveId?: string;
  apply(spec: MoveSpec): void;
}

export function baseSpec(moveId: string, tags: string[], params: Record<string, number>, burnChance: number, applies: StatusApply[] = []): MoveSpec {
  return { moveId, tags: new Set(tags), variant: null, params: { ...params }, projectiles: 1, spreadDeg: 15, fork: 0, beams: 1, beamSpreadDeg: 25,
    pierce: 0, chain: 0, chainRange: 180, burnChance, applies: applies.map((a) => ({ ...a })), reactionsOff: new Set(), areaPct: 0, incDmgPct: 0, moreDmg: 1,
    widenOverLife: 0, endExplosion: null, leech: 0 };
}

export function compatible(m: Pick<Modifier, 'tagsAny' | 'tagsAll' | 'tagsNone' | 'moveId'>, tags: Set<string>, moveId: string): boolean {
  if (m.moveId && m.moveId !== moveId) return false;
  if (m.tagsAny?.length && !m.tagsAny.some((t) => tags.has(t))) return false;
  if (m.tagsAll?.length && !m.tagsAll.every((t) => tags.has(t))) return false;
  if (m.tagsNone?.some((t) => tags.has(t))) return false;
  return true;
}

/** Run the pipeline. Returns the spec and the ordered list of applied modifier sources (for UI/debug/tests). */
export function buildMoveSpec(spec: MoveSpec, mods: Modifier[]): { spec: MoveSpec; applied: string[] } {
  const applied: string[] = [];
  for (const stage of STAGES) {
    for (const m of mods) {
      if (m.stage !== stage || !compatible(m, spec.tags, spec.moveId)) continue;
      m.apply(spec); applied.push(`${stage}:${m.source}`);
    }
  }
  return { spec, applied };
}

/** Final damage multiplier from stage-6 numbers. */
export const dmgFactor = (s: MoveSpec): number => (1 + s.incDmgPct / 100) * s.moreDmg;
export const areaFactor = (s: MoveSpec): number => 1 + s.areaPct / 100;

// ---------- data ops -> modifiers ----------
export type Op =
  | { op: 'add'; field: string; value: number }
  | { op: 'mul'; field: string; value: number }
  | { op: 'set'; field: string; value: unknown }
  | { op: 'addTag' | 'removeTag'; value: string }
  | { op: 'param'; key: string; mul?: number; add?: number }
  | { op: 'applyStatus'; status: string; chance: number; duration: number }
  | { op: 'disableReaction'; value: string };

const warned = new Set<string>();
export const warnOnce = (msg: string): void => { if (warned.has(msg)) return; warned.add(msg); console.warn(msg); };

const NUM_FIELDS = new Set(['projectiles', 'spreadDeg', 'fork', 'beams', 'beamSpreadDeg', 'pierce', 'chain', 'chainRange', 'burnChance', 'areaPct', 'incDmgPct', 'moreDmg', 'widenOverLife', 'leech']);
const SET_FIELDS = new Set(['endExplosion', 'widenOverLife', 'variant']);

export function applyOp(spec: MoveSpec, op: Op, source: string): void {
  const rec = spec as unknown as Record<string, unknown>;
  switch (op.op) {
    case 'add': case 'mul':
      if (!NUM_FIELDS.has(op.field)) { warnOnce(`[build] ${source}: unknown numeric field '${op.field}'`); return; }
      rec[op.field] = op.op === 'add' ? (rec[op.field] as number) + op.value : (rec[op.field] as number) * op.value; return;
    case 'set': if (!SET_FIELDS.has(op.field)) { warnOnce(`[build] ${source}: field '${op.field}' not settable`); return; } rec[op.field] = op.value; return;
    case 'addTag': spec.tags.add(op.value); return;
    case 'removeTag': spec.tags.delete(op.value); return;
    case 'param': { const v = spec.params[op.key]; if (v === undefined) return; spec.params[op.key] = v * (op.mul ?? 1) + (op.add ?? 0); return; }
    case 'applyStatus': spec.applies.push({ status: op.status, chance: op.chance, duration: op.duration }); return;
    case 'disableReaction': spec.reactionsOff.add(op.value); return;
    default: warnOnce(`[build] ${source}: unknown op ${JSON.stringify(op)}`);
  }
}

export interface OpsDef { id: string; stage: Stage; ops: Op[]; tagsAny?: string[]; tagsAll?: string[]; tagsNone?: string[]; moveId?: string }
export function opsModifier(d: OpsDef, source = d.id): Modifier {
  if (!(STAGES as readonly string[]).includes(d.stage)) warnOnce(`[build] ${source}: unknown stage '${d.stage}'`);
  return { source, stage: d.stage, tagsAny: d.tagsAny, tagsAll: d.tagsAll, tagsNone: d.tagsNone, moveId: d.moveId,
    apply: (s) => { for (const op of d.ops) applyOp(s, op, source); if (d.stage === 'variant') s.variant = d.id; } };
}
