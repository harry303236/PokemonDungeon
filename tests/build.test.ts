import { describe, it, expect, vi } from 'vitest';
import { TALENTS, GEMS, Build, newBuildSave, gemFits, moveTags, DIRECTOR, REACTIONS, validateDirector, engineMoveId } from '../src/core/build/build';
import { validateTalentData, canAllocate, talentBonuses, unhandledEffectTypes, type TalentData } from '../src/core/build/talents';
import { baseSpec, buildMoveSpec, opsModifier, compatible, STAGES, type Modifier } from '../src/core/build/pipeline';
import { Sim, newProgress } from '../src/core/sim';
import { newChain } from '../src/core/events/event-bus';

const mkBuild = (level = 10, evo = 1, debug = true) => { const s = newBuildSave(); const ctx = { level, evoStage1: evo }; const b = new Build(s, () => ctx); b.debug = debug; return { b, s, ctx }; };

describe('talent data validation', () => {
  it('shipped design file is valid (28 nodes)', () => {
    expect(TALENTS.nodes.length).toBe(28);
    expect(validateTalentData(TALENTS)).toEqual([]);
  });
  it('catches unknown requires, bad rank, bad evoStage, keystone w/o group, cycles', () => {
    const bad: TalentData = { meta: TALENTS.meta, nodes: [
      { id: 'a', branch: 'x', tier: 0, evoStage: 1, effectType: 'none', value: 0, maxRank: 0, requires: ['zzz'], exclusiveGroup: null },
      { id: 'b', branch: 'x', tier: 1, evoStage: 9, effectType: 'keystone', value: 'k', maxRank: 1, requires: ['c'], exclusiveGroup: null },
      { id: 'c', branch: 'x', tier: 1, evoStage: 1, effectType: 'none', value: 0, maxRank: 1, requires: ['b'], exclusiveGroup: null },
    ] };
    const e = validateTalentData(bad).join('\n');
    for (const s of ['requires unknown zzz', 'maxRank', 'evoStage 9', 'keystone without exclusiveGroup', 'cycle']) expect(e).toContain(s);
  });
  it('allocation rules: requires, maxRank, evo gating, points, one keystone', () => {
    const { b, s, ctx } = mkBuild(50, 3); s.bonusPoints = 200;
    expect(b.allocate('sun_t1_0').reason).toBe('requires');
    expect(b.allocate('root').ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(b.allocate('sun_t1_0').ok).toBe(true);
    expect(b.allocate('sun_t1_0').reason).toBe('maxRank');
    // evo gating: tier-2 nodes need evo stage 2
    b.allocate('sun_t1_1'); b.allocate('sun_t1_mid'); ctx.evoStage1 = 1;
    expect(b.allocate('sun_t2_0').reason).toBe('evoStage'); ctx.evoStage1 = 3;
    // walk both branches to their keystones; only one keystone allowed
    const walk = (br: string): void => { for (const id of [`${br}_t1_0`, `${br}_t1_1`, `${br}_t1_mid`, `${br}_t2_0`, `${br}_t2_1`, `${br}_t2_mid`, `${br}_t3_0`, `${br}_t3_1`]) b.allocate(id); };
    walk('sun'); walk('claw');
    expect(b.allocate('ks_solarPower').ok).toBe(true);
    expect(b.allocate('ks_blaze').reason).toBe('exclusive');
    // points
    expect(canAllocate(TALENTS, { root: 1 }, 'sun_t1_0', { level: 1, evoStage: 1 }).ok).toBe(false);
  });
  it('respec: free before Lv16, then 1 ash shard per node; full reset costs gold', () => {
    const lo = mkBuild(10); lo.b.allocate('root'); lo.b.allocate('sun_t1_0');
    expect(lo.b.refund('root').reason).toBe('hasDependents');
    expect(lo.b.refund('sun_t1_0').ok).toBe(true);
    const hi = mkBuild(20, 2); hi.b.allocate('root'); hi.b.allocate('wing_t1_0');
    expect(hi.b.refund('wing_t1_0').reason).toBe('ashShard');
    hi.s.ashShards = 1; expect(hi.b.refund('wing_t1_0').ok).toBe(true); expect(hi.s.ashShards).toBe(0);
    expect(hi.b.fullReset().reason).toBe('gold'); hi.s.gold = 5000;
    expect(hi.b.fullReset().ok).toBe(true); expect(hi.s.talents).toEqual({}); expect(hi.s.gold).toBe(3000);
  });
  it('unknown effectType warns once and does not crash', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d: TalentData = { meta: TALENTS.meta, nodes: [{ id: 'x', branch: 'b', tier: 0, evoStage: 1, effectType: 'teleportPct', value: 5, maxRank: 1, requires: [], exclusiveGroup: null }] };
    expect(() => talentBonuses(d, { x: 1 })).not.toThrow(); talentBonuses(d, { x: 1 });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('teleportPct')).length).toBe(1);
    expect(unhandledEffectTypes(d)).toEqual(['teleportPct']);
    warn.mockRestore();
  });
  it('rank multiplies value', () => { expect(talentBonuses(TALENTS, { sun_t1_0: 3 }).spAtkPct).toBe(12); });
});

