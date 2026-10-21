import { BALANCE } from './balance';
import { Rng } from './rng';
import { EventBus, childChain, canTrigger, newChain, type ChainContext } from './events/event-bus';
import { World, SpatialHash, type Entity, type MoveMods } from './ecs/world';
import { generateFloor, isWall, type FloorMap } from './dungeon/bsp-gen';
import { calcStats, xpToNext } from './stats/stat-calc';
import { calcDamage } from './combat/damage';
import { moveCooldown, energyCost } from './moves/cooldown';
import { BASIC_MOVE, DEFAULT_SLOTS, assignSlot, validateSlots, type Slots } from './moves/loadout';
import { Build, ensureBuild, moveTags, MOVE_TAGS, REACTIONS, STATUSES, GEMS, type BuildSave } from './build/build';
import { baseSpec, buildMoveSpec, dmgFactor, areaFactor, compatible, type Modifier, type MoveSpec } from './build/pipeline';
import { emptyBonuses, type PlayerBonuses } from './build/talents';
import { findPath, clampToFloor, hasLineOfSight, type Pt } from './dungeon/pathfind';
import { rollItem, canEquip, type Item, type ItemSlot } from './loot/loot-roller';
import { monster as monsterData, move as moveData, species as speciesData, MONSTERS } from '../data/registry';

export interface InputCommand {
  moveX: number; moveY: number; aimX: number; aimY: number; // aim in world px
  slots: boolean[]; dodge: boolean; // slots: RMB, Q, W, E, R (held)
  /** Key-down edges since the last tick (tap buffering); cast this tick if possible. */
  taps?: boolean[];
  /** One-shot click orders (left click): walk to point via A*, or attack a monster. */
  moveTo?: { x: number; y: number }; attackTarget?: number;
  /** Shift+LMB held: attack in place toward cursor with the primary attack. */
  forceAttack?: boolean;
  /** Consumable slots 1 / 2 (slot 1 = oran-berry heal; slot 2 reserved). */
  items?: boolean[];
}
export interface Progress {
  level: number; xp: number; inventory: Item[]; equipped: Partial<Record<ItemSlot, Item>>;
  bestFloor: number; nextUid: number; seed: number; slots?: Slots; build?: BuildSave;
}
export const newProgress = (seed: number): Progress => ({ level: 5, xp: 0, inventory: [], equipped: {}, bestFloor: 1, nextUid: 1, seed });

export const BASIC = BASIC_MOVE;
export const MAX_FLOOR = 5;
export const POTION_PER_FLOOR = 3; // TUNE
export const POTION_HEAL = 0.35; // TUNE
export const POTION_CD = 4; // TUNE
const T = BALANCE.TILE;

interface EquipStats { power: number; cdr: number; leech: number; kindling: boolean; extraProj: boolean; pierce: boolean; split: boolean; allIn: boolean }

export class Sim {
  readonly bus = new EventBus();
  world = new World();
  rng: Rng;
  floor!: FloorMap;
  floorNo = 1;
  player!: Entity;
  energy: number = BALANCE.energyMax;
  cooldowns = new Map<string, number>();
  dodgeCd = 0;
  /** Consumables: slot 0 = oran berry (heals POTION_HEAL of maxHp), refilled each floor; slot 1 reserved (empty). */
  potions: [number, number] = [POTION_PER_FLOOR, 0];
  potionCd = 0;
  private dashTaps = [false, false, false, false, false];
  totalMonsters = 0;
  killed = 0;
  exitOpen = false;
  bossAlive = false;
  victory = false;
  time = 0;
  private hash = new SpatialHash(64);
  /** Current click order (Diablo-style). */
  order: { kind: 'move'; path: Pt[]; goal: Pt } | { kind: 'attack'; target: number; path: Pt[]; repath: number } | null = null;
  private rootSeq = 1;
  build!: Build;
  bon: PlayerBonuses = emptyBonuses();

  constructor(public progress: Progress) {
    if (!progress.slots || !validateSlots(progress.slots).ok) progress.slots = [...DEFAULT_SLOTS];
    this.rng = new Rng(progress.seed);
    progress.build = ensureBuild(progress.build);
    this.build = new Build(progress.build, () => ({ level: this.progress.level, evoStage1: this.evoStage + 1 }));
    this.bon = this.build.bonuses();
    this.loadFloor(1);
  }

  /** 0 = charmander, 1 = charmeleon, 2 = charizard. */
  get evoStage(): number { const l = this.progress.level; return l >= 36 ? 2 : l >= 16 ? 1 : 0; }
  /** Evolution buff for flamethrower beam: [lengthMult, widthMult]. TUNE */
  static beamBuff(stage: number): [number, number] { return ([[1, 1], [1.3, 1.6], [1.6, 2.2]] as [number, number][])[stage] ?? [1, 1]; }

  /** Beam length clipped at the first wall tile (stepped ray). */
  beamReach(x: number, y: number, a: number, len: number): number {
    const cx = Math.cos(a), cy = Math.sin(a);
    for (let d = 0; d < len; d += 6) if (isWall(this.floor, Math.floor((x + cx * d) / T), Math.floor((y + cy * d) / T))) return d;
    return len;
  }

