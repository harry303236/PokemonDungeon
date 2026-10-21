import Phaser from 'phaser';
import type { Entity } from '../../core/ecs/world';
import { variantVfx } from '../../core/build/build';

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
    const loop = new Set(['flamethrower-loop', 'fire-spin', 'ember', 'flame-charge', 'ember-volley', 'ft-focus', 'ft-spread', 'fs-prison', 'fs-tornado', 'fc-comet', 'ground-fire', 'status-burning', 'status-fire-seed', 'chain-line', 'rx-sun-chain']);
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
  private blastPos = new Map<number, { x: number; y: number; r: number; v?: string | null }>();
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
  private has(key: string): boolean { return this.scene.anims.exists(key); }
  /** Stretch a horizontal sheet (origin left-middle) from (x1,y1) to (x2,y2), play briefly. */
  line(key: string, x1: number, y1: number, x2: number, y2: number, ms = 260): void {
    if (!this.has(key)) return; const d = Math.hypot(x2 - x1, y2 - y1); if (d < 4) return;
    const s = this.scene.add.sprite(x1, y1, key).setOrigin(0, 0.5).setRotation(Math.atan2(y2 - y1, x2 - x1)).setScale(d / 256, 1.4).setDepth(8.6).setBlendMode(Phaser.BlendModes.ADD); // above enemies + darkness mask
    s.play(key); this.scene.time.delayedCall(ms, () => s.destroy());
  }
  /** Reaction/one-shot hints from the sim (keys from vfx-index.json; aliases resolved here per _aliases notes). */
  reaction(e: { id: string; x: number; y: number; r: number; vfx?: string; x2?: number; y2?: number }): void {
    const k = `vfx-${e.vfx ?? 'detonate'}`;
    if (e.id === 'seed_detonate') { this.oneShot('vfx-detonate', e.x, e.y, (e.r * 2.4) / 256); if (e.x2 !== undefined && e.y2 !== undefined) this.line('vfx-chain-line', e.x2, e.y2, e.x, e.y); }
    else if (e.id === 'sticky_early') this.oneShot('vfx-detonate', e.x, e.y, 0.5);
    else if (e.id === 'sun_chain' && e.x2 !== undefined && e.y2 !== undefined) this.line('vfx-rx-sun-chain', e.x2, e.y2, e.x, e.y, 320);
    else if (e.id === 'charge_through_spin') { /* ring itself is drawn by the attached zone (scale 0.7, normal blend) */ }
    else if (this.has(k)) this.oneShot(k, e.x, e.y, Math.max(0.5, (e.r * 2.4) / 128));
    else { this.oneShot('vfx-fire-blast', e.x, e.y, (e.r * 2.6) / 256); }
    this.hit(e.x, e.y, true);
  }
  fxHint(e: { key: string; x: number; y: number; r?: number; x2?: number; y2?: number }): void {
    if (e.key === 'chain-line' && e.x2 !== undefined && e.y2 !== undefined) this.line('vfx-chain-line', e.x2, e.y2, e.x, e.y);
    else this.oneShot(`vfx-${e.key}`, e.x, e.y, ((e.r ?? 64) * 2) / 128);
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
    const live = new Set<number>(); const pv = pose(player); const all = [...entities]; const entities2 = all;
    for (const e of all) {
      if (e.dead) continue;
      if (e.kind === 'projectile' && e.team === 'player') {
        live.add(e.id); const vk = `vfx-${variantVfx(e.mods?.spec?.variant) ?? 'ember'}`; const key = this.has(vk) && e.moveId === 'ember' ? vk : 'vfx-ember';
        const s = this.sprite(e.id, key, 5); const v = pose(e);
        if (!s.anims.isPlaying) s.play(key);
        s.setPosition(v.x, v.y).setRotation(Math.atan2(e.vy, e.vx)).setScale((e.r * 6) / (key === 'vfx-ember' ? 128 : 64));
        if (Math.random() < 0.4) this.embers.emitParticleAt(v.x, v.y, 1);
      } else if (e.kind === 'beam') {
        const bv = e.mods?.spec?.variant;
        if ((bv === 'ft_focus' || bv === 'ft_spread') && this.has(`vfx-${variantVfx(bv)}`)) {
          live.add(e.id); const key = `vfx-${variantVfx(bv)}`; const s = this.sprite(e.id, key, 5); if (!s.anims.isPlaying) s.play(key);
          const a = player.rot + e.rot; const len = Math.max(8, (e.reach ?? e.len ?? 300) - 10);
          const mx = pv.x + Math.cos(a) * 14, my = pv.y + Math.sin(a) * 10 - 10;
          if (bv === 'ft_focus') {
            const sy = Math.max(0.5, ((e.width ?? 16) * 2.5) / 64) * 1.5; // artist: height x1.5
            s.setOrigin(0, 0.5).setPosition(mx, my).setRotation(a).setScale(len / 256, sy);
            const gid = -1e6 - e.id; live.add(gid); const gl = this.sprite(gid, key, 4.9); if (!gl.anims.isPlaying) gl.play(key); // underlay glow
            gl.setOrigin(0, 0.5).setPosition(mx, my).setRotation(a).setScale(len / 256, sy * 2.2).setAlpha(0.4);
          }
          else { s.setVisible(Math.abs(e.rot) < 0.01); s.setOrigin(0.1, 0.5).setPosition(mx, my).setRotation(a).setScale((len * 1.1) / 115); } // one fan sprite for the whole spread
          if (Math.random() < 0.3) this.sparks.emitParticleAt(mx + Math.cos(a) * len, my + Math.sin(a) * len, 1);
          continue;
        }
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
        live.add(e.id); const zk0 = `vfx-${variantVfx(e.mods?.spec?.variant) ?? 'fire-spin'}`; const zk = this.has(zk0) ? zk0 : 'vfx-fire-spin';
        const s = this.sprite(e.id, zk, 0.8); const v = pose(e);
        if (!s.anims.isPlaying) { s.play(zk); if (!e.follow) this.scorch(v.x, v.y, e.r * 0.9); }
        if (e.scale && player.dash) s.setPosition(v.x, v.y).setScale(e.scale).setBlendMode(Phaser.BlendModes.NORMAL); // charge_through_spin: ring 0.7 during charge
        else s.setPosition(v.x, v.y).setScale((e.r * 2.3) / 128).setBlendMode(Phaser.BlendModes.ADD);
        if (Math.random() < 0.25) this.smoke.emitParticleAt(v.x + (Math.random() - 0.5) * e.r, v.y + (Math.random() - 0.5) * e.r, 1);
      } else if (e.kind === 'blast') {
        live.add(e.id); const v = pose(e); const bv = e.sub === 'sticky' ? 'sticky' : e.mods?.spec?.variant ?? null;
        const wk = bv === 'sticky' ? 'vfx-status-fire-seed' : bv === 'fb_meteor' && this.has('vfx-fb-meteor') ? 'vfx-fb-meteor' : 'vfx-fire-blast-warn';
        const s = this.sprite(e.id, wk, 0.9);
        if (!s.anims.isPlaying && !s.anims.currentAnim) s.play(wk);
        s.setPosition(v.x, v.y).setScale(wk === 'vfx-fire-blast-warn' ? (e.r * 2.2) / 256 : wk === 'vfx-fb-meteor' ? (e.r * 1.6) / 128 : 0.7);
        this.blastPos.set(e.id, { x: v.x, y: v.y, r: e.r, v: bv });
      }
    }
    for (const e of entities2) {
      if (e.dead) continue;
      if (e.kind === 'ground') {
        const sunK = e.sub === 'fire' && e.sunlit && this.has('vfx-rx-ground-sun');
        const key = e.sub === 'seed' ? 'vfx-status-fire-seed' : sunK ? 'vfx-rx-ground-sun' : 'vfx-ground-fire'; if (!this.has(key)) continue;
        live.add(e.id); const s = this.sprite(e.id, key, e.sub === 'seed' ? 0.75 : 0.65); if (!s.anims.isPlaying) s.play(key);
        s.setPosition(e.x, e.y).setScale(e.sub === 'seed' ? 0.7 : (e.r * 2.6) / 128).setAlpha(Math.min(1, (e.life ?? 1) * 2));
        if (sunK) s.setBlendMode(Phaser.BlendModes.NORMAL).clearTint().setDepth(0.62); // ground_sun: tiled sea of fire, normal blend, no additive/white
      } else if (e.kind === 'monster' && e.burn && this.has('vfx-status-burning')) {
        const id = -e.id; live.add(id); const s = this.sprite(id, 'vfx-status-burning', 3); if (!s.anims.isPlaying) s.play('vfx-status-burning');
        const v = pose(e); s.setPosition(v.x, v.y - e.r * 1.6).setScale(0.45);
      }
    }
    // dash aura + trail
    if (player.dash?.moveId) {
      const comet = player.mods?.spec?.variant === 'fc_comet' && this.has('vfx-fc-comet');
      if (!this.dashAura) { const k = comet ? 'vfx-fc-comet' : 'vfx-flame-charge'; this.dashAura = this.scene.add.sprite(pv.x, pv.y, k).setDepth(4).setBlendMode(Phaser.BlendModes.ADD).play(k); }
      this.dashAura.setPosition(pv.x, pv.y).setRotation(Math.atan2(player.dash.dirY, player.dash.dirX)).setOrigin(comet ? 0.85 : 0.5, 0.5).setScale(comet ? 0.8 : 0.9);
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
        const ek = b.v === 'fb_star' && this.has('vfx-fb-star') ? 'vfx-fb-star' : (b.v === 'fb_meteor' || b.v === 'sticky') && this.has('vfx-detonate') ? 'vfx-detonate' : 'vfx-fire-blast';
        this.oneShot(ek, b.x, b.y, ((b.v === 'sticky' ? b.r * 1.6 : b.r * 2.8)) / 256); this.scorch(b.x, b.y, b.v === 'sticky' ? b.r * 0.5 : b.r); this.hit(b.x, b.y, b.v !== 'sticky');
        for (let i = 0; i < 8; i++) this.smoke.emitParticleAt(b.x + (Math.random() - 0.5) * b.r, b.y + (Math.random() - 0.5) * b.r, 1);
        this.blastPos.delete(id);
      }
    }
  }
}