describe('talents meta.ui', () => {
  it('points = level-1; debug grants only count in debug mode', () => {
    const n = mkBuild(20, 2, false); n.s.bonusPoints = 10; expect(n.b.pointsLeft()).toBe(19);
    n.b.debug = true; expect(n.b.pointsLeft()).toBe(29);
  });
  it('hideUnimplemented: unimplemented nodes are not allocatable and never block their children', () => {
    expect(TALENTS.meta.ui?.hideUnimplemented).toBe(true);
    expect(unhandledEffectTypes(TALENTS)).toEqual(['sunDurationPct']);
    const { b } = mkBuild(50, 3, true); b.s.bonusPoints = 99;
    for (const id of ['root', 'sun_t1_0', 'sun_t1_1', 'sun_t1_mid', 'sun_t2_0']) expect(b.allocate(id).ok).toBe(true);
    expect(b.allocate('sun_t2_1').reason).toBe('unimplemented');
    expect(b.allocate('sun_t2_mid').ok).toBe(true); // requires [sun_t2_0, sun_t2_1(hidden)] -> only sun_t2_0 counts
  });
  it('all three keystones + new node types have handlers', () => {
    const bon = talentBonuses(TALENTS, { ks_blaze: 1, claw_t3_0: 2, wing_t3_0: 1, claw_t2_mid: 1 });
    expect(bon.keystones.has('ks_blaze')).toBe(true); expect(bon.critDmgPct).toBe(16); expect(bon.projSpeedPct).toBe(8); expect(bon.comboStack).toBe(1);
  });
});

describe('modifier pipeline', () => {
  const log: string[] = [];
  const m = (stage: Modifier['stage'], src: string, extra: Partial<Modifier> = {}): Modifier => ({ source: src, stage, apply: () => { log.push(src); }, ...extra });
  it('applies in the fixed stage order regardless of input order', () => {
    log.length = 0;
    const { applied } = buildMoveSpec(baseSpec('ember', ['projectile', 'fire'], {}, 0), [m('numeric', 'n'), m('status', 'st'), m('onhit', 'o'), m('settle', 'r'), m('prehit', 'p'), m('shape', 's'), m('variant', 'v')]);
    expect(log).toEqual(['v', 's', 'p', 'r', 'o', 'st', 'n']);
    expect(applied.map((a) => a.split(':')[0])).toEqual([...STAGES]);
  });
  it('a stage-1 variant that adds a tag unlocks later tag-gated modifiers', () => {
    const aoeOnlyArea = opsModifier({ id: 'aoe', stage: 'numeric', tagsAny: ['area'], ops: [{ op: 'add', field: 'areaPct', value: 30 }] });
    const plain = buildMoveSpec(baseSpec('flamethrower', ['beam', 'fire'], { duration: 1 }, 0), [aoeOnlyArea]).spec;
    expect(plain.areaPct).toBe(0);
    const burst = opsModifier({ id: 'ft-burst', stage: 'variant', ops: [{ op: 'addTag', value: 'area' }, { op: 'param', key: 'duration', mul: 0.4 }] });
    const s = buildMoveSpec(baseSpec('flamethrower', ['beam', 'fire'], { duration: 1 }, 0), [aoeOnlyArea, burst]).spec;
    expect(s.areaPct).toBe(30); expect(s.variant).toBe('ft-burst'); expect(s.params.duration).toBeCloseTo(0.4);
  });
  it('gems compose: multiple projectiles + pierce + chain + fork', () => {
    const mods = ['multi', 'pierce', 'chain', 'fork'].map((g) => opsModifier(GEMS[g]!));
    const s = buildMoveSpec(baseSpec('ember', moveTags('ember'), {}, 0.1), mods).spec;
    expect([s.projectiles, s.pierce, s.chain, s.fork]).toEqual([3, 2, 2, 1]);
    expect(s.moreDmg).toBeCloseTo(0.75);
  });
});