  /** Debug: add levels (or jump to next evolution level). */
  debugLevelUp(toNextEvo = false): void {
    const pr = this.progress;
    const target = toNextEvo ? (pr.level < 16 ? 16 : pr.level < 36 ? 36 : pr.level + 1) : pr.level + 1;
    while (pr.level < Math.min(50, target)) this.gainXp(xpToNext(pr.level) - pr.xp);
  }

  get speciesId(): string { const l = this.progress.level; return l >= 36 ? 'charizard' : l >= 16 ? 'charmeleon' : 'charmander'; }

  equipStats(): EquipStats {
    const s: EquipStats = { power: 0, cdr: 0, leech: 0, kindling: false, extraProj: false, pierce: false, split: false, allIn: false };
    for (const it of Object.values(this.progress.equipped)) for (const a of it?.affixes ?? []) {
      if (a.id === 'power') s.power += a.value; else if (a.id === 'cdr') s.cdr += a.value; else if (a.id === 'leech') s.leech += a.value;
      else if (a.id === 'kindling') s.kindling = true; else if (a.id === 'extra-projectile') s.extraProj = true;
      else if (a.id === 'pierce') s.pierce = true; else if (a.id === 'split-flame') s.split = true; else if (a.id === 'all-in') s.allIn = true;
    }
    return s;
  }

  /** Species stats + talent % bonuses. */
  playerStats(): ReturnType<typeof calcStats> {
    const st = calcStats(speciesData(this.speciesId), this.progress.level); const b = this.bon;
    return { ...st, atk: Math.round(st.atk * (1 + b.atkPct / 100)), spa: Math.round(st.spa * (1 + b.spAtkPct / 100)), def: Math.round(st.def * (1 + b.defPct / 100)),
      moveSpeed: st.moveSpeed * (1 + b.speedPct / 100) };
  }
  /** Re-derive talent bonuses + player stats after a build change (keeps HP ratio). */
  refreshBuild(): void {
    this.bon = this.build.bonuses(); const p = this.player; if (!p) return;
    const ratio = (p.hp ?? 1) / Math.max(1, p.maxHp ?? 1); const st = this.playerStats();
    p.stats = st; p.maxHp = st.maxHp; p.hp = Math.max(1, Math.round(st.maxHp * ratio));
  }
  /** Debug: talent points + one of each gem + respec materials. */
  debugGrantBuild(): void { const b = this.build.s; b.bonusPoints += 5; b.gems.push(...Object.keys(GEMS)); b.ashShards += 3; b.gold += 2000; }

  loadFloor(n: number): void {
    this.floorNo = n;
    this.world = new World();
    this.floor = generateFloor(new Rng(this.progress.seed * 31 + n * 7919));
    const sp = speciesData(this.speciesId);
    const st = this.playerStats();
    const keepHp = this.player?.hp;
    this.player = this.world.spawn({ kind: 'player', x: (this.floor.start.cx + 0.5) * T, y: (this.floor.start.cy + 0.5) * T, r: 12, team: 'player',
      hp: keepHp && keepHp > 0 ? Math.min(keepHp, st.maxHp) : st.maxHp, maxHp: st.maxHp, stats: st, level: this.progress.level, types: sp.types, speciesId: sp.id, iframes: 0 });
    this.energy = BALANCE.energyMax; this.cooldowns.clear(); this.potions = [POTION_PER_FLOOR, 0]; this.potionCd = 0;
    this.killed = 0; this.exitOpen = false; this.bossAlive = false;
    const ids = Object.values(MONSTERS).filter((m) => !m.boss).map((m) => m.id);
    const lvl = 3 + n * 2;
    for (const room of this.floor.rooms) {
      if (room === this.floor.start) continue;
      const count = this.rng.int(2, 3 + Math.floor(n / 2));
      for (let i = 0; i < count; i++) {
        const tx = room.x + 1 + this.rng.int(0, Math.max(0, room.w - 3)); const ty = room.y + 1 + this.rng.int(0, Math.max(0, room.h - 3));
        this.spawnMonster(this.rng.pick(ids), (tx + 0.5) * T, (ty + 0.5) * T, lvl);
      }
    }
    if (n === MAX_FLOOR) { this.spawnMonster('onix-boss', (this.floor.exit.cx + 0.5) * T, (this.floor.exit.cy + 0.5) * T, lvl + 3, true); this.bossAlive = true; }
    this.totalMonsters = this.world.query('monster').length;
    this.progress.bestFloor = Math.max(this.progress.bestFloor, n);
  }

  spawnMonster(id: string, x: number, y: number, level: number, boss = false): Entity {
    const md = monsterData(id); const sp = speciesData(md.speciesId);
    const st = calcStats(sp, level, md.hpMult * BALANCE.monsterHpScale * BALANCE.tierHp ** (this.floorNo - 1));
    return this.world.spawn({ kind: 'monster', x, y, r: md.radius, team: 'enemy', hp: st.maxHp, maxHp: st.maxHp, stats: st, level, types: sp.types,
      speciesId: sp.id, monsterId: id, ai: { cd: this.rng.range(0.5, 1.5), windup: 0, state: 'idle' }, isBoss: boss });
  }

