import Phaser from 'phaser';
import { ART, BAR_BASE, HUD_KEYS, iconKey } from './hud-art';
import { HUD_FONT, PALETTE, PP_THEME, themeForType, type HudTheme } from './hud-theme';
import { drawBerryIcon, drawFireIcon } from './fire-icons';
import { t } from '../../i18n/t';

export interface HudBuff { id: string; color: number; label: string }
export interface HudState {
  hp: number; maxHp: number; pp: number; maxPp: number; level: number; xp: number; xpNext: number; levelsToEvolve: number | null;
  playerType?: Parameters<typeof themeForType>[0];
  slots: (string | null)[]; slotLabels: readonly string[]; cooldown: (id: string) => { left: number; total: number };
  items: { count: number; cdLeft: number; cdTotal: number }[]; buffs: HudBuff[];
}
export interface SlotRect { kind: 'skill' | 'item'; index: number; x: number; y: number; w: number; h: number }

const DEPTH = 30;
const ORB_SCALE = 0.5, SLOT_SCALE = 0.4, ITEM_SCALE = 0.4;
const SKILL_PITCH = 76, ITEM_PITCH = 58;

class Orb {
  backing: Phaser.GameObjects.Graphics; glow: Phaser.GameObjects.Graphics; fill: Phaser.GameObjects.Image; glass?: Phaser.GameObjects.Image;
  frame: Phaser.GameObjects.Image; maskG: Phaser.GameObjects.Graphics; text: Phaser.GameObjects.Text; label: Phaser.GameObjects.Text;
  private shown = 1;
  constructor(scene: Phaser.Scene, public theme: HudTheme, labelText: string) {
    this.backing = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH);
    this.glow = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH).setBlendMode(Phaser.BlendModes.ADD);
    this.fill = scene.add.image(0, 0, theme.fillKey).setScrollFactor(0).setDepth(DEPTH + 1);
    if (scene.textures.exists(HUD_KEYS.glass)) this.glass = scene.add.image(0, 0, HUD_KEYS.glass).setScrollFactor(0).setDepth(DEPTH + 2).setAlpha(0.6);
    this.frame = scene.add.image(0, 0, HUD_KEYS.orbFrame).setScrollFactor(0).setDepth(DEPTH + 3);
    this.maskG = scene.make.graphics({}, false).setScrollFactor(0);
    this.fill.setMask(this.maskG.createGeometryMask());
    this.text = scene.add.text(0, 0, '', { fontFamily: HUD_FONT, fontSize: '15px', color: PALETTE.text, stroke: PALETTE.shadow, strokeThickness: 4 }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 4);
    this.label = scene.add.text(0, 0, labelText, { fontFamily: HUD_FONT, fontSize: '11px', color: PALETTE.key, stroke: PALETTE.shadow, strokeThickness: 3 }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 4);
  }
  setTheme(th: HudTheme): void {
    if (th === this.theme) return; this.theme = th; this.fill.setTexture(th.fillKey);
    if (th.fillTint !== undefined) this.fill.setTint(th.fillTint); else this.fill.clearTint();
  }
  update(cx: number, cy: number, k: number, ratio: number, cur: number, max: number, time: number, pulse: boolean, flash: number): void {
    this.shown += (Math.max(0, Math.min(1, ratio)) - this.shown) * 0.2;
    const F = ART.orbFrame; const s = ORB_SCALE * k * (pulse ? 1 + 0.035 * Math.sin(time * 9) : 1);
    const r = F.r * s; const fcx = cx + (F.w / 2 - F.cx) * s, fcy = cy + (F.h / 2 - F.cy) * s; // frame image center so that hole center = (cx,cy)
    this.frame.setPosition(fcx, fcy).setScale(s);
    // dark glass behind the liquid
    this.backing.clear().fillStyle(0x050304, 0.92).fillCircle(cx, cy, r * 1.02); // empty part of the orb
    const glowA = (pulse ? 0.45 + 0.35 * Math.sin(time * 9) : 0.25) + flash;
    this.glow.clear().fillStyle(this.theme.accent, Math.max(0, Math.min(0.9, glowA)) * 0.5).fillCircle(cx, cy, r * 1.25).fillStyle(this.theme.accent, Math.max(0, Math.min(0.9, glowA)) * 0.4).fillCircle(cx, cy, r * 1.08);
    const tex = this.fill.texture.getSourceImage();
    const fs = (2 * r * 1.04) / Math.min(tex.width, tex.height);
    this.fill.setPosition(cx, cy).setScale(fs).setRotation(Math.sin(time * 0.6) * 0.08);
    this.glass?.setPosition(cx, cy).setScale((2 * r) / (this.glass.width || 1));
    // liquid mask: circle below a wavy surface at level = ratio
    const level = cy + r - 2 * r * this.shown; const pts: { x: number; y: number }[] = [];
    const steps = 32;
    for (let i = 0; i <= steps; i++) { const x = cx - r + (2 * r * i) / steps; const y = level + Math.sin(time * 3 + i * 0.6) * r * 0.035; const dx = x - cx; const half = Math.sqrt(Math.max(0, r * r - dx * dx)); pts.push({ x, y: Math.max(y, cy - half) }); }
    for (let i = steps; i >= 0; i--) { const x = cx - r + (2 * r * i) / steps; const dx = x - cx; pts.push({ x, y: cy + Math.sqrt(Math.max(0, r * r - dx * dx)) }); }
    this.maskG.clear().fillStyle(0xffffff).fillPoints(pts, true);
    this.text.setPosition(cx, cy + r * 0.15).setText(`${Math.ceil(cur)} / ${Math.round(max)}`).setFontSize(Math.round(15 * k));
    this.label.setPosition(cx, cy + r * 1.38).setFontSize(Math.round(11 * k));
  }
}

