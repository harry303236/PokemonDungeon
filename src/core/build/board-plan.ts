/** Plan/confirm for the v4 board: clicks stage changes on a pending delta; nothing is spent until confirm. */
import { BOARD, canAllocNode, canRefundNode, canRankMove, canUnrankMove, boardPointsSpent, type Board, type BoardState } from './board';

export interface BoardPlan { add: string[]; remove: string[]; moves: Record<string, number> }
export const emptyPlan = (): BoardPlan => ({ add: [], remove: [], moves: {} });
export const planEmpty = (p: BoardPlan): boolean => !p.add.length && !p.remove.length && !Object.values(p.moves).some(Boolean);
export function mergedState(s: BoardState, p: BoardPlan): BoardState {
  const moves = { ...s.moves }; for (const [m, d] of Object.entries(p.moves)) { const v = (moves[m] ?? 0) + d; if (v > 0) moves[m] = v; else delete moves[m]; }
  return { ...s, nodes: [...s.nodes.filter((id) => !p.remove.includes(id)), ...p.add], moves };
}
type Res = { ok: boolean; reason?: string };
/** pointsTotal = level-1 (+debug); returns remaining points for the merged state */
export const planPointsLeft = (b: Board, s: BoardState, p: BoardPlan, total: number): number => total - boardPointsSpent(b, mergedState(s, p));
export function stageAddNode(b: Board, s: BoardState, p: BoardPlan, id: string, total: number): Res {
  if (p.remove.includes(id)) { p.remove = p.remove.filter((x) => x !== id); return { ok: true }; }
  const r = canAllocNode(b, mergedState(s, p), id, { pointsLeft: planPointsLeft(b, s, p, total) }); if (r.ok) p.add.push(id); return r;
}
export function stageRemoveNode(b: Board, s: BoardState, p: BoardPlan, id: string): Res {
  const r = canRefundNode(b, mergedState(s, p), id); if (!r.ok) return r;
  if (p.add.includes(id)) p.add = p.add.filter((x) => x !== id); else p.remove.push(id);
  return { ok: true };
}
export function stageMove(b: Board, s: BoardState, p: BoardPlan, move: string, dir: 1 | -1, ctx: { level: number; total: number }): Res {
  const m = mergedState(s, p);
  const r = dir > 0 ? canRankMove(b, m, move, { level: ctx.level, pointsLeft: planPointsLeft(b, s, p, ctx.total) }) : canUnrankMove(b, m, move);
  if (r.ok) { p.moves[move] = (p.moves[move] ?? 0) + dir; if (!p.moves[move]) delete p.moves[move]; } return r;
}
/** refunds (board nodes + move ranks) cost 1 ash shard each after the free-respec level */
export const planRefunds = (p: BoardPlan): number => p.remove.length + Object.values(p.moves).reduce((a, d) => a + Math.max(0, -d), 0);
export const planCost = (p: BoardPlan, paid: boolean): { ashShards: number; gold: number } => ({ ashShards: paid ? planRefunds(p) : 0, gold: 0 });
/** Order removals far-to-near (BFS distance from start over the current allocation) so each single refund stays valid. */
export function removalOrder(b: Board, s: BoardState, remove: string[]): string[] {
  const dist = new Map<string, number>(); const alloc = new Set(s.nodes); const start = b.startFor('charmander'); const q: [string, number][] = [[start, 0]]; const seen = new Set([start]);
  while (q.length) { const [id, d] = q.shift()!; dist.set(id, d); for (const n of b.adj.get(id) ?? []) if (alloc.has(n) && !seen.has(n)) { seen.add(n); q.push([n, d + 1]); } }
  return [...remove].sort((x, y) => (dist.get(y) ?? 0) - (dist.get(x) ?? 0));
}
export interface PlanApplier { refundNode(id: string): Res; allocNode(id: string): Res; rankMove(m: string): Res; unrankMove(m: string): Res; s: { ashShards: number; board: BoardState } }
/** Apply refunds first (paying ash shards), then allocations in staged order. Fails without side effects if ash shards are short. */
export function applyPlan(build: PlanApplier, p: BoardPlan, paid: boolean, b: Board = BOARD): Res {
  if (build.s.ashShards < planCost(p, paid).ashShards) return { ok: false, reason: 'ashShard' };
  for (const [m, d] of Object.entries(p.moves)) for (let i = 0; i < -d; i++) build.unrankMove(m);
  for (const id of removalOrder(b, build.s.board, p.remove)) { const r = build.refundNode(id); if (!r.ok) return r; }
  for (const id of p.add) { const r = build.allocNode(id); if (!r.ok) return r; }
  for (const [m, d] of Object.entries(p.moves)) for (let i = 0; i < d; i++) build.rankMove(m);
  return { ok: true };
}
