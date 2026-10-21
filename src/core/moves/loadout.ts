/** 5 hotbar slots (RMB, Q, W, E, R). The basic attack is itself a slottable move. */
export const SLOT_COUNT = 5;
export const MAX_NON_BASIC = 4;
export const BASIC_MOVE = 'ember';
/** Moves Charmander can slot in the MVP (no skill tree yet: all unlocked). */
export const KNOWN_MOVES = ['ember', 'flamethrower', 'fire-spin', 'fire-blast', 'flare-blitz'] as const;
export type Slots = (string | null)[];
export const DEFAULT_SLOTS: Slots = ['ember', 'flamethrower', 'fire-spin', 'fire-blast', 'flare-blitz'];

export function validateSlots(s: Slots): { ok: true } | { ok: false; reason: 'length' | 'unknown' | 'duplicate' | 'too-many' } {
  if (s.length !== SLOT_COUNT) return { ok: false, reason: 'length' };
  const ids = s.filter((x): x is string => x !== null);
  if (ids.some((id) => !(KNOWN_MOVES as readonly string[]).includes(id))) return { ok: false, reason: 'unknown' };
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'duplicate' };
  if (ids.filter((id) => id !== BASIC_MOVE).length > MAX_NON_BASIC) return { ok: false, reason: 'too-many' };
  return { ok: true };
}

/** Place moveId (or null to clear) into slot; if the move is already in another slot, the two slots swap. */
export function assignSlot(s: Slots, slot: number, moveId: string | null): Slots {
  if (slot < 0 || slot >= SLOT_COUNT) return s;
  const next = [...s];
  const from = moveId === null ? -1 : next.indexOf(moveId);
  const prev = next[slot] ?? null;
  next[slot] = moveId;
  if (from >= 0 && from !== slot) next[from] = prev;
  return validateSlots(next).ok ? next : s;
}
