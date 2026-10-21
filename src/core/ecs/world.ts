import type { TypeId } from '../../data/schemas';
import type { Stats } from '../stats/stat-calc';
import type { Item } from '../loot/loot-roller';

export type EntityKind = 'player' | 'monster' | 'projectile' | 'beam' | 'zone' | 'blast' | 'item';
export type Team = 'player' | 'enemy';

/** Lightweight entity record: components are optional fields (see ADR-015 in docs/decisions.md). */
export interface Entity {
  id: number; kind: EntityKind; x: number; y: number; vx: number; vy: number; r: number; rot: number;
  team?: Team; owner?: number; dead?: boolean;
  // combat
  hp?: number; maxHp?: number; stats?: Stats; level?: number; types?: TypeId[]; speciesId?: string;
  iframes?: number; burn?: { stacks: number; t: number; src: number }; bound?: { t: number; src: number };
  // monster
  monsterId?: string; ai?: { cd: number; windup: number; state: 'idle' | 'chase' | 'attack' }; isBoss?: boolean;
  // damage carriers
  moveId?: string; life?: number; tick?: number; tickT?: number; hitSet?: Set<number>; pierce?: number;
  len?: number; width?: number; /** beam: current reach after wall clipping */ reach?: number; delay?: number; mods?: MoveMods;
  // dash
  dash?: { t: number; dirX: number; dirY: number; speed: number; hit: boolean; moveId?: string };
  // loot
  item?: Item;
}
export interface MoveMods { powerBonus: number; leech: number; kindling: boolean }

export class World {
  private nextId = 1;
  readonly entities = new Map<number, Entity>();
  spawn(e: Omit<Entity, 'id' | 'vx' | 'vy' | 'rot'> & Partial<Pick<Entity, 'vx' | 'vy' | 'rot'>>): Entity {
    const full: Entity = { vx: 0, vy: 0, rot: 0, ...e, id: this.nextId++ };
    this.entities.set(full.id, full);
    return full;
  }
  get(id: number): Entity | undefined { return this.entities.get(id); }
  query(kind: EntityKind): Entity[] { const out: Entity[] = []; for (const e of this.entities.values()) if (e.kind === kind && !e.dead) out.push(e); return out; }
  cleanup(): void { for (const [id, e] of this.entities) if (e.dead) this.entities.delete(id); }
}

/** Uniform-grid spatial hash (cell 64px) for broad-phase hit tests. */
export class SpatialHash {
  private cells = new Map<number, Entity[]>();
  constructor(private cell = 64) {}
  private key(cx: number, cy: number): number { return cx * 73856093 ^ cy * 19349663; }
  clear(): void { this.cells.clear(); }
  insert(e: Entity): void {
    const k = this.key(Math.floor(e.x / this.cell), Math.floor(e.y / this.cell));
    let l = this.cells.get(k); if (!l) { l = []; this.cells.set(k, l); } l.push(e);
  }
  near(x: number, y: number, radius: number): Entity[] {
    const out: Entity[] = [];
    const c0x = Math.floor((x - radius) / this.cell), c1x = Math.floor((x + radius) / this.cell);
    const c0y = Math.floor((y - radius) / this.cell), c1y = Math.floor((y + radius) / this.cell);
    for (let cx = c0x; cx <= c1x; cx++) for (let cy = c0y; cy <= c1y; cy++) { const l = this.cells.get(this.key(cx, cy)); if (l) out.push(...l); }
    return out;
  }
}
