import Phaser from 'phaser';
import { Environment, FpsMeter, type Light } from '../views/environment';
import { VfxAssets, VfxView } from '../views/vfx-view';
import { Sim, MAX_FLOOR, xpToNext, type Progress } from '../../core/sim';
import { BALANCE } from '../../core/balance';
import { WALL } from '../../core/dungeon/bsp-gen';
import { clampToFloor } from '../../core/dungeon/pathfind';
import { monster as monsterData, move as moveData } from '../../data/registry';
import { moveCooldown } from '../../core/moves/cooldown';
import { SpriteProvider, TILESET_KEY, DARK_TILES_KEY, type AnimName } from '../views/sprite-provider';
import { renderPose } from '../views/render-pose';
import { Fx } from '../views/fx';
import { SkillPanelView } from '../views/skill-panel-view';
import { Hud, type HudBuff } from '../hud/hud';
import { HUD_FONT, PALETTE } from '../hud/hud-theme';
import { POTION_CD } from '../../core/sim';
import { TapBuffer } from '../input/tap-buffer';
import { InputMap, SLOT_LABELS } from '../input/input-map';
import { InventoryView } from '../views/inventory-view';
import { saveProgress } from '../save-io';
import { t } from '../../i18n/t';

const T = BALANCE.TILE;
const SPECIES_COLOR: Record<string, number> = { charmander: 0xf08030, charmeleon: 0xd04020, charizard: 0xe86a20 };
const RARITY_COLOR: Record<string, number> = { common: 0xdddddd, uncommon: 0x55ff55, rare: 0x5599ff, epic: 0xcc66ff, legendary: 0xffaa33 };
const hex = (s: string): number => parseInt(s.replace('#', ''), 16);

export class DungeonScene extends Phaser.Scene {
  private sim!: Sim;
  private input2!: InputMap;
  private mapG!: Phaser.GameObjects.Graphics;
  private g!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Graphics;
  private hudBar!: Hud;
  private taps = new TapBuffer(5);
  private help!: Phaser.GameObjects.Text;
  private hudText!: Phaser.GameObjects.Text;
  private banner!: Phaser.GameObjects.Text;
  private bannerT = 0;
  private acc = 0;
  private drawnFloor = -1;
  private inv!: InventoryView;
  private skills!: SkillPanelView;
  private saveT = 0;
  private fx!: Fx;
  private bars!: Phaser.GameObjects.Graphics;
  private sprites = new Map<number, Phaser.GameObjects.Sprite>();
  /** Positions before the latest fixed step, for render interpolation. */
  private prevPos = new Map<number, { x: number; y: number }>();
  private alpha = 1;
  /** Entities that actually moved on the last simulated step (not the last painted frame). */
  private moved = new Set<number>();
  private hurtUntil = new Map<number, number>();
  private castUntil = 0;
  private blasts = new Map<number, { x: number; y: number; r: number }>();
  private tileLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  private now = 0;
  private pending: { moveTo?: { x: number; y: number }; attackTarget?: number } = {};
  private lmb: { mode: 'ground' | 'attack' | 'force'; since: number } | null = null;
  private marker: { x: number; y: number; t: number } | null = null;
  private env!: Environment;
  private vfx: VfxView | null = null;
  private glowSpots: { img: Phaser.GameObjects.Image; x: number; y: number; ph: number; r: number }[] = [];
  private fpsMeter = new FpsMeter();
  private fpsText!: Phaser.GameObjects.Text;

  constructor() { super('dungeon'); }

