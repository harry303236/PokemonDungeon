/**
 * Talent system v4 (charmander-talents-v4.json): shared passive board (nodes + undirected edges), move trunk, ascendancy, jewels.
 * Pure functions over BoardState (ids only — never coordinates). Rules:
 *  - allocate: node must be adjacent to the start node or an allocated node; `requires` only for special conditions (keystone → zone N3).
 *  - refund: blocked if any remaining allocated node would lose its path to the start (BFS) or a `requires` dependent remains.
 *  - points: 1/level shared by board nodes + move ranks (rank 1 of the Lv1 move is free so the basic attack works at Lv1).
 */
import RAW from '../../data/build/charmander-talents-v4.json';
import RULES from '../../data/build/jewel-rules.json';
import { TALENT_EFFECTS, emptyBonuses, pct, type Handler, type PlayerBonuses, type TalentNode } from './talents';
import { warnOnce as _w, type Modifier } from './pipeline';

export interface BoardNode {
  id: string; kind: 'start' | 'small' | 'notable' | 'keystone' | 'jewel'; name: string; effectType: string; value: number | string | Record<string, number | string> | null;
  pos: { x: number; y: number }; branch?: string; region?: string; startFor?: string; requires?: string[]; exclusiveGroup?: string | null; drawback?: string; radius?: number; affectsNodes?: string[]; desc?: string;
}
export interface AscNode { id: string; name: string; entry?: boolean; effectType: string; value: number | Record<string, number>; desc?: string; requires?: string[]; exclusiveGroup?: string | null }
export interface TrunkMove { move: string; learnLevel: number; maxRank: number; enhance: string; variantAtRank: number; note?: string }
export interface BoardRaw {
  meta: { pointsPerLevel: number; totalPoints: number; ascendancyPoints: Record<string, number>; respec: { freeBeforeLevel: number }; mechanics?: Record<string, number | string>; [k: string]: unknown };
  moveTrunk: TrunkMove[]; nodes: BoardNode[]; edges: [string, string][]; ascendancy: AscNode[]; jewels: { legendary: { id: string; name: string; rule: string; implicit?: Implicit }[]; rules: string[]; normal: Record<string, unknown> };
}
export interface JewelItem { uid: string; base: string; affixes?: { effectType: string; value: number }[] }
export interface BoardState { nodes: string[]; moves: Record<string, number>; asc: string[]; jewels: JewelItem[]; sockets: Record<string, string> }
export interface Effect { effectType: string; value: number | string | Record<string, number | string> | null }

