// Dev-time only: fetch PokeAPI data into data/raw (cached, with retry). Never used at runtime.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = 'data/raw';
const API = 'https://pokeapi.co/api/v2';

async function getJson(path: string): Promise<unknown> {
  const file = join(RAW, path.replace(/\//g, '__') + '.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(`${API}/${path}`);
      if (!res.ok) throw new Error(`${res.status} ${path}`);
      const json = (await res.json()) as unknown;
      writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error('unreachable');
}

interface NamedRef { name: string; url: string }
interface SpeciesRaw { evolution_chain: { url: string } }
interface PokemonRaw { types: { type: NamedRef }[] }

async function main(): Promise<void> {
  mkdirSync(RAW, { recursive: true });
  const list = JSON.parse(readFileSync('data/design/species-list.json', 'utf8')) as string[];
  const types = new Set<string>();
  for (const id of list) {
    const p = (await getJson(`pokemon/${id}`)) as PokemonRaw;
    p.types.forEach((t) => types.add(t.type.name));
    const s = (await getJson(`pokemon-species/${id}`)) as SpeciesRaw;
    const chainId = s.evolution_chain.url.split('/').filter(Boolean).pop();
    await getJson(`evolution-chain/${chainId}`);
    console.log('fetched', id);
  }
  const allTypes = ['normal','fire','water','grass','electric','ice','fighting','poison','ground','flying','psychic','bug','rock','ghost','dragon','dark','steel','fairy'];
  for (const t of allTypes) await getJson(`type/${t}`);
  console.log('done');
}
void main();
