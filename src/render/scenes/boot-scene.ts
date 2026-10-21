import Phaser from 'phaser';
import { queueHudArt, generateHudTextures } from '../hud/hud-art';
import { SpriteProvider, TILESET_KEY, TILESET_URL, type SkinManifest } from '../views/sprite-provider';

/** Loads optional skin (sprites) + CC0 tileset. Missing files are tolerated -> placeholder rendering. */
export class BootScene extends Phaser.Scene {
  constructor() { super('boot'); }
  preload(): void {
    this.load.on('loaderror', (f: Phaser.Loader.File) => console.info(`[skin] optional asset missing: ${f.key}`));
    this.load.text('skin-manifest', 'assets/skin/manifest.json'); // text, so an SPA 404 fallback page can't throw
    queueHudArt(this);
    this.load.spritesheet(TILESET_KEY, TILESET_URL, { frameWidth: 16, frameHeight: 16, spacing: 1 });
  }
  create(): void {
    this.makeFxTextures();
    generateHudTextures(this); // procedural fallback for any HUD slice that failed to load
    SpriteProvider.tiles = this.textures.exists(TILESET_KEY);
    if (SpriteProvider.tiles) this.textures.get(TILESET_KEY).setFilter(Phaser.Textures.FilterMode.NEAREST);
    let m: SkinManifest | undefined;
    try { m = JSON.parse(String(this.cache.text.get('skin-manifest') ?? '')) as SkinManifest; } catch { console.info('[skin] no skin manifest; using placeholders'); }
    if (!m?.species) { this.scene.start('title'); return; }
    SpriteProvider.queueSkin(this, m);
    this.load.once('complete', () => { SpriteProvider.createAnims(this); this.scene.start('title'); });
    this.load.start();
  }
  private makeFxTextures(): void {
    const g = this.make.graphics({}, false);
    for (let i = 8; i > 0; i--) { g.fillStyle(0xffffff, 0.12 + (8 - i) * 0.1); g.fillCircle(8, 8, i); }
    g.generateTexture('flare', 16, 16); g.clear();
    g.fillStyle(0xffffff).fillCircle(3, 3, 3); g.generateTexture('spark', 6, 6); g.destroy();
  }
}