export class Board {
  readonly nodes = new Map<string, BoardNode>(); readonly adj = new Map<string, Set<string>>(); readonly socketRadius = new Map<string, string[]>(); readonly owner = new Map<string, string>();
  sockDist(sock: string, id: string): number { const a = this.nodes.get(sock)!.pos, c = this.nodes.get(id)!.pos; return Math.hypot(a.x - c.x, a.y - c.y); }
  readonly asc = new Map<string, AscNode>(); readonly trunk = new Map<string, TrunkMove>(); edgeCount = 0;
  constructor(readonly raw: BoardRaw) {
    for (const n of raw.nodes) { this.nodes.set(n.id, n); this.adj.set(n.id, new Set()); }
    for (const [a, b] of raw.edges) { if (!this.nodes.has(a) || !this.nodes.has(b)) continue; this.adj.get(a)!.add(b); this.adj.get(b)!.add(a); this.edgeCount++; }
    // in-radius lists come ONLY from data (affectsNodes, precomputed by gen_v4.py with nearest-socket-wins); never recomputed at runtime
    for (const s of raw.nodes) if (s.kind === 'jewel') this.socketRadius.set(s.id, [...(s.affectsNodes ?? [])]);
    // node -> owning socket (data guarantees uniqueness; if data ever overlaps, nearest socket then id order wins)
    for (const [sock, ids] of this.socketRadius) for (const id of ids) {
      const cur = this.owner.get(id); if (!cur || this.sockDist(sock, id) < this.sockDist(cur, id) || (this.sockDist(sock, id) === this.sockDist(cur, id) && sock < cur)) this.owner.set(id, sock);
    }
    for (const a of raw.ascendancy) this.asc.set(a.id, a);
    for (const t of raw.moveTrunk) this.trunk.set(t.move, t);
  }
  get meta() { return this.raw.meta; }
  startFor(line: string): string { return this.raw.nodes.find((n) => n.kind === 'start' && n.startFor === line)?.id ?? this.raw.nodes[0]!.id; }
  /** the Lv1 trunk move (rank 1 free) */
  get freeMove(): string { return [...this.trunk.values()].sort((a, b) => a.learnLevel - b.learnLevel)[0]!.move; }
}
export const loadBoard = (raw: BoardRaw): Board => new Board(raw);
export const BOARD = loadBoard(RAW as unknown as BoardRaw);
export const JEWEL_RULES = RULES as unknown as {
  legendary: Record<string, { from: string[]; mode: 'replace' | 'add'; to: { effectType: string; mult: number; abs?: boolean }[] }>;
  normal: { affixPool: { effectType: string; min: number; max: number }[] }; drops: { chancePerKill: number; chanceBoss: number; legendaryShare: number };
};
export const LINE = 'charmander';
export const emptyBoardState = (b: Board = BOARD): BoardState => ({ nodes: [], moves: { [b.freeMove]: 1 }, asc: [], jewels: [], sockets: {} });

// ---------- graph ----------
/** BFS from the start over allocated nodes only. */
export function reachableFromStart(b: Board, alloc: Set<string>, line = LINE): Set<string> {
  const start = b.startFor(line); const seen = new Set<string>([start]); const q = [start];
  while (q.length) { const id = q.shift()!; for (const n of b.adj.get(id) ?? []) if (alloc.has(n) && !seen.has(n)) { seen.add(n); q.push(n); } }
  seen.delete(start); return seen;
}
export function shortestPath(b: Board, from: string, to: string): string[] | null {
  const prev = new Map<string, string | null>([[from, null]]); const q = [from];
  while (q.length) { const id = q.shift()!; if (id === to) break; for (const n of b.adj.get(id) ?? []) if (!prev.has(n)) { prev.set(n, id); q.push(n); } }
  if (!prev.has(to)) return null; const out: string[] = []; for (let c: string | null = to; c !== null; c = prev.get(c) ?? null) out.unshift(c); return out;
}
type Res = { ok: boolean; reason?: string };
export interface BoardCtx { level: number; evoStage: number; pointsLeft: number }
export function canAllocNode(b: Board, s: BoardState, id: string, ctx: Pick<BoardCtx, 'pointsLeft'>): Res {
  const n = b.nodes.get(id); if (!n) return { ok: false, reason: 'unknown' };
  if (n.kind === 'start') return { ok: false, reason: 'start' };
  const alloc = new Set(s.nodes); if (alloc.has(id)) return { ok: false, reason: 'allocated' };
  if (ctx.pointsLeft < 1) return { ok: false, reason: 'points' };
  const start = b.startFor(LINE);
  if (![...(b.adj.get(id) ?? [])].some((x) => x === start || alloc.has(x))) return { ok: false, reason: 'notAdjacent' };
  if ((n.requires ?? []).some((r) => !alloc.has(r))) return { ok: false, reason: 'requires' };
  if (n.exclusiveGroup && [...alloc].some((o) => o !== id && b.nodes.get(o)?.exclusiveGroup === n.exclusiveGroup)) return { ok: false, reason: 'exclusive' };
  return { ok: true };
}
export function canRefundNode(b: Board, s: BoardState, id: string): Res {
  const n = b.nodes.get(id); if (!n || n.kind === 'start') return { ok: false, reason: 'start' };
  const alloc = new Set(s.nodes); if (!alloc.has(id)) return { ok: false, reason: 'notAllocated' };
  alloc.delete(id);
  if ([...alloc].some((o) => (b.nodes.get(o)?.requires ?? []).includes(id))) return { ok: false, reason: 'requiredBy' };
  const reach = reachableFromStart(b, alloc); if ([...alloc].some((o) => !reach.has(o))) return { ok: false, reason: 'disconnects' };
  return { ok: true };
}

