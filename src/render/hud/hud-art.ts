import Phaser from 'phaser';

/** Replaceable HUD texture keys. Drop artist PNGs at public/assets/hud/<key>.png to override; otherwise generated here. */
export const HUD_KEYS = {
  orbFrame: 'hud-orb-frame', hpFill: 'hud-orb-hp-fill', ppFill: 'hud-orb-pp-fill', slotFrame: 'hud-slot-frame', slotFrameSmall: 'hud-slot-frame-small',
  xpFrame: 'hud-xp-frame', xpFill: 'hud-xp-fill', glass: 'hud-orb-glass', buffFrame: 'hud-buff-frame', barBase: 'hud-bar-base',
} as const;
/** Bar base slice geometry (1250x445): 7 sockets (5 skills + 2 consumables) + XP groove, in source pixels. */
export const BAR_BASE = { w: 1250, h: 445, sockets: [168, 319, 471, 624, 777, 930, 1083], socketY: 197, socketW: 116, socketH: 138, xp: { x0: 137, x1: 1105, y: 329.5, h: 29 } };
/** Icon file names differ from move ids where the artist used the English move name. */
const ICON_ALIAS: Record<string, string> = { 'flare-blitz': 'flame-charge' };
export const iconKey = (id: string): string => `icon-${ICON_ALIAS[id] ?? id}`;
const ICON_INDEX = 'hud-icon-index';
/** Geometry of the artist slices (procedural fallbacks are drawn to the same sizes). */
export const ART = {
  orbFrame: { w: 334, h: 348, cx: 167, cy: 176, r: 92 },
  slot: { w: 179, h: 208, inner: 145 }, item: { w: 145, h: 137, inner: 111 },
  xpFrame: { w: 743, h: 66 }, xpFill: { w: 706, h: 34 },
};
const ARTIST_KEYS = [HUD_KEYS.barBase, HUD_KEYS.orbFrame, HUD_KEYS.hpFill, HUD_KEYS.ppFill, HUD_KEYS.slotFrame, HUD_KEYS.slotFrameSmall, HUD_KEYS.xpFrame, HUD_KEYS.xpFill];
/** Artist PNGs live in public/assets/hud/<key>.png (committed, original art). Missing files -> procedural fallback. */
export function queueHudArt(scene: Phaser.Scene): void {
  for (const k of ARTIST_KEYS) scene.load.image(k, `assets/hud/${k}.png`);
  scene.load.json(ICON_INDEX, 'assets/hud/icons/index.json');
}
/** Second boot phase: queue every icon listed in icons/index.json (e.g. icon-ember -> assets/hud/icons/icon-ember.png). */
export function queueHudIcons(scene: Phaser.Scene): number {
  const list = scene.cache.json.get(ICON_INDEX) as unknown;
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const name of list) if (typeof name === 'string' && /^[a-z0-9-]+$/.test(name)) { scene.load.image(`icon-${name}`, `assets/hud/icons/icon-${name}.png`); n++; }
  return n;
}

type Ctx = CanvasRenderingContext2D;
function canvas(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: Ctx) => void): void {
  if (scene.textures.exists(key)) return; // artist override (or already generated)
  const tex = scene.textures.createCanvas(key, w, h); if (!tex) return;
  draw(tex.getContext()); tex.refresh();
}
const iron = (c: Ctx, x0: number, y0: number, x1: number, y1: number): CanvasGradient => {
  const g = c.createLinearGradient(x0, y0, x1, y1); g.addColorStop(0, '#5c5c66'); g.addColorStop(0.45, '#26262c'); g.addColorStop(1, '#0e0e12'); return g;
};
function rivet(c: Ctx, x: number, y: number, r = 3): void {
  const g = c.createRadialGradient(x - r / 3, y - r / 3, 0, x, y, r); g.addColorStop(0, '#b8b8c0'); g.addColorStop(1, '#202026');
  c.fillStyle = g; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fill();
}
function spike(c: Ctx, x: number, y: number, w: number, h: number): void {
  c.fillStyle = iron(c, x - w, y - h, x + w, y); c.beginPath(); c.moveTo(x - w, y); c.lineTo(x, y - h); c.lineTo(x + w, y); c.closePath(); c.fill();
  c.strokeStyle = '#08080a'; c.lineWidth = 1.5; c.stroke();
}

