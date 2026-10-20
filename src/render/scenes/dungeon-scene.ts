import Phaser from 'phaser';
import { Sim, LOADOUT, BASIC, MAX_FLOOR, xpToNext, type Progress } from '../../core/sim';
import { BALANCE } from '../../core/balance';
import { WALL } from '../../core/dungeon/bsp-gen';
import { monster as monsterData, move as moveData } from '../../data/registry';
import { moveCooldown } from '../../core/moves/cooldown';
import { InputMap } from '../input/input-map';
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
  private saveT = 0;

  constructor() { super('dungeon'); }

  create(data: { progress: Progress }): void {
    this.sim = new Sim(data.progress);
    this.input2 = new InputMap(this);
    this.mapG = this.add.graphics();
    this.g = this.add.graphics();
    this.hud = this.add.graphics().setScrollFactor(0).setDepth(10);
    this.hudText = this.add.text(16, 0, '', { fontSize: '14px', color: '#fff' }).setScrollFactor(0).setDepth(11);
    this.banner = this.add.text(0, 80, '', { fontSize: '26px', color: '#ffe080', stroke: '#000', strokeThickness: 4 }).setScrollFactor(0).setDepth(11).setOrigin(0.5);
    this.inv = new InventoryView(() => this.sim, () => saveProgress(this.sim.progress));
    this.events.once('shutdown', () => this.inv.destroy());
    const kb = this.input.keyboard;
    kb?.on('keydown-I', () => this.inv.toggle());
    kb?.on('keydown-L', (ev: KeyboardEvent) => this.sim.debugLevelUp(ev.shiftKey)); // debug
    kb?.on('keydown-R', () => { if (this.sim.player.dead) this.sim.respawn(); });
    kb?.on('keydown-ENTER', () => { if (this.sim.victory) { saveProgress(this.sim.progress); this.scene.start('title'); } });
    this.bindEvents();
  }

  private say(msg: string): void { this.banner.setText(msg); this.bannerT = 2.5; }

  private bindEvents(): void {
    const bus = this.sim.bus;
    bus.on('damage:dealt', (e) => {
      const color = e.target === this.sim.player.id ? '#ff5050' : e.typeEff > 1 ? '#ffe040' : e.typeEff < 1 ? '#999' : '#fff';
      const size = e.isCrit || e.typeEff > 1 ? 20 : 14;
      const txt = this.add.text(e.x + Phaser.Math.Between(-8, 8), e.y, String(e.amount), { fontSize: `${size}px`, color, stroke: '#000', strokeThickness: 3 }).setOrigin(0.5).setDepth(5);
      this.tweens.add({ targets: txt, y: e.y - 36, alpha: 0, duration: 700, onComplete: () => txt.destroy() });
    });
    bus.on('player:levelup', (e) => { this.say(t('hud.levelup', { level: e.level })); saveProgress(this.sim.progress); });
    bus.on('player:evolve', (e) => { this.say(t(`hud.evolve.${e.stage}`)); saveProgress(this.sim.progress); });
    bus.on('floor:cleared', () => this.say(t('hud.exitOpen')));
    bus.on('loot:picked', () => { const it = this.sim.progress.inventory.at(-1); if (it) this.say(t('hud.loot', { rarity: t(`rarity.${it.rarity}`) })); if (this.inv.open) this.inv.render(); saveProgress(this.sim.progress); });
  }

  update(_time: number, deltaMs: number): void {
    this.acc += Math.min(0.1, deltaMs / 1000);
    const cmd = this.input2.read();
    if (this.inv.open) { cmd.basic = false; cmd.slots = [false, false, false, false]; }
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
    for (let y = 0; y < f.h; y++) for (let x = 0; x < f.w; x++) {
      const wall = f.tiles[y * f.w + x] === WALL;
      if (wall) {
        const nearFloor = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => f.tiles[(y + (dy ?? 0)) * f.w + x + (dx ?? 0)] === 1);
        if (nearFloor) { g.fillStyle(0x4a3b33).fillRect(x * T, y * T, T, T); g.fillStyle(0x5c4a40).fillRect(x * T, y * T, T, 6); }
      } else { g.fillStyle((x + y) % 2 ? 0x2a2420 : 0x2e2723).fillRect(x * T, y * T, T, T); }
    }
  }

  private drawEntities(): void {
    const g = this.g; g.clear(); const s = this.sim; const p = s.player;
    const ex = s.floor.exit;
    g.lineStyle(3, s.exitOpen ? 0x40ff80 : 0x555555).strokeCircle((ex.cx + 0.5) * T, (ex.cy + 0.5) * T, T * 0.9);
    for (const e of s.world.entities.values()) {
      if (e.dead) continue;
      switch (e.kind) {
        case 'item': g.fillStyle(RARITY_COLOR[e.item?.rarity ?? 'common'] ?? 0xffffff).fillRect(e.x - 6, e.y - 6, 12, 12); g.lineStyle(1, 0x000000).strokeRect(e.x - 6, e.y - 6, 12, 12); break;
        case 'zone': g.fillStyle(0xff6020, 0.25).fillCircle(e.x, e.y, e.r); g.lineStyle(2, 0xff9040, 0.8).strokeCircle(e.x, e.y, e.r); break;
        case 'blast': { const k = 1 - (e.life ?? 0) / (e.delay ?? 0.4); g.lineStyle(2, 0xffe060).strokeCircle(e.x, e.y, e.r); g.fillStyle(0xff8020, 0.35).fillCircle(e.x, e.y, e.r * k); break; }
        case 'beam': { const a = p.rot + e.rot; const len = e.len ?? 300; g.lineStyle(e.width ?? 22, 0xff7020, 0.6).lineBetween(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len);
          g.lineStyle((e.width ?? 22) / 3, 0xffe080, 0.9).lineBetween(p.x, p.y, p.x + Math.cos(a) * len, p.y + Math.sin(a) * len); break; }
        case 'projectile': g.fillStyle(e.team === 'player' ? 0xffa030 : 0x60a0ff).fillCircle(e.x, e.y, e.r); break;
        case 'monster': {
          const md = monsterData(e.monsterId ?? '');
          if (e.ai?.state === 'attack') g.lineStyle(2, 0xff3030, 0.8).strokeCircle(e.x, e.y, e.r + 6);
          g.fillStyle(hex(md.color)).fillCircle(e.x, e.y, e.r);
          g.fillStyle(0xffffff).fillCircle(e.x + Math.cos(e.rot) * e.r * 0.6, e.y + Math.sin(e.rot) * e.r * 0.6, 3);
          if (e.burn) g.lineStyle(2, 0xff5010).strokeCircle(e.x, e.y, e.r + 2);
          const w = e.r * 2; const frac = Math.max(0, (e.hp ?? 0) / (e.maxHp ?? 1));
          g.fillStyle(0x000000).fillRect(e.x - w / 2, e.y - e.r - 8, w, 4); g.fillStyle(e.isBoss ? 0xff4040 : 0x40e040).fillRect(e.x - w / 2, e.y - e.r - 8, w * frac, 4);
          break;
        }
        case 'player': {
          if (e.dead) break;
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
    const slots = [BASIC, ...LOADOUT];
    slots.forEach((id, i) => {
      const x = W / 2 - 150 + i * 62, y = H - 70;
      h.fillStyle(0x221a18, 0.9).fillRect(x, y, 54, 54); h.lineStyle(2, 0x886644).strokeRect(x, y, 54, 54);
      const cdFrac = s.cooldownLeft(id) / moveCooldown(moveData(id));
      if (cdFrac > 0) h.fillStyle(0x000000, 0.65).fillRect(x, y + 54 * (1 - cdFrac), 54, 54 * cdFrac);
    });
    const labels = slots.map((id, i) => `${['LMB', '1/RMB', '2', '3', '4'][i]}:${t(`move.${id}`)}`).join('   ');
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
