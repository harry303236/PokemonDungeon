import type Phaser from 'phaser';

type G = Phaser.GameObjects.Graphics;
/** Teardrop flame polygon. */
function flame(g: G, cx: number, cy: number, w: number, h: number, color: number, alpha = 1, lean = 0): void {
  const pts: { x: number; y: number }[] = [];
  for (let i = 0; i <= 24; i++) {
    const t = (i / 24) * Math.PI * 2; const sx = Math.sin(t), cyy = Math.cos(t);
    const up = cyy < 0 ? 1 : 0; // top half narrows to tip
    const r = up ? (1 + cyy) ** 0.9 : 1;
    pts.push({ x: cx + sx * (w / 2) * r + lean * up * -cyy * h * 0.3, y: cy + (cyy < 0 ? cyy * h * 0.75 : cyy * h * 0.3) });
  }
  g.fillStyle(color, alpha).fillPoints(pts, true);
}
function flameStack(g: G, cx: number, cy: number, s: number, lean = 0): void {
  flame(g, cx, cy, s * 0.9, s * 1.2, 0xc81e08, 1, lean); flame(g, cx, cy + s * 0.08, s * 0.62, s * 0.85, 0xff7a10, 1, lean); flame(g, cx, cy + s * 0.16, s * 0.32, s * 0.45, 0xffe68a, 1, lean);
}

/** Fire-themed procedural skill icons (size = icon box). */
export function drawFireIcon(g: G, id: string, cx: number, cy: number, size: number): void {
  const s = size;
  g.fillStyle(0x1a0804, 1).fillRect(cx - s / 2, cy - s / 2, s, s);
  g.fillStyle(0x5a1404, 0.55).fillCircle(cx, cy + s * 0.1, s * 0.45);
  switch (id) {
    case 'ember': flameStack(g, cx, cy + s * 0.12, s * 0.5); for (const [dx, dy] of [[-0.28, 0.2], [0.27, 0.05], [0.2, 0.3]] as const) g.fillStyle(0xffb040).fillCircle(cx + dx * s, cy + dy * s, s * 0.04); break;
    case 'flamethrower':
      for (let i = 0; i < 4; i++) flame(g, cx - s * 0.3 + i * s * 0.18, cy + s * 0.2 - i * s * 0.12, s * (0.22 + i * 0.06), s * (0.3 + i * 0.08), [0xc81e08, 0xff5a10, 0xff9a20, 0xffe68a][i] ?? 0xffffff, 1, 1);
      break;
    case 'fire-spin':
      for (let i = 0; i < 3; i++) { g.lineStyle(s * 0.07, [0xc81e08, 0xff7a10, 0xffd060][i] ?? 0xffffff, 1); g.beginPath(); g.arc(cx, cy + s * 0.05, s * (0.34 - i * 0.09), i * 1.8, i * 1.8 + Math.PI * 1.4); g.strokePath(); }
      flame(g, cx, cy + s * 0.08, s * 0.2, s * 0.3, 0xffe68a);
      break;
    case 'fire-blast': {
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i / 10) * Math.PI * 2; const r = i % 2 ? s * 0.14 : s * 0.4; pts.push({ x: cx + Math.cos(a) * r, y: cy + s * 0.04 + Math.sin(a) * r }); }
      g.fillStyle(0xff6a10).fillPoints(pts, true); g.fillStyle(0xffe68a).fillCircle(cx, cy + s * 0.04, s * 0.13);
      break;
    }
    case 'flare-blitz':
      g.fillStyle(0xc81e08, 0.9).fillTriangle(cx - s * 0.42, cy - s * 0.25, cx + s * 0.18, cy - s * 0.05, cx - s * 0.42, cy + s * 0.25);
      g.fillStyle(0xff9a20).fillTriangle(cx - s * 0.3, cy - s * 0.14, cx + s * 0.2, cy, cx - s * 0.3, cy + s * 0.14);
      g.fillStyle(0xffe68a).fillCircle(cx + s * 0.2, cy, s * 0.13);
      break;
    default: flameStack(g, cx, cy + s * 0.1, s * 0.5);
  }
}

/** Oran berry consumable icon. */
export function drawBerryIcon(g: G, cx: number, cy: number, s: number, dim: boolean): void {
  const a = dim ? 0.35 : 1;
  g.fillStyle(0x1a64d8, a).fillCircle(cx, cy + s * 0.06, s * 0.3); g.fillStyle(0x8ac8ff, a).fillCircle(cx - s * 0.1, cy - s * 0.04, s * 0.08);
  g.fillStyle(0x3aa040, a).fillTriangle(cx, cy - s * 0.22, cx + s * 0.22, cy - s * 0.36, cx + s * 0.06, cy - s * 0.18);
}
