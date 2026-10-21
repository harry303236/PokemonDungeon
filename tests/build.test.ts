import { describe, it, expect, vi } from 'vitest';
import { TALENTS, GEMS, Build, newBuildSave, gemFits, moveTags } from '../src/core/build/build';
import { validateTalentData, canAllocate, talentBonuses, unhandledEffectTypes, type TalentData } from '../src/core/build/talents';
import { baseSpec, buildMoveSpec, opsModifier, STAGES, type Modifier } from '../src/core/build/pipeline';
import { Sim, newProgress } from '../src/core/sim';
import { newChain } from '../src/core/events/event-bus';

const mkBuild = (level = 10, evo = 1) => { const s = newBuildSave(); const ctx = { level, evoStage1: evo }; return { b: new Build(s, () => ctx), s, ctx }; };

describe('talent data validation', () => {
  it('shipped design file is valid (46 nodes)', () => {
    expect(TALENTS.nodes.length).toBe(46);
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

describe('modifier pipeline', () => {
  const log: string[] = [];
  const m = (stage: Modifier['stage'], src: string, extra: Partial<Modifier> = {}): Modifier => ({ source: src, stage, apply: () => { log.push(src); }, ...extra });
  it('applies in the fixed stage order regardless of input order', () => {
    log.length = 0;
    const { applied } = buildMoveSpec(baseSpec('ember', ['projectile', 'fire'], {}, 0), [m('numeric', 'n'), m('reaction', 'r'), m('onhit', 'o'), m('prehit', 'p'), m('shape', 's'), m('variant', 'v')]);
    expect(log).toEqual(['v', 's', 'p', 'o', 'r', 'n']);
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
    const mods = ['gem-multi', 'gem-pierce', 'gem-chain', 'gem-fork'].map((g) => opsModifier(GEMS[g]!));
    const s = buildMoveSpec(baseSpec('ember', moveTags('ember'), {}, 0.1), mods).spec;
    expect([s.projectiles, s.pierce, s.chain, s.fork]).toEqual([3, 2, 2, 1]);
    expect(s.moreDmg).toBeCloseTo(0.75);
  });
});

describe('support gems', () => {
  it('compatibility by tags', () => {
    expect(gemFits('gem-pierce', 'ember', moveTags('ember'))).toBe(true);
    expect(gemFits('gem-pierce', 'fire-blast', moveTags('fire-blast'))).toBe(false);
    expect(gemFits('gem-aoe', 'fire-spin', moveTags('fire-spin'))).toBe(true);
    expect(gemFits('gem-aoe', 'flamethrower', moveTags('flamethrower'))).toBe(true);
    expect(gemFits('gem-aoe', 'ember', moveTags('ember'))).toBe(false);
    expect(gemFits('gem-burning', 'flare-blitz', moveTags('flare-blitz'))).toBe(true);
  });
  it('socket count follows evo stage; incompatible gems refused', () => {
    const { b, s, ctx } = mkBuild(10, 1); s.gems = ['gem-pierce', 'gem-chain', 'gem-aoe'];
    expect(b.sockets('ember').length).toBe(1); ctx.evoStage1 = 3; expect(b.sockets('ember').length).toBe(3);
    expect(b.socket('ember', 0, 'gem-aoe', moveTags('ember')).reason).toBe('incompatible');
    expect(b.socket('ember', 0, 'gem-pierce', moveTags('ember')).ok).toBe(true);
    expect(s.gems).not.toContain('gem-pierce');
    b.unsocket('ember', 0); expect(s.gems).toContain('gem-pierce');
  });
  it('sockets travel with the move when slots are rebound', () => {
    const sim = new Sim(newProgress(3)); const bs = sim.build.s; bs.gems.push('gem-multi');
    expect(sim.build.socket('ember', 0, 'gem-multi', moveTags('ember')).ok).toBe(true);
    expect(sim.moveSpec('ember').projectiles).toBe(3);
    sim.setSlot(4, 'ember'); // move basic attack from RMB to R (swap)
    expect(sim.slots[4]).toBe('ember');
    expect(sim.moveSpec('ember').projectiles).toBe(3);
    expect(sim.moveSpec('flare-blitz').projectiles).toBe(1);
  });
  it('multiple projectiles gem actually spawns more projectiles in the sim', () => {
    const sim = new Sim(newProgress(3)); sim.build.s.gems.push('gem-multi'); sim.build.socket('ember', 0, 'gem-multi', moveTags('ember'));
    sim.tryCast('ember', sim.player.x + 100, sim.player.y);
    expect(sim.world.query('projectile').filter((e) => e.team === 'player').length).toBe(3);
  });
});

describe('statuses & reactions', () => {
  it('ember applies ember-seed; an area fire hit detonates it into a burst (consumed)', () => {
    const sim = new Sim(newProgress(5)); const p = sim.player;
    const m = [...sim.world.query('monster')][0]!; m.x = p.x + 60; m.y = p.y; m.hp = m.maxHp = 1e6;
    const seen: string[] = []; sim.bus.on('reaction', (e) => seen.push(e.id));
    sim.hit(p, m, 'ember', 1, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('ember') }, newChain(1));
    expect(m.statuses?.['ember-seed']).toBeTruthy();
    sim.hit(p, m, 'fire-blast', 1, { powerBonus: 0, leech: 0, kindling: false, spec: sim.moveSpec('fire-blast') }, newChain(2));
    expect(seen).toEqual(['ember-detonate']);
    expect(m.statuses?.['ember-seed']).toBeUndefined();
  });
  it('flamethrower variant pair: burst = short + end explosion + area tag; sustained = longer + widening', () => {
    const sim = new Sim(newProgress(5));
    const base = sim.moveSpec('flamethrower');
    sim.build.chooseUpgrade('flamethrower', 'variant', 'ft-burst'); const burst = sim.moveSpec('flamethrower');
    sim.build.chooseUpgrade('flamethrower', 'variant', 'ft-sustained'); const sus = sim.moveSpec('flamethrower');
    expect(burst.params.duration!).toBeLessThan(base.params.duration!); expect(burst.endExplosion).toBeTruthy(); expect(burst.tags.has('area')).toBe(true);
    expect(sus.params.duration!).toBeGreaterThan(base.params.duration!); expect(sus.widenOverLife).toBeGreaterThan(0); expect(sus.endExplosion).toBeNull();
  });
});
