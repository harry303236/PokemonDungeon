# Decisions (new ADRs)
- ADR-015: Prototype uses a simplified entity store (`core/ecs/world.ts`: one Entity record with optional component fields + spatial hash) instead of Map-per-component ECS. Faster to build; can be migrated later behind the same Sim API.
- ADR-016: Exit opens after 60% of floor monsters are killed (and boss dead on floor 5) — room-clear tracking deferred.
- ADR-017: Skill tree not implemented yet; fixed loadout flamethrower / fire-spin / fire-blast / flare-blitz + basic ember. Player starts Lv5.
- ADR-018: Monster HP scaled by `BALANCE.monsterHpScale = 0.35` (TUNE) for ARPG pacing; zone ticks ×3 (TUNE).
- ADR-019: Items have 3 slots for now (held, TM-ember, TM-flamethrower); 8 of 18 affixes implemented (power, cdr, leech, extra-projectile, pierce, kindling, split-flame, all-in).
- ADR-020: XP curve `20 * L^1.5` (TUNE); evolution by level only changes species/stats/color (no cutscene).
- ADR-021: Floor-5 boss is a single-phase Onix (hpMult 6), no telegraphed phases yet.
- ADR-022: Kenney assets not added (Q19): all visuals are procedural shapes.
