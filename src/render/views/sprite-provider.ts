import Phaser from 'phaser';

export interface SkinAnim { file: string; frameWidth: number; frameHeight: number; durations: number[] }
export interface SkinManifest { version: number; species: Record<string, { source: string; anims: Record<string, SkinAnim> }> }
export type AnimName = 'idle' | 'walk' | 'attack' | 'hurt';

const SKIN_BASE = 'assets/skin/';
export const DARK_TILES_KEY = 'tiles-dark-32';
export const TILESET_KEY = 'tiles';
export const TILESET_URL = 'assets/cc0/kenney-roguelike-caves/tiles.png';

/** Swappable skin layer (ADR-010): sprites if public/assets/skin is present, otherwise placeholder shapes. */
export class SpriteProvider {
  static manifest: SkinManifest | null = null;
  static tiles = false;
  /** Artist 32px tileset name->frame index (tiles-dark-32.json), null = fall back to Kenney. */
  static darkTiles: Record<string, number> | null = null;
  private static rows = new Map<string, number>();

  static queueSkin(scene: Phaser.Scene, m: SkinManifest): void {
    SpriteProvider.manifest = m;
    for (const [sp, e] of Object.entries(m.species)) for (const [a, d] of Object.entries(e.anims))
      scene.load.spritesheet(`${sp}-${a}`, SKIN_BASE + d.file, { frameWidth: d.frameWidth, frameHeight: d.frameHeight });
  }

  /** Create 8-direction Phaser animations (PMD rows: S, SE, E, NE, N, NW, W, SW). */
  static createAnims(scene: Phaser.Scene): void {
    const m = SpriteProvider.manifest; if (!m) return;
    for (const [sp, e] of Object.entries(m.species)) for (const [a, d] of Object.entries(e.anims)) {
      const key = `${sp}-${a}`; if (!scene.textures.exists(key)) continue;
      const tex = scene.textures.get(key);
      tex.setFilter(Phaser.Textures.FilterMode.NEAREST);
      const src = tex.getSourceImage();
      const cols = Math.max(1, Math.floor(src.width / d.frameWidth)); const rows = Math.max(1, Math.floor(src.height / d.frameHeight));
      SpriteProvider.rows.set(key, rows);
      const frameMs = d.durations.length ? (d.durations.reduce((x, y) => x + y, 0) / d.durations.length) * (1000 / 60) : 120;
      for (let r = 0; r < rows; r++) {
        const k = `${key}-${r}`; if (scene.anims.exists(k)) continue;
        scene.anims.create({ key: k, frames: scene.anims.generateFrameNumbers(key, { start: r * cols, end: r * cols + cols - 1 }),
          frameRate: 1000 / frameMs, repeat: a === 'walk' || a === 'idle' ? -1 : 0 });
      }
    }
  }
  static has(species: string): boolean { return !!SpriteProvider.manifest?.species[species]; }
  /** Animation key for species/anim/facing angle; falls back to walk when anim missing. */
  static animKey(species: string, anim: AnimName, rot: number): string | null {
    const e = SpriteProvider.manifest?.species[species]; if (!e) return null;
    const a = e.anims[anim] ? anim : 'walk';
    const key = `${species}-${a}`; const rows = SpriteProvider.rows.get(key) ?? 1;
    const oct = ((Math.round(rot / (Math.PI / 4)) % 8) + 8) % 8; // 0=E,1=SE,2=S,...
    const row = [2, 1, 0, 7, 6, 5, 4, 3][oct] ?? 0;
    return `${key}-${rows >= 8 ? row : 0}`;
  }
}
