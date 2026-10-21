import Phaser from 'phaser';
import { Sim, MAX_FLOOR, xpToNext, type Progress } from '../../core/sim';
import { BALANCE } from '../../core/balance';
import { WALL } from '../../core/dungeon/bsp-gen';
import { clampToFloor } from '../../core/dungeon/pathfind';
import { monster as monsterData, move as moveData } from '../../data/registry';
import { moveCooldown } from '../../core/moves/cooldown';
import { SpriteProvider, TILESET_KEY, type AnimName } from '../views/sprite-provider';
import { Fx } from '../views/fx';
import { SkillPanelView } from '../views/skill-panel-view';
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
  private lastPos = new Map<number, { x: number; y: number }>();
  private hurtUntil = new Map<number, number>();
  private castUntil = 0;
  private blasts = new Map<number, { x: number; y: number; r: number }>();
  private tileLayers: Phaser.Tilemaps.TilemapLayer[] = [];
  private now = 0;
  private pending: { moveTo?: { x: number; y: number }; attackTarget?: number } = {};
  private lmb: { mode: 'ground' | 'attack' | 'force'; since: number } | null = null;
  private marker: { x: number; y: number; t: number } | null = null;
  private barTexts: Phaser.GameObjects.Text[] = [];

  constructor() { super('dungeon'); }

  create(data: { progress: Progress }): void {
    this.sim = new Sim(data.progress);
    this.input2 = new InputMap(this);
    this.mapG = this.add.graphics();
    this.g = this.add.graphics().setDepth(1);
    this.bars = this.add.graphics().setDepth(7);
    this.fx = new Fx(this);
    this.hud = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.hudText = this.add.text(16, 0, '', { fontSize: '14px', color: '#fff' }).setScrollFactor(0).setDepth(11);
    this.banner = this.add.text(0, 80, '', { fontSize: '26px', color: '#ffe080', stroke: '#000', strokeThickness: 4 }).setScrollFactor(0).setDepth(11).setOrigin(0.5);
    this.inv = new InventoryView(() => this.sim, () => saveProgress(this.sim.progress));
    this.skills = new SkillPanelView(() => this.sim, () => saveProgress(this.sim.progress));
    this.events.once('shutdown', () => { this.inv.destroy(); this.skills.destroy(); });
    const kb = this.input.keyboard;
    kb?.addCapture('TAB');
    kb?.on('keydown-TAB', () => this.skills.toggle());
    kb?.on('keydown-I', () => { this.inv.toggle(); this.skills.setOpen(this.inv.open); });
    kb?.on('keydown-L', (ev: KeyboardEvent) => this.sim.debugLevelUp(ev.shiftKey)); // debug
    kb?.on('keydown-R', () => { if (this.sim.player.dead) this.sim.respawn(); });
    kb?.on('keydown-ENTER', () => { if (this.sim.victory) { saveProgress(this.sim.progress); this.scene.start('title'); } });
    this.bindEvents();
    this.bindPointer();
    // Debug/test hook (read-only use in automated browser checks).
    (window as unknown as { __pokedungeon?: unknown }).__pokedungeon = { sim: () => this.sim, cam: this.cameras.main };
    for (let i = 0; i < 15; i++) this.barTexts.push(this.add.text(0, 0, '', { fontSize: '11px', color: '#fff', stroke: '#000', strokeThickness: 3 }).setScrollFactor(0).setDepth(12).setOrigin(0.5));
  }

  private uiOpen(): boolean { return this.inv.open || this.skills.open; }

  private bindPointer(): void {
    this.input.on('pointerdown', (ptr: Phaser.Input.Pointer) => {
      if (!ptr.leftButtonDown() || this.uiOpen() || this.sim.player.dead) return;
      const wp = ptr.positionToCamera(this.cameras.main) as Phaser.Math.Vector2;
      const shift = (ptr.event as MouseEvent | undefined)?.shiftKey ?? false;
      if (shift) { this.lmb = { mode: 'force', since: this.now }; return; }
      let best: number | undefined; let bd = Infinity;
      for (const m of this.sim.world.query('monster')) { const d = Math.hypot(m.x - wp.x, m.y - wp.y); if (d < m.r + 14 && d < bd) { bd = d; best = m.id; } }
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
      const color = e.target === this.sim.player.id ? '#ff5050' : e.typeEff > 1 ? '#ffe040' : e.typeEff < 1 ? '#999' : '#fff';
      const size = e.isCrit || e.typeEff > 1 ? 20 : 14;
      const tgt = this.sim.world.get(e.target);
      this.hurtUntil.set(e.target, this.now + 0.25);
      const big = e.isCrit || e.typeEff > 1 || (!!tgt?.maxHp && e.amount >= tgt.maxHp * 0.2);
      this.fx.hit(e.x, e.y + 8, big);
      if (big || e.target === this.sim.player.id) this.cameras.main.shake(110, e.target === this.sim.player.id ? 0.006 : 0.004);
      const txt = this.add.text(e.x + Phaser.Math.Between(-8, 8), e.y, String(e.amount), { fontSize: `${size}px`, color, stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(5);
      this.tweens.add({ targets: txt, y: e.y - 36, alpha: 0, duration: 700, onComplete: () => txt.destroy() });
    });
    bus.on('move:cast', () => { const p = this.sim.player; this.castUntil = this.now + 0.3; this.fx.muzzle(p.x, p.y, p.rot); });
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
    while (this.acc >= BALANCE.FIXED_DT) { this.sim.step(BALANCE.FIXED_DT, cmd); this.acc -= BALANCE.FIXED_DT; }
    if (this.sim.floorNo !== prevFloor) saveProgress(this.sim.progress);
    this.saveT += deltaMs / 1000; if (this.saveT > 60) { this.saveT = 0; saveProgress(this.sim.progress); }
    if (this.drawnFloor !== this.sim.floorNo) this.drawMap();
    this.cameras.main.centerOn(this.sim.player.x, this.sim.player.y);
    this.drawEntities();
    this.drawHud(deltaMs / 1000);
  }

  private drawMap(): void {
    const f = this.sim.floor; const g = this.mapG; g.clear();
    this.drawnFloor = this.sim.floorNo;
    this.tileLayers.forEach((l) => l.tilemap.destroy()); this.tileLayers = [];
    if (SpriteProvider.tiles) { this.buildTilemap(); return; }
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const wall = f.tiles[y * f.w + x] === WALL;
      if (wall) {
        const nearFloor = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => f.tiles[(y + (dy ?? 0)) * f.w + x + (dx ?? 0)] === 1);
        if (nearFloor) { g.fillStyle(0x4a3b33).fillRect(x * T, y * T, T, T); g.fillStyle(0x5c4a40).fillRect(x * T, y * T, T, 6); }
      } else { g.fillStyle((x + y) % 2 ? 0x2a2420 : 0x2e2723).fillRect(x * T, y * T, T, T); }
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

  private animFor(e: { id: number; kind: string; x: number; y: number; dash?: unknown; ai?: { state: string } }): AnimName {
    if ((this.hurtUntil.get(e.id) ?? 0) > this.now) return 'hurt';
    if (e.kind === 'player' ? this.castUntil > this.now || !!e.dash : e.ai?.state === 'attack') return 'attack';
    const lp = this.lastPos.get(e.id); const moved = lp ? Math.hypot(e.x - lp.x, e.y - lp.y) > 0.3 : false;
    this.lastPos.set(e.id, { x: e.x, y: e.y });
    return moved ? 'walk' : 'idle';
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
      spr.setScale(e.isBoss ? 2 : 2).setPosition(e.x, e.y).setDepth(2 + e.y / 100000);
      const blink = e.kind === 'player' && (e.iframes ?? 0) > 0 && Math.floor(this.sim.time * 20) % 2 === 0;
      spr.setAlpha(blink ? 0.5 : 1);
      if ((this.hurtUntil.get(e.id) ?? 0) - 0.17 > this.now) spr.setTintFill(0xffffff); else if (e.burn) spr.setTint(0xffb080); else spr.clearTint();
    }
    for (const [id, spr] of this.sprites) if (!seen.has(id)) { spr.destroy(); this.sprites.delete(id); this.lastPos.delete(id); }
  }

  private emitFx(): void {
    const s = this.sim; const p = s.player; const live = new Set<number>();
    for (const e of s.world.entities.values()) {
      if (e.dead) continue;
      if (e.kind === 'projectile') this.fx.projectile(e.x, e.y, e.team === 'enemy');
      else if (e.kind === 'beam') this.fx.beam(p.x, p.y, p.rot + e.rot, e.len ?? 300, e.width ?? 22);
      else if (e.kind === 'zone') this.fx.zone(e.x, e.y, e.r);
      else if (e.kind === 'blast') { live.add(e.id); this.blasts.set(e.id, { x: e.x, y: e.y, r: e.r }); this.fx.telegraph(e.x, e.y, e.r); }
      else if ((e.kind === 'monster' || e.kind === 'player') && e.burn) this.fx.burnTick(e.x, e.y);
    }
    if (p.dash?.moveId) this.fx.dash(p.x, p.y);
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
    if (s.order?.kind === 'attack') { const tg = s.world.get(s.order.target); if (tg && !tg.dead) g.lineStyle(2, 0xff4040, 0.9).strokeEllipse(tg.x, tg.y + tg.r * 0.5, tg.r * 3, tg.r * 1.4); }
    g.lineStyle(3, s.exitOpen ? 0x40ff80 : 0x555555).strokeCircle((ex.cx + 0.5) * T, (ex.cy + 0.5) * T, T * 0.9);
    for (const e of s.world.entities.values()) {
      if (e.dead) continue;
      switch (e.kind) {
        case 'item': g.fillStyle(RARITY_COLOR[e.item?.rarity ?? 'common'] ?? 0xffffff).fillRect(e.x - 6, e.y - 6, 12, 12); g.lineStyle(1, 0x000000).strokeRect(e.x - 6, e.y - 6, 12, 12); break;
        case 'zone': g.fillStyle(0xff6020, 0.15).fillCircle(e.x, e.y, e.r); g.lineStyle(2, 0xff9040, 0.5).strokeCircle(e.x, e.y, e.r); break;
        case 'blast': { const k = 1 - (e.life ?? 0) / (e.delay ?? 0.4); g.lineStyle(2, 0xffe060).strokeCircle(e.x, e.y, e.r); g.fillStyle(0xff8020, 0.35).fillCircle(e.x, e.y, e.r * k); break; }
        case 'beam': { const a = p.rot + e.rot; const len = e.len ?? 300; g.lineStyle(e.width ?? 22, 0xff7020, 0.35).lineBetween(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
          g.lineStyle((e.width ?? 22) / 3, 0xffe080, 0.6).lineBetween(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len); break; }
        case 'projectile': g.fillStyle(e.team === 'player' ? 0xfff0b0 : 0x90c8ff).fillCircle(e.x, e.y, e.r * 0.7); break;
        case 'monster': {
          const w = e.r * 2; const frac = Math.max(0, (e.hp ?? 0) / (e.maxHp ?? 1)); const top = this.sprites.has(e.id) ? e.y - e.r - 26 : e.y - e.r - 8;
          this.bars.fillStyle(0x000000).fillRect(e.x - w / 2, top, w, 4); this.bars.fillStyle(e.isBoss ? 0xff4040 : 0x40e040).fillRect(e.x - w / 2, top, w * frac, 4);
          g.fillStyle(0x000000, 0.35).fillEllipse(e.x, e.y + e.r * 0.5, e.r * 2, e.r * 0.8);
          if (this.sprites.has(e.id)) { if (e.ai?.state === 'attack') g.lineStyle(2, 0xff3030, 0.8).strokeEllipse(e.x, e.y + e.r * 0.5, e.r * 2.6, e.r * 1.2); break; }
          const md = monsterData(e.monsterId ?? '');
          if (e.ai?.state === 'attack') g.lineStyle(2, 0xff3030, 0.8).strokeCircle(e.x, e.y, e.r + 6);
          g.fillStyle(hex(md.color)).fillCircle(e.x, e.y, e.r);
          g.fillStyle(0xffffff).fillCircle(e.x + Math.cos(e.rot) * e.r * 0.6, e.y + Math.sin(e.rot) * e.r * 0.6, 3);
          if (e.burn) g.lineStyle(2, 0xff5010).strokeCircle(e.x, e.y, e.r + 2);
          break;
        }
        case 'player': {
          if (e.dead) break;
          g.fillStyle(0x000000, 0.35).fillEllipse(e.x, e.y + 7, 24, 9);
          if (this.sprites.has(e.id)) break;
          const blink = (e.iframes ?? 0) > 0 && Math.floor(s.time * 20) % 2 === 0;
          g.fillStyle(SPECIES_COLOR[e.speciesId ?? ''] ?? 0xf08030, blink ? 0.4 : 1).fillCircle(e.x, e.y, e.r);
          g.fillStyle(0xffd040).fillCircle(e.x - Math.cos(e.rot) * e.r, e.y - Math.sin(e.rot) * e.r, 5); // tail flame
          g.fillStyle(0xffffff).fillCircle(e.x + Math.cos(e.rot) * e.r * 0.6, e.y + Math.sin(e.rot) * e.r * 0.6, 3);
          break;
        }
      }
    }
  }

  private drawHud(dt: number): void {
    const s = this.sim; const p = s.player; const h = this.hud; const W = this.scale.width, H = this.scale.height;
    h.clear();
    const bar = (x: number, y: number, w: number, frac: number, c: number): void => { h.fillStyle(0x000000, 0.7).fillRect(x, y, w, 14); h.fillStyle(c).fillRect(x, y, w * Math.max(0, Math.min(1, frac)), 14); };
    bar(16, H - 70, 260, (p.hp ?? 0) / (p.maxHp ?? 1), 0xd03030);
    bar(16, H - 50, 260, s.energy / BALANCE.energyMax, 0x3080ff);
    bar(16, H - 30, 260, s.progress.xp / xpToNext(s.progress.level), 0xc0c040);
    const slots = s.slots;
    slots.forEach((id, i) => {
      const x = W / 2 - 165 + i * 66, y = H - 74, S = 58;
      h.fillStyle(0x1a1412, 0.92).fillRect(x, y, S, S); h.lineStyle(2, 0x886644).strokeRect(x, y, S, S);
      const [kt, nt, ct] = [this.barTexts[i * 3], this.barTexts[i * 3 + 1], this.barTexts[i * 3 + 2]];
      kt?.setPosition(x + 9, y + 7).setText(SLOT_LABELS[i] ?? '').setColor('#ffcc66');
      if (!id) { nt?.setText(''); ct?.setText(''); return; }
      drawMoveIcon(h, id, x + S / 2, y + S / 2 - 3);
      nt?.setPosition(x + S / 2, y + S - 8).setText(t(`move.${id}`));
      const left = s.cooldownLeft(id); const cdFrac = left / moveCooldown(moveData(id));
      if (cdFrac > 0) h.fillStyle(0x000000, 0.6).fillRect(x, y + S * (1 - cdFrac), S, S * cdFrac);
      ct?.setPosition(x + S / 2, y + S / 2 - 3).setText(left > 0.05 ? left.toFixed(1) : '').setFontSize(16);
    });
    const labels = slots.map((id, i) => `${SLOT_LABELS[i]}:${id ? t(`move.${id}`) : t('skills.empty')}`).join('   ');
    const need = Math.ceil(s.totalMonsters * 0.6);
    let status = `${t('hud.floor', { floor: s.floorNo, max: MAX_FLOOR })}   ${t('hud.level', { level: s.progress.level })}   HP ${Math.ceil(p.hp ?? 0)}/${p.maxHp}   ${t('hud.kills', { k: s.killed, need })}`;
    if (s.exitOpen) status += `   ${t('hud.exitOpen')}`;
    this.hudText.setPosition(16, 10).setText(`${status}\n${labels}\n${t('hud.help')}`);
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

const SHAPE_ICON_COLOR: Record<string, number> = { projectile: 0xff9a3c, beam: 0xff5a1f, zone: 0xe8462a, 'aoe-target': 0xffcc33, dash: 0xd0302a };
/** Simple generated skill icon: colored orb + glyph by shape. */
function drawMoveIcon(h: Phaser.GameObjects.Graphics, id: string, cx: number, cy: number): void {
  const m = moveData(id); const c = SHAPE_ICON_COLOR[m.shape] ?? 0xff8800;
  h.fillStyle(c, 0.35).fillCircle(cx, cy, 20); h.fillStyle(c, 0.8).fillCircle(cx, cy, 14);
  h.fillStyle(0xfff0c0); h.lineStyle(3, 0xfff0c0);
  switch (m.shape) {
    case 'projectile': h.fillCircle(cx + 4, cy - 2, 5); h.fillTriangle(cx - 10, cy + 6, cx + 1, cy + 1, cx + 1, cy - 5); break;
    case 'beam': h.lineBetween(cx - 12, cy + 8, cx + 12, cy - 8); h.lineStyle(1, 0xffffff).lineBetween(cx - 12, cy + 8, cx + 12, cy - 8); break;
    case 'zone': h.strokeCircle(cx, cy, 9); h.fillCircle(cx, cy, 3); break;
    case 'aoe-target': for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; h.fillCircle(cx + Math.cos(a) * 8, cy + Math.sin(a) * 8, 3); } h.fillCircle(cx, cy, 4); break;
    case 'dash': h.fillTriangle(cx - 10, cy - 8, cx + 10, cy, cx - 10, cy + 8); break;
    default: h.fillCircle(cx, cy, 5);
  }
}