describe('support gems', () => {
  it('compatibility by tags', () => {
    expect(gemFits('pierce', 'ember', moveTags('ember'))).toBe(true);
    expect(gemFits('pierce', 'fire-blast', moveTags('fire-blast'))).toBe(false);
    expect(gemFits('aoe', 'fire-spin', moveTags('fire-spin'))).toBe(true);
    expect(gemFits('aoe', 'flamethrower', moveTags('flamethrower'))).toBe(false); // director: aoe requires 'area' only
    expect(gemFits('aoe', 'ember', moveTags('ember'))).toBe(false);
    expect(gemFits('ignite', 'flare-blitz', moveTags('flare-blitz'))).toBe(true);
  });
  it('socket count follows evo stage; incompatible gems refused', () => {
    const { b, s, ctx } = mkBuild(10, 1); s.gems = ['pierce', 'chain', 'aoe'];
    expect(b.sockets('ember').length).toBe(1); ctx.evoStage1 = 3; expect(b.sockets('ember').length).toBe(3);
    expect(b.socket('ember', 0, 'aoe').reason).toBe('incompatible');
    expect(b.socket('ember', 0, 'pierce').ok).toBe(true);
    expect(s.gems).not.toContain('pierce');
    b.unsocket('ember', 0); expect(s.gems).toContain('pierce');
  });
  it('sockets travel with the move when slots are rebound', () => {
    const sim = new Sim(newProgress(3)); const bs = sim.build.s; bs.gems.push('multi');
    expect(sim.build.socket('ember', 0, 'multi').ok).toBe(true);
    expect(sim.moveSpec('ember').projectiles).toBe(3);
    sim.setSlot(4, 'ember'); // move basic attack from RMB to R (swap)
    expect(sim.slots[4]).toBe('ember');
    expect(sim.moveSpec('ember').projectiles).toBe(3);
    expect(sim.moveSpec('flare-blitz').projectiles).toBe(1);
  });
  it('multiple projectiles gem actually spawns more projectiles in the sim', () => {
    const sim = new Sim(newProgress(3)); sim.build.s.gems.push('multi'); sim.build.socket('ember', 0, 'multi');
    sim.tryCast('ember', sim.player.x + 100, sim.player.y);
    expect(sim.world.query('projectile').filter((e) => e.team === 'player').length).toBe(3);
  });
});