  // ---------- step ----------
  step(dt: number, cmd: InputCommand): void {
    if (this.victory) return;
    this.time += dt;
    const p = this.player;
    this.hash.clear();
    for (const m of this.world.query('monster')) this.hash.insert(m);
    this.energy = Math.min(BALANCE.energyMax, this.energy + BALANCE.energyRegen * (1 + this.bon.ppRegenPct / 100) * dt);
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.potionCd = Math.max(0, this.potionCd - dt);
    p.iframes = Math.max(0, (p.iframes ?? 0) - dt);
    if (!p.dead) this.playerInput(dt, cmd);
    this.aiStep(dt);
    this.carriersStep(dt);
    this.statusStep(dt);
    this.lootStep();
    this.floorStep();
    this.world.cleanup();
  }

  private playerInput(dt: number, cmd: InputCommand): void {
    const p = this.player;
    p.rot = Math.atan2(cmd.aimY - p.y, cmd.aimX - p.x);
    if (p.dash) {
      // taps during a dash/dodge are held until it ends (max one dash) instead of being dropped
      if (cmd.taps?.some(Boolean)) this.dashTaps = this.dashTaps.map((v, i) => v || !!cmd.taps?.[i]);
      const d = p.dash; d.t -= dt;
      this.moveEntity(p, d.dirX * d.speed * dt, d.dirY * d.speed * dt);
      if (d.moveId) this.dashHits(p);
      if (d.t <= 0) p.dash = undefined;
      return;
    }
    if (cmd.dodge && this.dodgeCd <= 0) {
      const len = Math.hypot(cmd.moveX, cmd.moveY) || 1;
      const dx = cmd.moveX || Math.cos(p.rot); const dy = cmd.moveY || Math.sin(p.rot);
      p.dash = { t: 0.2, dirX: dx / (cmd.moveX || cmd.moveY ? len : 1), dirY: dy / (cmd.moveX || cmd.moveY ? len : 1), speed: 650, hit: false };
      p.iframes = Math.max(p.iframes ?? 0, 0.3); this.dodgeCd = 0.9 * Math.max(0.2, 1 + this.bon.dodgeCdPct / 100);
      return;
    }
    if (cmd.moveTo) this.orderMove(cmd.moveTo.x, cmd.moveTo.y);
    if (cmd.attackTarget !== undefined) this.order = { kind: 'attack', target: cmd.attackTarget, path: [], repath: 0 };
    const len = Math.hypot(cmd.moveX, cmd.moveY);
    if (len > 0) { this.order = null; const sp = (p.stats?.moveSpeed ?? 160) * dt; this.moveEntity(p, (cmd.moveX / len) * sp, (cmd.moveY / len) * sp); }
    else if (cmd.forceAttack) { this.order = null; const a = this.primaryAttack(); if (a) this.tryCast(a, cmd.aimX, cmd.aimY); }
    else this.followOrder(dt);
    const dashTaps = this.dashTaps; this.dashTaps = [false, false, false, false, false];
    this.slots.forEach((id, i) => { if (id && (cmd.slots[i] || cmd.taps?.[i] || dashTaps[i])) this.tryCast(id, cmd.aimX, cmd.aimY); });
    if (cmd.items?.[0]) this.usePotion(0);
  }

  usePotion(slot: number): boolean {
    const p = this.player; const n = this.potions[slot] ?? 0;
    if (slot !== 0 || n <= 0 || this.potionCd > 0 || p.dead || !p.maxHp || (p.hp ?? 0) >= p.maxHp) return false;
    this.potions[0] = n - 1; this.potionCd = POTION_CD;
    p.hp = Math.min(p.maxHp, (p.hp ?? 0) + p.maxHp * POTION_HEAL);
    return true;
  }

  /** Levels until next evolution (null at final stage). */
  levelsToEvolve(): number | null { const l = this.progress.level; return l < 16 ? 16 - l : l < 36 ? 36 - l : null; }

  /** Primary click attack: basic if slotted, else first slotted damaging move. */
  primaryAttack(): string | null {
    if (this.slots.includes(BASIC)) return BASIC;
    return this.slots.find((id): id is string => !!id && moveData(id).power > 0) ?? null;
  }
  attackRange(id: string): number {
    const pr = moveData(id).params;
    return pr.range ? pr.range * 0.8 : pr.length ?? pr.maxRange ?? pr.distance ?? 200;
  }
  orderMove(x: number, y: number): boolean {
    const p = this.player; const goal = clampToFloor(this.floor, x, y, T);
    const path = findPath(this.floor, Math.floor(p.x / T), Math.floor(p.y / T), Math.floor(goal.x / T), Math.floor(goal.y / T));
    if (!path) { this.order = null; return false; }
    const pts = path.map((t) => ({ x: (t.x + 0.5) * T, y: (t.y + 0.5) * T }));
    if (pts.length) pts[pts.length - 1] = goal;
    this.order = { kind: 'move', path: pts, goal };
    return true;
  }
  private stepAlong(path: Pt[], dt: number): void {
    const p = this.player; let budget = (p.stats?.moveSpeed ?? 160) * dt;
    while (budget > 0 && path.length) {
      const wp = path[0] as Pt; const dx = wp.x - p.x, dy = wp.y - p.y; const d = Math.hypot(dx, dy);
      if (d <= budget) { this.moveEntity(p, dx, dy); budget -= d; path.shift(); }
      else { this.moveEntity(p, (dx / d) * budget, (dy / d) * budget); p.rot = Math.atan2(dy, dx); budget = 0; }
    }
  }
  private followOrder(dt: number): void {
    const o = this.order; const p = this.player; if (!o) return;
    if (o.kind === 'move') { this.stepAlong(o.path, dt); if (!o.path.length) this.order = null; return; }
    const tgt = this.world.get(o.target); const atk = this.primaryAttack();
    if (!tgt || tgt.dead || !atk) { this.order = null; return; }
    const d = Math.hypot(tgt.x - p.x, tgt.y - p.y);
    if (d <= this.attackRange(atk) && hasLineOfSight(this.floor, p.x, p.y, tgt.x, tgt.y, T)) {
      p.rot = Math.atan2(tgt.y - p.y, tgt.x - p.x); this.tryCast(atk, tgt.x, tgt.y); return;
    }
    o.repath -= dt;
    if (o.repath <= 0 || !o.path.length) {
      o.repath = 0.4;
      const path = findPath(this.floor, Math.floor(p.x / T), Math.floor(p.y / T), Math.floor(tgt.x / T), Math.floor(tgt.y / T));
      o.path = (path ?? []).map((t) => ({ x: (t.x + 0.5) * T, y: (t.y + 0.5) * T }));
    }
    this.stepAlong(o.path, dt);
  }

