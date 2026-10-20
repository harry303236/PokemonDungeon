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
      const cmd: InputCommand = { moveX: 0, moveY: 0, aimX: tgt?.x ?? 0, aimY: tgt?.y ?? 0, basic: true, slots: [f % 7 === 0, f % 11 === 0, f % 13 === 0, false], dodge: false };
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