/** Diablo-style bottom HUD: HP orb, 5 skill slots + 2 consumables, XP bar, buff row, PP orb. */
export class Hud {
  private hp: Orb; private pp: Orb;
  private g: Phaser.GameObjects.Graphics; private fx: Phaser.GameObjects.Graphics; private cd: Phaser.GameObjects.Graphics;
  private slotImgs: Phaser.GameObjects.Image[] = []; private iconImgs: Phaser.GameObjects.Image[] = []; private base?: Phaser.GameObjects.Image; private texts: Phaser.GameObjects.Text[] = [];
  private xpFrame: Phaser.GameObjects.Image; private xpFill: Phaser.GameObjects.Image; private xpText: Phaser.GameObjects.Text;
  private buffTexts: Phaser.GameObjects.Text[] = [];
  private flashes = [0, 0, 0, 0, 0, 0, 0];
  private ppFlash = 0;
  rects: SlotRect[] = [];
  bounds = new Phaser.Geom.Rectangle();
  dragFrom: number | null = null;

  constructor(private scene: Phaser.Scene) {
    this.hp = new Orb(scene, themeForType('fire'), 'HP');
    this.pp = new Orb(scene, PP_THEME, 'PP');
    this.g = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 1);
    if (scene.textures.exists(HUD_KEYS.barBase)) this.base = scene.add.image(0, 0, HUD_KEYS.barBase).setScrollFactor(0).setDepth(DEPTH);
    for (let i = 0; i < 7; i++) this.iconImgs.push(scene.add.image(0, 0, '__DEFAULT').setScrollFactor(0).setDepth(DEPTH + 2).setVisible(false));
    for (let i = 0; i < 7; i++) this.slotImgs.push(scene.add.image(0, 0, i < 5 ? HUD_KEYS.slotFrame : HUD_KEYS.slotFrameSmall).setScrollFactor(0).setDepth(DEPTH + 3));
    this.cd = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 3.5);
    this.fx = scene.add.graphics().setScrollFactor(0).setDepth(DEPTH + 4).setBlendMode(Phaser.BlendModes.ADD);
    const txt = (size: number, color: string): Phaser.GameObjects.Text => scene.add.text(0, 0, '', { fontFamily: HUD_FONT, fontSize: `${size}px`, color, stroke: PALETTE.shadow, strokeThickness: 4 }).setOrigin(0.5).setScrollFactor(0).setDepth(DEPTH + 5);
    for (let i = 0; i < 7; i++) this.texts.push(txt(12, PALETTE.key), txt(18, PALETTE.text), txt(11, PALETTE.text)); // key, cooldown, count
    this.xpFrame = scene.add.image(0, 0, HUD_KEYS.xpFrame).setScrollFactor(0).setDepth(DEPTH + 3);
    this.xpFill = scene.add.image(0, 0, HUD_KEYS.xpFill).setScrollFactor(0).setDepth(DEPTH + 2).setOrigin(0, 0.5);
    this.xpText = txt(12, PALETTE.text);
    for (let i = 0; i < 6; i++) this.buffTexts.push(txt(9, PALETTE.text));
  }

  flashSlot(i: number): void { if (i >= 0 && i < this.flashes.length) this.flashes[i] = 1; this.ppFlash = 0.5; }
  contains(x: number, y: number): boolean { return this.bounds.contains(x, y); }
  slotAt(x: number, y: number): SlotRect | null { return this.rects.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) ?? null; }

  update(st: HudState, dt: number, time: number): void {
    const W = this.scene.scale.width, H = this.scene.scale.height;
    const k = Math.max(0.4, Math.min(1.25, W / 1280, (W - 24) / 960, H / 600)); // full layout spans ~940k px
    const cx = W / 2, base_ = H - 70 * k; const g = this.g; const fx = this.fx; g.clear(); fx.clear(); this.cd.clear();
    for (let i = 0; i < this.flashes.length; i++) this.flashes[i] = Math.max(0, (this.flashes[i] ?? 0) - dt * 4);
    this.ppFlash = Math.max(0, this.ppFlash - dt * 2.5);
    const base = this.base; const bb = BAR_BASE;
    const b = base ? Math.min(0.5 * k, (W - 24 - 2 * 175 * k) / bb.w) : 0; // bar-base scale
    const baseCY = H - (bb.h * b) / 2 - 2 * k;
    const orbDX = base ? (bb.w * b) / 2 + 78 * k : 372 * k; const orbY = base ? baseCY : base_ - 34 * k;
    // orbs
    this.hp.setTheme(themeForType(st.playerType));
    this.hp.update(cx - orbDX, orbY, k, st.hp / Math.max(1, st.maxHp), st.hp, st.maxHp, time, st.hp / Math.max(1, st.maxHp) < 0.3, 0);
    this.pp.update(cx + orbDX, orbY, k, st.pp / Math.max(1, st.maxPp), st.pp, st.maxPp, time, false, this.ppFlash);
    // slot geometry: artist bar base sockets, or fallback row with individual slot frames
    const left = cx - 262 * k, right = cx + 262 * k, fallbackY = base_ - 26 * k;
    const slotPos = (i: number): { x: number; y: number; size: number } => base
      ? ((so) => ({ x: cx + (so.cx - bb.w / 2) * b, y: baseCY + (so.cy - bb.h / 2) * b, size: Math.min(so.w, so.h) * b * 0.92 }))(bb.sockets[i] ?? { cx: 0, cy: 0, w: 0, h: 0 })
      : { x: i < 5 ? left + 38 * k + i * SKILL_PITCH * k : left + 5 * SKILL_PITCH * k + 47 * k + (i - 5) * ITEM_PITCH * k, y: i < 5 ? fallbackY : fallbackY + 6 * k,
          size: (i < 5 ? ART.slot.inner * SLOT_SCALE : ART.item.inner * ITEM_SCALE) * k * 0.92 };
    if (base) base.setPosition(cx, baseCY).setScale(b).setVisible(true);
    else g.fillStyle(0x0a0806, 0.78).fillRoundedRect(left - 8 * k, fallbackY - 44 * k, right - left + 16 * k, H - (fallbackY - 44 * k) + 12 * k, 10 * k);
    this.rects = [];
    for (let i = 0; i < 7; i++) {
      const isSkill = i < 5; const { x, y, size: inner } = slotPos(i);
      const img = this.slotImgs[i]; if (!img) continue;
      img.setVisible(!base).setPosition(x, y).setScale((isSkill ? SLOT_SCALE : ITEM_SCALE) * k);
      this.rects.push({ kind: isSkill ? 'skill' : 'item', index: isSkill ? i : i - 5, x: x - inner / 2, y: y - inner / 2, w: inner, h: inner });
      const [keyT, cdT, cntT] = [this.texts[i * 3], this.texts[i * 3 + 1], this.texts[i * 3 + 2]];
      const so = bb.sockets[i]; const keyY = base && so ? baseCY + (so.cy + so.h / 2 + 12 - bb.h / 2) * b + 2 * k : y + inner / 2 + 11 * k;
      keyT?.setPosition(x, keyY).setText(isSkill ? st.slotLabels[i] ?? '' : String(i - 4)).setFontSize(Math.round(12 * k));
      const icon = this.iconImgs[i]; const iconId = isSkill ? st.slots[i] : i === 5 ? 'berry' : null;
      const art = !!iconId && this.scene.textures.exists(iconKey(iconId));
      if (icon) { icon.setVisible(art); if (art && iconId) { if (icon.texture.key !== iconKey(iconId)) icon.setTexture(iconKey(iconId)); icon.setPosition(x, y).setDisplaySize(inner, inner); } }
      let left_ = 0, total = 1;
      if (isSkill) {
        const id = st.slots[i];
        if (id) { if (!art) drawFireIcon(g, id, x, y, inner); const c = st.cooldown(id); left_ = c.left; total = c.total; }
        else if (!base) g.fillStyle(0x000000, 0.6).fillRect(x - inner / 2, y - inner / 2, inner, inner);
        cntT?.setText('');
        if (this.dragFrom === i) fx.lineStyle(2, 0xffd080, 0.9).strokeRect(x - inner / 2, y - inner / 2, inner, inner);
      } else {
        const it = st.items[i - 5]; const has = !!it && it.count > 0;
        if (!base) g.fillStyle(0x000000, 0.6).fillRect(x - inner / 2, y - inner / 2, inner, inner);
        if (i === 5) { if (!art) drawBerryIcon(g, x, y, inner, !has); else icon?.setAlpha(has ? 1 : 0.35); }
        cntT?.setPosition(x + inner / 2 - 8 * k, y + inner / 2 - 9 * k).setText(it && i === 5 ? String(it.count) : '').setFontSize(Math.round(13 * k));
        if (it) { left_ = it.cdLeft; total = Math.max(0.001, it.cdTotal); }
      }
      // cooldown sweep (dim pie) + seconds; drawn above icons
      if (left_ > 0.02) {
        const frac = Math.min(1, left_ / total);
        this.cd.fillStyle(0x000000, 0.55).slice(x, y, inner * 0.72, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2, false).fillPath();
        this.cd.fillStyle(0x000000, 0.25).fillRect(x - inner / 2, y - inner / 2, inner, inner);
        cdT?.setPosition(x, y).setText(left_ >= 10 ? left_.toFixed(0) : left_.toFixed(1)).setFontSize(Math.round((isSkill ? 20 : 15) * k));
      } else cdT?.setText('');
      const fl = this.flashes[i] ?? 0;
      if (fl > 0) { this.fx.fillStyle(0xff7a20, 0.55 * fl).fillRect(x - inner / 2 - 4, y - inner / 2 - 4, inner + 8, inner + 8); this.fx.fillStyle(0xffd080, 0.35 * fl).fillCircle(x, y, inner * 0.6); }
    }
    // XP bar (fill cropped by ratio; frame = bar-base groove or fallback xp frame)
    const xpY = base ? baseCY + (bb.xp.y - bb.h / 2) * b : H - 18 * k;
    const innerW = base ? (bb.xp.x1 - bb.xp.x0) * b : (right - left) * 0.98 * 0.84;
    const xpX0 = base ? cx + (bb.xp.x0 - bb.w / 2) * b : cx - innerW / 2;
    const xpH = base ? bb.xp.h * b * 0.9 : 14 * k;
    this.xpFrame.setVisible(!base);
    if (!base) { const fw = (right - left) * 0.98; const fsx = fw / ART.xpFrame.w; this.xpFrame.setPosition(cx, xpY).setScale(fsx, fsx * 0.9); }
    const ratio = Math.max(0, Math.min(1, st.xp / Math.max(1, st.xpNext)));
    const fill = this.xpFill; const tw = fill.texture.getSourceImage().width, th = fill.texture.getSourceImage().height;
    fill.setPosition(xpX0, xpY).setScale(innerW / tw, xpH / th).setCrop(0, 0, tw * ratio, th);
    fx.fillStyle(0xffa040, 0.2).fillRect(xpX0, xpY - xpH / 2, innerW * ratio, xpH);
    const evo = st.levelsToEvolve === null ? t('hud.xp.final') : t('hud.xp.evo', { n: st.levelsToEvolve });
    this.xpText.setPosition(cx, xpY).setText(`Lv ${st.level}  ·  ${Math.floor(ratio * 100)}%  ·  ${evo}`).setFontSize(Math.round(12 * k));
    const s0 = bb.sockets[0] ?? { cx: 0, cy: 0, w: 0, h: 0 };
    const buffLeft = base ? cx + (s0.cx - s0.w / 2 - bb.w / 2) * b : left;
    const slotTop = base ? baseCY + (s0.cy - s0.h / 2 - bb.h / 2) * b : fallbackY - 34 * k;
    // buff row (above slots, left aligned)
    const by = slotTop - 40 * k;
    this.buffTexts.forEach((bt, i) => {
      const b = st.buffs[i]; if (!b) { bt.setText(''); return; }
      const bx = buffLeft + 14 * k + i * 30 * k;
      g.fillStyle(0x000000, 0.7).fillRect(bx - 12 * k, by - 12 * k, 24 * k, 24 * k);
      g.fillStyle(b.color, 0.9).fillCircle(bx, by, 8 * k); g.lineStyle(2, 0xc8b080, 0.9).strokeRect(bx - 12 * k, by - 12 * k, 24 * k, 24 * k);
      bt.setPosition(bx, by + 19 * k).setText(b.label).setFontSize(Math.round(10 * k));
    });
    const top = Math.min(by - 14 * k, orbY - 100 * k);
    this.bounds.setTo(cx - orbDX - 90 * k, top, 2 * (orbDX + 90 * k), H - top);
  }
}
