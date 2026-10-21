import { isWall, type FloorMap } from './bsp-gen';

export interface Pt { x: number; y: number }
const DIRS: [number, number, number][] = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

/** A* on the tile grid (8-dir, no corner cutting). Returns tile coords from start (exclusive) to goal, or null. */
export function findPath(f: FloorMap, sx: number, sy: number, gx: number, gy: number, maxNodes = 6000): Pt[] | null {
  if (isWall(f, gx, gy) || isWall(f, sx, sy)) return null;
  if (sx === gx && sy === gy) return [];
  const W = f.w; const key = (x: number, y: number): number => y * W + x;
  const g = new Map<number, number>([[key(sx, sy), 0]]); const from = new Map<number, number>();
  const h = (x: number, y: number): number => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
  // binary heap of [f, key]
  const heap: [number, number][] = [[h(sx, sy), key(sx, sy)]];
  const push = (it: [number, number]): void => { heap.push(it); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if ((heap[p]?.[0] ?? 0) <= it[0]) break; heap[i] = heap[p] as [number, number]; i = p; } heap[i] = it; };
  const pop = (): [number, number] | undefined => {
    const top = heap[0]; const last = heap.pop(); if (!top || !last || heap.length === 0) return top;
    let i = 0; const n = heap.length;
    for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; let mv = last[0];
      if (l < n && (heap[l]?.[0] ?? Infinity) < mv) { m = l; mv = heap[l]?.[0] ?? Infinity; }
      if (r < n && (heap[r]?.[0] ?? Infinity) < mv) m = r;
      if (m === i) break; heap[i] = heap[m] as [number, number]; i = m; }
    heap[i] = last; return top;
  };
  const closed = new Set<number>(); let expanded = 0;
  while (heap.length) {
    const cur = pop(); if (!cur) break; const k = cur[1];
    if (closed.has(k)) continue; closed.add(k);
    const cx = k % W, cy = Math.floor(k / W);
    if (cx === gx && cy === gy) {
      const out: Pt[] = []; let c: number | undefined = k;
      while (c !== undefined && c !== key(sx, sy)) { out.push({ x: c % W, y: Math.floor(c / W) }); c = from.get(c); }
      return out.reverse();
    }
    if (++expanded > maxNodes) return null;
    const cg = g.get(k) ?? 0;
    for (const [dx, dy, cost] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (isWall(f, nx, ny)) continue;
      if (dx && dy && (isWall(f, cx + dx, cy) || isWall(f, cx, cy + dy))) continue;
      const nk = key(nx, ny); const ng = cg + cost;
      if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, k); push([ng + h(nx, ny), nk]); }
    }
  }
  return null;
}

/** Nearest floor tile (BFS rings) to a tile coord; null if none within radius. */
export function nearestFloorTile(f: FloorMap, tx: number, ty: number, maxR = 12): Pt | null {
  if (!isWall(f, tx, ty)) return { x: tx, y: ty };
  for (let r = 1; r <= maxR; r++) {
    let best: Pt | null = null; let bd = Infinity;
    for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) {
      if (Math.max(Math.abs(x - tx), Math.abs(y - ty)) !== r || isWall(f, x, y)) continue;
      const d = Math.hypot(x - tx, y - ty); if (d < bd) { bd = d; best = { x, y }; }
    }
    if (best) return best;
  }
  return null;
}

/** Clamp a world-space point onto walkable floor (center of nearest floor tile if inside a wall). */
export function clampToFloor(f: FloorMap, x: number, y: number, tile: number): Pt {
  const tx = Math.floor(x / tile), ty = Math.floor(y / tile);
  if (!isWall(f, tx, ty)) return { x, y };
  const n = nearestFloorTile(f, tx, ty);
  return n ? { x: (n.x + 0.5) * tile, y: (n.y + 0.5) * tile } : { x, y };
}

/** Tile-sampled line of sight. */
export function hasLineOfSight(f: FloorMap, ax: number, ay: number, bx: number, by: number, tile: number): boolean {
  const d = Math.hypot(bx - ax, by - ay); const n = Math.ceil(d / (tile / 3));
  for (let i = 1; i < n; i++) { const t = i / n; if (isWall(f, Math.floor((ax + (bx - ax) * t) / tile), Math.floor((ay + (by - ay) * t) / tile))) return false; }
  return true;
}