  get slots(): Slots { return this.progress.slots ?? DEFAULT_SLOTS; }
  /** Rebind a hotbar slot (swaps if the move is already slotted). Returns false if rejected. */
  setSlot(slot: number, moveId: string | null): boolean {
    const before = this.slots; const after = assignSlot(before, slot, moveId);
    this.progress.slots = after; return after !== before;
  }

  cooldownLeft(id: string): number { return this.cooldowns.get(id) ?? 0; }

  tryCast(id: string, ax: number, ay: number): boolean {
    const m = moveData(id); const p = this.player; const eq = this.equipStats();
    if (this.cooldownLeft(id) > 0) return false;
    const lowHp = (p.hp ?? 0) < (p.maxHp ?? 1) * 0.25;
    const cost = eq.allIn && lowHp ? 0 : energyCost(m);
    if (this.energy < cost) return false;
    this.energy -= cost;
    this.cooldowns.set(id, moveCooldown(m, eq.cdr));
    const spec = this.moveSpec(id, eq);
    const mods: MoveMods = { powerBonus: eq.power, leech: eq.leech + spec.leech, kindling: eq.kindling, spec };
    const ang = Math.atan2(ay - p.y, ax - p.x);
    const pr = spec.params;
    this.bus.emit('move:cast', { caster: p.id, moveId: id });
    const area = areaFactor(spec);
    switch (m.shape) {
      case 'projectile': {
        const n = Math.max(1, Math.round(spec.projectiles));
        for (let i = 0; i < n; i++) {
          const a = ang + (n > 1 ? (i - (n - 1) / 2) * ((spec.spreadDeg * Math.PI) / 180) : 0);
          this.spawnProjectile(id, p.x, p.y, a, mods, new Set(), spec.pierce, spec.chain, spec.fork);
        }
        break;
      }
      case 'beam': {
        const nb = Math.max(1, Math.round(spec.beams)); const step = (spec.beamSpreadDeg * Math.PI) / 180;
        const angles = Array.from({ length: nb }, (_, i) => ang + (i - (nb - 1) / 2) * step);
        const [evoLen, evoWidth] = Sim.beamBuff(this.evoStage);
        for (const a of angles) this.world.spawn({ kind: 'beam', x: p.x, y: p.y, rot: a - ang, r: 0, team: 'player', owner: p.id, moveId: id,
          life: pr.duration ?? 0.8, tick: pr.tick ?? 0.1, tickT: 0, len: (pr.length ?? 300) * evoLen, width: (pr.width ?? 22) * evoWidth * area,
          mods, delay: 1 });
        break;
      }
      case 'zone': case 'aoe-target': {
        const maxR = pr.maxRange ?? 260; const d = Math.min(maxR, Math.hypot(ax - p.x, ay - p.y));
        const { x, y } = clampToFloor(this.floor, p.x + Math.cos(ang) * d, p.y + Math.sin(ang) * d, T);
        if (m.shape === 'zone') this.world.spawn({ kind: 'zone', x, y, r: (pr.r ?? 80) * area, team: 'player', owner: p.id, moveId: id, life: pr.duration ?? 4, tick: pr.tick ?? 0.5, tickT: 0, mods });
        else this.world.spawn({ kind: 'blast', x, y, r: (pr.r ?? 100) * area, team: 'player', owner: p.id, moveId: id, life: pr.delay ?? 0.4, delay: pr.delay ?? 0.4, mods });
        break;
      }
      case 'dash': {
        const spd = pr.speed ?? 1000;
        p.dash = { t: (pr.distance ?? 200) / spd, dirX: Math.cos(ang), dirY: Math.sin(ang), speed: spd, hit: false, moveId: id };
        p.iframes = Math.max(p.iframes ?? 0, p.dash.t); p.hitSet = new Set(); p.mods = mods;
        break;
      }
      default: break;
    }
    return true;
  }