  create(data: { progress: Progress }): void {
    this.sim = new Sim(data.progress);
    this.input2 = new InputMap(this);
    this.mapG = this.add.graphics();
    this.g = this.add.graphics().setDepth(1);
    this.bars = this.add.graphics().setDepth(7);
    this.fx = new Fx(this);
    this.env = new Environment(this);
    this.vfx = VfxAssets.ok ? new VfxView(this) : null;
    this.fpsText = this.add.text(16, 56, '', { fontFamily: 'monospace', fontSize: '13px', color: '#9cff9c', backgroundColor: 'rgba(0,0,0,0.6)', padding: { x: 6, y: 4 } }).setScrollFactor(0).setDepth(60).setVisible(false);
    this.input.keyboard?.on('keydown-F3', (ev: KeyboardEvent) => { ev.preventDefault(); this.fpsText.setVisible(!this.fpsText.visible); });
    (window as unknown as { __fps?: () => unknown; __env?: Environment }).__fps = () => this.fpsMeter.stats();
    (window as unknown as { __env?: Environment }).__env = this.env;
    this.hud = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.hudText = this.add.text(16, 0, '', { fontFamily: HUD_FONT, fontSize: '15px', color: PALETTE.text, stroke: PALETTE.shadow, strokeThickness: 4 }).setScrollFactor(0).setDepth(11);
    this.hudBar = new Hud(this);
    this.help = this.add.text(0, 0, t('hud.help.full'), { fontFamily: HUD_FONT, fontSize: '15px', color: PALETTE.text, backgroundColor: 'rgba(10,8,6,0.88)', padding: { x: 18, y: 14 }, lineSpacing: 6, stroke: PALETTE.shadow, strokeThickness: 2 })
      .setScrollFactor(0).setDepth(40).setOrigin(0.5).setVisible(false);
    this.banner = this.add.text(0, 80, '', { fontFamily: HUD_FONT, fontSize: '26px', color: PALETTE.dmgSuper, stroke: '#000', strokeThickness: 5 }).setScrollFactor(0).setDepth(11).setOrigin(0.5);
    this.inv = new InventoryView(() => this.sim, () => saveProgress(this.sim.progress));
    this.skills = new SkillPanelView(() => this.sim, () => saveProgress(this.sim.progress));
    this.events.once('shutdown', () => { this.inv.destroy(); this.skills.destroy(); });
    const kb = this.input.keyboard;
    kb?.addCapture('TAB,F1,F3');
    (['Q', 'W', 'E', 'R'] as const).forEach((key, i) => kb?.on(`keydown-${key}`, (ev: KeyboardEvent) => { if (!ev.repeat && !this.uiOpen()) this.taps.press(i + 1); }));
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => { if ((ptr.button === 2 || ptr.rightButtonDown()) && !this.uiOpen()) this.taps.press(0); });
    kb?.on('keydown-ONE', () => { if (!this.uiOpen()) this.sim.usePotion(0); });
    kb?.on('keydown-F1', () => this.help.setVisible(!this.help.visible));
    kb?.on('keydown-TAB', () => this.skills.toggle());
    kb?.on('keydown-I', () => { this.inv.toggle(); this.skills.setOpen(this.inv.open); });
    kb?.on('keydown-L', (ev: KeyboardEvent) => this.sim.debugLevelUp(ev.shiftKey)); // debug
    kb?.on('keydown-R', () => { if (this.sim.player.dead) this.sim.respawn(); });
    kb?.on('keydown-ENTER', () => { if (this.sim.victory) { saveProgress(this.sim.progress); this.scene.start('title'); } });
    this.cameras.main.setRoundPixels(true);
    this.bindEvents();
    this.bindPointer();
    // Debug/test hook (read-only use in automated browser checks).
    (window as unknown as { __pokedungeon?: unknown }).__pokedungeon = { sim: () => this.sim, cam: this.cameras.main, hudRects: () => this.hudBar.rects };
    this.bindHudDrop();
  }

  /** Rebinding on the HUD bar: drops from the DOM skill panel onto canvas slots, and in-bar drag (panel open). */
  private bindHudDrop(): void {
    const canvas = this.game.canvas;
    const toGame = (ev: DragEvent): { x: number; y: number } => { const r = canvas.getBoundingClientRect(); return { x: ((ev.clientX - r.left) * canvas.width) / r.width, y: ((ev.clientY - r.top) * canvas.height) / r.height }; };
    const over = (ev: DragEvent): void => { const p = toGame(ev); if (this.hudBar.slotAt(p.x, p.y)?.kind === 'skill') ev.preventDefault(); };
    const drop = (ev: DragEvent): void => {
      const p = toGame(ev); const slot = this.hudBar.slotAt(p.x, p.y); if (slot?.kind !== 'skill') return;
      ev.preventDefault();
      try { const d = JSON.parse(ev.dataTransfer?.getData('text/plain') ?? '') as { move?: string }; if (d.move) { this.sim.setSlot(slot.index, d.move); this.afterRebind(); } } catch { /* ignore */ }
    };
    canvas.addEventListener('dragover', over); canvas.addEventListener('drop', drop);
    this.events.once('shutdown', () => { canvas.removeEventListener('dragover', over); canvas.removeEventListener('drop', drop); });
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      const s = this.hudBar.slotAt(ptr.x, ptr.y);
      if (s?.kind === 'skill' && this.skills.open && ptr.leftButtonDown()) this.hudBar.dragFrom = s.index;
      if (s?.kind === 'item' && ptr.leftButtonDown() && !this.uiOpen()) this.sim.usePotion(s.index);
    });
    this.input.on('pointerup', (ptr: Phaser.Input.Pointer) => {
      const from = this.hudBar.dragFrom; this.hudBar.dragFrom = null; if (from === null) return;
      const s = this.hudBar.slotAt(ptr.x, ptr.y); const id = this.sim.slots[from] ?? null;
      if (s?.kind === 'skill' && s.index !== from && id) { this.sim.setSlot(s.index, id); this.afterRebind(); }
    });
  }
  private afterRebind(): void { saveProgress(this.sim.progress); if (this.skills.open) this.skills.render(); }

  private uiOpen(): boolean { return this.inv.open || this.skills.open; }

  private bindPointer(): void {
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (!ptr.leftButtonDown() || this.uiOpen() || this.sim.player.dead || this.hudBar.contains(ptr.x, ptr.y)) return;
      const wp = ptr.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      const shift = (ptr.event as MouseEvent | undefined)?.shiftKey ?? false;
      if (shift) { this.lmb = { mode: 'force', since: this.now }; return; }
      let best: number | undefined; let bd = Infinity;
      for (const m of this.sim.world.query('monster')) { const v = this.pose(m); const d = Math.hypot(v.x - wp.x, v.y - wp.y); if (d < m.r + 14 && d < bd) { bd = d; best = m.id; } }
      if (best !== undefined) { this.pending.attackTarget = best; this.lmb = { mode: 'attack', since: this.now }; return; }
      this.pending.moveTo = { x: wp.x, y: wp.y }; this.lmb = { mode: 'ground', since: this.now };
      const g = clampToFloor(this.sim.floor, wp.x, wp.y, T); this.marker = { x: g.x, y: g.y, t: 0.6 };
    });
    this.input.on('pointerup', (ptr: Phaser.Input.Pointer) => { if (!ptr.leftButtonDown()) this.lmb = null; });
  }

  private say(msg: string): void { this.banner.setText(msg); this.bannerT = 2.5; }

  private bindEvents(): void {
    const bus = this.sim.bus;
    bus.on('damage:dealt', (e) => {
      const color = e.target === this.sim.player.id ? PALETTE.dmgPlayer : e.typeEff > 1 ? PALETTE.dmgSuper : e.typeEff < 1 ? PALETTE.dmgWeak : PALETTE.dmg;
      const size = e.isCrit || e.typeEff > 1 ? 20 : 14;
      const tgt = this.sim.world.get(e.target);
      this.hurtUntil.set(e.target, this.now + 0.25);
      const big = e.isCrit || e.typeEff > 1 || (!!tgt?.maxHp && e.amount >= tgt.maxHp * 0.2);
      if (this.vfx) this.vfx.hit(e.x, e.y + 8, big); else this.fx.hit(e.x, e.y + 8, big);
      if (big || e.target === this.sim.player.id) this.cameras.main.shake(110, e.target === this.sim.player.id ? 0.006 : 0.004);
      const txt = this.add.text(e.x + Phaser.Math.Between(-8, 8), e.y, String(e.amount), { fontFamily: HUD_FONT, fontSize: `${size}px`, color, stroke: PALETTE.shadow, strokeThickness: 4 }).setOrigin(0.5).setDepth(5);
      this.tweens.add({ targets: txt, y: e.y - 36, alpha: 0, duration: 700, onComplete: () => txt.destroy() });
    });
    bus.on('move:cast', (e) => { this.hudBar.flashSlot(this.sim.slots.indexOf(e.moveId)); const p = this.sim.player; this.castUntil = this.now + 0.3; this.fx.muzzle(p.x, p.y, p.rot); });
    bus.on('player:levelup', (e) => { this.say(t('hud.levelup', { level: e.level })); saveProgress(this.sim.progress); });
    bus.on('player:evolve', (e) => { this.say(t(`hud.evolve.${e.stage}`)); saveProgress(this.sim.progress); });
    bus.on('floor:cleared', () => this.say(t('hud.exitOpen')));
    bus.on('loot:picked', () => { const it = this.sim.progress.inventory.at(-1); if (it) this.say(t('hud.loot', { rarity: t(`rarity.${it.rarity}`) })); if (this.inv.open) this.inv.render(); saveProgress(this.sim.progress); });
  }

  update(_time: number, deltaMs: number): void {
    this.now += deltaMs / 1000;
    this.acc += Math.min(0.1, deltaMs / 1000);
    const cmd = this.input2.read(this.sim.player.x, this.sim.player.y);
    const ptr = this.input.activePointer;
    if (this.lmb && !ptr.leftButtonDown()) this.lmb = null;
    if (this.pending.moveTo) cmd.moveTo = this.pending.moveTo;
    if (this.pending.attackTarget !== undefined) cmd.attackTarget = this.pending.attackTarget;
    this.pending = {};
    if (this.lmb?.mode === 'force') cmd.forceAttack = true;
    if (this.lmb?.mode === 'ground' && this.now - this.lmb.since > 0.25 && !cmd.moveX && !cmd.moveY) {
      const p = this.sim.player; const dx = cmd.aimX - p.x, dy = cmd.aimY - p.y; // hold = steer toward cursor
      if (Math.hypot(dx, dy) > 10) { cmd.moveX = dx; cmd.moveY = dy; }
    }
    if (this.inv.open || this.skills.open) { cmd.forceAttack = false; cmd.moveTo = undefined; cmd.attackTarget = undefined; cmd.slots = cmd.slots.map(() => false); cmd.moveX = 0; cmd.moveY = 0; cmd.dodge = false; }
    const prevFloor = this.sim.floorNo;
    let stepped = false;
    while (this.acc >= BALANCE.FIXED_DT) {
      this.capturePrev();
      cmd.taps = stepped ? undefined : this.taps.consume(); // latched taps go to the first tick only
      this.sim.step(BALANCE.FIXED_DT, cmd);
      this.acc -= BALANCE.FIXED_DT;
      stepped = true;
    }
    if (this.sim.floorNo !== prevFloor) {
      this.prevPos.clear(); this.moved.clear(); this.alpha = 1;
      saveProgress(this.sim.progress);
    } else {
      this.alpha = this.acc / BALANCE.FIXED_DT;
      if (stepped) this.noteMovement();
    }
    this.saveT += deltaMs / 1000; if (this.saveT > 60) { this.saveT = 0; saveProgress(this.sim.progress); }
    if (this.drawnFloor !== this.sim.floorNo) this.drawMap();
    this.focusCamera();
    this.drawEntities();
    this.drawHud(deltaMs / 1000);
    this.updateEnv(deltaMs / 1000);
  }

  private updateEnv(dt: number): void {
    const t = this.now; const lights: Light[] = [];
    const pv = this.pose(this.sim.player); lights.push({ x: pv.x, y: pv.y, r: 260 });
    for (const e of this.sim.world.entities.values()) {
      if (e.dead) continue;
      if (e.kind === 'projectile' && e.team === 'player') { const v = this.pose(e); lights.push({ x: v.x, y: v.y, r: 90, a: 0.8 }); }
      else if (e.kind === 'beam') { const a = this.sim.player.rot + e.rot; const L = e.reach ?? e.len ?? 300; for (let k = 1; k <= 3; k++) lights.push({ x: pv.x + Math.cos(a) * L * k / 3.2, y: pv.y + Math.sin(a) * L * k / 3.2, r: 120 }); }
      else if (e.kind === 'zone' || e.kind === 'blast') { const v = this.pose(e); lights.push({ x: v.x, y: v.y, r: e.r * 2.2, a: 0.9 }); }
    }
    const ex = this.sim.floor.exit; if (this.sim.exitOpen) lights.push({ x: (ex.cx + 0.5) * T, y: (ex.cy + 0.5) * T, r: 110, a: 0.8 });
    const v = this.cameras.main.worldView;
    for (const g of this.glowSpots) {
      const k = 0.55 + 0.45 * Math.sin(t * 2.4 + g.ph); g.img.setAlpha(k * 0.55);
      if (g.x > v.x - 80 && g.x < v.right + 80 && g.y > v.y - 80 && g.y < v.bottom + 80) lights.push({ x: g.x, y: g.y, r: g.r, a: 0.35 + 0.35 * k });
    }
    this.env.update(t, dt, this.cameras.main, lights);
    if (dt > 0) this.fpsMeter.push(t, 1 / dt);
    if (this.fpsText.visible) { const st = this.fpsMeter.stats(); this.fpsText.setText(`FPS ${this.game.loop.actualFps.toFixed(0)}  avg ${st.avg.toFixed(0)}  min ${st.min.toFixed(0)} (10s)  [F3]`); }
  }

  private drawMap(): void {
    const f = this.sim.floor; const g = this.mapG; g.clear();
    this.drawnFloor = this.sim.floorNo;
    this.tileLayers.forEach((l) => l.tilemap.destroy()); this.tileLayers = [];
    this.glowSpots.forEach((g) => g.img.destroy()); this.glowSpots = [];
    this.env.setBounds(f.w * T, f.h * T);
    if (SpriteProvider.darkTiles) { this.buildDarkTilemap(SpriteProvider.darkTiles); return; }
    if (SpriteProvider.tiles) { this.buildTilemap(); return; }
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const wall = f.tiles[y * f.w + x] === WALL;
      if (wall) {
        const nearFloor = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => f.tiles[(y + (dy ?? 0)) * f.w + x + (dx ?? 0)] === 1);
        if (nearFloor) { g.fillStyle(0x4a3b33).fillRect(x * T, y * T, T, T); g.fillStyle(0x5c4a40).fillRect(x * T, y * T, T, 6); }
      } else { g.fillStyle((x + y) % 2 ? 0x2a2420 : 0x2e2723).fillRect(x * T, y * T, T, T); }
    }
  }

  /** Artist 32px volcanic tileset (tiles-dark-32.json names). Void stays empty so the lava layer shows. */
  private buildDarkTilemap(N: Record<string, number>): void {
    const f = this.sim.floor;
    const hash = (x: number, y: number): number => { let h = (x * 374761393 + y * 668265263 + this.sim.floorNo * 982451653) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const isFloor = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] !== WALL;
    const id = (k: string): number => N[k] ?? -1;
    const DECOR = ['decor-rock', 'decor-rock', 'decor-bones', 'decor-skull', 'decor-mushroom', 'decor-crystal', 'decor-embers'];
    const GLOW: Record<string, number> = { 'decor-mushroom': 0xff8a30, 'decor-crystal': 0xff7020, 'decor-embers': 0xff5010 };
    const ex = f.exit; const doorSet = new Set((f.doors ?? []).map((d) => d.y * f.w + d.x));
    const base: number[][] = []; const deco: number[][] = []; const glows: { x: number; y: number; c: number; r: number }[] = [];
    for (let y = 0; y < f.h; y++) {
      const row: number[] = []; const drow: number[] = [];
      for (let x = 0; x < f.w; x++) {
        let t = -1; let d = -1; const h = hash(x, y);
        if (isFloor(x, y)) {
          const k = h < 0.03 ? 'floor-lava' : h < 0.11 ? 'floor-cracked' : h < 0.5 ? 'floor-2' : 'floor-1';
          const door = doorSet.has(y * f.w + x) && id('doorway') >= 0;
          t = door ? id('doorway') : id(k); if (!door && k === 'floor-lava') glows.push({ x, y, c: 0xff5a10, r: 70 });
          const edge = !isFloor(x, y - 1) || !isFloor(x - 1, y) || !isFloor(x + 1, y) || !isFloor(x, y + 1);
          if (x === ex.cx && y === ex.cy) d = id('exit-stairs');
          else if (!edge && !doorSet.has(y * f.w + x) && hash(y, x) < 0.05) { const dk = DECOR[Math.floor(hash(x + 7, y + 3) * DECOR.length)] ?? 'decor-rock'; d = id(dk); const gc = GLOW[dk]; if (gc) glows.push({ x, y, c: gc, r: 55 }); }
        } else if (isFloor(x, y + 1)) {
          const lava = h < 0.12; t = id(lava ? 'wall-face-lava' : 'wall-face'); if (lava) glows.push({ x, y, c: 0xff5a10, r: 60 });
        } else if ([[1, 0], [-1, 0], [0, -1]].some(([dx, dy]) => isFloor(x + (dx ?? 0), y + (dy ?? 0)))) t = id('wall-top');
        else if (isFloor(x + 1, y + 1)) t = id('corner-tl');
        else if (isFloor(x - 1, y + 1)) t = id('corner-tr');
        else if (isFloor(x + 1, y - 1)) t = id('corner-bl');
        else if (isFloor(x - 1, y - 1)) t = id('corner-br');
        row.push(t); drow.push(d);
      }
      base.push(row); deco.push(drow);
    }
    for (const [data, depth] of [[base, 0], [deco, 0.5]] as const) {
      const map = this.make.tilemap({ data: data as number[][], tileWidth: 32, tileHeight: 32 });
      const ts = map.addTilesetImage(DARK_TILES_KEY, DARK_TILES_KEY, 32, 32, 0, 0);
      if (!ts) continue;
      const layer = map.createLayer(0, ts, 0, 0);
      if (layer) { layer.setScale(T / 32).setDepth(depth); this.tileLayers.push(layer); }
    }
    for (const g of glows) {
      const cx = (g.x + 0.5) * T, cy = (g.y + 0.5) * T;
      const img = this.add.image(cx, cy, 'env-light').setTint(g.c).setBlendMode(Phaser.BlendModes.ADD).setScale((g.r * 1.1) / 256).setDepth(0.7);
      this.glowSpots.push({ img, x: cx, y: cy, ph: hash(g.x + 11, g.y) * 6.28, r: g.r * 2.2 });
    }
  }

  private buildTilemap(): void {
    const f = this.sim.floor; const COLS = 29; const fr = (c: number, r: number): number => r * COLS + c;
    const FLOORS = [fr(10, 7), fr(10, 7), fr(10, 7), fr(11, 7), fr(13, 7), fr(10, 8)];
    const DECOR = [fr(1, 3), fr(2, 3), fr(1, 4), fr(2, 4), fr(1, 2), fr(0, 2), fr(5, 2), fr(6, 2), fr(3, 4)];
    const hash = (x: number, y: number): number => { let h = (x * 374761393 + y * 668265263 + this.sim.floorNo * 982451653) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
    const isFloor = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < f.w && y < f.h && f.tiles[y * f.w + x] !== WALL;
    const base: number[][] = []; const deco: number[][] = [];
    for (let y = 0; y < f.h; y++) {
      const row: number[] = []; const drow: number[] = [];
      for (let x = 0; x < f.w; x++) {
        let t = -1; let d = -1;
        if (isFloor(x, y)) {
          t = FLOORS[Math.floor(hash(x, y) * FLOORS.length)] ?? fr(10, 7);
          const isEdge = !isFloor(x, y - 1) || !isFloor(x - 1, y) || !isFloor(x + 1, y) || !isFloor(x, y + 1);
          if (!isEdge && hash(y, x) < 0.04) d = DECOR[Math.floor(hash(x + 7, y + 3) * DECOR.length)] ?? -1;
        } else if (isFloor(x, y + 1)) t = fr(10, 4); // wall face
        else if ([[1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].some(([dx, dy]) => isFloor(x + (dx ?? 0), y + (dy ?? 0)))) t = fr(10, 2); // wall top
        row.push(t); drow.push(d);
      }
      base.push(row); deco.push(drow);
    }
    for (const [data, depth] of [[base, 0], [deco, 0.5]] as const) {
      const map = this.make.tilemap({ data: data as number[][], tileWidth: 16, tileHeight: 16 });
      const ts = map.addTilesetImage(TILESET_KEY, TILESET_KEY, 16, 16, 0, 1);
      if (!ts) continue;
      const layer = map.createLayer(0, ts, 0, 0);
      if (layer) { layer.setScale(T / 16).setDepth(depth); this.tileLayers.push(layer); }
    }
  }

  private animFor(e: { id: number; kind: string; dash?: unknown; ai?: { state: string } }): AnimName {
    if ((this.hurtUntil.get(e.id) ?? 0) > this.now) return 'hurt';
    if (e.kind === 'player' ? this.castUntil > this.now || !!e.dash : e.ai?.state === 'attack') return 'attack';
    return this.moved.has(e.id) ? 'walk' : 'idle';
  }

  /** Positions before this fixed step. Called inside the step loop so only the last step is interpolated. */
  private capturePrev(): void {
    this.prevPos.clear();
    for (const e of this.sim.world.entities.values()) this.prevPos.set(e.id, { x: e.x, y: e.y });
  }

  private noteMovement(): void {
    this.moved.clear();
    for (const e of this.sim.world.entities.values()) {
      const p = this.prevPos.get(e.id);
      if (!p) continue;
      const dx = e.x - p.x, dy = e.y - p.y;
      if (dx * dx + dy * dy > 0.09) this.moved.add(e.id);
    }
  }

  /** Interpolated, pixel-snapped draw position. */
  private pose(e: { id: number; x: number; y: number }): { x: number; y: number } {
    const p = renderPose(this.prevPos.get(e.id), e, this.alpha);
    return { x: Math.round(p.x), y: Math.round(p.y) };
  }

  private focusCamera(): void {
    const v = this.pose(this.sim.player);
    const cam = this.cameras.main;
    cam.centerOn(v.x, v.y);
    // Flooring scroll and sprites separately vibrates by 1px when the viewport size is odd.
    cam.scrollX = Math.round(cam.scrollX);
    cam.scrollY = Math.round(cam.scrollY);
  }

  private syncSprites(): void {
    const seen = new Set<number>();
    for (const e of this.sim.world.entities.values()) {
      if (e.dead || (e.kind !== 'player' && e.kind !== 'monster') || !e.speciesId || !SpriteProvider.has(e.speciesId)) continue;
      seen.add(e.id);
      let spr = this.sprites.get(e.id);
      if (!spr) { spr = this.add.sprite(e.x, e.y, `${e.speciesId}-walk`).setOrigin(0.5, 0.62); this.sprites.set(e.id, spr); }
      const key = SpriteProvider.animKey(e.speciesId, this.animFor(e), e.rot);
      if (key && spr.anims.currentAnim?.key !== key) spr.play(key, true);
      const v = this.pose(e);
      spr.setScale(e.isBoss ? 2 : 2).setPosition(v.x, v.y).setDepth(2 + v.y / 100000);
      const blink = e.kind === 'player' && (e.iframes ?? 0) > 0 && Math.floor(this.sim.time * 20) % 2 === 0;
      spr.setAlpha(blink ? 0.5 : 1);
      if ((this.hurtUntil.get(e.id) ?? 0) - 0.17 > this.now) spr.setTintFill(0xffffff); else if (e.burn) spr.setTint(0xffb080); else spr.clearTint();
    }
    for (const [id, spr] of this.sprites) if (!seen.has(id)) { spr.destroy(); this.sprites.delete(id); }
  }

  private emitFx(): void {
    const s = this.sim; const p = s.player; const live = new Set<number>();
    if (this.vfx) {
      this.vfx.sync(s.world.entities.values(), p, (e) => this.pose(e));
      for (const e of s.world.entities.values()) {
        if (e.dead) continue;
        if (e.kind === 'projectile' && e.team === 'enemy') { const v = this.pose(e); this.fx.projectile(v.x, v.y, true); }
        else if (e.kind === 'blast') live.add(e.id);
        else if ((e.kind === 'monster' || e.kind === 'player') && e.burn) { const v = this.pose(e); this.fx.burnTick(v.x, v.y); }
      }
      for (const e of s.world.entities.values()) if (e.kind === 'blast' && !e.dead) this.blasts.set(e.id, { x: e.x, y: e.y, r: e.r });
      for (const [id] of this.blasts) if (!live.has(id)) { this.cameras.main.shake(160, 0.008); this.blasts.delete(id); }
      return;
    }
    for (const e of s.world.entities.values()) {
      if (e.dead) continue;
      const v = this.pose(e);
      if (e.kind === 'projectile') this.fx.projectile(v.x, v.y, e.team === 'enemy');
      else if (e.kind === 'beam') { const pv = this.pose(p); this.fx.beam(pv.x, pv.y, p.rot + e.rot, e.reach ?? e.len ?? 300, e.width ?? 22); }
      else if (e.kind === 'zone') this.fx.zone(v.x, v.y, e.r);
      else if (e.kind === 'blast') { live.add(e.id); this.blasts.set(e.id, { x: v.x, y: v.y, r: e.r }); this.fx.telegraph(v.x, v.y, e.r); }
      else if ((e.kind === 'monster' || e.kind === 'player') && e.burn) this.fx.burnTick(v.x, v.y);
    }
    if (p.dash?.moveId) { const v = this.pose(p); this.fx.dash(v.x, v.y); }
    for (const [id, b] of this.blasts) if (!live.has(id)) { this.fx.explosion(b.x, b.y, b.r); this.cameras.main.shake(160, 0.008); this.blasts.delete(id); }
  }

  private drawEntities(): void {
    this.syncSprites(); this.emitFx(); this.bars.clear();
    const g = this.g; g.clear(); const s = this.sim; const p = s.player;
    const ex = s.floor.exit;
    if (this.marker) {
      this.marker.t -= 1 / 60; const k = Math.max(0, this.marker.t / 0.6);
      g.lineStyle(2, 0x80ff80, k).strokeCircle(this.marker.x, this.marker.y, 6 + (1 - k) * 12);
      g.lineStyle(2, 0x80ff80, k).strokeEllipse(this.marker.x, this.marker.y, 20, 10);
      if (this.marker.t <= 0) this.marker = null;
    }
    if (s.order?.kind === 'move') { g.fillStyle(0x80ff80, 0.35); for (const wp of s.order.path) g.fillCircle(wp.x, wp.y, 2); }
    if (s.order?.kind === 'attack') { const tg = s.world.get(s.order.target); if (tg && !tg.dead) { const v = this.pose(tg); g.lineStyle(2, 0xff4040, 0.9).strokeEllipse(v.x, v.y + tg.r * 0.5, tg.r * 3, tg.r * 1.4); } }
    g.lineStyle(3, s.exitOpen ? 0x40ff80 : 0x555555).strokeCircle((ex.cx + 0.5) * T, (ex.cy + 0.5) * T, T * 0.9);
    for (const e of s.world.entities.values()) {
      if (e.dead) continue;
      const v = this.pose(e);
      switch (e.kind) {
        case 'item': g.fillStyle(RARITY_COLOR[e.item?.rarity ?? 'common'] ?? 0xffffff).fillRect(v.x - 6, v.y - 6, 12, 12); g.lineStyle(1, 0x000000).strokeRect(v.x - 6, v.y - 6, 12, 12); break;
        case 'zone': g.fillStyle(0xff6020, 0.15).fillCircle(v.x, v.y, e.r); g.lineStyle(2, 0xff9040, 0.5).strokeCircle(v.x, v.y, e.r); break;
        case 'blast': { const k = 1 - (e.life ?? 0) / (e.delay ?? 0.4); g.lineStyle(2, 0xffe060).strokeCircle(v.x, v.y, e.r); g.fillStyle(0xff8020, 0.35).fillCircle(v.x, v.y, e.r * k); break; }
        case 'beam': { if (this.vfx) break; const a = p.rot + e.rot; const len = e.reach ?? e.len ?? 300; const pv = this.pose(p); g.lineStyle(e.width ?? 22, 0xff7020, 0.35).lineBetween(pv.x, pv.y, pv.x + Math.cos(a) * len, pv.y + Math.sin(a) * len);
          g.lineStyle((e.width ?? 22) / 3, 0xffe080, 0.6).lineBetween(pv.x, pv.y, pv.x + Math.cos(a) * len, pv.y + Math.sin(a) * len); break; }
        case 'projectile': g.fillStyle(e.team === 'player' ? 0xfff0b0 : 0x90c8ff).fillCircle(v.x, v.y, e.r * 0.7); break;
        case 'monster': {
          const w = e.r * 2; const frac = Math.max(0, (e.hp ?? 0) / (e.maxHp ?? 1)); const top = this.sprites.has(e.id) ? v.y - e.r - 26 : v.y - e.r - 8;
          this.bars.fillStyle(0x000000).fillRect(v.x - w / 2, top, w, 4); this.bars.fillStyle(e.isBoss ? 0xff4040 : 0x40e040).fillRect(v.x - w / 2, top, w * frac, 4);
          g.fillStyle(0x000000, 0.35).fillEllipse(v.x, v.y + e.r * 0.5, e.r * 2, e.r * 0.8);
          if (this.sprites.has(e.id)) { if (e.ai?.state === 'attack') g.lineStyle(2, 0xff3030, 0.8).strokeEllipse(v.x, v.y + e.r * 0.5, e.r * 2.6, e.r * 1.2); break; }
          const md = monsterData(e.monsterId ?? '');
          if (e.ai?.state === 'attack') g.lineStyle(2, 0xff3030, 0.8).strokeCircle(v.x, v.y, e.r + 6);
          g.fillStyle(hex(md.color)).fillCircle(v.x, v.y, e.r);
          g.fillStyle(0xffffff).fillCircle(v.x + Math.cos(e.rot) * e.r * 0.6, v.y + Math.sin(e.rot) * e.r * 0.6, 3);
          if (e.burn) g.lineStyle(2, 0xff5010).strokeCircle(v.x, v.y, e.r + 2);
          break;
        }
        case 'player': {
          if (e.dead) break;
          g.fillStyle(0x000000, 0.35).fillEllipse(v.x, v.y + 7, 24, 9);
          if (this.sprites.has(e.id)) break;
          const blink = (e.iframes ?? 0) > 0 && Math.floor(s.time * 20) % 2 === 0;
          g.fillStyle(SPECIES_COLOR[e.speciesId ?? ''] ?? 0xf08030, blink ? 0.4 : 1).fillCircle(v.x, v.y, e.r);
          g.fillStyle(0xffd040).fillCircle(v.x - Math.cos(e.rot) * e.r, v.y - Math.sin(e.rot) * e.r, 5); // tail flame
          g.fillStyle(0xffffff).fillCircle(v.x + Math.cos(e.rot) * e.r * 0.6, v.y + Math.sin(e.rot) * e.r * 0.6, 3);
          break;
        }
      }
    }
  }

  private hudBuffs(): HudBuff[] {
    const s = this.sim; const p = s.player; const eq = s.equipStats(); const out: HudBuff[] = [];
    if (s.evoStage > 0) out.push({ id: 'evo', color: 0xff8a20, label: t('buff.evo') });
    if (eq.kindling) out.push({ id: 'kindling', color: 0xff4a10, label: t('buff.kindling') });
    if (eq.split) out.push({ id: 'split', color: 0xffb040, label: t('buff.split') });
    if (eq.allIn && (p.hp ?? 0) < (p.maxHp ?? 1) * 0.25) out.push({ id: 'all-in', color: 0xffe060, label: t('buff.allIn') });
    if (p.burn) out.push({ id: 'burn', color: 0xc02010, label: t('buff.burn') });
    return out;
  }

  private drawHud(dt: number): void {
    const s = this.sim; const p = s.player; const h = this.hud; const W = this.scale.width, H = this.scale.height;
    h.clear();
    this.hudBar.update({
      hp: Math.max(0, p.hp ?? 0), maxHp: p.maxHp ?? 1, pp: s.energy, maxPp: BALANCE.energyMax, level: s.progress.level,
      xp: s.progress.xp, xpNext: xpToNext(s.progress.level), levelsToEvolve: s.levelsToEvolve(), playerType: p.types?.[0],
      slots: s.slots, slotLabels: SLOT_LABELS, cooldown: (id) => ({ left: s.cooldownLeft(id), total: moveCooldown(moveData(id)) }),
      items: [{ count: s.potions[0], cdLeft: s.potionCd, cdTotal: POTION_CD }, { count: s.potions[1], cdLeft: 0, cdTotal: 1 }], buffs: this.hudBuffs(),
    }, dt, this.now);
    this.help.setPosition(W / 2, H / 2 - 40);
    const need = Math.ceil(s.totalMonsters * 0.6);
    let status = `${t('hud.floor', { floor: s.floorNo, max: MAX_FLOOR })}   ${t('hud.kills', { k: s.killed, need })}`;
    if (s.exitOpen) status += `   ${t('hud.exitOpen')}`;
    this.hudText.setPosition(16, 10).setText(`${status}\n${t('hud.helpHint')}`);
    // minimap
    const f = s.floor; const ms = 2.2; const mx = W - f.w * ms - 12, my = 12;
    h.fillStyle(0x000000, 0.5).fillRect(mx, my, f.w * ms, f.h * ms);
    h.fillStyle(0x777777, 0.6);
    for (const r of f.rooms) h.fillRect(mx + r.x * ms, my + r.y * ms, r.w * ms, r.h * ms);
    h.fillStyle(s.exitOpen ? 0x40ff80 : 0x888888).fillRect(mx + f.exit.cx * ms - 2, my + f.exit.cy * ms - 2, 5, 5);
    h.fillStyle(0xff8030).fillCircle(mx + (p.x / T) * ms, my + (p.y / T) * ms, 3);
    // banner
    this.bannerT -= dt;
    if (p.dead) this.banner.setText(t('hud.dead')).setAlpha(1);
    else if (s.victory) this.banner.setText(t('hud.victory')).setAlpha(1);
    else this.banner.setAlpha(this.bannerT > 0 ? 1 : 0);
    this.banner.setPosition(W / 2, H / 2 - 120);
  }
}

