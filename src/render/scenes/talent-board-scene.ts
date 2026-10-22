import Phaser from 'phaser';
import { BOARD, type BoardNode } from '../../core/build/board';
import ICONS from '../../data/build/talent-icons-v4.json';
import { jewelArt, JEWEL_ART_KEYS } from '../views/talent-art';
import type { TalentBoardController, NodeVisual } from '../views/talent-board-ui';

const ART = 'assets/hud/talents/';
const SIZE: Record<BoardNode['kind'], number> = { small: 46, notable: 64, keystone: 92, jewel: 60, start: 70 };
const FRAME: Record<BoardNode['kind'], string> = { small: 'small', notable: 'notable', keystone: 'keystone', jewel: 'sock-empty', start: 'notable' };
const REGION_LABEL: Record<string, { text: string; x: number; y: number }> = {
  sun: { text: '烈陽焚天', x: -620, y: -200 }, claw: { text: '龍爪狂襲', x: 0, y: -1000 }, wing: { text: '灼燒之翼', x: 640, y: -260 }, util: { text: '通用', x: 0, y: 420 },
};
export const ZOOM_MIN = 0.35, ZOOM_MAX = 1.6;

interface NodeObj { frame: Phaser.GameObjects.Image; icon?: Phaser.GameObjects.Image; fx?: Phaser.FX.ColorMatrix; size: number }

