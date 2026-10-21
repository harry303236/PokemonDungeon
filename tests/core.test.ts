import { describe, it, expect } from 'vitest';
import { Rng } from '../src/core/rng';
import { calcStats } from '../src/core/stats/stat-calc';
import { calcDamage } from '../src/core/combat/damage';
import { typeMult } from '../src/core/combat/type-chart';
import { moveCooldown, energyCost } from '../src/core/moves/cooldown';
import { generateFloor } from '../src/core/dungeon/bsp-gen';
import { rollRarity, rollItem, canEquip, type Item } from '../src/core/loot/loot-roller';
import { canTrigger, newChain, childChain } from '../src/core/events/event-bus';
import { migrate, save, load, SAVE_KEY } from '../src/core/save/save-manager';
import { Sim, newProgress, type InputCommand } from '../src/core/sim';
import { species, move } from '../src/data/registry';

describe('data', () => {
  it('charmander base stats & evolution', () => {
    expect(Object.values(species('charmander').baseStats)).toEqual([39, 52, 43, 60, 50, 65]);
    expect(species('charmeleon').evolvesTo?.minLevel).toBe(36);
  });
});
describe('rng', () => {
  it('is deterministic', () => { const a = new Rng(42), b = new Rng(42); expect([a.next(), a.next()]).toEqual([b.next(), b.next()]); });
});
describe('combat', () => {
  it('Lv10 charmander ember vs Lv10 rattata in snapshot range', () => {
    const c = calcStats(species('charmander'), 10), r = calcStats(species('rattata'), 10);
    const lo = calcDamage({ level: 10, power: 40, atk: c.spa, def: r.spd, moveType: 'fire', attackerTypes: ['fire'], defenderTypes: ['normal'], isCrit: false, roll: 0 });
    const hi = calcDamage({ level: 10, power: 40, atk: c.spa, def: r.spd, moveType: 'fire', attackerTypes: ['fire'], defenderTypes: ['normal'], isCrit: false, roll: 1 });
    expect(lo.dmg).toBeGreaterThanOrEqual(10); expect(hi.dmg).toBeLessThanOrEqual(13); expect(hi.typeEff).toBe(1);
  });
  it('type chart incl. immunity -> 0.25', () => {
    expect(typeMult('fire', ['grass'])).toBe(2); expect(typeMult('water', ['fire'])).toBe(2);
    expect(typeMult('normal', ['ghost'])).toBe(0.25); expect(typeMult('fire', ['rock', 'water'])).toBe(0.25);
  });
  it('cooldowns and energy', () => {
    expect(moveCooldown(move('flamethrower'))).toBeCloseTo(2.667, 2);
    expect(moveCooldown(move('fire-blast'))).toBeCloseTo(8, 5);
    expect(moveCooldown(move('flamethrower'), 0.9)).toBeCloseTo(2.667 * 0.6, 2);
    expect(energyCost(move('flamethrower'))).toBe(18); expect(energyCost(move('flare-blitz'))).toBe(24);
  });
});
describe('chain guard', () => {
  it('stops at depth 3 and dedups affix:target', () => {
    const c = newChain(1); expect(canTrigger(c, 'x', 5)).toBe(true); expect(canTrigger(c, 'x', 5)).toBe(false);
    const d3 = childChain(childChain(childChain(c))); expect(canTrigger(d3, 'x', 6)).toBe(false);
  });
});
describe('dungeon', () => {
  it('same seed -> same floor', () => {
    const a = generateFloor(new Rng(7)), b = generateFloor(new Rng(7));
    expect(Buffer.from(a.tiles).equals(Buffer.from(b.tiles))).toBe(true); expect(a.rooms.length).toBeGreaterThan(3);
  });
});
describe('loot', () => {
  it('rarity distribution within ±2% over 10k rolls', () => {
    const rng = new Rng(123); const n = 10000; const c: Record<string, number> = {};
    for (let i = 0; i < n; i++) { const r = rollRarity(rng); c[r] = (c[r] ?? 0) + 1; }
    expect(Math.abs((c.common ?? 0) / n - 0.6)).toBeLessThan(0.02); expect(Math.abs((c.uncommon ?? 0) / n - 0.28)).toBeLessThan(0.02);
    expect(Math.abs((c.rare ?? 0) / n - 0.1)).toBeLessThan(0.02);
  });
  it('affix count follows rarity', () => {
    const rng = new Rng(9);
    for (let i = 0; i < 500; i++) { const it = rollItem(rng, i); const n = it.affixes.length;
      if (it.rarity === 'common') expect(n).toBe(0); if (it.rarity === 'uncommon') expect(n).toBe(1); if (it.rarity === 'rare') expect(n).toBeLessThanOrEqual(2); }
  });
  it('rejects 2 cost affixes across equipment', () => {
    const a: Item = { uid: 1, slot: 'held', rarity: 'epic', affixes: [{ id: 'all-in', value: 1 }] };
    const b: Item = { uid: 2, slot: 'tm-ember', rarity: 'epic', affixes: [{ id: 'all-in', value: 1 }] };
    expect(canEquip(b, [a]).ok).toBe(false); expect(canEquip(a, []).ok).toBe(true);
  });
});
describe('save', () => {
  it('migrates v0 and restores from .bak when corrupt', () => {
    expect(migrate({ level: 3, inventory: [] }).version).toBe(1);
    const m = new Map<string, string>(); const kv = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    const p = newProgress(1); save(kv, p); p.level = 9; save(kv, p);
    m.set(SAVE_KEY, '{broken'); expect(load(kv)?.level).toBe(5);
  });
});
describe('sim smoke', () => {
  it('bot can clear floors without crashing', () => {
    const sim = new Sim(newProgress(2024)); let cleared = 0; sim.bus.on('floor:cleared', () => cleared++);
    for (let f = 0; f < 60 * 60 * 6 && sim.floorNo < 3; f++) {
      if (sim.player.dead) sim.respawn();
      const p = sim.player; const ms = sim.world.query('monster');
      let tgt = ms[0]; let best = Infinity;
      for (const m of ms) { const d = Math.hypot(m.x - p.x, m.y - p.y); if (d < best) { best = d; tgt = m; } }
      // cheat-walk: teleport toward target / exit to test combat + flow, not pathfinding
      const ex = sim.floor.exit; const goal = sim.exitOpen ? { x: (ex.cx + 0.5) * 32, y: (ex.cy + 0.5) * 32 } : tgt ?? p;
      if (Math.hypot(goal.x - p.x, goal.y - p.y) > 150 || sim.exitOpen) { p.x += (goal.x - p.x) * 0.05; p.y += (goal.y - p.y) * 0.05; }
      p.hp = p.maxHp; // invulnerable bot
      const cmd: InputCommand = { moveX: 0, moveY: 0, aimX: tgt?.x ?? 0, aimY: tgt?.y ?? 0, slots: [true, f % 7 === 0, f % 11 === 0, f % 13 === 0, false], dodge: false };
      sim.step(1 / 60, cmd);
    }
    expect(cleared).toBeGreaterThanOrEqual(2); expect(sim.floorNo).toBeGreaterThanOrEqual(3); expect(sim.progress.level).toBeGreaterThan(5);
  });
});