  /** Equipment affixes expressed as pipeline modifiers (so they compose with gems/talents in the fixed stage order). */
  private equipModifiers(eq: EquipStats): Modifier[] {
    const out: Modifier[] = [];
    if (eq.extraProj) out.push({ source: 'affix:extra-projectile', stage: 'shape', moveId: BASIC, apply: (s) => { s.projectiles += 1; } });
    if (eq.split) out.push({ source: 'affix:split-flame', stage: 'shape', moveId: 'flamethrower', apply: (s) => { s.beams = 3; s.moreDmg *= 0.5; s.params.length = (s.params.length ?? 300) * 0.6; } });
    if (eq.pierce) out.push({ source: 'affix:pierce', stage: 'prehit', moveId: BASIC, apply: (s) => { s.pierce += 2; } });
    return out;
  }
  /** Build the cast spec through the modifier pipeline (variant -> shape -> prehit -> onhit -> reaction -> numeric). */
  moveSpec(id: string, eq = this.equipStats()): MoveSpec {
    const m = moveData(id); const td = MOVE_TAGS[id];
    const base = baseSpec(id, moveTags(id, m.shape, m.type), m.params, m.status?.id === 'burn' ? m.status.chance / 100 : 0, td?.applies ?? []);
    if (m.category === 'physical' && this.bon.meleeLifestealPct > 0) base.leech += this.bon.meleeLifestealPct / 100;
    return buildMoveSpec(base, this.build.modifiersFor(id, this.equipModifiers(eq), this.bon)).spec;
  }
  private spawnProjectile(id: string, x: number, y: number, a: number, mods: MoveMods, hitSet: Set<number>, pierce: number, chain: number, fork: number): void {
    const pr = mods.spec?.params ?? moveData(id).params; const spd = pr.speed ?? 500;
    this.world.spawn({ kind: 'projectile', x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, rot: a, r: pr.radius ?? 8, team: 'player', owner: this.player.id,
      moveId: id, life: (pr.range ?? 400) / spd, hitSet, pierce, chain, fork, mods });
  }

  private dashHits(p: Entity): void {
    const id = p.dash?.moveId; if (!id) return;
    const w = (moveData(id).params.width ?? 40) / 2;
    for (const m of this.hash.near(p.x, p.y, w + 40)) {
      if (m.dead || p.hitSet?.has(m.id) || Math.hypot(m.x - p.x, m.y - p.y) > w + m.r) continue;
      p.hitSet?.add(m.id);
      const dealt = this.hit(p, m, id, 1, p.mods, newChain(this.rootSeq++));
      const recoil = moveData(id).params.recoil ?? 0;
      if (recoil > 0 && p.hp !== undefined) p.hp = Math.max(1, p.hp - Math.round(dealt * recoil));
    }
  }

  // ---------- damage ----------
  hit(src: Entity, target: Entity, moveId: string, mult: number, mods: MoveMods | undefined, chain: ChainContext): number {
    if (target.dead || target.hp === undefined) return 0;
    if (target.kind === 'player' && (target.iframes ?? 0) > 0) return 0;
    if (target.kind === 'player' && this.bon.evasionPct > 0 && this.rng.next() < this.bon.evasionPct / 100) return 0; // talent evasion
    const spec = src.team === 'player' ? mods?.spec : undefined;
    if (spec) mult *= dmgFactor(spec);
    const m = moveData(moveId);
    const a = src.stats; const d = target.stats;
    if (!a || !d) return 0;
    const phys = m.category === 'physical';
    const isCrit = this.rng.next() < BALANCE.critChance + (src.team === 'player' ? this.bon.critPct / 100 : 0);
    const tierDmg = src.team === 'enemy' ? BALANCE.tierDmg ** (this.floorNo - 1) : 1;
    const { dmg, typeEff } = calcDamage({ level: src.level ?? 1, power: m.power, atk: phys ? a.atk : a.spa, def: phys ? d.def : d.spd, moveType: m.type,
      attackerTypes: src.types ?? [], defenderTypes: target.types ?? [], isCrit, roll: this.rng.next(), bonus: mods?.powerBonus ?? 0, mult: mult * tierDmg,
      burnedPhysical: phys && !!src.burn });
    target.hp -= dmg;
    if (target.kind === 'player') target.iframes = BALANCE.playerIFrames;
    this.bus.emit('damage:dealt', { target: target.id, amount: dmg, isCrit, typeEff, x: target.x, y: target.y - target.r });
    if (mods && mods.leech > 0 && src.hp !== undefined && src.maxHp) src.hp = Math.min(src.maxHp, src.hp + dmg * mods.leech);
    // status
    const st = m.status;
    let burnChance = spec ? spec.burnChance : st?.id === 'burn' ? st.chance / 100 : 0;
    if (spec && !target.dead) {
      // stage 4: statuses applied on hit
      for (const ap of spec.applies) if (this.rng.next() < ap.chance) this.applyStatus(target, ap.status, ap.duration, src.id);
      // stage 5: reactions (data rules: trigger tags + required status -> effect)
      if (!mods?.noReact) this.reactions(src, target, spec, mods, chain);
    }
    if (mods?.kindling && m.type === 'fire' && canTrigger(chain, 'kindling', target.id)) burnChance += 0.15;
    if (burnChance > 0 && this.rng.next() < burnChance) this.applyBurn(target, src.id);
    if (moveId === 'fire-spin') target.bound = { t: 1, src: src.id };
    if (target.hp <= 0) this.kill(target, src.id, 'hit', chain);
    return dmg;
  }

