/**
 * Talent system v4: passive board (nodes + undirected edges), move trunk, ascendancy, jewels.
 * Reachability/adjacency tests were written first (CTO requirement) and drive board.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  BOARD, loadBoard, emptyBoardState, canAllocNode, canRefundNode, reachableFromStart, boardPointsSpent, boardPointsTotal,
  canRankMove, canUnrankMove, ascPointsTotal, canAllocAsc, canRefundAsc, conversionsFor, previewConversion, boardBonuses,
  migrateBuildSave, shortestPath, JEWEL_RULES, type BoardState, type JewelItem,
} from '../src/core/build/board';
import { mechanics } from '../src/core/build/talents';
import { moveSpeedPct } from '../src/core/build/talents';
import { Sim, newProgress } from '../src/core/sim';

const B = BOARD; const START = B.startFor('charmander');
const st = (nodes: string[], extra: Partial<BoardState> = {}): BoardState => ({ ...emptyBoardState(), nodes: [...nodes], ...extra });
const ctx = (level = 50, evo = 3, s?: BoardState) => ({ level, evoStage: evo, bonusPoints: 0, debug: false, pointsLeft: boardPointsTotal(B, { level, bonusPoints: 0, debug: false }) - boardPointsSpent(B, s ?? emptyBoardState()) });

describe('v4 board data', () => {
  it('loads 66 nodes / 68 edges with expected kinds', () => {
    expect(B.nodes.size).toBe(66); expect(B.edgeCount).toBe(68);
    const k = (kind: string) => [...B.nodes.values()].filter((n) => n.kind === kind).length;
    expect(k('start')).toBe(1); expect(k('keystone')).toBe(3); expect(k('jewel')).toBe(4); expect(k('notable')).toBe(13); expect(k('small')).toBe(45);
    expect(START).toBe('start_charmander');
  });
  it('edges are undirected', () => { expect(B.adj.get('sun_a1')!.has(START)).toBe(true); expect(B.adj.get(START)!.has('sun_a1')).toBe(true); });
  it('socket in-radius node lists are precomputed on load (no socket, no start)', () => {
    for (const s of ['sun_jewel', 'claw_jewel', 'wing_jewel', 'util_jewel']) {
      const list = B.socketRadius.get(s)!; expect(list.length).toBeGreaterThan(0);
      const sp = B.nodes.get(s)!; for (const id of list) { const n = B.nodes.get(id)!; expect(Math.hypot(n.pos.x - sp.pos.x, n.pos.y - sp.pos.y)).toBeLessThanOrEqual(sp.radius!); expect(n.kind).not.toBe('jewel'); expect(n.kind).not.toBe('start'); }
    }
  });
});

describe('adjacency + reachability (written first)', () => {
  it('only nodes adjacent to the start or an allocated node can be allocated', () => {
    expect(canAllocNode(B, st([]), 'sun_a1', ctx()).ok).toBe(true);
    expect(canAllocNode(B, st([]), 'sun_a2', ctx())).toMatchObject({ ok: false, reason: 'notAdjacent' });
    expect(canAllocNode(B, st(['sun_a1']), 'sun_a2', ctx()).ok).toBe(true);
    expect(canAllocNode(B, st(['sun_a1']), 'sun_a1', ctx())).toMatchObject({ ok: false, reason: 'allocated' });
    expect(canAllocNode(B, st([]), START, ctx())).toMatchObject({ ok: false });
  });
  it.each([
    // [allocated, refund, ok, why]
    [['sun_a1', 'sun_a2', 'sun_a3'], 'sun_a3', true, 'leaf'],
    [['sun_a1', 'sun_a2', 'sun_a3'], 'sun_a2', false, 'middle of a chain strands sun_a3'],
    [['sun_a1', 'sun_a2', 'sun_a3'], 'sun_a1', false, 'first node strands the chain'],
    [['sun_a1', 'util_bot_1', 'util_bot_2'], 'util_bot_1', false, 'strands util_bot_2'],
    // loop: start-sun_a1-util_bot_1..5-wing_a1-start; removing a node inside the loop keeps all reachable
    [['sun_a1', 'util_bot_1', 'util_bot_2', 'util_bot_3', 'util_bot_4', 'util_bot_5', 'wing_a1'], 'util_bot_3', true, 'alternate path via the loop'],
    [['sun_a1', 'util_bot_1', 'util_bot_2', 'util_bot_3', 'util_bot_4', 'util_bot_5', 'wing_a1'], 'sun_a1', true, 'loop keeps util_bot_1 reachable through wing_a1'],
    [['sun_a1', 'util_bot_1', 'util_bot_2', 'util_bot_3', 'util_bot_4', 'util_bot_5', 'wing_a1', 'util_bot_regen'], 'util_bot_3', false, 'regen hangs only off util_bot_3'],
  ])('refund %j - %s -> %s (%s)', (alloc, id, ok) => {
    const r = canRefundNode(B, st(alloc as string[]), id as string); expect(r.ok).toBe(ok); if (!ok) expect(r.reason).toBe('disconnects');
  });
  it('reachableFromStart is a BFS over allocated nodes only', () => {
    const r = reachableFromStart(B, new Set(['sun_a1', 'sun_a3'])); expect(r.has('sun_a1')).toBe(true); expect(r.has('sun_a3')).toBe(false);
  });
  it('cannot refund the start or an unallocated node', () => {
    expect(canRefundNode(B, st([]), START).ok).toBe(false); expect(canRefundNode(B, st([]), 'sun_a1').reason).toBe('notAllocated');
  });
});

describe('keystones (requires <zone>_N3 + exclusive)', () => {
  const pathTo = (id: string) => shortestPath(B, START, id)!.slice(1);
  it.each(['sun', 'claw', 'wing'])('%s keystone needs %s_N3 even when adjacent; minimum 16 points from start', (z) => {
    const toKs = pathTo(`${z}_KS`); const before = toKs.slice(0, -1);
    expect(canAllocNode(B, st(before), `${z}_KS`, ctx())).toMatchObject({ ok: false, reason: 'requires' });
    const withN3 = [...new Set([...before, ...pathTo(`${z}_N3`)])];
    expect(canAllocNode(B, st(withN3), `${z}_KS`, ctx()).ok).toBe(true);
    expect(withN3.length + 1).toBe(16);
    // refunding N3 while the keystone is allocated is blocked
    expect(canRefundNode(B, st([...withN3, `${z}_KS`]), `${z}_N3`)).toMatchObject({ ok: false });
  });
  it('only one keystone (exclusiveGroup)', () => {
    const a = [...new Set([...pathTo('sun_KS'), ...pathTo('sun_N3'), ...pathTo('claw_N3'), ...pathTo('claw_KS').slice(0, -1)])];
    expect(canAllocNode(B, st(a), 'claw_KS', ctx())).toMatchObject({ ok: false, reason: 'exclusive' });
  });
});

describe('shared point pool (1/level, moves + board)', () => {
  it('total = level-1 (49 at Lv50); debug points only in debug mode', () => {
    expect(boardPointsTotal(B, { level: 50, bonusPoints: 0, debug: false })).toBe(49);
    expect(boardPointsTotal(B, { level: 10, bonusPoints: 5, debug: false })).toBe(9);
    expect(boardPointsTotal(B, { level: 10, bonusPoints: 5, debug: true })).toBe(14);
  });
  it('board nodes and move ranks draw from the same pool; Lv1 move rank 1 is free', () => {
    const s = st(['sun_a1', 'sun_a2'], { moves: { ember: 3, flame_charge: 2 } });
    expect(boardPointsSpent(B, s)).toBe(2 + (3 - 1) + 2);
    const c = ctx(5, 1, s); expect(c.pointsLeft).toBe(4 - 6);
    expect(canAllocNode(B, s, 'sun_a3', c)).toMatchObject({ ok: false, reason: 'points' });
    expect(canRankMove(B, s, 'flamethrower', c)).toMatchObject({ ok: false });
  });
});

describe('move trunk', () => {
  it.each([
    ['ember', 1, true], ['flame_charge', 3, false], ['flame_charge', 4, true], ['flamethrower', 9, false], ['flamethrower', 10, true],
    ['fire_spin', 16, true], ['fire_blast', 23, false], ['fire_blast', 24, true],
  ])('%s learnable at Lv%d: %s', (m, lvl, ok) => {
    const s = st([], { moves: { ember: 1 } }); expect(canRankMove(B, s, m as string, { ...ctx(lvl as number, 1, s), pointsLeft: 10 }).ok || (m === 'ember')).toBe(ok);
  });
  it('max rank 3; refund must keep the free rank 1 of the Lv1 move', () => {
    const s = st([], { moves: { ember: 3 } }); expect(canRankMove(B, s, 'ember', { ...ctx(), pointsLeft: 10 })).toMatchObject({ ok: false, reason: 'maxRank' });
    expect(canUnrankMove(B, st([], { moves: { ember: 1 } }), 'ember').ok).toBe(false);
    expect(canUnrankMove(B, st([], { moves: { ember: 2 } }), 'ember').ok).toBe(true);
  });
  it('rank 2 enhancement feeds the move pipeline (ember +1 projectile)', () => {
    const sim = new Sim(newProgress(3)); sim.build.s.board = st([], { moves: { ember: 1 } }); sim.refreshBuild(); const p1 = sim.moveSpec('ember').projectiles;
    sim.build.s.board = st([], { moves: { ember: 2 } }); sim.refreshBuild(); expect(sim.moveSpec('ember').projectiles).toBe(p1 + 1);
  });
  it('unlearned trunk moves cannot be cast from slots', () => {
    const sim = new Sim(newProgress(3)); sim.build.s.board = st([], { moves: { ember: 1 } }); sim.refreshBuild();
    expect(sim.moveUsable('flamethrower')).toBe(false); expect(sim.moveUsable('ember')).toBe(true);
  });
});

describe('ascendancy', () => {
  it('points: 1 each at Lv36/42/48, only after evolving to Charizard', () => {
    expect(ascPointsTotal(B, 35, 2)).toBe(0); expect(ascPointsTotal(B, 36, 2)).toBe(0); expect(ascPointsTotal(B, 36, 3)).toBe(1); expect(ascPointsTotal(B, 48, 3)).toBe(3);
  });
  it('choose one side: entry first (exclusive), then its own nodes', () => {
    const c = { level: 50, evoStage: 3 };
    expect(canAllocAsc(B, st([]), 'asc_fw_1', c)).toMatchObject({ ok: false, reason: 'requires' });
    expect(canAllocAsc(B, st([]), 'asc_flame_wing', c).ok).toBe(true);
    const s = st([], { asc: ['asc_flame_wing'] });
    expect(canAllocAsc(B, s, 'asc_dragon_blood', c)).toMatchObject({ ok: false, reason: 'exclusive' });
    expect(canAllocAsc(B, s, 'asc_db_1', c)).toMatchObject({ ok: false });
    expect(canAllocAsc(B, s, 'asc_fw_2', c).ok).toBe(true);
    expect(canAllocAsc(B, st([], { asc: ['asc_flame_wing', 'asc_fw_1', 'asc_fw_2'] }), 'asc_fw_3', c)).toMatchObject({ ok: false, reason: 'points' });
    expect(canAllocAsc(B, st([]), 'asc_flame_wing', { level: 50, evoStage: 2 })).toMatchObject({ ok: false, reason: 'evoStage' });
    expect(canRefundAsc(B, st([], { asc: ['asc_flame_wing', 'asc_fw_1'] }), 'asc_flame_wing').ok).toBe(false);
  });
  it('first point gives the main effect', () => {
    const b = boardBonuses(B, st([], { asc: ['asc_dragon_blood'] })); expect(b.asc.fireToDragonPct).toBe(30);
    const w = boardBonuses(B, st([], { asc: ['asc_flame_wing'] })); expect(w.asc.flight).toMatchObject({ invulnSec: 0.3 });
  });
});

describe('jewels: conversion scope, caps, preview', () => {
  const lens: JewelItem = { uid: 'j1', base: 'jw_solar_lens' }; const heart: JewelItem = { uid: 'j2', base: 'jw_dragon_heart' }; const wind: JewelItem = { uid: 'j3', base: 'jw_tailwind' };
  const inRadius = (sock: string, b = B) => b.socketRadius.get(sock)!;
  // With the shipped radius (220) no spAtk small sits inside any socket (reported to design); widen sun_jewel to 400 for the lens tests.
  const LB = loadBoard({ ...B.raw, nodes: B.raw.nodes.map((n) => (n.id === 'sun_jewel' ? { ...n, radius: 400 } : n)) });
  it('legendary jewels convert only allocated SMALL nodes inside the radius', () => {
    const sock = 'sun_jewel'; const path = [...new Set([...shortestPath(LB, START, sock)!.slice(1), 'sun_d1'])];
    const s = st(path, { jewels: [lens], sockets: { [sock]: 'j1' } });
    const conv = conversionsFor(LB, s);
    for (const [id] of conv) { const n = LB.nodes.get(id)!; expect(n.kind).toBe('small'); expect(inRadius(sock, LB)).toContain(id); expect(s.nodes).toContain(id); }
    // sun_d1 is spAtkPct, in radius and allocated -> converted to sunBurnDmgPct x2
    expect(inRadius(sock, LB)).toContain('sun_d1'); expect(inRadius(sock, LB)).toContain('sun_N1'); expect(conv.get('sun_d1')?.after).toEqual([{ effectType: 'sunBurnDmgPct', value: 6 }]);
    // notables/keystones in radius are never converted
    expect(conv.has('sun_N3')).toBe(false); expect(conv.has('sun_N1')).toBe(false);
    expect(boardBonuses(LB, s).spAtkPct).toBe(boardBonuses(LB, st(path)).spAtkPct - 3);
  });
  it('unallocated in-radius nodes are not converted', () => {
    const s = st(['sun_jewel'], { jewels: [lens], sockets: { sun_jewel: 'j1' } }); expect(conversionsFor(LB, s).size).toBe(0);
  });
  it('a socketed jewel only works when the socket node itself is allocated', () => {
    const path = shortestPath(B, START, 'util_jewel')!.slice(1, -1); const s = st(path, { jewels: [heart], sockets: { util_jewel: 'j2' } });
    expect(conversionsFor(B, s).size).toBe(0);
  });
  it('龍心 turns defense-type smalls into attack of the same magnitude', () => {
    const path = shortestPath(B, START, 'util_jewel')!.slice(1); const s = st(path, { jewels: [heart], sockets: { util_jewel: 'j2' } });
    const conv = conversionsFor(B, s); expect(conv.get('util_bot_4')?.after).toEqual([{ effectType: 'atkPct', value: 2 }]);
    const b = boardBonuses(B, s); expect(b.damageTakenPct).toBe(0); expect(b.atkPct).toBeGreaterThanOrEqual(2);
  });
  it('順風羽 keeps speed and adds projectile speed + trail damage, still capped by meta.mechanics', () => {
    const path = shortestPath(B, START, 'util_jewel')!.slice(1); const s = st(path, { jewels: [wind], sockets: { util_jewel: 'j3' } });
    const conv = conversionsFor(B, s); const speedNodes = [...conv.keys()]; expect(speedNodes).toEqual(['util_bot_5']);
    expect(conv.get('util_bot_5')!.after).toEqual([{ effectType: 'moveSpeedPct', value: 3 }, { effectType: 'projSpeedPct', value: 3 }, { effectType: 'trailDmgPct', value: 3 }]);
    for (const id of speedNodes) expect(['speedPct', 'moveSpeedPct']).toContain(B.nodes.get(id)!.effectType);
    const b = boardBonuses(B, s); b.speedPct += 500; // push far over the cap
    const M = mechanics({ meta: B.meta } as never); expect(moveSpeedPct(b, M).value).toBe(M.moveSpeedCapPct);
  });
  it('normal jewel affixes go through the same stat handlers and caps', () => {
    const path = shortestPath(B, START, 'util_jewel')!.slice(1);
    const s = st(path, { jewels: [{ uid: 'n1', base: 'normal', affixes: [{ effectType: 'moveSpeedPct', value: 999 }, { effectType: 'cooldownReductionPct', value: 999 }] }], sockets: { util_jewel: 'n1' } });
    const b = boardBonuses(B, s); const M = mechanics({ meta: B.meta } as never);
    expect(moveSpeedPct(b, M).value).toBe(M.moveSpeedCapPct);
  });
  it('preview lists every in-radius small node that would convert, with before/after, allocated or not', () => {
    const rows = previewConversion(LB, 'sun_jewel', lens, st([]));
    expect(rows.map((r) => r.id)).toEqual(['sun_d1']);
    for (const r of rows) { const n = LB.nodes.get(r.id)!; expect(n.kind).toBe('small'); expect(inRadius('sun_jewel', LB)).toContain(r.id); expect(r.before.effectType).toBe('spAtkPct'); expect(r.after[0]!.effectType).toBe('sunBurnDmgPct'); expect(r.after[0]!.value).toBe(2 * (n.value as number)); expect(r.active).toBe(false); }
    const rows2 = previewConversion(LB, 'sun_jewel', lens, st([...shortestPath(LB, START, 'sun_jewel')!.slice(1), 'sun_d1']));
    expect(rows2.every((r) => r.active)).toBe(true);
    const hp = previewConversion(B, 'util_jewel', heart, st([])); expect(hp.map((r) => r.id).sort()).toEqual(['util_bot_2', 'util_bot_4']);
    expect(previewConversion(B, 'sun_jewel', lens, st([]))).toEqual([]); // shipped radius: nothing to convert
    expect(previewConversion(B, 'sun_jewel', { uid: 'n', base: 'normal', affixes: [] }, st([]))).toEqual([]);
  });
  it('jewel rules are data (src/data/build/jewel-rules.json)', () => { expect(Object.keys(JEWEL_RULES.legendary).sort()).toEqual(['jw_dragon_heart', 'jw_solar_lens', 'jw_tailwind']); });
});

describe('saves: ids only + v3 migration', () => {
  it('v3 saves migrate by refunding everything into a fresh v4 board', () => {
    const m = migrateBuildSave({ talents: { root: 1, claw_t1_0: 3 }, gems: [], sockets: {}, upgrades: { flamethrower: { variant: 'ft_focus' } }, gold: 5, ashShards: 1, bonusPoints: 0 } as SL & { gold: number });
    expect(m.talents).toEqual({}); expect(m.board.nodes).toEqual([]); expect(m.board.moves).toEqual({ ember: 1 }); expect(m.boardVersion).toBe(4); expect(m.migratedFromV3).toBe(true);
    expect(m.upgrades.flamethrower).toBeUndefined(); expect(m.gold).toBe(5);
  });
  it('unknown node ids in a save are dropped and the rest must stay connected', () => {
    const m = migrateBuildSave({ ...emptyMigrated(), board: { ...emptyBoardState(), nodes: ['sun_a1', 'ghost', 'sun_a3'] } } as SL);
    expect(m.board.nodes).toEqual(['sun_a1']);
  });
  it('board state serialises to ids only (no coordinates)', () => {
    const s = JSON.stringify(st(['sun_a1'])); expect(s).not.toMatch(/"x"|"pos"/);
  });
  it('loadBoard is pure (fresh instance equal)', () => { expect(loadBoard(B.raw).nodes.size).toBe(66); });
});
type SL = Parameters<typeof migrateBuildSave>[0];
function emptyMigrated() { return { talents: {}, gems: [], sockets: {}, upgrades: {}, gold: 0, ashShards: 0, bonusPoints: 0, boardVersion: 4 }; }

import { emptyPlan, stageAddNode, stageRemoveNode, stageMove, planCost, applyPlan, mergedState } from '../src/core/build/board-plan';
import { newBuildSave, Build } from '../src/core/build/build';
describe('v4 plan/confirm', () => {
  const mk = (level = 20) => { const s = newBuildSave(); s.ashShards = 5; const b = new Build(s, () => ({ level, evoStage1: 2 })); return b; };
  it('staging spends nothing; adjacency is checked against staged nodes', () => {
    const b = mk(); const p = emptyPlan(); const tot = b.pointsLeft();
    expect(stageAddNode(BOARD, b.s.board, p, 'sun_a2', tot).ok).toBe(false);
    expect(stageAddNode(BOARD, b.s.board, p, 'sun_a1', tot).ok).toBe(true);
    expect(stageAddNode(BOARD, b.s.board, p, 'sun_a2', tot).ok).toBe(true);
    expect(b.s.board.nodes).toEqual([]); expect(mergedState(b.s.board, p).nodes).toEqual(['sun_a1', 'sun_a2']);
    expect(stageRemoveNode(BOARD, b.s.board, p, 'sun_a1').ok).toBe(false); // would strand staged sun_a2
  });
  it('confirm applies staged refunds (ash after Lv16) far-to-near, then adds', () => {
    const b = mk(20); for (const id of ['sun_a1', 'sun_a2', 'sun_a3']) expect(b.allocNode(id).ok).toBe(true);
    const p = emptyPlan(); expect(stageRemoveNode(BOARD, b.s.board, p, 'sun_a3').ok).toBe(true); expect(stageRemoveNode(BOARD, b.s.board, p, 'sun_a2').ok).toBe(true);
    expect(stageAddNode(BOARD, b.s.board, p, 'claw_a1', b.pointsLeft() + 0).ok).toBe(true);
    expect(stageMove(BOARD, b.s.board, p, 'flame_charge', 1, { level: 20, total: b.pointsLeft() + 0 }).ok).toBe(true);
    expect(planCost(p, true).ashShards).toBe(2);
    expect(applyPlan(b, p, true).ok).toBe(true);
    expect(b.s.board.nodes.sort()).toEqual(['claw_a1', 'sun_a1']); expect(b.s.ashShards).toBe(3); expect(b.s.board.moves.flame_charge).toBe(1);
  });
  it('confirm fails cleanly when ash shards are short', () => {
    const b = mk(20); b.allocNode('sun_a1'); b.s.ashShards = 0; const p = emptyPlan(); stageRemoveNode(BOARD, b.s.board, p, 'sun_a1');
    expect(applyPlan(b, p, true)).toMatchObject({ ok: false, reason: 'ashShard' }); expect(b.s.board.nodes).toEqual(['sun_a1']);
  });
});

describe('v4 mechanics in the sim', () => {
  const idle = (sim: Sim) => ({ moveX: 1, moveY: 0, aimX: sim.player.x + 100, aimY: sim.player.y, slots: [false, false, false, false, false], dodge: false });
  const clear = (sim: Sim) => { for (const m of sim.world.query('monster')) { m.x = -9999; m.y = -9999; } };
  it('烈焰之翼: dodge becomes flight (0.3 s invuln) and landing spawns a fire impact', () => {
    const sim = new Sim(newProgress(3)); clear(sim); sim.build.s.board.asc = ['asc_flame_wing']; sim.refreshBuild();
    sim.step(1 / 60, { ...idle(sim), dodge: true }); expect(sim.player.dash?.flight).toBe(true); expect(sim.player.iframes).toBeGreaterThanOrEqual(0.29);
    let blast = false; for (let i = 0; i < 30; i++) { sim.step(1 / 60, idle(sim)); if (sim.world.query('blast').length) blast = true; }
    expect(blast).toBe(true); expect(sim.landedAt).toBeGreaterThan(0);
  });
  it('龍之血脈: 30% of fire damage is dragon-typed (ignores fire resistance)', () => {
    const sim = new Sim(newProgress(3)); const m = sim.world.query('monster')[0]!; m.hp = m.maxHp = 1e9; m.types = ['fire'];
    (sim as unknown as { rng: { next: () => number } }).rng = { next: () => 0.5, int: (a: number) => a, range: (a: number) => a, pick: <T,>(x: T[]) => x[0] } as never;
    const hit = () => { const before = m.hp!; sim.hit(sim.player, m, 'ember', 1, undefined, { rootId: 1, depth: 0, seen: new Set() } as never); return before - m.hp!; };
    const base = hit(); sim.build.s.board.asc = ['asc_dragon_blood']; sim.refreshBuild(); const conv = hit();
    expect(conv).toBeGreaterThan(base); // fire resists fire (0.5x); dragon portion is neutral
  });
  it('日冕: burn ticks hit harder during Sunny Day', () => {
    const mk = (sun: boolean) => { const sim = new Sim(newProgress(3)); sim.build.s.board = { ...emptyBoardState(), nodes: shortestPath(B, START, 'sun_N3')!.slice(1) }; sim.refreshBuild();
      const m = sim.world.query('monster')[0]!; for (const o of sim.world.query('monster')) if (o !== m) { o.x = -9999; } m.hp = m.maxHp = 1e6; sim.applyBurn(m, sim.player.id); if (sun) sim.debugSun(30);
      const h0 = m.hp!; (sim as unknown as { statusStep: (dt: number) => void }).statusStep(0.5); return h0 - m.hp!; };
    expect(mk(true)).toBeGreaterThan(mk(false) * 1.2);
  });
  it('晴空延長 scales Sunny Day duration', () => {
    const sim = new Sim(newProgress(3)); sim.build.s.board = { ...emptyBoardState(), nodes: shortestPath(B, START, 'sun_b1')!.slice(1) }; sim.refreshBuild();
    sim.debugSun(10); expect(sim.sunT).toBeCloseTo(10 * (1 + (B.nodes.get('sun_b1')!.value as number) / 100));
  });
  it('debug grant + drops add jewels that can be socketed into an allocated socket only', () => {
    const sim = new Sim(newProgress(3)); sim.debugGrantJewels(); const js = sim.build.s.board.jewels;
    expect(js.filter((j) => j.base !== 'normal').map((j) => j.base).sort()).toEqual(['jw_dragon_heart', 'jw_solar_lens', 'jw_tailwind']);
    for (const j of js.filter((x) => x.base === 'normal')) { expect(j.affixes!.length).toBeGreaterThanOrEqual(2); expect(j.affixes!.length).toBeLessThanOrEqual(3); }
    expect(sim.build.socketJewel('util_jewel', js[0]!.uid)).toMatchObject({ ok: false, reason: 'socketNotAllocated' });
    sim.build.s.board.nodes = shortestPath(B, START, 'util_jewel')!.slice(1); expect(sim.build.socketJewel('util_jewel', js[0]!.uid).ok).toBe(true);
  });
});

import LABELS from '../src/data/build/talent-labels.json';
describe('v4 labels', () => {
  it('every v4 node / ascendancy / jewel affix effectType has a Chinese label', () => {
    const L = LABELS as Record<string, unknown>;
    for (const n of B.raw.nodes) expect(L[n.effectType], n.id).toBeTruthy();
    for (const a of B.raw.ascendancy) expect(L[a.effectType], a.id).toBeTruthy();
    for (const a of JEWEL_RULES.normal.affixPool) expect(L[a.effectType], a.effectType).toBeTruthy();
    for (const r of Object.values(JEWEL_RULES.legendary)) for (const t of r.to) expect(L[t.effectType]).toBeTruthy();
  });
  it('every v4 effectType has a gameplay handler (nothing silently ignored)', async () => {
    const { BOARD_EFFECTS } = await import('../src/core/build/board');
    for (const n of B.raw.nodes) if (n.effectType !== 'keystone') expect(BOARD_EFFECTS[n.effectType], n.id).toBeTruthy();
    for (const a of B.raw.ascendancy) expect(BOARD_EFFECTS[a.effectType], a.id).toBeTruthy();
  });
});