describe('director content (charmander-moves-gems.json)', () => {
  const cast = (sim: Sim, id: string): void => { sim.cooldowns.clear(); sim.energy = 999; sim.tryCast(id, sim.player.x + 120, sim.player.y); };
  const fresh = (): Sim => { const sim = new Sim(newProgress(5)); sim.debugLevelUp(true); sim.debugLevelUp(true); return sim; }; // Charizard: 3 sockets

  it('loads + validates with every entry bound (no stubs)', () => {
    expect(validateDirector()).toEqual([]);
    expect(Object.values(GEMS).filter((g) => g.stub)).toEqual([]);
    expect(REACTIONS.filter((r) => r.stub)).toEqual([]);
    expect(DIRECTOR.moves.flatMap((m) => m.variants).length).toBe(10);
  });

  // table-driven: every variant x every gem -> socket iff compatible with the variant-modified tags, spec builds, cast runs a few ticks w/o throwing
  const VARIANTS = DIRECTOR.moves.flatMap((m) => m.variants.map((v) => ({ move: engineMoveId(m.id), v: v.id })));
  const GEM_IDS = DIRECTOR.supportGems.map((g) => g.id);
  for (const { move, v } of VARIANTS) for (const g of GEM_IDS) {
    it(`${move}/${v} + ${g}`, () => {
      const sim = fresh(); sim.build.s.gems.push(g); sim.build.chooseUpgrade(move, 'variant', v);
      const res = sim.build.socket(move, 0, g);
      expect(res.ok).toBe(gemFits(g, move, sim.build.effectiveTags(move)));
      const spec = sim.moveSpec(move);
      expect(spec.variant).toBe(v);
      if (res.ok && !GEMS[g]!.stub) expect(spec.tags.size).toBeGreaterThan(0);
      const m = [...sim.world.query('monster')][0]!; m.x = sim.player.x + 80; m.y = sim.player.y;
      expect(() => { cast(sim, move); for (let i = 0; i < 90; i++) sim.step(1 / 60, { moveX: 0, moveY: 0, aimX: sim.player.x + 120, aimY: sim.player.y, slots: [false, false, false, false, false], dodge: false }); }).not.toThrow();
    });
  }

  it('ember_volley: 3 shots; + multi = 5 with wider spread', () => {
    const sim = fresh(); sim.build.chooseUpgrade('ember', 'variant', 'ember_volley');
    expect(sim.moveSpec('ember').projectiles).toBe(3);
    sim.build.s.gems.push('multi'); sim.build.socket('ember', 0, 'multi');
    const s = sim.moveSpec('ember'); expect(s.projectiles).toBe(5); expect(s.spreadDeg).toBeGreaterThan(10);
  });
  it('ember_seed leaves a ground seed; a fire hit near it detonates it and chain-detonates neighbours', () => {
    const sim = fresh(); sim.build.chooseUpgrade('ember', 'variant', 'ember_seed'); const p = sim.player;
    const m = [...sim.world.query('monster')][0]!; m.x = p.x + 60; m.y = p.y; m.hp = m.maxHp = 1e7;
    sim.hit(p, m, 'ember', 1, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('ember') }, newChain(1));
    expect(sim.world.query('ground').filter((g) => g.sub === 'seed').length).toBe(1);
    sim.spawnGround('seed', m.x + 60, m.y, 6, p.id); // neighbour within 3 tiles
    const ids: string[] = []; sim.bus.on('reaction', (e) => ids.push(e.id));
    sim.hit(p, m, 'fire-blast', 1, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('fire-blast') }, newChain(2));
    expect(ids.filter((x) => x === 'seed_detonate').length).toBe(2);
    expect(sim.world.query('ground').filter((g) => g.sub === 'seed' && !g.dead).length).toBe(0);
  });
  it('burn_consume: ft_focus on a burning enemy consumes burn for burst damage', () => {
    const sim = fresh(); sim.build.chooseUpgrade('flamethrower', 'variant', 'ft_focus'); const p = sim.player;
    const m = [...sim.world.query('monster')][0]!; m.hp = m.maxHp = 1e5; m.burn = { stacks: 3, t: 4, src: p.id };
    const before = m.hp; sim.hit(p, m, 'flamethrower', 0.0001, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('flamethrower') }, newChain(3));
    expect(m.burn).toBeUndefined(); expect(before - m.hp).toBeGreaterThan(1000);
  });
  it('fs_prison roots normal enemies; fs_tornado follows the caster; fc_ram pulls + stuns', () => {
    const sim = fresh(); const p = sim.player; const m = [...sim.world.query('monster')][0]!; m.x = p.x + 100; m.y = p.y; m.hp = m.maxHp = 1e7;
    sim.build.chooseUpgrade('fire-spin', 'variant', 'fs_prison'); sim.cooldowns.clear(); sim.energy = 999; sim.tryCast('fire-spin', m.x, m.y);
    sim.step(1 / 60, { moveX: 0, moveY: 0, aimX: m.x, aimY: m.y, slots: [false, false, false, false, false], dodge: false });
    expect(m.statuses?.root).toBeTruthy();
    const sim2 = fresh(); sim2.build.chooseUpgrade('fire-spin', 'variant', 'fs_tornado'); cast(sim2, 'fire-spin');
    const z = sim2.world.query('zone')[0]!; sim2.player.x += 40; sim2.step(1 / 60, { moveX: 0, moveY: 0, aimX: 0, aimY: 0, slots: [false, false, false, false, false], dodge: false });
    expect(z.x).toBeCloseTo(sim2.player.x);
    const sim3 = fresh(); sim3.build.chooseUpgrade('flare-blitz', 'variant', 'fc_ram'); const p3 = sim3.player; const m3 = [...sim3.world.query('monster')][0]!;
    m3.hp = m3.maxHp = 1e7; m3.x = p3.x + 240; m3.y = p3.y; cast(sim3, 'flare-blitz');
    for (let i = 0; i < 20; i++) sim3.step(1 / 60, { moveX: 0, moveY: 0, aimX: p3.x + 300, aimY: p3.y, slots: [false, false, false, false, false], dodge: false });
    expect(m3.statuses?.stun ?? null).not.toBeNull();
  });
  it('sun_chain: chain jumps get +10% each under sun (offsets ft_focus -20%)', () => {
    const sim = fresh(); sim.build.chooseUpgrade('flamethrower', 'variant', 'ft_focus');
    const s = sim.moveSpec('flamethrower'); const a = [...sim.world.query('monster')]; const [m1, m2] = [a[0]!, a[1]!];
    const k0 = (sim as unknown as { chainStepMult: (s: unknown, a: unknown, b: unknown) => number }).chainStepMult(s, m1, m2);
    sim.debugSun(5); const k1 = (sim as unknown as { chainStepMult: (s: unknown, a: unknown, b: unknown) => number }).chainStepMult(s, m1, m2);
    expect(k0).toBeCloseTo(0.8); expect(k1).toBeCloseTo(0.9);
  });
  it('delayed gem leaves a sticky mark; another fire hit detonates it early', () => {
    const sim = fresh(); const p = sim.player; sim.build.s.gems.push('delayed'); expect(sim.build.socket('ember', 0, 'delayed').ok).toBe(true);
    const m = [...sim.world.query('monster')][0]!; m.hp = m.maxHp = 1e7;
    sim.hit(p, m, 'ember', 1, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('ember') }, newChain(4));
    const mark = sim.world.query('blast').find((b) => b.sub === 'sticky')!; expect(mark.life).toBeCloseTo(1);
    sim.hit(p, m, 'fire-blast', 1, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('fire-blast') }, newChain(5));
    expect(mark.life!).toBeLessThan(0.01);
  });
  it('fb_meteor excludes the delayed gem (tag exclusion composes with variant tags)', () => {
    const sim = fresh(); sim.build.chooseUpgrade('fire-blast', 'variant', 'fb_meteor');
    const spec = sim.moveSpec('fire-blast'); expect(spec.tags.has('delayed')).toBe(true);
    const mods = sim.build.modifiersFor('fire-blast'); void mods;
    expect(compatible(GEMS.delayed!, spec.tags, 'fire-blast')).toBe(false);
  });

  // --- director update 2026-10-21 23:10 ---
  const mods0 = (sim: Sim, id: string) => ({ powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec(id) });
  it('REGRESSION: burn_consume only consumes burn that existed before the hit (not burn applied by the same hit)', () => {
    const sim = fresh(); sim.build.chooseUpgrade('flamethrower', 'variant', 'ft_focus'); const p = sim.player;
    const m = [...sim.world.query('monster')][0]!; m.hp = m.maxHp = 1e6; m.burn = undefined;
    const ids: string[] = []; sim.bus.on('reaction', (e) => ids.push(e.id));
    const md = mods0(sim, 'flamethrower'); md.spec.burnChance = 1; // guaranteed ignite on this hit
    sim.hit(p, m, 'flamethrower', 0.0001, md, newChain(10));
    expect(m.burn).toBeTruthy(); expect(ids).not.toContain('burn_consume');
    sim.step(1 / 60, { moveX: 0, moveY: 0, aimX: 0, aimY: 0, slots: [false, false, false, false, false], dodge: false });
    sim.hit(p, m, 'flamethrower', 0.0001, mods0(sim, 'flamethrower'), newChain(11)); // next hit: pre-existing burn -> consumed
    expect(ids).toContain('burn_consume'); expect(m.burn).toBeUndefined();
  });
  it('reaction rules: max depth 3 and once per object per frame', () => {
    const sim = fresh(); sim.build.chooseUpgrade('flamethrower', 'variant', 'ft_focus'); const p = sim.player;
    const m = [...sim.world.query('monster')][0]!; m.hp = m.maxHp = 1e6; const ids: string[] = []; sim.bus.on('reaction', (e) => ids.push(e.id));
    m.burn = { stacks: 1, t: 4, src: p.id };
    sim.hit(p, m, 'flamethrower', 0.0001, mods0(sim, 'flamethrower'), { rootId: 1, depth: 3, visited: new Set() });
    expect(ids).toEqual([]); // depth 3 = max -> no reaction
    sim.hit(p, m, 'flamethrower', 0.0001, mods0(sim, 'flamethrower'), newChain(12)); expect(ids).toEqual(['burn_consume']);
    m.burn = { stacks: 1, t: 4, src: p.id };
    sim.hit(p, m, 'flamethrower', 0.0001, mods0(sim, 'flamethrower'), newChain(13)); expect(ids).toEqual(['burn_consume']); // same frame -> once
  });
  it('ft_focus has inherent pierce (3 targets); pierce gem adds +2 (5 targets)', () => {
    const sim = fresh(); sim.build.chooseUpgrade('flamethrower', 'variant', 'ft_focus');
    expect(1 + sim.moveSpec('flamethrower').pierce).toBe(3);
    sim.build.s.gems.push('pierce'); expect(sim.build.socket('flamethrower', 0, 'pierce').ok).toBe(true);
    expect(1 + sim.moveSpec('flamethrower').pierce).toBe(5);
    // in-sim: line of 7 monsters, count how many get hit by one tick
    const p = sim.player; const ms = [...sim.world.query('monster')].slice(0, 7);
    ms.forEach((m, i) => { m.x = p.x + 40 + i * 30; m.y = p.y; m.hp = m.maxHp = 1e7; m.ai!.state = 'idle'; m.ai!.cd = 99; });
    const hit = new Set<number>(); sim.bus.on('damage:dealt', (e) => hit.add(e.target));
    sim.cooldowns.clear(); sim.energy = 999; sim.tryCast('flamethrower', p.x + 300, p.y);
    sim.step(1 / 60, { moveX: 0, moveY: 0, aimX: p.x + 300, aimY: p.y, slots: [false, false, false, false, false], dodge: false });
    expect(hit.size).toBe(5);
  });
  it('base flamethrower refuses aoe; ft_spread (adds area) accepts it', () => {
    const sim = fresh(); sim.build.s.gems.push('aoe');
    expect(sim.build.socket('flamethrower', 0, 'aoe').reason).toBe('incompatible');
    sim.build.chooseUpgrade('flamethrower', 'variant', 'ft_spread');
    expect(sim.build.socket('flamethrower', 0, 'aoe').ok).toBe(true);
    expect(sim.moveSpec('flamethrower').areaPct).toBe(30);
  });
  it('fc_ram: bosses are not stunned but take +10% damage for 3 s', () => {
    const sim = fresh(); sim.build.chooseUpgrade('flare-blitz', 'variant', 'fc_ram'); const p = sim.player;
    const boss = sim.spawnMonster('onix-boss', p.x + 240, p.y, 10, true); boss.hp = boss.maxHp = 1e7;
    sim.cooldowns.clear(); sim.energy = 999; sim.tryCast('flare-blitz', p.x + 300, p.y);
    for (let i = 0; i < 20; i++) sim.step(1 / 60, { moveX: 0, moveY: 0, aimX: p.x + 300, aimY: p.y, slots: [false, false, false, false, false], dodge: false });
    expect(boss.statuses?.stun).toBeUndefined(); expect(boss.statuses?.['dmg-vuln']?.t).toBeGreaterThan(2.5);
  });
});

