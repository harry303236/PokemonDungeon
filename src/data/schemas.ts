import { z } from 'zod';

export const TYPE_IDS = ['normal','fire','water','grass','electric','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy'] as const;
export const TypeIdSchema = z.enum(TYPE_IDS);
export type TypeId = z.infer<typeof TypeIdSchema>;

export const BaseStatsSchema = z.object({ hp: z.number(), atk: z.number(), def: z.number(), spa: z.number(), spd: z.number(), spe: z.number() });
export const SpeciesSchema = z.object({
  id: z.string(), names: z.object({ 'zh-Hant': z.string(), en: z.string() }),
  types: z.array(TypeIdSchema).min(1).max(2), baseStats: BaseStatsSchema, baseExp: z.number(),
  evolvesTo: z.object({ speciesId: z.string(), minLevel: z.number() }).nullable(),
  learnset: z.array(z.string()),
});
export type SpeciesData = z.infer<typeof SpeciesSchema>;
export const SpeciesFileSchema = z.record(z.string(), SpeciesSchema);
export const TypeChartSchema = z.record(TypeIdSchema, z.record(TypeIdSchema, z.number()));

export const ShapeSchema = z.enum(['projectile','arc-melee','cone','beam','zone','aoe-target','dash','aoe-self','buff-self']);
export const MoveSchema = z.object({
  id: z.string(), type: TypeIdSchema, category: z.enum(['physical','special','status']),
  power: z.number(), pp: z.number(), shape: ShapeSchema,
  params: z.record(z.string(), z.number()),
  status: z.object({ id: z.string(), chance: z.number(), duration: z.number() }).optional(),
});
export type MoveData = z.infer<typeof MoveSchema>;

export const MonsterSchema = z.object({
  id: z.string(), speciesId: z.string(), ai: z.enum(['melee-rusher','ranged-kiter','burrower']),
  hpMult: z.number(), xpMult: z.number(), move: z.string(), color: z.string(), radius: z.number(),
});
export type MonsterData = z.infer<typeof MonsterSchema>;

export const AffixSchema = z.object({
  id: z.string(), kind: z.enum(['stat','shape','trigger','reaction','cost']),
  requiresMove: z.string().optional(), stat: z.enum(['power','cdr','leech']).optional(),
  min: z.number().optional(), max: z.number().optional(),
});
export type AffixData = z.infer<typeof AffixSchema>;