describe('evolution move buff', () => {
  const beam = (sim: Sim): { len: number; width: number } => {
    sim.cooldowns.clear(); sim.energy = 100;
    sim.tryCast('flamethrower', sim.player.x + 100, sim.player.y);
    const b = sim.world.query('beam').at(-1);
    return { len: b?.len ?? 0, width: b?.width ?? 0 };
  };
  it('flamethrower grows at Lv16 and Lv36, with evolve events', () => {
    const sim = new Sim(newProgress(5)); const stages: number[] = [];
    sim.bus.on('player:evolve', (e) => stages.push(e.stage));
    const b0 = beam(sim);
    sim.debugLevelUp(true); expect(sim.progress.level).toBe(16); expect(sim.speciesId).toBe('charmeleon');
    const b1 = beam(sim);
    sim.debugLevelUp(true); expect(sim.progress.level).toBe(36); expect(sim.speciesId).toBe('charizard');
    const b2 = beam(sim);
    expect(stages).toEqual([1, 2]);
    expect(b1.len).toBeGreaterThan(b0.len); expect(b1.width).toBeGreaterThan(b0.width);
    expect(b2.len).toBeGreaterThan(b1.len); expect(b2.width).toBeGreaterThan(b1.width);
  });
  it('L adds exactly one level', () => { const sim = new Sim(newProgress(5)); sim.debugLevelUp(); expect(sim.progress.level).toBe(6); });
});