// ---------- points ----------
export const boardPointsTotal = (b: Board, c: { level: number; bonusPoints: number; debug: boolean }): number =>
  Math.min(b.meta.totalPoints, Math.max(0, c.level - 1) * b.meta.pointsPerLevel) + (c.debug ? c.bonusPoints : 0);
export const boardPointsSpent = (b: Board, s: BoardState): number =>
  s.nodes.length + Object.values(s.moves).reduce((a, v) => a + v, 0) - Math.min(1, s.moves[b.freeMove] ?? 0);

// ---------- move trunk ----------
export function canRankMove(b: Board, s: BoardState, move: string, ctx: Pick<BoardCtx, 'level' | 'pointsLeft'>): Res {
  const t = b.trunk.get(move); if (!t) return { ok: false, reason: 'unknown' }; const r = s.moves[move] ?? 0;
  if (r >= t.maxRank) return { ok: false, reason: 'maxRank' };
  if (ctx.level < t.learnLevel) return { ok: false, reason: 'level' };
  const free = move === b.freeMove && r === 0; if (!free && ctx.pointsLeft < 1) return { ok: false, reason: 'points' };
  return { ok: true };
}
export function canUnrankMove(b: Board, s: BoardState, move: string): Res {
  const r = s.moves[move] ?? 0; if (r <= 0) return { ok: false, reason: 'notAllocated' };
  if (move === b.freeMove && r <= 1) return { ok: false, reason: 'free' };
  return { ok: true };
}

// ---------- ascendancy ----------
export const ascPointsTotal = (b: Board, level: number, evoStage: number): number =>
  evoStage < 3 ? 0 : Object.entries(b.meta.ascendancyPoints).reduce((a, [lv, p]) => a + (level >= Number(lv) ? p : 0), 0);
export function canAllocAsc(b: Board, s: BoardState, id: string, ctx: { level: number; evoStage: number }): Res {
  const n = b.asc.get(id); if (!n) return { ok: false, reason: 'unknown' }; if (s.asc.includes(id)) return { ok: false, reason: 'allocated' };
  if (ctx.evoStage < 3) return { ok: false, reason: 'evoStage' };
  if (s.asc.length >= ascPointsTotal(b, ctx.level, ctx.evoStage)) return { ok: false, reason: 'points' };
  if ((n.requires ?? []).some((r) => !s.asc.includes(r))) return { ok: false, reason: 'requires' };
  if (n.exclusiveGroup && s.asc.some((o) => o !== id && b.asc.get(o)?.exclusiveGroup === n.exclusiveGroup)) return { ok: false, reason: 'exclusive' };
  return { ok: true };
}
export function canRefundAsc(b: Board, s: BoardState, id: string): Res {
  if (!s.asc.includes(id)) return { ok: false, reason: 'notAllocated' };
  if (s.asc.some((o) => (b.asc.get(o)?.requires ?? []).includes(id))) return { ok: false, reason: 'requiredBy' };
  return { ok: true };
}

