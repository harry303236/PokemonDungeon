// raw (PokeAPI cache) + design JSON -> src/data/generated
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { SpeciesFileSchema, TYPE_IDS, type SpeciesData } from '../src/data/schemas.js';

const raw = (p: string): unknown => JSON.parse(readFileSync(`data/raw/${p.replace(/\//g, '__')}.json`, 'utf8')) as unknown;
interface NamedRef { name: string; url: string }
interface PokemonRaw { types: { type: NamedRef }[]; stats: { base_stat: number; stat: NamedRef }[]; base_experience: number;
  moves: { move: NamedRef; version_group_details: { version_group: NamedRef }[] }[] }
interface SpeciesRaw { names: { name: string; language: NamedRef }[]; evolution_chain: { url: string } }
interface ChainLink { species: NamedRef; evolution_details: { min_level: number | null }[]; evolves_to: ChainLink[] }
interface TypeRaw { damage_relations: Record<string, NamedRef[]> }

const STAT_MAP: Record<string, keyof SpeciesData['baseStats']> = { hp: 'hp', attack: 'atk', defense: 'def', 'special-attack': 'spa', 'special-defense': 'spd', speed: 'spe' };

function findEvo(link: ChainLink, id: string): SpeciesData['evolvesTo'] {
  if (link.species.name === id) {
    const next = link.evolves_to[0];
    return next ? { speciesId: next.species.name, minLevel: next.evolution_details[0]?.min_level ?? 0 } : null;
  }
  for (const c of link.evolves_to) { const r = findEvo(c, id); if (r !== undefined) return r; }
  return undefined as unknown as null;
}

const list = JSON.parse(readFileSync('data/design/species-list.json', 'utf8')) as string[];
const out: Record<string, SpeciesData> = {};
for (const id of list) {
  const p = raw(`pokemon/${id}`) as PokemonRaw;
  const s = raw(`pokemon-species/${id}`) as SpeciesRaw;
  const chainId = s.evolution_chain.url.split('/').filter(Boolean).pop() ?? '';
  const chain = raw(`evolution-chain/${chainId}`) as { chain: ChainLink };
  const bs = { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 };
  for (const st of p.stats) { const k = STAT_MAP[st.stat.name]; if (k) bs[k] = st.base_stat; }
  out[id] = {
    id,
    names: { 'zh-Hant': s.names.find((n) => n.language.name === 'zh-hant')?.name ?? id, en: s.names.find((n) => n.language.name === 'en')?.name ?? id },
    types: p.types.map((t) => t.type.name) as SpeciesData['types'],
    baseStats: bs, baseExp: p.base_experience,
    evolvesTo: findEvo(chain.chain, id) ?? null,
    learnset: p.moves.filter((m) => m.version_group_details.some((v) => v.version_group.name === 'scarlet-violet')).map((m) => m.move.name).sort(),
  };
}
SpeciesFileSchema.parse(out);
const chart: Record<string, Record<string, number>> = {};
for (const a of TYPE_IDS) {
  const row: Record<string, number> = {};
  for (const d of TYPE_IDS) row[d] = 1;
  const rel = (raw(`type/${a}`) as TypeRaw).damage_relations;
  rel.double_damage_to?.forEach((t) => (row[t.name] = 2));
  rel.half_damage_to?.forEach((t) => (row[t.name] = 0.5));
  rel.no_damage_to?.forEach((t) => (row[t.name] = 0));
  chart[a] = row;
}
mkdirSync('src/data/generated', { recursive: true });
writeFileSync('src/data/generated/species.json', JSON.stringify(out, null, 1));
writeFileSync('src/data/generated/type-chart.json', JSON.stringify(chart));
for (const f of ['moves', 'monsters', 'affixes']) writeFileSync(`src/data/generated/${f}.json`, readFileSync(`data/design/${f}.json`, 'utf8'));
console.log('built', Object.keys(out).length, 'species');