import LABELS from '../src/data/build/talent-labels.json';
describe('talent labels', () => {
  it('every effectType in the talent data has a Chinese label', () => {
    for (const n of TALENTS.nodes) expect((LABELS as Record<string, unknown>)[n.effectType], n.effectType).toBeTruthy();
  });
});

import { mechanics } from '../src/core/build/talents';
describe('fire trail + combo mechanics (data fields)', () => {
  it('meta.mechanics: trail life 2 s, per-enemy ICD 0.5 s, combo reset 2 s', () => {
    expect(mechanics(TALENTS)).toMatchObject({ trailLifeSec: 2, trailPerEnemyIcdSec: 0.5, comboResetSec: 2 });
  });
  it('overlapping trail patches hit the same enemy at most once per 0.5 s; patches expire after 2 s', () => {
    const sim = new Sim(newProgress(3)); const mons = sim.world.query('monster'); const m = mons[0]!;
    for (const o of mons) if (o !== m) { o.x = -9999; o.y = -9999; }
    const px = sim.player.x + 200, py = sim.player.y; m.x = px; m.y = py; m.hp = m.maxHp = 1e9;
    for (let i = 0; i < 4; i++) sim.spawnGround('fire', m.x + i * 3, m.y, sim.mech.trailLifeSec, sim.player.id, 0.08);
    const spy = vi.spyOn(sim, 'hit'); const times: number[] = [];
    spy.mockImplementation((_s, t, _id, mult) => { if (t === m && mult === 0.08) times.push(sim.time); return 0; });
    const idle = { moveX: 0, moveY: 0, aimX: 0, aimY: 0, slots: [false, false, false, false, false], dodge: false };
    for (let i = 0; i < 180; i++) { sim.step(1 / 60, idle); m.x = px; m.y = py; } // pin enemy inside the patches
    expect(times.length).toBeGreaterThanOrEqual(3); expect(times.length).toBeLessThanOrEqual(5);
    for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(0.5 - 1e-6);
    expect(sim.world.query('ground').filter((g) => g.dmgMult).length).toBe(0);
  });
});