// ---------- jewels ----------
export interface Implicit { effectType: string; value: number; text?: string }
/** Fixed implicit of a legendary jewel (data: jewels.legendary[].implicit). Active whenever the socket is live, independent of in-range nodes. */
export const jewelImplicit = (base: string, b: Board = BOARD): Implicit | undefined => b.raw.jewels.legendary.find((l) => l.id === base)?.implicit;
export const isLegendary = (j: JewelItem): boolean => !!JEWEL_RULES.legendary[j.base];
export interface Conversion { id: string; jewel: string; before: Effect; after: Effect[]; active: boolean }
function convert(n: BoardNode, base: string): Effect[] | null {
  const rule = JEWEL_RULES.legendary[base]; if (!rule || n.kind !== 'small' || !rule.from.includes(n.effectType) || typeof n.value !== 'number') return null;
  const v = n.value; const to = rule.to.map((t) => ({ effectType: t.effectType, value: Math.round((t.abs ? Math.abs(v) : v) * t.mult * 100) / 100 }));
  return rule.mode === 'add' ? [{ effectType: n.effectType, value: v }, ...to] : to;
}
/** What a jewel would convert if placed in `socket` (all in-radius smalls; `active` = node currently allocated). Normal jewels convert nothing. */
export function previewConversion(b: Board, socket: string, j: JewelItem, s: BoardState): Conversion[] {
  const alloc = new Set(s.nodes); const out: Conversion[] = [];
  for (const id of b.socketRadius.get(socket) ?? []) { const n = b.nodes.get(id)!; const after = convert(n, j.base); if (after) out.push({ id, jewel: j.uid, before: { effectType: n.effectType, value: n.value }, after, active: alloc.has(id) }); }
  return out;
}
/** A socket is live only if it is allocated AND connected to the start (a respec that cuts it off turns the jewel off; the jewel stays socketed). */
export function socketActive(b: Board, s: BoardState, sock: string, reach = reachableFromStart(b, new Set(s.nodes))): boolean { return s.nodes.includes(sock) && reach.has(sock); }
/** Only one of each legendary type may be socketed on the whole board. */
export function legendaryConflict(s: BoardState, sock: string, j: JewelItem): string | null {
  if (!isLegendary(j)) return null;
  for (const [k, uid] of Object.entries(s.sockets)) { if (k === sock || uid === j.uid) continue; if (s.jewels.find((x) => x.uid === uid)?.base === j.base) return k; }
  return null;
}
/** Live conversions: socket live + jewel present; only allocated small nodes owned by that socket (nearest socket wins, at most one legendary per node). */
export function conversionsFor(b: Board, s: BoardState): Map<string, Conversion> {
  const out = new Map<string, Conversion>(); const reach = reachableFromStart(b, new Set(s.nodes));
  for (const [sock, uid] of Object.entries(s.sockets)) {
    const j = s.jewels.find((x) => x.uid === uid); if (!j || !socketActive(b, s, sock, reach)) continue;
    for (const c of previewConversion(b, sock, j, s)) if (c.active && b.owner.get(c.id) === sock) out.set(c.id, c);
  }
  return out;
}
// ---------- effects ----------
const asc = (k: string, f: (v: Record<string, number> & number) => unknown): Handler => (b, _t, n) => { (b.asc as Record<string, unknown>)[k] = f(n.value as never); };
/** v4 effect registry = v3 TALENT_EFFECTS + new board / ascendancy types. */
export const BOARD_EFFECTS: Record<string, Handler> = {
  ...TALENT_EFFECTS,
  jewelSocket: () => {},
  sunDurationSec: pct('sunDurationSec'), fireDmgPct: pct('fireDmgPct'), sunBurnDmgPct: pct('sunBurnDmgPct'), sunDurationPct: pct('sunDurationPct'), dodgeIgnite: pct('dodgeIgnite'),
  areaPct: (b, total) => { b.moveMods.push({ source: 'board:areaPct', stage: 'numeric', apply: (s) => { s.areaPct += total; } }); },
  /** attack speed = basic-attack cooldown reduction, summed into that move's CDR (still capped) */
  attackSpeedPct: (b, total) => { b.moveCdPct.ember = (b.moveCdPct.ember ?? 0) - total; },
  onHitTakenAtkPct: (b, _t, n) => { const v = n.value as unknown as Record<string, number>; b.onHitTakenAtk = { pct: (b.onHitTakenAtk?.pct ?? 0) + Number(v.pct ?? 0), sec: Math.max(b.onHitTakenAtk?.sec ?? 0, Number(v.sec ?? 0)) }; },
  dodgeBecomesFlight: asc('flight', (v) => ({ invulnSec: Number(v.invulnSec ?? 0.3), landingFireDmgPctOfBasic: Number(v.landingFireDmgPctOfBasic ?? 80) })),
  airborneAreaPct: asc('airborneAreaPct', (v) => Number(v)), flightLeavesTrail: asc('flightTrail', (v) => Number(v)),
  postFlightDamageTakenPct: asc('postFlightDr', (v) => ({ pct: Number(v.pct), sec: Number(v.sec) })),
  fireToDragonConvertPct: asc('fireToDragonPct', (v) => Number(v)), dragonAuraMaxStacksDelta: asc('auraMaxDelta', (v) => Number(v)),
  dragonAuraDamageTakenPctPerStack: asc('auraDrPerStack', (v) => Number(v)), dragonAuraCritDmgPct: asc('auraCritDmgPct', (v) => Number(v)),
};
/** Rank-2 "enhance" per trunk move (text in data; mechanics here). Keys are director move ids. */
export const MOVE_ENHANCE: Record<string, (b: PlayerBonuses, engineId: string) => void> = {
  ember: (b, id) => b.moveMods.push({ source: 'trunk:ember+1', stage: 'shape', moveId: id, apply: (s) => { s.projectiles += 1; } }),
  flame_charge: (b, id) => b.moveMods.push({ source: 'trunk:flame_charge', stage: 'numeric', moveId: id, apply: (s) => { if (s.params.distance) s.params.distance *= 1.25; } }),
  flamethrower: (b, id) => b.moveMods.push({ source: 'trunk:flamethrower', stage: 'numeric', moveId: id, apply: (s) => { if (s.params.duration) s.params.duration *= 1.2; } }),
  fire_spin: (b, id) => b.moveMods.push({ source: 'trunk:fire_spin', stage: 'numeric', moveId: id, apply: (s) => { s.areaPct += 20; } }),
  fire_blast: (b) => { b.moveCdPct.fire_blast = (b.moveCdPct.fire_blast ?? 0) - 15; },
};
export function applyEffect(b: PlayerBonuses, e: Effect, src: string): void {
  if (e.effectType === 'keystone') { b.keystones.add(String(e.value)); return; }
  const h = BOARD_EFFECTS[e.effectType]; if (!h) { _w(`[board] unhandled effectType '${e.effectType}' (${src})`); return; }
  h(b, typeof e.value === 'number' ? e.value : 0, { id: src, effectType: e.effectType, value: e.value } as unknown as TalentNode, 1);
}
/** Effects of one board node after jewel conversion (what the tooltip / bonuses use). */
export const nodeEffects = (b: Board, s: BoardState, id: string, conv = conversionsFor(b, s)): Effect[] => {
  const n = b.nodes.get(id)!; return conv.get(id)?.after ?? [{ effectType: n.effectType, value: n.value }];
};
export function boardBonuses(b: Board, s: BoardState, engineId: (m: string) => string = (m) => m): PlayerBonuses {
  const out = emptyBonuses(); const conv = conversionsFor(b, s); const alloc = new Set(s.nodes);
  for (const id of s.nodes) { if (!b.nodes.has(id)) continue; for (const e of nodeEffects(b, s, id, conv)) applyEffect(out, e, id); }
  const reach = reachableFromStart(b, new Set(s.nodes)); void alloc;
  for (const [sock, uid] of Object.entries(s.sockets)) { if (!socketActive(b, s, sock, reach)) continue; const j = s.jewels.find((x) => x.uid === uid); for (const a of j?.affixes ?? []) applyEffect(out, a, `jewel:${uid}`);
    const imp = j && jewelImplicit(j.base, b); if (imp) applyEffect(out, imp, `implicit:${uid}`); }
  for (const [m, r] of Object.entries(s.moves)) if (r >= 2) MOVE_ENHANCE[m]?.(out, engineId(m));
  for (const id of s.asc) { const n = b.asc.get(id); if (n) applyEffect(out, n, id); }
  return out;
}
/** Sum two bonus sets (v3 tree + v4 board). */
export function mergeBonuses(a: PlayerBonuses, b: PlayerBonuses): PlayerBonuses {
  const o = { ...a } as unknown as Record<string, unknown>; const bb = b as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(bb)) { if (typeof v === 'number') o[k] = ((o[k] as number) ?? 0) + v; }
  o.keystones = new Set([...a.keystones, ...b.keystones]); o.moveMods = [...a.moveMods, ...b.moveMods] as Modifier[];
  const cd: Record<string, number> = { ...a.moveCdPct }; for (const [k, v] of Object.entries(b.moveCdPct)) cd[k] = (cd[k] ?? 0) + v; o.moveCdPct = cd;
  o.onDodgeSpeed = a.onDodgeSpeed && b.onDodgeSpeed ? { pct: a.onDodgeSpeed.pct + b.onDodgeSpeed.pct, sec: Math.max(a.onDodgeSpeed.sec, b.onDodgeSpeed.sec) } : a.onDodgeSpeed ?? b.onDodgeSpeed;
  o.lowHpDr = a.lowHpDr && b.lowHpDr ? { threshold: Math.max(a.lowHpDr.threshold, b.lowHpDr.threshold), pct: a.lowHpDr.pct + b.lowHpDr.pct } : a.lowHpDr ?? b.lowHpDr;
  o.oocRegen = a.oocRegen && b.oocRegen ? { delaySec: Math.min(a.oocRegen.delaySec, b.oocRegen.delaySec), pct: a.oocRegen.pct + b.oocRegen.pct } : a.oocRegen ?? b.oocRegen;
  o.onHitTakenAtk = a.onHitTakenAtk ?? b.onHitTakenAtk; o.asc = { ...a.asc, ...b.asc };
  return o as unknown as PlayerBonuses;
}