  applyStatus(t: Entity, id: string, duration: number, src: number): void {
    const def = STATUSES[id]; const cur = t.statuses?.[id];
    (t.statuses ??= {})[id] = { t: Math.max(cur?.t ?? 0, duration || def?.duration || 3), stacks: Math.min(def?.maxStacks ?? 1, (cur?.stacks ?? 0) + 1), src };
  }
  private reactions(src: Entity, target: Entity, spec: MoveSpec, mods: MoveMods | undefined, chain: ChainContext): void {
    for (const rule of REACTIONS) {
      if (spec.reactionsOff.has(rule.id) || !target.statuses?.[rule.requires] || !compatible(rule.trigger, spec.tags, spec.moveId)) continue;
      if (!canTrigger(chain, `reaction:${rule.id}`, target.id)) continue;
      if (rule.consume) delete target.statuses[rule.requires];
      this.bus.emit('reaction', { id: rule.id, x: target.x, y: target.y, r: rule.effect.r });
      if (rule.effect.type === 'burst') {
        const burstMods: MoveMods = { ...(mods ?? { powerBonus: 0, leech: 0, kindling: false }), noReact: true };
        for (const t of this.hash.near(target.x, target.y, rule.effect.r + 30)) if (!t.dead && Math.hypot(t.x - target.x, t.y - target.y) < rule.effect.r + t.r) this.hit(src, t, spec.moveId, rule.effect.mult, burstMods, childChain(chain));
      }
    }
  }

  applyBurn(t: Entity, src: number): void {
    if (t.types?.includes('fire')) return;
    t.burn = { stacks: Math.min(BALANCE.burnMaxStacks, (t.burn?.stacks ?? 0) + 1), t: 4, src };
  }

  kill(t: Entity, killer: number, cause: 'hit' | 'burn' | 'bound', chain: ChainContext): void {
    if (t.dead) return;
    if (t.kind === 'player') { t.hp = 0; t.dead = true; return; }
    t.dead = true;
    this.bus.emit('entity:killed', { victim: t.id, killer, cause, chain: childChain(chain) });
    if (t.kind !== 'monster') return;
    this.killed++;
    if (t.isBoss) this.bossAlive = false;
    const md = monsterData(t.monsterId ?? '');
    const sp = speciesData(md.speciesId);
    this.gainXp(Math.round(((sp.baseExp * (t.level ?? 1)) / 7) * md.xpMult));
    // build currencies: gold always, ash shard / support gem sometimes (TUNE)
    const b = this.build.s; b.gold += Math.round((t.level ?? 1) * (t.isBoss ? 20 : 2));
    if (this.rng.next() < (t.isBoss ? 1 : 0.06)) { b.ashShards++; this.bus.emit('build:gain', { what: 'ash_shard' }); }
    if (this.rng.next() < (t.isBoss ? 1 : 0.04)) { const ids = Object.keys(GEMS); const g = ids[this.rng.int(0, ids.length - 1)]; if (g) { b.gems.push(g); this.bus.emit('build:gain', { what: g }); } }
    if (this.bon.burnSpread > 0 && t.burn) for (const o of this.hash.near(t.x, t.y, 90)) if (!o.dead && o !== t) this.applyBurn(o, killer);
    const drops = t.isBoss ? 3 : this.rng.next() < BALANCE.dropChance ? 1 : 0;
    for (let i = 0; i < drops; i++) {
      const item = rollItem(this.rng, this.progress.nextUid++, Math.ceil(this.floorNo / 2) + (t.isBoss ? 1 : 0));
      const e = this.world.spawn({ kind: 'item', x: t.x + this.rng.range(-16, 16), y: t.y + this.rng.range(-16, 16), r: 10, item });
      this.bus.emit('loot:dropped', { itemId: e.id, x: e.x, y: e.y });
    }
  }

  gainXp(n: number): void {
    const pr = this.progress; pr.xp += n;
    while (pr.level < 50 && pr.xp >= xpToNext(pr.level)) {
      const before = this.evoStage;
      pr.xp -= xpToNext(pr.level); pr.level++;
      const sp = speciesData(this.speciesId); const st = this.playerStats();
      const p = this.player; p.stats = st; p.level = pr.level; p.maxHp = st.maxHp; p.hp = st.maxHp; p.types = sp.types; p.speciesId = sp.id;
      this.bus.emit('player:levelup', { level: pr.level });
      if (this.evoStage > before) this.bus.emit('player:evolve', { speciesId: sp.id, stage: this.evoStage });
    }
  }