export function generateHudTextures(scene: Phaser.Scene): void {
  const F = ART.orbFrame; const R = F.r;
  canvas(scene, HUD_KEYS.orbFrame, F.w, F.h, (c) => {
    const C = F.cx, CY = F.cy;
    for (const [a, h] of [[-90, 60], [-62, 36], [-118, 36], [90, 40]] as const) { const rad = (a * Math.PI) / 180; c.save(); c.translate(C + Math.cos(rad) * (R + 26), CY + Math.sin(rad) * (R + 26)); c.rotate(rad + Math.PI / 2); spike(c, 0, 0, 14, h); c.restore(); }
    c.lineWidth = 30; c.strokeStyle = iron(c, 0, 0, F.w, F.h); c.beginPath(); c.arc(C, CY, R + 16, 0, Math.PI * 2); c.stroke();
    c.lineWidth = 3; c.strokeStyle = '#7a7a86'; c.beginPath(); c.arc(C, CY, R + 2, Math.PI, Math.PI * 2); c.stroke();
    c.strokeStyle = '#55555f'; c.lineWidth = 2;
    for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; c.beginPath(); c.arc(C + Math.cos(a) * (R + 16), CY + Math.sin(a) * (R + 16), 7, a, a + Math.PI * 1.3); c.stroke(); }
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2 + 0.2; rivet(c, C + Math.cos(a) * (R + 16), CY + Math.sin(a) * (R + 16), 4); }
  });
  const fill = (key: string, top: string, bottom: string, swirl: string): void => canvas(scene, key, R * 2, R * 2, (c) => {
    const g = c.createLinearGradient(0, 0, 0, R * 2); g.addColorStop(0, top); g.addColorStop(1, bottom);
    c.fillStyle = g; c.beginPath(); c.arc(R, R, R, 0, Math.PI * 2); c.fill();
    for (let i = 0; i < 4; i++) {
      c.strokeStyle = swirl; c.globalAlpha = 0.15 + i * 0.08; c.lineWidth = 9 - i * 2; c.beginPath();
      for (let t = 0; t <= 1; t += 0.02) { const a = t * Math.PI * 2.6 + i; const rr = R * 0.92 * t; const x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr * 0.8; if (t === 0) c.moveTo(x, y); else c.lineTo(x, y); }
      c.stroke();
    }
    c.globalAlpha = 1;
  });
  fill(HUD_KEYS.hpFill, '#ff4a38', '#5a0306', '#ffc2a0');
  fill(HUD_KEYS.ppFill, '#ffd860', '#6a4200', '#fff2b0');
  canvas(scene, HUD_KEYS.glass, R * 2, R * 2, (c) => {
    const g = c.createRadialGradient(R * 0.7, R * 0.55, 2, R, R, R); g.addColorStop(0, 'rgba(255,255,255,0.45)'); g.addColorStop(0.25, 'rgba(255,255,255,0.06)'); g.addColorStop(0.85, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.6)');
    c.fillStyle = g; c.beginPath(); c.arc(R, R, R, 0, Math.PI * 2); c.fill();
  });
  const slotFrame = (key: string, w: number, h: number, inner: number): void => canvas(scene, key, w, h, (c) => {
    const x0 = (w - inner) / 2 - 10, y0 = (h - inner) / 2 - 10, m = inner + 20;
    c.fillStyle = iron(c, x0, y0, x0 + m, y0 + m); c.fillRect(x0, y0, m, m);
    c.clearRect(x0 + 10, y0 + 10, inner, inner);
    c.strokeStyle = '#8a8a94'; c.lineWidth = 2; c.strokeRect(x0 + 2, y0 + 2, m - 4, m - 4);
    spike(c, w / 2, y0, 10, 22);
    for (const [x, y] of [[x0 + 5, y0 + 5], [x0 + m - 5, y0 + 5], [x0 + 5, y0 + m - 5], [x0 + m - 5, y0 + m - 5]] as const) rivet(c, x, y, 3);
  });
  slotFrame(HUD_KEYS.slotFrame, ART.slot.w, ART.slot.h, ART.slot.inner);
  slotFrame(HUD_KEYS.slotFrameSmall, ART.item.w, ART.item.h, ART.item.inner);
  canvas(scene, HUD_KEYS.xpFrame, ART.xpFrame.w, ART.xpFrame.h, (c) => {
    const W = ART.xpFrame.w, H = ART.xpFrame.h; c.fillStyle = iron(c, 0, 0, 0, H);
    c.beginPath(); c.moveTo(0, H / 2); c.lineTo(40, 6); c.lineTo(W - 40, 6); c.lineTo(W, H / 2); c.lineTo(W - 40, H - 6); c.lineTo(40, H - 6); c.closePath(); c.fill();
    c.strokeStyle = '#75757f'; c.lineWidth = 2; c.stroke(); c.clearRect(60, 18, W - 120, H - 36);
  });
  canvas(scene, HUD_KEYS.xpFill, ART.xpFill.w, ART.xpFill.h, (c) => {
    const g = c.createLinearGradient(0, 0, 0, ART.xpFill.h); g.addColorStop(0, '#ffe08a'); g.addColorStop(0.5, '#ff8a1c'); g.addColorStop(1, '#8a2a04');
    c.fillStyle = g; c.fillRect(0, 0, ART.xpFill.w, ART.xpFill.h);
  });
  canvas(scene, HUD_KEYS.buffFrame, 30, 30, (c) => { c.strokeStyle = '#8a7a5a'; c.lineWidth = 2; c.strokeRect(1, 1, 28, 28); c.strokeStyle = '#000'; c.strokeRect(3, 3, 24, 24); });
}