import { assignSlot, validateSlots, DEFAULT_SLOTS } from '../src/core/moves/loadout';
describe('hotbar loadout', () => {
  it('default is valid; basic is slottable anywhere', () => {
    expect(validateSlots(DEFAULT_SLOTS).ok).toBe(true);
    const s = assignSlot(DEFAULT_SLOTS, 4, 'ember'); expect(s[4]).toBe('ember'); expect(s[0]).toBe('flare-blitz');
  });
  it('swaps instead of duplicating, and allows clearing', () => {
    const s = assignSlot(DEFAULT_SLOTS, 1, 'fire-blast'); expect(s[1]).toBe('fire-blast'); expect(s[3]).toBe('flamethrower');
    expect(assignSlot(DEFAULT_SLOTS, 2, null)[2]).toBeNull();
  });
  it('rejects >4 non-basic, duplicates, unknown moves', () => {
    expect(validateSlots(['flamethrower', 'fire-spin', 'fire-blast', 'flare-blitz', 'flamethrower']).ok).toBe(false);
    expect(validateSlots(['ember', 'hyper-beam', null, null, null]).ok).toBe(false);
    expect(assignSlot(DEFAULT_SLOTS, 0, 'hyper-beam')).toBe(DEFAULT_SLOTS);
  });
  it('sim casts whatever is in the slot', () => {
    const sim = new Sim(newProgress(3)); sim.setSlot(0, 'fire-blast');
    sim.step(1 / 60, { moveX: 0, moveY: 0, aimX: sim.player.x + 50, aimY: sim.player.y, slots: [true, false, false, false, false], dodge: false });
    expect(sim.cooldownLeft('fire-blast')).toBeGreaterThan(7);
  });
});

