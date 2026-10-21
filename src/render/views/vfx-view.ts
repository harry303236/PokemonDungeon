import Phaser from 'phaser';
import type { Entity } from '../../core/ecs/world';

interface VfxMeta { file: string; frameWidth: number; frameHeight: number; frames: number; order?: string[] }
const INDEX = 'vfx-index';
const P = { spark: 0, ember: 1, smoke: 2, ring: 3, scorch: 4, flash: 5 } as const;

/** Artist VFX sheets (public/assets/vfx, see vfx-index.json). All art faces RIGHT -> rotated to cast direction. */
export class VfxAssets {
  static ok = false;
  static queueIndex(scene: Phaser.Scene): void { scene.load.json(INDEX, 'assets/vfx/vfx-index.json'); }
  static queueSheets(scene: Phaser.Scene): void {
    const idx = scene.cache.json.get(INDEX) as Record<string, VfxMeta> | undefined;
    if (!idx || typeof idx !== 'object') return;
    for (const [k, m] of Object.entries(idx)) if (m && /^[\w.-]+\.png$/.test(m.file)) scene.load.spritesheet(`vfx-${k}`, `assets/vfx/${m.file}`, { frameWidth: m.frameWidth, frameHeight: m.frameHeight });
  }
  static createAnims(scene: Phaser.Scene): void {
    const idx = scene.cache.json.get(INDEX) as Record<string, VfxMeta> | undefined; if (!idx) return;
    const rate: Record<string, number> = { 'flamethrower-start': 30, 'flamethrower-loop': 20, 'flamethrower-end': 24, 'fire-spin': 16, 'fire-blast-warn': 20, 'fire-blast': 24, ember: 20, 'flame-charge': 24 };
    const loop = new Set(['flamethrower-loop', 'fire-spin', 'ember', 'flame-charge']);
    for (const [k, m] of Object.entries(idx)) {
      if (k === 'particles' || !scene.textures.exists(`vfx-${k}`) || scene.anims.exists(`vfx-${k}`)) continue;
      scene.anims.create({ key: `vfx-${k}`, frames: scene.anims.generateFrameNumbers(`vfx-${k}`, { start: 0, end: m.frames - 1 }), frameRate: rate[k] ?? 20, repeat: loop.has(k) ? -1 : 0 });
    }
    VfxAssets.ok = ['ember', 'flamethrower-loop', 'fire-spin', 'fire-blast', 'flame-charge', 'particles'].every((k) => scene.textures.exists(`vfx-${k}`));
  }
}

type Pose = (e: { id: number; x: number; y: number }) => { x: number; y: number };

/** Binds artist VFX sprites to sim entities each frame; particles from the shared sheet are accents. */
export class VfxView {
  private bound = new Map<number, Phaser.GameObjects.Sprite>();
  private beamPhase = new Map<number, 'start' | 'loop'>();
  private blastPos = new Map<number, { x: number; y: number; r: number }>();
  private dashAura?: Phaser.GameObjects.Sprite;
  private sparks: Phaser.GameObjects.Particles.ParticleEmitter;
  private embers: Phaser.GameObjects.Particles.ParticleEmitter;
  private smoke: Phaser.GameObjects.Particles.ParticleEmitter;
  constructor(private scene: Phaser.Scene) {
    const add = Phaser.BlendModes.ADD;
    this.sparks = scene.add.particles(0, 0, 'vfx-particles', { frame: [P.spark], emitting: false, blendMode: add, lifespan: { min: 200, max: 450 }, speed: { min: 80, max: 260 }, scale: { start: 1.2, end: 0 }, rotate: { min: 0, max: 360 } }).setDepth(6);
    this.embers = scene.add.particles(0, 0, 'vfx-particles', { frame: [P.ember], emitting: false, blendMode: add, lifespan: { min: 300, max: 700 }, speed: { min: 10, max: 60 }, scale: { start: 1, end: 0 }, alpha: { start: 1, end: 0 } }).setDepth(6);
    this.smoke = scene.add.particles(0, 0, 'vfx-particles', { frame: [P.smoke], emitting: false, lifespan: { min: 700, max: 1300 }, speedY: { min: -40, max: -15 }, speedX: { min: -12, max: 12 }, scale: { start: 1.5, end: 3.5 }, alpha: { start: 0.45, end: 0 } }).setDepth(5);
  }