/** v4 passive board: its own scene + camera (drag-pan, wheel zoom). DOM overlay (header, trunk, jewels, plan, tooltip) lives in TalentBoardController. */
export class TalentBoardScene extends Phaser.Scene {
  private ctrl!: TalentBoardController; private objs = new Map<string, NodeObj>(); private edges!: Phaser.GameObjects.Graphics; private rings!: Phaser.GameObjects.Graphics;
  private drag: { x: number; y: number; sx: number; sy: number; moved: boolean } | null = null; private t = 0; private labels: Phaser.GameObjects.Text[] = [];
  constructor() { super('talent-board'); }
  init(data: { ctrl: TalentBoardController }): void { this.ctrl = data.ctrl; }
  preload(): void {
    for (const f of ['small', 'notable', 'keystone']) if (!this.textures.exists(`tf-${f}`)) this.load.image(`tf-${f}`, `${ART}talent-frame-${f}.png`);
    if (!this.textures.exists('tf-sock-empty')) this.load.image('tf-sock-empty', `${ART}jewels/jewel-socket-empty.png`);
    if (!this.textures.exists('tf-sock-filled')) this.load.image('tf-sock-filled', `${ART}jewels/jewel-socket-filled.png`);
    for (const k of JEWEL_ART_KEYS) if (!this.textures.exists(`jw-${k}`)) this.load.image(`jw-${k}`, `${ART}${jewelArt(k)}`);
    for (const n of BOARD.raw.nodes) { const p = (ICONS as Record<string, string | null>)[n.id]; if (p && !this.textures.exists(`ti-${n.id}`)) this.load.image(`ti-${n.id}`, ART + p); }
  }
  create(): void {
    this.labels = []; this.objs.clear(); this.drag = null; // scene instance is reused across launches: drop references to the previous run's objects
    const cam = this.cameras.main; cam.setBackgroundColor('#0a0605'); // opaque: hide the dungeon/HUD underneath
    this.add.rectangle(0, 0, 10, 10, 0x0c0705, 0.985).setOrigin(0).setScrollFactor(0).setDepth(-10).setName('bg');
    this.scale.on('resize', this.fitBg, this); this.fitBg();
    // soft region glows
    const glow = this.add.graphics().setDepth(-5);
    for (const [k, c] of [['sun', 0x7a3410], ['claw', 0x5a1810], ['wing', 0x5a3a20], ['util', 0x2a2a2a]] as const) {
      const ns = BOARD.raw.nodes.filter((n) => n.region === k); const cx = ns.reduce((a, n) => a + n.pos.x, 0) / ns.length, cy = ns.reduce((a, n) => a + n.pos.y, 0) / ns.length;
      for (let i = 6; i > 0; i--) { glow.fillStyle(c, 0.035); glow.fillCircle(cx, cy, 90 * i); }
    }
    for (const r of Object.values(REGION_LABEL)) this.labels.push(this.add.text(r.x, r.y, r.text, { fontFamily: '"Noto Sans CJK TC", sans-serif', fontSize: '34px', color: '#ffc75a', stroke: '#2a1000', strokeThickness: 6 }).setOrigin(0.5).setAlpha(0.95).setDepth(6));
    this.edges = this.add.graphics().setDepth(0); this.rings = this.add.graphics().setDepth(2);
    for (const n of BOARD.raw.nodes) {
      const s = SIZE[n.kind]; const o: NodeObj = { size: s, frame: this.add.image(n.pos.x, n.pos.y, `tf-${FRAME[n.kind]}`).setDisplaySize(s, s).setDepth(3) };
      if (this.textures.exists(`ti-${n.id}`)) {
        const is = s * (n.kind === 'keystone' ? 0.5 : 0.6); o.icon = this.add.image(n.pos.x, n.pos.y, `ti-${n.id}`).setDisplaySize(is, is).setDepth(1);
        o.fx = o.icon.preFX?.addColorMatrix();
      }
      o.frame.setInteractive(new Phaser.Geom.Circle(o.frame.width / 2, o.frame.height / 2, o.frame.width * 0.42), Phaser.Geom.Circle.Contains);
      o.frame.on('pointerover', (p: Phaser.Input.Pointer) => this.ctrl.hover(n.id, p.x, p.y));
      o.frame.on('pointerout', () => this.ctrl.hover(null, 0, 0));
      o.frame.on('pointerup', (p: Phaser.Input.Pointer) => { if (this.drag?.moved) return; this.ctrl.click(n.id, p.button === 2 ? 'right' : 'left'); });
      this.objs.set(n.id, o);
    }
    // camera: drag-pan + wheel zoom around the cursor
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => { this.drag = { x: p.x, y: p.y, sx: cam.scrollX, sy: cam.scrollY, moved: false }; });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      this.ctrl.pointer(p.x, p.y);
      if (!this.drag || !p.isDown) return; const dx = p.x - this.drag.x, dy = p.y - this.drag.y;
      if (Math.hypot(dx, dy) > 6) this.drag.moved = true;
      if (this.drag.moved) { cam.setScroll(this.drag.sx - dx / cam.zoom, this.drag.sy - dy / cam.zoom); this.ctrl.cameraChanged(); }
    });
    this.input.on('pointerup', () => { this.time.delayedCall(0, () => { this.drag = null; }); });
    this.input.on('wheel', (p: Phaser.Input.Pointer, _o: unknown, _dx: number, dy: number) => this.zoomAt(p.x, p.y, cam.zoom * (dy > 0 ? 0.9 : 1.1)));
    this.resetView();
    this.ctrl.attach(this); this.redraw();
  }
  private fitBg(): void { const bg = this.children.getByName('bg') as Phaser.GameObjects.Rectangle | null; bg?.setSize(this.scale.width, this.scale.height); }
  resetView(): void { const cam = this.cameras.main; cam.setZoom(Math.min(this.scale.width / 1950, this.scale.height / 1450) * 1.05); cam.centerOn(-40, -300); this.ctrl?.cameraChanged(); }
  zoomAt(sx: number, sy: number, z: number): void {
    const cam = this.cameras.main; const before = cam.getWorldPoint(sx, sy); cam.setZoom(Phaser.Math.Clamp(z, ZOOM_MIN, ZOOM_MAX));
    const after = cam.getWorldPoint(sx, sy); cam.setScroll(cam.scrollX + before.x - after.x, cam.scrollY + before.y - after.y); this.ctrl.cameraChanged();
  }
  /** viewport in world coords (minimap) */
  view(): { x: number; y: number; w: number; h: number; zoom: number } { const v = this.cameras.main.worldView; return { x: v.x, y: v.y, w: v.width, h: v.height, zoom: this.cameras.main.zoom }; }
  worldToScreen(x: number, y: number): { x: number; y: number } { const c = this.cameras.main; return { x: (x - c.worldView.x) * c.zoom, y: (y - c.worldView.y) * c.zoom }; }
  centerOn(x: number, y: number, zoom?: number): void { const c = this.cameras.main; if (zoom) c.setZoom(zoom); c.centerOn(x, y); this.ctrl.cameraChanged(); }

  /** Re-style nodes/edges from the controller's visual state. */
  redraw(): void {
    const vis = this.ctrl.visuals(); const g = this.edges; g.clear();
    const on = (id: string) => { const v = vis.get(id); return v === 'on' || v === 'plan' || v === 'start'; };
    for (const [a, b] of BOARD.raw.edges) {
      const A = BOARD.nodes.get(a)!.pos, Bp = BOARD.nodes.get(b)!.pos; const both = on(a) && on(b); const plan = both && (vis.get(a) === 'plan' || vis.get(b) === 'plan');
      if (plan) this.dashed(g, A.x, A.y, Bp.x, Bp.y, 0x7fd8ff, 4); else { g.lineStyle(both ? 5 : 2.5, both ? 0xf0a83a : 0x5a4a3a, both ? 1 : 0.8); g.lineBetween(A.x, A.y, Bp.x, Bp.y); }
    }
    for (const [id, o] of this.objs) this.styleNode(id, o, vis.get(id) ?? 'off');
    this.drawRings();
  }
  private styleNode(id: string, o: NodeObj, v: NodeVisual): void {
    const lit = v === 'on' || v === 'plan' || v === 'start';
    if (BOARD.nodes.get(id)?.kind === 'jewel') {
      const base = this.ctrl.socketBase(id); o.frame.setTexture(base ? 'tf-sock-filled' : 'tf-sock-empty').setDisplaySize(o.size, o.size);
      if (base) { const is = o.size * 0.5; if (!o.icon) o.icon = this.add.image(BOARD.nodes.get(id)!.pos.x, BOARD.nodes.get(id)!.pos.y, `jw-${base}`).setDepth(4); o.icon.setTexture(`jw-${base}`).setDisplaySize(is, is * 144 / 128).setVisible(true);
        o.icon.setAlpha(this.ctrl.socketLive(id) ? 1 : 0.4); } else o.icon?.setVisible(false);
      o.frame.setTint(lit ? 0xffffff : v === 'avail' ? 0xb8b0a0 : 0x6a625a); return;
    }
    o.frame.setTint(lit ? 0xffffff : v === 'avail' ? 0xb8b0a0 : 0x6a625a);
    if (o.fx) { o.fx.reset(); if (!lit) { o.fx.grayscale(1); o.fx.brightness(v === 'avail' ? 0.85 : 0.55, true); } }
    else o.icon?.setTint(lit ? 0xffffff : 0x666666);
  }
  private drawRings(): void {
    const r = this.rings; r.clear(); const vis = this.ctrl.visuals(); const pulse = 0.55 + 0.45 * Math.sin(this.t * 5);
    for (const [id, o] of this.objs) {
      const n = BOARD.nodes.get(id)!; const v = vis.get(id); const rad = o.size * 0.36;
      if (v === 'on' || v === 'start') { r.lineStyle(4, 0xff9a2a, 0.9); r.strokeCircle(n.pos.x, n.pos.y, rad); r.lineStyle(10, 0xff7a1a, 0.18); r.strokeCircle(n.pos.x, n.pos.y, rad + 3); }
      else if (v === 'plan') this.dashedCircle(r, n.pos.x, n.pos.y, rad + 2, 0x7fd8ff, pulse);
      else if (v === 'remove') this.dashedCircle(r, n.pos.x, n.pos.y, rad + 2, 0xff6a5a, pulse);
      else if (v === 'avail') { r.lineStyle(2, 0x8fd08f, 0.55); r.strokeCircle(n.pos.x, n.pos.y, rad); }
    }
    const hl = this.ctrl.highlights();
    if (hl.socket) { const s = BOARD.nodes.get(hl.socket)!; r.lineStyle(3, 0x7fd8ff, 0.55); r.strokeCircle(s.pos.x, s.pos.y, s.radius ?? 0); r.fillStyle(0x7fd8ff, 0.05); r.fillCircle(s.pos.x, s.pos.y, s.radius ?? 0); }
    // conversion preview: converted nodes flash (fast pulse + expanding ring)
    const flash = 0.5 + 0.5 * Math.sin(this.t * 9); const ph = (this.t * 1.4) % 1;
    for (const id of hl.nodes) { const n = BOARD.nodes.get(id)!; const o = this.objs.get(id)!;
      r.fillStyle(0xffe066, 0.12 + 0.28 * flash); r.fillCircle(n.pos.x, n.pos.y, o.size * 0.5);
      r.lineStyle(5, 0xffe066, 0.45 + 0.55 * flash); r.strokeCircle(n.pos.x, n.pos.y, o.size * 0.5);
      r.lineStyle(3, 0xfff2a0, 1 - ph); r.strokeCircle(n.pos.x, n.pos.y, o.size * (0.5 + 0.45 * ph)); }
  }
  private dashed(g: Phaser.GameObjects.Graphics, x1: number, y1: number, x2: number, y2: number, c: number, w: number): void {
    const L = Math.hypot(x2 - x1, y2 - y1); const n = Math.max(1, Math.floor(L / 14)); g.lineStyle(w, c, 1);
    for (let i = 0; i < n; i += 2) { const a = i / n, b = Math.min(1, (i + 1) / n); g.lineBetween(x1 + (x2 - x1) * a, y1 + (y2 - y1) * a, x1 + (x2 - x1) * b, y1 + (y2 - y1) * b); }
  }
  private dashedCircle(g: Phaser.GameObjects.Graphics, x: number, y: number, r: number, c: number, a: number): void {
    g.lineStyle(4, c, a); for (let i = 0; i < 16; i += 2) { g.beginPath(); g.arc(x, y, r, (i / 16) * Math.PI * 2, ((i + 1) / 16) * Math.PI * 2); g.strokePath(); }
  }
  update(_t: number, dt: number): void { this.t += dt / 1000; this.drawRings(); this.pinLabels(); }
  /** Zone titles keep a constant on-screen size (≈26px) at every zoom, and are clamped inside the viewport edge so they stay visible. */
  private pinLabels(): void {
    const c = this.cameras.main; const k = 0.78 / c.zoom; const v = c.worldView; const m = 40 / c.zoom;
    for (const [i, r] of Object.values(REGION_LABEL).entries()) { const t = this.labels[i]; if (!t) continue; t.setScale(k);
      const hw = (t.width * k) / 2 + m * 0.3, hh = (t.height * k) / 2 + m * 0.3;
      t.setPosition(Phaser.Math.Clamp(r.x, v.x + hw, v.right - hw), Phaser.Math.Clamp(r.y, v.y + hh + 40 / c.zoom, v.bottom - hh - 60 / c.zoom)); }
  }
}