import { findPath, clampToFloor, nearestFloorTile } from '../src/core/dungeon/pathfind';
import { isWall, type FloorMap } from '../src/core/dungeon/bsp-gen';
const mkFloor = (rows: string[]): FloorMap => {
  const h = rows.length, w = rows[0]?.length ?? 0; const tiles = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => (tiles[y * w + x] = c === '.' ? 1 : 0)));
  const room = { x: 0, y: 0, w: 1, h: 1, cx: 1, cy: 1 };
  return { w, h, tiles, rooms: [room], start: room, exit: room };
};
describe('pathfinding', () => {
  const f = mkFloor(['#######', '#..#..#', '#..#..#', '#.....#', '#######']);
  it('routes around walls without corner cutting', () => {
    const p = findPath(f, 1, 1, 5, 1); expect(p).not.toBeNull();
    expect(p?.at(-1)).toEqual({ x: 5, y: 1 });
    expect(p?.some((t) => t.y === 3)).toBe(true); // must go down through the gap
    for (const t of p ?? []) expect(isWall(f, t.x, t.y)).toBe(false);
  });
  it('returns null for walls / unreachable', () => {
    expect(findPath(f, 1, 1, 3, 1)).toBeNull();
    expect(findPath(mkFloor(['#####', '#.#.#', '#####']), 1, 1, 3, 1)).toBeNull();
  });
  it('works on generated floors', () => {
    const g = generateFloor(new Rng(11)); const a = g.start, b = g.exit;
    expect(findPath(g, a.cx, a.cy, b.cx, b.cy)?.length).toBeGreaterThan(0);
  });
});
describe('fire spin clamp', () => {
  const f = mkFloor(['#######', '#.....#', '#######', '#######']);
  it('clamps a point inside a wall to the nearest floor tile center', () => {
    expect(nearestFloorTile(f, 3, 3)).toEqual({ x: 3, y: 1 });
    expect(clampToFloor(f, 3.5 * 32, 3.5 * 32, 32)).toEqual({ x: 3.5 * 32, y: 1.5 * 32 });
    expect(clampToFloor(f, 2.2 * 32, 1.4 * 32, 32)).toEqual({ x: 2.2 * 32, y: 1.4 * 32 });
  });
  it('sim never spawns fire-spin zone inside a wall', () => {
    const sim = new Sim(newProgress(8)); const p = sim.player;
    for (let a = 0; a < 16; a++) {
      sim.cooldowns.clear(); sim.energy = 100;
      const ang = (a / 16) * Math.PI * 2; sim.tryCast('fire-spin', p.x + Math.cos(ang) * 400, p.y + Math.sin(ang) * 400);
    }
    const zones = sim.world.query('zone'); expect(zones.length).toBe(16);
    for (const z of zones) expect(isWall(sim.floor, Math.floor(z.x / 32), Math.floor(z.y / 32))).toBe(false);
  });
});
describe('click orders', () => {
  it('click-to-move reaches the goal via A*', () => {
    const sim = new Sim(newProgress(21)); const ex = sim.floor.rooms[1] ?? sim.floor.exit;
    for (const m of sim.world.query('monster')) m.dead = true; sim.world.cleanup();
    const idle = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, slots: [false, false, false, false, false], dodge: false };
    sim.step(1 / 60, { ...idle, moveTo: { x: (ex.cx + 0.5) * 32, y: (ex.cy + 0.5) * 32 } });
    for (let i = 0; i < 60 * 30 && sim.order; i++) sim.step(1 / 60, idle);
    expect(Math.hypot(sim.player.x - (ex.cx + 0.5) * 32, sim.player.y - (ex.cy + 0.5) * 32)).toBeLessThan(4);
  });
  it('attack order uses first slotted attack when basic is unslotted', () => {
    const sim = new Sim(newProgress(21)); sim.setSlot(0, null);
    expect(sim.primaryAttack()).toBe('flamethrower');
  });
});
describe('attack order', () => {
  it('walks into range and kills the clicked monster with basic attacks', () => {
    const sim = new Sim(newProgress(21)); const p = sim.player;
    for (const m of sim.world.query('monster')) m.dead = true; sim.world.cleanup();
    const m = sim.spawnMonster('rattata', p.x, p.y, 3); // same tile, then move it via path target
    m.ai = undefined; const idle = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, slots: [false, false, false, false, false], dodge: false };
    sim.step(1 / 60, { ...idle, attackTarget: m.id });
    for (let i = 0; i < 60 * 20 && !m.dead; i++) { p.hp = p.maxHp; sim.step(1 / 60, idle); }
    sim.step(1 / 60, idle); expect(m.dead).toBe(true); expect(sim.order).toBeNull();
  });
});

describe('consumables', () => {
  it('oran berry heals 35%, has cooldown and per-floor stock', () => {
    const sim = new Sim(newProgress(4)); const p = sim.player; const max = p.maxHp ?? 0;
    p.hp = 10; expect(sim.usePotion(0)).toBe(true); expect(p.hp).toBeCloseTo(Math.min(max, 10 + max * 0.35));
    p.hp = 10; expect(sim.usePotion(0)).toBe(false); // cooldown
    sim.potionCd = 0; expect(sim.usePotion(1)).toBe(false); // slot 2 empty
    expect(sim.potions[0]).toBe(2);
    p.hp = max; sim.potionCd = 0; expect(sim.usePotion(0)).toBe(false); // full hp
    expect(sim.levelsToEvolve()).toBe(11);
  });
});
