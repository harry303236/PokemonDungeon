import speciesJson from './generated/species.json';
import movesJson from './generated/moves.json';
import monstersJson from './generated/monsters.json';
import affixesJson from './generated/affixes.json';
import type { AffixData, MonsterData, MoveData, SpeciesData } from './schemas';

// Data is validated at build time by `npm run validate-data`; cast here to keep the runtime bundle small.
export const SPECIES = speciesJson as unknown as Record<string, SpeciesData>;
const index = <T extends { id: string }>(arr: T[]): Record<string, T> => Object.fromEntries(arr.map((x) => [x.id, x]));
export const MOVES = index(movesJson as unknown as MoveData[]);
export const MONSTERS = index(monstersJson as unknown as MonsterData[]);
export const AFFIXES = index(affixesJson as unknown as AffixData[]);
function get<T>(rec: Record<string, T>, id: string, what: string): T {
  const v = rec[id];
  if (!v) throw new Error(`unknown ${what}: ${id}`);
  return v;
}
export const species = (id: string): SpeciesData => get(SPECIES, id, 'species');
export const move = (id: string): MoveData => get(MOVES, id, 'move');
export const monster = (id: string): MonsterData => get(MONSTERS, id, 'monster');
export const affix = (id: string): AffixData => get(AFFIXES, id, 'affix');
