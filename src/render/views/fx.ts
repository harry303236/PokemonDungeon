import Phaser from 'phaser';

const FIRE = [0xfff2a0, 0xffb030, 0xff6010, 0xd02000];
const WATER = [0xd0f0ff, 0x60b0ff, 0x2060d0];
type Emitter = Phaser.GameObjects.Particles.ParticleEmitter;

/** Phaser particle FX for fire moves; render-only, may use Math.random (AGENTS.md VFX exception). */
export class Fx {
  private trail: Emitter; private burst: Emitter; private flame: Emitter; private water: Emitter; private rise: Emitter;
  constructor(private scene: Phaser.Scene) {
    const base = { emitting: false, blendMode: Phaser.BlendModes.ADD };
    this.trail = scene.add.particles(0, 0, 'flare', { ...base, lifespan: 280, speed: { min: 5, max: 40 }, scale: { start: 0.9, end: 0 }, tint: FIRE, alpha: { start: 1, end: 0 } });
    this.burst = scene.add.particles(0, 0, 'flare', { ...base, lifespan: { min: 300, max: 600 }, speed: { min: 60, max: 260 }, scale: { start: 1.4, end: 0 }, tint: FIRE, alpha: { start: 1, end: 0 } });
    this.flame = scene.add.particles(0, 0, 'flare', { ...base, lifespan: { min: 200, max: 420 }, speed: { min: 20, max: 90 }, scale: { start: 1.6, end: 0.1 }, tint: FIRE, alpha: { start: 0.9, end: 0 } });
    this.rise = scene.add.particles(0, 0, 'flare', { ...base, lifespan: { min: 400, max: 800 }, speedY: { min: -90, max: -30 }, speedX: { min: -15, max: 15 }, scale: { start: 1.3, end: 0 }, tint: FIRE, alpha: { start: 0.8, end: 0 } });
    this.water = scene.add.particles(0, 0, 'spark', { emitting: false, lifespan: 300, speed: { min: 10, max: 60 }, scale: { start: 1, end: 0 }, tint: WATER, alpha: { start: 1, end: 0 } });
    for (const e of [this.trail, this.burst, this.flame, this.rise, this.water]) e.setDepth(6);
  }
  projectile(x: number, y: number, enemy: boolean): void { (enemy ? this.water : this.trail).emitParticleAt(x, y, enemy ? 1 : 2); }
  muzzle(x: number, y: number, rot: number): void { this.flame.emitParticleAt(x + Math.cos(rot) * 14, y + Math.sin(rot) * 14, 6); }
  hit(x: number, y: number, big: boolean): void { this.burst.emitParticleAt(x, y, big ? 18 : 7); }
  beam(x: number, y: number, rot: number, len: number, width: number): void {
    for (let i = 0; i < 7; i++) {
      const d = Math.random() * len; const off = (Math.random() - 0.5) * width;
      this.flame.emitParticleAt(x + Math.cos(rot) * d - Math.sin(rot) * off, y + Math.sin(rot) * d + Math.cos(rot) * off, 1);
    }
  }
  zone(x: number, y: number, r: number): void {
    for (let i = 0; i < 3; i++) { const a = Math.random() * Math.PI * 2; const d = Math.sqrt(Math.random()) * r; this.rise.emitParticleAt(x + Math.cos(a) * d, y + Math.sin(a) * d, 1); }
  }
  telegraph(x: number, y: number, r: number): void { const a = Math.random() * Math.PI * 2; this.trail.emitParticleAt(x + Math.cos(a) * r, y + Math.sin(a) * r, 1); }
  explosion(x: number, y: number, r: number): void {
    this.burst.emitParticleAt(x, y, 50);
    for (let i = 0; i < 20; i++) { const a = (i / 20) * Math.PI * 2; this.rise.emitParticleAt(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8, 1); }
  }
  dash(x: number, y: number): void { this.flame.emitParticleAt(x, y, 4); }
  burnTick(x: number, y: number): void { if (Math.random() < 0.15) this.rise.emitParticleAt(x + (Math.random() - 0.5) * 16, y - 6, 1); }
}
