# Progress
## M0
- [x] Vite + TS strict (noUncheckedIndexedAccess) + Phaser 3 + Vitest + ESLint + zod
- [x] AGENTS.md, docs/, CREDITS.md
- [x] scripts/fetch-pokeapi.ts (cache+retry, zh-Hant, scarlet-violet learnset) — data/raw committed
- [x] species-list.json, build-data.ts, validate-data.ts, zod schemas (subset of 03 types)
- [x] core/rng.ts (mulberry32), core/events/event-bus.ts
- [x] Title shows 小火龍 from generated JSON
- [ ] Prettier config; full 03 schema coverage
## M1 (mostly)
- [x] entity store + fixed-step sim (60 Hz) + spatial hash
- [x] InputMap -> InputCommand (WASD, mouse aim, dodge)
- [x] stat-calc, damage, type-chart (immune->0.25), cooldown/energy
- [x] shapes: projectile, beam, zone, aoe-target, dash, arc-melee (monsters)
- [ ] shapes: cone, aoe-self, buff-self; statuses other than burn/bound
- [x] damage numbers, HUD (HP/energy/XP, 5 cooldown slots), minimap
## M2+ (partial)
- [x] BSP floor gen (deterministic, tested), 5 floors, exit flow
- [x] 3 monster types (rattata melee, geodude tank, poliwag ranged) + simplified Onix boss
- [ ] 10 monster types / AI archetypes, elites, weather, campfire move swap, boss phases
- [x] Loot roller (rarity weights + tier), ground drops, auto pickup, inventory DOM, equip rules (shape/cost)
- [x] Level-up + evolution by level (16/36)
- [ ] Skill tree, abilities (blaze/solar-power), 10 of 18 affixes, reactions
- [x] Save v1 to localStorage + .bak + v0->v1 migration (tested)
- [ ] Hub, settings, audio