  private sprite(id: number, key: string, depth: number): Phaser.GameObjects.Sprite {
    let s = this.bound.get(id);
    if (!s) { s = this.scene.add.sprite(0, 0, key).setDepth(depth).setBlendMode(Phaser.BlendModes.ADD); this.bound.set(id, s); }
    return s;
  }
  oneShot(key: string, x: number, y: number, scale: number, rot = 0, depth = 6): void {
    if (!this.scene.anims.exists(key)) return;
    const s = this.scene.add.sprite(x, y, key).setScale(scale).setRotation(rot).setDepth(depth).setBlendMode(Phaser.BlendModes.ADD);
    s.play(key); s.once('animationcomplete', () => s.destroy());
  }
  /** Scorch decal on the floor (normal blend, fades out). */
  scorch(x: number, y: number, r: number): void {
    const d = this.scene.add.image(x, y, 'vfx-particles', P.scorch).setScale((r * 2) / 16).setDepth(0.6).setAlpha(0.8).setRotation(Math.random() * 6.28);
    this.scene.tweens.add({ targets: d, alpha: 0, delay: 3500, duration: 1500, onComplete: () => d.destroy() });
  }
  private ring(x: number, y: number): void {
    const ring = this.scene.add.image(x, y, 'vfx-particles', P.ring).setBlendMode(Phaser.BlendModes.ADD).setDepth(6).setScale(0.8);
    this.scene.tweens.add({ targets: ring, scale: 2.2, alpha: 0, duration: 220, onComplete: () => ring.destroy() });
  }
  /** Hit: impact ring + flash + sparks. */
  hit(x: number, y: number, big: boolean): void {
    const ring = this.scene.add.image(x, y, 'vfx-particles', P.ring).setBlendMode(Phaser.BlendModes.ADD).setDepth(6).setScale(1);
    this.scene.tweens.add({ targets: ring, scale: big ? 4.5 : 3, alpha: 0, duration: 260, onComplete: () => ring.destroy() });
    const fl = this.scene.add.image(x, y, 'vfx-particles', P.flash).setBlendMode(Phaser.BlendModes.ADD).setDepth(6).setScale(big ? 3 : 2).setAlpha(0.9);
    this.scene.tweens.add({ targets: fl, alpha: 0, scale: big ? 4 : 2.6, duration: 120, onComplete: () => fl.destroy() });
    this.sparks.emitParticleAt(x, y, big ? 12 : 6);
  }

