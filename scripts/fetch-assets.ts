// Setup-time asset fetcher. Downloads PMD SpriteCollab sprites (fallback: PokeAPI static sprite) into the
// git-ignored skin folder, and (only if missing) the CC0 Kenney tileset. Never runs at game runtime.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

interface Manifest { skinDir: string; pmdBase: string; fallbackBase: string; anims: string[]; species: Record<string, number>;
  tileset: { page: string; dest: string; zipEntry: string } }
export interface SkinAnim { file: string; frameWidth: number; frameHeight: number; durations: number[] }
export interface SkinEntry { source: 'pmd' | 'pokeapi'; anims: Record<string, SkinAnim> }

const M = JSON.parse(readFileSync('assets.manifest.json', 'utf8')) as Manifest;
const force = process.argv.includes('--force');
const ifMissing = process.argv.includes('--if-missing');

async function get(url: string): Promise<Buffer | null> {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url); if (r.status === 404) return null; if (!r.ok) throw new Error(String(r.status)); return Buffer.from(await r.arrayBuffer()); }
    catch { await new Promise((res) => setTimeout(res, 500 * 2 ** i)); }
  }
  return null;
}
const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

function parseAnims(xml: string): Map<string, { copyOf?: string; fw: number; fh: number; durations: number[] }> {
  const out = new Map<string, { copyOf?: string; fw: number; fh: number; durations: number[] }>();
  for (const block of xml.split('<Anim>').slice(1)) {
    const name = tag(block, 'Name'); if (!name) continue;
    out.set(name, { copyOf: tag(block, 'CopyOf'), fw: Number(tag(block, 'FrameWidth') ?? 0), fh: Number(tag(block, 'FrameHeight') ?? 0),
      durations: [...block.matchAll(/<Duration>(\d+)<\/Duration>/g)].map((m) => Number(m[1])) });
  }
  return out;
}

async function fetchSpecies(id: string, dex: number): Promise<SkinEntry | null> {
  const dir = join(M.skinDir, id); mkdirSync(dir, { recursive: true });
  const code = String(dex).padStart(4, '0');
  const xmlBuf = await get(`${M.pmdBase}/${code}/AnimData.xml`);
  if (xmlBuf) {
    const anims = parseAnims(xmlBuf.toString('utf8')); const entry: SkinEntry = { source: 'pmd', anims: {} };
    for (const want of M.anims) {
      let a = anims.get(want); let name = want;
      for (let hop = 0; a?.copyOf && hop < 4; hop++) { name = a.copyOf; a = anims.get(name); }
      if (!a || !a.fw) continue;
      const file = `${name}-Anim.png`; const dest = join(dir, file);
      if (force || !existsSync(dest)) { const png = await get(`${M.pmdBase}/${code}/${file}`); if (!png) continue; writeFileSync(dest, png); }
      entry.anims[want.toLowerCase()] = { file: `${id}/${file}`, frameWidth: a.fw, frameHeight: a.fh, durations: a.durations };
    }
    if (entry.anims.walk) return entry;
  }
  const png = await get(`${M.fallbackBase}/${dex}.png`);
  if (!png) return null;
  writeFileSync(join(dir, 'static.png'), png);
  return { source: 'pokeapi', anims: { walk: { file: `${id}/static.png`, frameWidth: 96, frameHeight: 96, durations: [1] } } };
}

/** The CC0 tileset is committed (and recolored for the volcano look) — never overwrite it.
 *  Only restores the original Kenney sheet if the file is missing entirely (e.g. a broken checkout). */
async function fetchTileset(): Promise<void> {
  if (existsSync(M.tileset.dest)) return;
  const html = (await get(M.tileset.page))?.toString('utf8') ?? '';
  const url = /https:\/\/kenney\.nl\/media\/pages\/assets\/[^"']+\.zip/.exec(html)?.[0];
  if (!url) { console.warn('tileset: zip link not found; game falls back to procedural tiles'); return; }
  const zip = await get(url); if (!zip) return;
  const zipPath = join(tmpdir(), 'kenney-tiles.zip'); writeFileSync(zipPath, zip);
  mkdirSync(dirname(M.tileset.dest), { recursive: true });
  writeFileSync(M.tileset.dest, execFileSync('unzip', ['-p', zipPath, M.tileset.zipEntry]));
  console.log('tileset ok');
}

async function main(): Promise<void> {
  if (ifMissing && !force && existsSync(join(M.skinDir, 'manifest.json'))) {
    const have = JSON.parse(readFileSync(join(M.skinDir, 'manifest.json'), 'utf8')) as { species?: Record<string, unknown> };
    if (Object.keys(M.species).every((id) => have.species?.[id])) { console.log('[fetch-assets] skin cached, skipping'); return; }
  }
  mkdirSync(M.skinDir, { recursive: true });
  const skin: Record<string, SkinEntry> = {};
  for (const [id, dex] of Object.entries(M.species)) {
    const e = await fetchSpecies(id, dex);
    if (e) { skin[id] = e; console.log(`${id}: ${e.source} [${Object.keys(e.anims).join(', ')}]`); } else console.warn(`${id}: no sprite (placeholder will be used)`);
  }
  writeFileSync(join(M.skinDir, 'manifest.json'), JSON.stringify({ version: 1, species: skin }, null, 1));
  await fetchTileset();
}
// Never fail install/dev/build: on network errors the game falls back to placeholder shapes.
main().catch((e: unknown) => { console.warn('[fetch-assets] failed, placeholders will be used:', e); });
