import { describe, it, expect } from 'vitest';
import { MOVE_TAGS, SKILL_UPGRADES, GEMS, REACTIONS, moveTags, tagLabel } from '../src/core/build/build';
import TAG_LABELS from '../src/data/build/tag-labels.json';
import DIRECTOR from '../src/data/build/charmander-moves-gems.json';

/** Every tag that appears anywhere in move/gem/reaction data (plus the shape fallback in moveTags). */
function allTags(): Set<string> {
  const t = new Set<string>();
  for (const d of Object.values(MOVE_TAGS)) for (const x of d.tags ?? []) t.add(x);
  for (const m of DIRECTOR.moves) { for (const x of m.tags) t.add(x); for (const v of m.variants) for (const x of v.addTags) t.add(x); }
  for (const g of DIRECTOR.supportGems as { requiresAnyTags?: string[]; excludesTags?: string[] }[]) for (const x of [...(g.requiresAnyTags ?? []), ...(g.excludesTags ?? [])]) t.add(x);
  for (const gs of Object.values(SKILL_UPGRADES)) for (const g of gs) for (const o of g.options) for (const op of o.ops) if (op.op === 'addTag' || op.op === 'removeTag') t.add(String(op.value));
  for (const g of Object.values(GEMS)) for (const x of [...(g.tagsAny ?? []), ...(g.tagsAll ?? []), ...(g.tagsNone ?? [])]) t.add(x);
  for (const r of REACTIONS) for (const x of [...(r.trigger.tagsAll ?? []), ...(r.trigger.tagsAny ?? [])]) t.add(x);
  for (const shape of ['projectile', 'beam', 'zone', 'aoe-target', 'dash', 'arc-melee']) for (const x of moveTags('__none__', shape)) t.add(x);
  return t;
}
describe('move tag labels', () => {
  it('every tag used in data has a Chinese label', () => {
    const L = TAG_LABELS as Record<string, string>; const missing = [...allTags()].filter((x) => !L[x]);
    expect(missing).toEqual([]);
    for (const x of allTags()) expect(L[x]).toMatch(/[\u4e00-\u9fff]/);
  });
  it('tagLabel falls back to the raw tag only for unknown tags', () => {
    expect(tagLabel('projectile')).toBe('投射物'); expect(tagLabel('zzz')).toBe('zzz');
  });
});