import { stageAdd, stageRemove, statusLine, effectLine, planCost, merged } from '../src/core/build/talent-plan';
describe('talent plan/confirm + tooltip lines', () => {
  const N = (id: string) => TALENTS.nodes.find((n) => n.id === id)!;
  const ctx = { level: 50, evoStage: 3 };
  it('staging spends nothing and respects prereqs; unstage works', () => {
    const a = {}; const p: Record<string, number> = {};
    expect(stageAdd(TALENTS, a, p, 'claw_t1_0', ctx).ok).toBe(false);
    expect(stageAdd(TALENTS, a, p, 'root', ctx).ok).toBe(true);
    expect(stageAdd(TALENTS, a, p, 'claw_t1_0', ctx).ok).toBe(true);
    expect(a).toEqual({}); expect(p).toEqual({ root: 1, claw_t1_0: 1 });
    expect(stageRemove(TALENTS, a, p, 'root').ok).toBe(false); // staged child depends on it
    expect(stageRemove(TALENTS, a, p, 'claw_t1_0').ok).toBe(true); expect(p).toEqual({ root: 1 });
  });
  it('staged refunds cost ash shards only after free-respec level', () => {
    const a = { root: 1, claw_t1_0: 2 }; const p: Record<string, number> = {};
    expect(stageRemove(TALENTS, a, p, 'claw_t1_0').ok).toBe(true);
    expect(planCost(p, true).ashShards).toBe(1); expect(planCost(p, false).ashShards).toBe(0); expect(merged(a, p).claw_t1_0).toBe(1);
  });
  it('status lines: exclusive keystone, level, prereq names, learned', () => {
    expect(statusLine(TALENTS, { ks_blaze: 1 }, {}, N('ks_solarPower'), ctx).text).toBe('已選擇其他關鍵天賦');
    expect(statusLine(TALENTS, { root: 1 }, {}, N('claw_t1_mid'), ctx).text).toMatch(/^需要先點：/);
    expect(statusLine(TALENTS, {}, {}, N('ks_blaze'), { level: 10, evoStage: 1 }).text).toBe(`需要等級 ${TALENTS.meta.evoStageUnlock['3']}`);
    expect(statusLine(TALENTS, { root: 1 }, {}, N('root'), ctx).text).toBe('已習得');
  });
  it('effect line shows current and next rank; keystone has drawback field', () => {
    const n = N('claw_t1_0'); const v = n.value as number;
    expect(effectLine(n, 1)).toContain(`目前 +${v}`); expect(effectLine(n, 1)).toContain(`下一級 +${v * 2}`);
    expect(N('ks_solarPower').drawback).toBeTruthy();
  });
});
