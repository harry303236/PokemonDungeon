import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { AffixSchema, MonsterSchema, MoveSchema, SpeciesFileSchema, TypeChartSchema } from '../src/data/schemas.js';
const j = (f: string): unknown => JSON.parse(readFileSync(`src/data/generated/${f}.json`, 'utf8')) as unknown;
const species = SpeciesFileSchema.parse(j('species'));
TypeChartSchema.parse(j('type-chart'));
const moves = z.array(MoveSchema).parse(j('moves'));
const monsters = z.array(MonsterSchema).parse(j('monsters'));
z.array(AffixSchema).parse(j('affixes'));
const ids = new Set(moves.map((m) => m.id));
for (const m of monsters) {
  if (!species[m.speciesId]) throw new Error(`monster ${m.id}: unknown species`);
  if (!ids.has(m.move)) throw new Error(`monster ${m.id}: move has no behavior`);
}
console.log('data OK');
