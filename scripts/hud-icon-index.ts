// Writes public/assets/hud/icons/index.json listing available icon PNGs, so the game only requests files that exist
// (new artist icons auto-swap in on next dev/build without code changes).
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
const dir = 'public/assets/hud/icons';
const names = existsSync(dir) ? readdirSync(dir).filter((f) => /^icon-[a-z0-9-]+\.png$/.test(f)).map((f) => f.slice(5, -4)).sort() : [];
if (existsSync(dir)) writeFileSync(`${dir}/index.json`, JSON.stringify(names, null, 1) + '\n');
console.log(`[hud-icons] ${names.length} icons: ${names.join(', ')}`);
