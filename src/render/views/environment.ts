import Phaser from 'phaser';

export interface Light { x: number; y: number; r: number; a?: number }
const LAVA = 'env-lava', LAVA_GLOW = 'env-lava-glow', LIGHT = 'env-light';

/** Volcano ambience: animated lava under the void, rising embers, and a darkness render-texture with soft light holes
 *  (no Light2D / normal maps). Render-only; Math.random allowed (VFX). */
export class Environment {
  private lava: Phaser.GameObjects.TileSprite;
  private glow: Phaser.GameObjects.TileSprite;
  private dark?: Phaser.GameObjects.RenderTexture;
  private stamp: Phaser.GameObjects.Image;
  private embers: Phaser.GameObjects.Particles.ParticleEmitter;
  darkness = 0.86;
  enabled = true;

  constructor(private scene: Phaser.Scene) {
    Environment.makeTextures(scene);
    this.lava = scene.add.tileSprite(0, 0, 16, 16, LAVA).setOrigin(0).setDepth(-2).setTint(0x9a7a6a);
    this.glow = scene.add.tileSprite(0, 0, 16, 16, LAVA_GLOW).setOrigin(0).setDepth(-1).setBlendMode(Phaser.BlendModes.ADD);
    this.stamp = scene.make.image({ key: LIGHT }, false);
    this.embers = scene.add.particles(0, 0, 'flare', {
      emitting: false, blendMode: Phaser.BlendModes.ADD, lifespan: { min: 1200, max: 2600 }, speedY: { min: -70, max: -25 }, speedX: { min: -20, max: 20 },
      scale: { start: 0.45, end: 0 }, alpha: { start: 0.9, end: 0 }, tint: [0xffd27a, 0xff8a20, 0xff4a10],
    }).setDepth(8.5);
  }

  /** Cover the floor's pixel bounds with lava (void tiles in the tilemap are empty, so lava shows through). */
  setBounds(w: number, h: number): void { this.lava.setSize(w, h); this.glow.setSize(w, h); }

  update(time: number, dt: number, cam: Phaser.Cameras.Scene2D.Camera, lights: Light[]): void {
    this.lava.tilePositionX = time * 6; this.lava.tilePositionY = time * 3.5;
    this.glow.tilePositionX = -time * 9; this.glow.tilePositionY = time * 5; this.glow.setAlpha(0.35 + 0.15 * Math.sin(time * 1.7));
    // embers drift up anywhere in view (mostly visible over the lava)
    const v = cam.worldView; const n = Math.random() < dt * 28 ? 1 : 0;
    if (n) this.embers.emitParticleAt(v.x + Math.random() * v.width, v.y + v.height * (0.3 + Math.random() * 0.8), 1);
    // darkness mask
    // low-res mask (1/RES) upscaled with linear filtering: lights are soft anyway, and it's ~16x cheaper on fill-rate
    const RES = 4; const W = Math.ceil(this.scene.scale.width / RES), H = Math.ceil(this.scene.scale.height / RES);
    if (!this.dark || this.dark.width !== W || this.dark.height !== H) {
      this.dark?.destroy();
      this.dark = this.scene.add.renderTexture(0, 0, W, H).setOrigin(0).setScrollFactor(0).setDepth(9).setScale(RES);
    }
    const d = this.dark; d.setVisible(this.enabled); if (!this.enabled) return;
    d.clear(); d.fill(0x05020a, this.darkness);
    for (const l of lights) {
      const r = l.r / RES, sx = (l.x - v.x) / RES, sy = (l.y - v.y) / RES; if (sx < -r || sy < -r || sx > W + r || sy > H + r) continue;
      this.stamp.setScale((r * 2) / 256).setAlpha(l.a ?? 1);
      d.erase(this.stamp, sx, sy);
    }
  }

  static makeTextures(scene: Phaser.Scene): void {
    const tex = scene.textures;
    if (!tex.exists(LIGHT)) {
      const c = tex.createCanvas(LIGHT, 256, 256); const ctx = c?.getContext();
      if (c && ctx) { const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.45, 'rgba(255,255,255,0.75)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256); c.refresh(); }
    }
    const noise = (key: string, base: [number, number, number], hot: [number, number, number], k: number): void => {
      if (tex.exists(key)) return;
      const S = 128; const c = tex.createCanvas(key, S, S); const ctx = c?.getContext(); if (!c || !ctx) return;
      const img = ctx.createImageData(S, S);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const u = (x / S) * Math.PI * 2, w = (y / S) * Math.PI * 2; // tileable sum of sines
        let n = Math.sin(u * 2 + Math.sin(w * 3) * 1.3) + Math.sin(w * 2 + Math.sin(u * 3) * 1.1) + 0.5 * Math.sin((u + w) * 5) + 0.35 * Math.sin((u - w) * 7);
        n = Math.max(0, 1 - Math.abs(n) * k); const t = n ** 2.2; const i = (y * S + x) * 4;
        img.data[i] = base[0] + (hot[0] - base[0]) * t; img.data[i + 1] = base[1] + (hot[1] - base[1]) * t; img.data[i + 2] = base[2] + (hot[2] - base[2]) * t; img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0); c.refresh();
    };
    noise(LAVA, [70, 8, 2], [255, 170, 40], 0.9);
    noise(LAVA_GLOW, [0, 0, 0], [180, 60, 10], 1.6);
  }
}

/** Rolling FPS stats for the F3 overlay. */
export class FpsMeter {
  private samples: { t: number; fps: number }[] = [];
  push(t: number, fps: number): void { this.samples.push({ t, fps }); while (this.samples.length && (this.samples[0]?.t ?? t) < t - 10) this.samples.shift(); }
  stats(): { now: number; avg: number; min: number } {
    const s = this.samples; if (!s.length) return { now: 0, avg: 0, min: 0 };
    return { now: s[s.length - 1]?.fps ?? 0, avg: s.reduce((a, b) => a + b.fps, 0) / s.length, min: Math.min(...s.map((x) => x.fps)) };
  }
}