  // ---------- carriers ----------
  private carriersStep(dt: number): void {
    const p = this.player;
    for (const e of this.world.entities.values()) {
      if (e.dead || e.life === undefined) continue;
      e.life -= dt;
      if (e.kind === 'projectile') {
        this.moveEntity(e, e.vx * dt, e.vy * dt, true);
        if (e.team === 'player') {
          for (const m of this.hash.near(e.x, e.y, e.r + 32)) {
            if (m.dead || e.hitSet?.has(m.id) || Math.hypot(m.x - e.x, m.y - e.y) > m.r + e.r) continue;
            e.hitSet?.add(m.id);
            const owner = this.world.get(e.owner ?? -1); if (owner) this.hit(owner, m, e.moveId ?? BASIC, 1, e.mods, newChain(this.rootSeq++));
            if (this.projectileOnHit(e, m)) break;
          }
        } else if (!p.dead && Math.hypot(p.x - e.x, p.y - e.y) < p.r + e.r) {
          const owner = this.world.get(e.owner ?? -1); if (owner) this.hit(owner, p, e.moveId ?? 'water-gun', 1, undefined, newChain(this.rootSeq++));
          e.dead = true;
        }
      } else if (e.kind === 'beam') {
        e.x = p.x; e.y = p.y;
        e.tickT = (e.tickT ?? 0) - dt;
        if (e.tickT <= 0) {
          e.tickT += e.tick ?? 0.1;
          const m = moveData(e.moveId ?? 'flamethrower');
          const perTick = ((e.tick ?? 0.1) / (m.params.duration ?? 0.8)) * BALANCE.sustainedComp * (e.delay ?? 1);
          const a = p.rot + e.rot; const cx = Math.cos(a), cy = Math.sin(a); const len = this.beamReach(p.x, p.y, a, e.len ?? 300); e.reach = len;
          for (const t of this.hash.near(p.x + cx * len / 2, p.y + cy * len / 2, len / 2 + 40)) {
            const rx = t.x - p.x, ry = t.y - p.y; const along = rx * cx + ry * cy; const perp = Math.abs(-rx * cy + ry * cx);
            const sp = e.mods?.spec; const dur = sp?.params.duration ?? 0.8; const w = (e.width ?? 22) * (1 + (sp?.widenOverLife ?? 0) * Math.max(0, 1 - (e.life ?? 0) / dur));
            if (!t.dead && along > 0 && along < len && perp < w / 2 + t.r) this.hit(p, t, m.id, perTick, e.mods, newChain(this.rootSeq++));
          }
        }
        const ex = e.mods?.spec?.endExplosion;
        if (ex && e.life <= 0) { const a = p.rot + e.rot; const L = e.reach ?? e.len ?? 300;
          this.world.spawn({ kind: 'blast', x: p.x + Math.cos(a) * L, y: p.y + Math.sin(a) * L, r: ex.r * areaFactor(e.mods?.spec ?? baseSpec('', [], {}, 0)), team: 'player', owner: p.id, moveId: e.moveId, life: 0.05, delay: 0.05, dmgMult: ex.mult, mods: e.mods }); }
      } else if (e.kind === 'zone') {
        e.tickT = (e.tickT ?? 0) - dt;
        if (e.tickT <= 0) {
          e.tickT += e.tick ?? 0.5;
          const m = moveData(e.moveId ?? 'fire-spin');
          const perTick = ((e.tick ?? 0.5) / (m.params.duration ?? 4)) * BALANCE.sustainedComp * 3; // TUNE: zone is the main DoT tool
          for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) this.hit(p, t, m.id, perTick, e.mods, newChain(this.rootSeq++));
        }
      } else if (e.kind === 'blast') {
        if (e.life <= 0) for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) this.hit(p, t, e.moveId ?? 'fire-blast', e.dmgMult ?? 1, e.mods, newChain(this.rootSeq++));
      }
      if (e.life <= 0) e.dead = true;
    }
  }

  /** Projectile hit resolution, fixed order: pierce (prehit) -> fork -> chain (onhit) -> expire. Returns true if this projectile is done. */
  projectileOnHit(e: Entity, m: Entity): boolean {
    if ((e.pierce ?? 0) > 0) { e.pierce = (e.pierce ?? 0) - 1; return false; }
    const mods = e.mods ?? { powerBonus: 0, leech: 0, kindling: false }; const a = Math.atan2(e.vy, e.vx); const id = e.moveId ?? BASIC;
    if ((e.fork ?? 0) > 0) {
      for (const d of [-0.5, 0.5]) this.spawnProjectile(id, m.x, m.y, a + d, mods, new Set(e.hitSet), 0, e.chain ?? 0, (e.fork ?? 0) - 1);
      e.dead = true; return true;
    }
    if ((e.chain ?? 0) > 0) {
      const range = mods.spec?.chainRange ?? 180; let best: Entity | null = null; let bd = range;
      for (const o of this.hash.near(m.x, m.y, range)) { if (o.dead || o === m || e.hitSet?.has(o.id)) continue; const d = Math.hypot(o.x - m.x, o.y - m.y); if (d < bd) { bd = d; best = o; } }
      if (best) { this.spawnProjectile(id, m.x, m.y, Math.atan2(best.y - m.y, best.x - m.x), mods, new Set(e.hitSet), 0, (e.chain ?? 0) - 1, 0); }
    }
    e.dead = true; return true;
  }

  private statusStep(dt: number): void {
    for (const e of [...this.world.query('monster'), this.player]) {
      if (e.dead || e.hp === undefined || !e.maxHp) continue;
      if (e.burn) {
        const bmul = e.kind === 'monster' ? 1 + this.bon.burnDmgPct / 100 : 1;
        e.hp -= e.maxHp * (e.isBoss ? BALANCE.burnPctBoss : BALANCE.burnPctPerSec) * e.burn.stacks * dt * bmul;
        e.burn.t -= dt;
        const src = e.burn.src;
        if (e.burn.t <= 0) e.burn = undefined;
        if (e.hp <= 0) this.kill(e, src, 'burn', newChain(this.rootSeq++));
      }
      if (e.statuses) for (const [k, v] of Object.entries(e.statuses)) { v.t -= dt; if (v.t <= 0) delete e.statuses[k]; }
      if (e.bound) { e.bound.t -= dt; if (e.bound.t <= 0) e.bound = undefined; }
    }
  }

  // ---------- AI ----------
  private aiStep(dt: number): void {
    const p = this.player;
    for (const m of this.world.query('monster')) {
      const ai = m.ai; const md = monsterData(m.monsterId ?? ''); if (!ai) continue;
      const dx = p.x - m.x, dy = p.y - m.y; const dist = Math.hypot(dx, dy) || 1;
      ai.cd = Math.max(0, ai.cd - dt);
      if (ai.state === 'idle') { if (dist < BALANCE.monsterAggro || (m.hp ?? 0) < (m.maxHp ?? 0)) ai.state = 'chase'; else continue; }
      if (p.dead) continue;
      m.rot = Math.atan2(dy, dx);
      const mv = moveData(md.move);
      let speed = (m.stats?.moveSpeed ?? 150) * 0.75 * (m.bound ? 0.5 : 1);
      if (ai.state === 'attack') {
        ai.windup -= dt;
        if (ai.windup <= 0) {
          ai.state = 'chase'; ai.cd = moveCooldown(mv);
          if (mv.shape === 'projectile') {
            const spd = mv.params.speed ?? 300;
            this.world.spawn({ kind: 'projectile', x: m.x, y: m.y, vx: (dx / dist) * spd, vy: (dy / dist) * spd, r: mv.params.radius ?? 7, team: 'enemy', owner: m.id, moveId: mv.id, life: (mv.params.range ?? 300) / spd });
          } else if (dist < (mv.params.range ?? 40) + p.r + m.r) this.hit(m, p, mv.id, 1, undefined, newChain(this.rootSeq++));
        }
        continue;
      }
      const ranged = md.ai === 'ranged-kiter';
      const reach = ranged ? 260 : (mv.params.range ?? 40) + m.r;
      if (ai.cd <= 0 && dist < reach) { ai.state = 'attack'; ai.windup = ranged ? 0.3 : 0.35; continue; }
      if (ranged && dist < 160) speed = -speed * 0.8;
      else if (ranged && dist < 240) speed = 0;
      this.moveEntity(m, (dx / dist) * speed * dt, (dy / dist) * speed * dt);
    }
    // simple separation
    const ms = this.world.query('monster');
    for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
      const a = ms[i], b = ms[j]; if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y; const d = Math.hypot(dx, dy); const min = a.r + b.r;
      if (d > 0 && d < min && d < 64) { const push = (min - d) / 2; this.moveEntity(a, (-dx / d) * push, (-dy / d) * push); this.moveEntity(b, (dx / d) * push, (dy / d) * push); }
    }
  }

  private lootStep(): void {
    const p = this.player;
    for (const it of this.world.query('item')) {
      if (!it.item || Math.hypot(it.x - p.x, it.y - p.y) > BALANCE.pickupRadius + p.r) continue;
      if (this.progress.inventory.length >= 60) continue;
      this.progress.inventory.push(it.item); it.dead = true;
      this.bus.emit('loot:picked', { itemId: it.item.uid });
    }
  }

  private floorStep(): void {
    const need = Math.ceil(this.totalMonsters * 0.6);
    if (!this.exitOpen && this.killed >= need && !this.bossAlive) { this.exitOpen = true; this.bus.emit('floor:cleared', { floor: this.floorNo }); }
    const p = this.player; const ex = this.floor.exit;
    if (this.exitOpen && Math.hypot(p.x - (ex.cx + 0.5) * T, p.y - (ex.cy + 0.5) * T) < T) {
      if (this.floorNo >= MAX_FLOOR) this.victory = true; else this.loadFloor(this.floorNo + 1);
    }
  }

  /** Restart current floor after death (unpicked loot lost; level/items kept). */
  respawn(): void { const p = this.player; p.hp = p.maxHp; p.dead = false; this.loadFloor(this.floorNo); }

  equip(uid: number): { ok: boolean; reason?: string } {
    const pr = this.progress; const idx = pr.inventory.findIndex((i) => i.uid === uid); const item = pr.inventory[idx];
    if (!item) return { ok: false };
    const res = canEquip(item, Object.values(pr.equipped).filter((x): x is Item => !!x));
    if (!res.ok) return { ok: false, reason: res.reason };
    const prev = pr.equipped[item.slot];
    pr.inventory.splice(idx, 1); if (prev) pr.inventory.push(prev);
    pr.equipped[item.slot] = item;
    return { ok: true };
  }

  moveEntity(e: Entity, dx: number, dy: number, killOnWall = false): void {
    const blocked = (x: number, y: number): boolean => {
      const r = e.kind === 'projectile' ? 2 : e.r * 0.8;
      return isWall(this.floor, Math.floor((x - r) / T), Math.floor((y - r) / T)) || isWall(this.floor, Math.floor((x + r) / T), Math.floor((y - r) / T)) ||
        isWall(this.floor, Math.floor((x - r) / T), Math.floor((y + r) / T)) || isWall(this.floor, Math.floor((x + r) / T), Math.floor((y + r) / T));
    };
    if (!blocked(e.x + dx, e.y)) e.x += dx; else if (killOnWall) e.dead = true;
    if (!blocked(e.x, e.y + dy)) e.y += dy; else if (killOnWall) e.dead = true;
  }
}
export { xpToNext };