// ---------- saves ----------
interface SaveLike { talents: Record<string, number>; upgrades: Record<string, Record<string, string>>; board?: BoardState; boardVersion?: number; migratedFromV3?: boolean }
/** v3 saves (no boardVersion) → refund everything (talents cleared, variants cleared since rank 3 now gates them). v4 saves are sanitised: unknown ids dropped, disconnected nodes dropped. */
export function migrateBuildSave<T extends SaveLike>(raw: T, b: Board = BOARD): T & { board: BoardState; boardVersion: 4 } {
  if (raw.boardVersion !== 4) {
    const had = Object.keys(raw.talents ?? {}).length > 0 || Object.keys(raw.upgrades ?? {}).length > 0;
    return { ...raw, talents: {}, upgrades: {}, board: emptyBoardState(b), boardVersion: 4, migratedFromV3: had };
  }
  const s = raw.board ?? emptyBoardState(b);
  const known = s.nodes.filter((id) => b.nodes.has(id) && b.nodes.get(id)!.kind !== 'start');
  const reach = reachableFromStart(b, new Set(known)); const nodes = known.filter((id) => reach.has(id));
  const moves: Record<string, number> = {}; for (const [m, r] of Object.entries(s.moves ?? {})) { const t = b.trunk.get(m); if (t && r > 0) moves[m] = Math.min(t.maxRank, r); }
  moves[b.freeMove] = Math.max(1, moves[b.freeMove] ?? 0);
  const ascIds = (s.asc ?? []).filter((id) => b.asc.has(id));
  const jewels = (s.jewels ?? []).filter((j) => j && j.uid && j.base); const sockets: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.sockets ?? {})) if (b.nodes.get(k)?.kind === 'jewel' && jewels.some((j) => j.uid === v)) sockets[k] = v;
  return { ...raw, board: { nodes, moves, asc: ascIds, jewels, sockets }, boardVersion: 4 };
}