  sync(entities: Iterable<Entity>, player: Entity, pose: Pose): void {
    const live = new Set<number>(); const pv = pose(player);
    for (const e of entities) {
      if (e.dead) continue;
      if (e.kind === 'projectile' && e.team === 'player') {
        live.add(e.id); const s = this.sprite(e.id, 'vfx-ember', 5); const v = pose(e);
        if (!s.anims.isPlaying) s.play('vfx-ember');
        s.setPosition(v.x, v.y).setRotation(Math.atan2(e.vy, e.vx)).setScale((e.r * 6) / 128);
        if (Math.random() < 0.4) this.embers.emitParticleAt(v.x, v.y, 1);
      } else if (e.kind === 'beam') {
        live.add(e.id); const s = this.sprite(e.id, 'vfx-flamethrower-start', 5);
        const phase = this.beamPhase.get(e.id);
        if (!phase) { s.play('vfx-flamethrower-start'); this.beamPhase.set(e.id, 'start'); s.once('animationcomplete', () => { if (this.bound.get(e.id) === s) { s.play('vfx-flamethrower-loop'); this.beamPhase.set(e.id, 'loop'); } }); }
        const a = player.rot + e.rot; const full = e.len ?? 300; const reach = e.reach ?? full;
        // mouth: a bit forward of the sprite centre and raised (sprite origin is at the feet-ish 0.62)
        const mx = pv.x + Math.cos(a) * 14, my = pv.y + Math.sin(a) * 10 - 10;
        const len = Math.max(8, reach - 10);
        s.setOrigin(0.04, 0.5).setPosition(mx, my).setRotation(a).setScale(len / 240, ((e.width ?? 55) * 3) / 128);
        const ex = mx + Math.cos(a) * len, ey = my + Math.sin(a) * len;
        if (Math.random() < 0.5) { const d = Math.random() * len; this.smoke.emitParticleAt(mx + Math.cos(a) * d, my + Math.sin(a) * d, 1); }
        if (reach < full - 4) { // wall hit: small ring + sparks at the contact point
          this.sparks.emitParticleAt(ex, ey, 2);
          if (Math.random() < 0.18) this.ring(ex, ey);
        } else if (Math.random() < 0.6) { const d = len * (0.6 + Math.random() * 0.4); this.sparks.emitParticleAt(mx + Math.cos(a) * d, my + Math.sin(a) * d, 1); }
      } else if (e.kind === 'zone') {
        live.add(e.id); const s = this.sprite(e.id, 'vfx-fire-spin', 0.8); const v = pose(e);
        if (!s.anims.isPlaying) { s.play('vfx-fire-spin'); this.scorch(v.x, v.y, e.r * 0.9); }
        s.setPosition(v.x, v.y).setScale((e.r * 2.3) / 128);
        if (Math.random() < 0.25) this.smoke.emitParticleAt(v.x + (Math.random() - 0.5) * e.r, v.y + (Math.random() - 0.5) * e.r, 1);
      } else if (e.kind === 'blast') {
        live.add(e.id); const s = this.sprite(e.id, 'vfx-fire-blast-warn', 0.9); const v = pose(e);
        if (!s.anims.isPlaying && !s.anims.currentAnim) s.play('vfx-fire-blast-warn');
        s.setPosition(v.x, v.y).setScale((e.r * 2.2) / 256); this.blastPos.set(e.id, { x: v.x, y: v.y, r: e.r });
      }
    }
    // dash aura + trail
    if (player.dash?.moveId) {
      if (!this.dashAura) { this.dashAura = this.scene.add.sprite(pv.x, pv.y, 'vfx-flame-charge').setDepth(4).setBlendMode(Phaser.BlendModes.ADD).play('vfx-flame-charge'); }
      this.dashAura.setPosition(pv.x, pv.y).setRotation(Math.atan2(player.dash.dirY, player.dash.dirX)).setScale(0.9);
      this.embers.emitParticleAt(pv.x, pv.y, 3); this.smoke.emitParticleAt(pv.x, pv.y, 1);
    } else if (this.dashAura) { this.dashAura.destroy(); this.dashAura = undefined; }
    for (const [id, s] of this.bound) {
      if (live.has(id)) continue;
      if (this.beamPhase.has(id)) { // play end then destroy
        s.play('vfx-flamethrower-end'); s.once('animationcomplete', () => s.destroy()); this.beamPhase.delete(id);
      } else s.destroy();
      this.bound.delete(id);
      const b = this.blastPos.get(id);
      if (b) {
        this.oneShot('vfx-fire-blast', b.x, b.y, (b.r * 2.8) / 256); this.scorch(b.x, b.y, b.r); this.hit(b.x, b.y, true);
        for (let i = 0; i < 8; i++) this.smoke.emitParticleAt(b.x + (Math.random() - 0.5) * b.r, b.y + (Math.random() - 0.5) * b.r, 1);
        this.blastPos.delete(id);
      }
    }
  }
}
