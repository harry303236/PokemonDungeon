import { describe, it, expect } from 'vitest';
import { Sim, newProgress, resumeFloor, MAX_FLOOR } from '../src/core/sim';
import { JEWEL_RULES } from '../src/core/build/board';
import { shouldStepSim, FLAGS } from '../src/config/flags';

describe('continue resumes at the deepest floor reached', () => {
  it('resumeFloor clamps and handles old/corrupt saves', () => {
    expect(resumeFloor({ bestFloor: 3 })).toBe(3);
    expect(resumeFloor({ bestFloor: 99 })).toBe(MAX_FLOOR);
    expect(resumeFloor({ bestFloor: 0 })).toBe(1);
    expect(resumeFloor({ bestFloor: undefined as never })).toBe(1);
    expect(resumeFloor({ bestFloor: 'x' as never })).toBe(1);
  });
  it('a sim built from a saved progress starts at the entrance of bestFloor; new game at floor 1', () => {
    const p = newProgress(7); p.bestFloor = 3; const s = new Sim(p);
    expect(s.floorNo).toBe(3);
    expect(Math.floor(s.player.x / 32)).toBe(s.floor.start.cx); expect(Math.floor(s.player.y / 32)).toBe(s.floor.start.cy);
    expect(new Sim(newProgress(7)).floorNo).toBe(1);
    const old = newProgress(7) as unknown as Record<string, unknown>; delete old.bestFloor; expect(new Sim(old as never).floorNo).toBe(1);
  });
});

describe('jewel inventory cap', () => {
  const fill = (s: Sim, n: number) => { for (let i = 0; i < n; i++) s.build.s.board.jewels.push(s.rollJewel('normal')); };
  it('cap is data (30); drops beyond it stay on the ground and can be picked up later', () => {
    expect(JEWEL_RULES.inventoryCap).toBe(30);
    const s = new Sim(newProgress(3)); const msgs: string[] = []; s.bus.on('build:gain', (e) => msgs.push(String(e.what)));
    fill(s, 30); expect(s.jewelsFull()).toBe(true);
    const far = { x: s.player.x + 500, y: s.player.y };
    expect(s.giveJewel(s.rollJewel('jw_tailwind'), far.x, far.y)).toBe(false);
    expect(s.build.s.board.jewels.length).toBe(30); expect(msgs).toContain('jewelFull');
    const ground = [...s.world.query('item')].filter((e) => e.jewel); expect(ground.length).toBe(1);
    // free a slot, walk onto it -> picked up
    expect(s.build.discardJewel(s.build.s.board.jewels[0]!.uid).ok).toBe(true);
    const g = ground[0]!; s.player.x = g.x; s.player.y = g.y;
    s.step(1 / 60, { moveX: 0, moveY: 0, aimX: g.x, aimY: g.y, slots: [false, false, false, false, false], dodge: false } as never);
    expect(s.build.s.board.jewels.length).toBe(30); expect(s.build.s.board.jewels.at(-1)!.base).toBe('jw_tailwind'); expect(g.dead).toBe(true);
  });
  it('socketed jewels count toward the cap and cannot be discarded directly', () => {
    const s = new Sim(newProgress(3)); const b = s.build;
    fill(s, 29); const leg = s.rollJewel('jw_solar_lens'); b.s.board.jewels.push(leg); b.s.board.sockets.util_jewel = leg.uid;
    expect(s.jewelsFull()).toBe(true);
    expect(b.discardJewel(leg.uid)).toEqual({ ok: false, reason: 'socketed' });
    delete b.s.board.sockets.util_jewel; expect(b.discardJewel(leg.uid).ok).toBe(true); expect(b.discardJewel('nope').ok).toBe(false);
  });
});

describe('UI pause flag', () => {
  it('pauses only when a panel is open and the flag is on', () => {
    expect(FLAGS.pauseSimWhenUiOpen).toBe(true);
    expect(shouldStepSim(true)).toBe(false); expect(shouldStepSim(false)).toBe(true);
    expect(shouldStepSim(true, { pauseSimWhenUiOpen: false })).toBe(true);
  });
});
