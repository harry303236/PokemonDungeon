import type { Rng } from '../rng';
export interface Room { x: number; y: number; w: number; h: number; cx: number; cy: number }
export interface FloorMap { w: number; h: number; tiles: Uint8Array; rooms: Room[]; start: Room; exit: Room }
export const WALL = 0;
export const FLOOR = 1;

interface Leaf { x: number; y: number; w: number; h: number; a?: Leaf; b?: Leaf; room?: Room }
const MIN_LEAF = 12;

function split(l: Leaf, rng: Rng, depth: number): void {
  if (depth > 5) return;
  const horiz = l.w / l.h < 0.8 ? true : l.h / l.w < 0.8 ? false : rng.next() < 0.5;
  const size = horiz ? l.h : l.w;
  if (size < MIN_LEAF * 2) return;
  const cut = rng.int(MIN_LEAF, size - MIN_LEAF);
  if (horiz) { l.a = { x: l.x, y: l.y, w: l.w, h: cut }; l.b = { x: l.x, y: l.y + cut, w: l.w, h: l.h - cut }; }
  else { l.a = { x: l.x, y: l.y, w: cut, h: l.h }; l.b = { x: l.x + cut, y: l.y, w: l.w - cut, h: l.h }; }
  split(l.a, rng, depth + 1); split(l.b, rng, depth + 1);
}

/** Deterministic BSP floor: same seed -> same floor. */
export function generateFloor(rng: Rng, w = 72, h = 54): FloorMap {
  const tiles = new Uint8Array(w * h);
  const root: Leaf = { x: 1, y: 1, w: w - 2, h: h - 2 };
  split(root, rng, 0);
  const rooms: Room[] = [];
  const carve = (x: number, y: number): void => { if (x > 0 && y > 0 && x < w - 1 && y < h - 1) tiles[y * w + x] = FLOOR; };
  const visit = (l: Leaf): Room => {
    if (l.a && l.b) {
      const ra = visit(l.a); const rb = visit(l.b);
      // L-shaped corridor, 2 tiles wide
      const mx = rng.next() < 0.5;
      const [x1, y1, x2, y2] = [ra.cx, ra.cy, rb.cx, rb.cy];
      const hline = (y: number, xa: number, xb: number): void => { for (let x = Math.min(xa, xb); x <= Math.max(xa, xb); x++) { carve(x, y); carve(x, y + 1); } };
      const vline = (x: number, ya: number, yb: number): void => { for (let y = Math.min(ya, yb); y <= Math.max(ya, yb); y++) { carve(x, y); carve(x + 1, y); } };
      if (mx) { hline(y1, x1, x2); vline(x2, y1, y2); } else { vline(x1, y1, y2); hline(y2, x1, x2); }
      return rng.next() < 0.5 ? ra : rb;
    }
    const rw = rng.int(6, Math.max(6, l.w - 3)); const rh = rng.int(5, Math.max(5, l.h - 3));
    const rx = l.x + rng.int(1, Math.max(1, l.w - rw - 1)); const ry = l.y + rng.int(1, Math.max(1, l.h - rh - 1));
    const room: Room = { x: rx, y: ry, w: rw, h: rh, cx: Math.floor(rx + rw / 2), cy: Math.floor(ry + rh / 2) };
    for (let y = ry; y < ry + rh; y++) for (let x = rx; x < rx + rw; x++) carve(x, y);
    rooms.push(room); l.room = room;
    return room;
  };
  visit(root);
  const start = rooms[0];
  if (!start) throw new Error('no rooms');
  let exit = start; let best = -1;
  for (const r of rooms) { const d = Math.hypot(r.cx - start.cx, r.cy - start.cy); if (d > best) { best = d; exit = r; } }
  return { w, h, tiles, rooms, start, exit };
}
export const isWall = (f: FloorMap, tx: number, ty: number): boolean =>
  tx < 0 || ty < 0 || tx >= f.w || ty >= f.h || f.tiles[ty * f.w + tx] === WALL;
