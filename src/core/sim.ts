import { BALANCE } from './balance';
import { Rng } from './rng';
import { EventBus, childChain, canTrigger, newChain, type ChainContext } from './events/event-bus';
import { World, SpatialHash, type Entity, type MoveMods } from './ecs/world';
import { generateFloor, isWall, type FloorMap } from './dungeon/bsp-gen';
import { calcStats, xpToNext } from './stats/stat-calc';
import { calcDamage } from './combat/damage';
import { moveCooldown, energyCost } from './moves/cooldown';
import { BASIC_MOVE, DEFAULT_SLOTS, assignSlot, validateSlots, type Slots } from './moves/loadout';
import { TALENTS, engineMoveId, Build, ensureBuild, moveTags, MOVE_TAGS, STATUSES, GEMS, reactionsFor, triggerMatches, REACTION_RULES, type BuildSave, type ReactionRule } from './build/build';
import { baseSpec, buildMoveSpec, dmgFactor, areaFactor, type Modifier, type MoveSpec } from './build/pipeline';
import { BOARD, JEWEL_RULES, type JewelItem } from './build/board';
import { typeMult } from './combat/type-chart';
import { emptyBonuses, mechanics, moveSpeedPct, cdrPct, damageReductionPct, burnBonusPct, projSpeedPct, trailDmgPct, dodgeCdrPct, type PlayerBonuses } from './build/talents';
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
/** Floor a Continue resumes on: deepest floor reached as of the save (its entrance), clamped; old/corrupt saves fall back to 1. */
export const resumeFloor = (p: Pick<Progress, 'bestFloor'>): number => { const f = Math.floor(Number(p.bestFloor)); return Number.isFinite(f) ? Math.min(MAX_FLOOR, Math.max(1, f)) : 1; };
export const POTION_PER_FLOOR = 3; // TUNE
export const POTION_HEAL = 0.35; // TUNE
export const POTION_CD = 4; // TUNE
const T = BALANCE.TILE;

interface EquipStats { power: number; cdr: number; leech: number; kindling: boolean; extraProj: boolean; pierce: boolean; split: boolean; allIn: boolean }

interface PreHit { burn?: { stacks: number; t: number; src: number }; statuses: Set<string> }

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
  /** 'Sunny day' weather timer (director reactions sun_chain / ground_sun). No in-game source yet: debug Shift+K. */
  sunT = 0;
  private trailAcc = 0;
  private moveTrail = 0;
  private dashHitCount = new Map<number, { n: number; t: number }>();
  /** fire trail: same enemy takes trail damage at most once per trailPerEnemyIcdSec across ALL patches */
  private trailHitT = new Map<number, number>();
  trailCanHit(id: number): boolean { const t = this.trailHitT.get(id); if (t !== undefined && this.time - t < this.mech.trailPerEnemyIcdSec) return false; this.trailHitT.set(id, this.time); return true; }
  readonly mech = mechanics(TALENTS, BOARD.meta.mechanics as never);
  private combo = 0; private comboT = -9;
  /** reaction once-per-object-per-frame guard (cleared every step) */
  private reactedThisFrame = new Set<string>();
  bon: PlayerBonuses = emptyBonuses();

  constructor(public progress: Progress) {
    if (!progress.slots || !validateSlots(progress.slots).ok) progress.slots = [...DEFAULT_SLOTS];
    this.rng = new Rng(progress.seed);
    progress.build = ensureBuild(progress.build);
    this.build = new Build(progress.build, () => ({ level: this.progress.level, evoStage1: this.evoStage + 1 }));
    this.bon = this.build.bonuses();
    this.progress.bestFloor = resumeFloor(progress);
    this.loadFloor(this.progress.bestFloor);
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
      maxHp: Math.round(st.maxHp * (1 + b.maxHpPct / 100)), moveSpeed: st.moveSpeed * (1 + moveSpeedPct(b, this.mech).value / 100) };
  }
  /** Current move speed: base × (1 + capped(static talents + post-dodge buff)). Caps applied after summing. */
  moveSpeed(): number {
    const base = calcStats(speciesData(this.speciesId), this.progress.level).moveSpeed;
    const buff = this.bon.onDodgeSpeed && this.time < this.dodgeBuffUntil ? this.bon.onDodgeSpeed.pct : 0;
    return base * (1 + moveSpeedPct(this.bon, this.mech, buff).value / 100);
  }
  /** Cooldown multiplier for a move from talents (global CDR + per-move %, summed then capped). */
  talentCdMult(id: string): number {
    const per = Object.entries(this.bon.moveCdPct).find(([k]) => engineMoveId(k) === id)?.[0];
    return 1 - cdrPct(this.bon, this.mech, per).value / 100;
  }
  /** 戰鬥節奏: on-kill CD refund, max N triggers/frame and max X s refunded per rolling second (meta.mechanics). */
  onKillRefund(): number {
    const v = this.bon.onKillCdRefundSec; if (v <= 0) return 0;
    if (this.killRefundFrame === this.frameNo && this.killRefundsThisFrame >= this.mech.onKillCdRefundMaxPerFrame) return 0;
    if (this.killRefundFrame !== this.frameNo) { this.killRefundFrame = this.frameNo; this.killRefundsThisFrame = 0; }
    this.killRefundLog = this.killRefundLog.filter(([t]) => this.time - t < 1);
    const used = this.killRefundLog.reduce((s, [, a]) => s + a, 0);
    const amt = Math.min(v, this.mech.onKillCdRefundMaxSecPerSec - used); if (amt <= 1e-9) return 0;
    this.killRefundsThisFrame++; this.killRefundLog.push([this.time, amt]);
    for (const [k, cd] of this.cooldowns) this.cooldowns.set(k, Math.max(0, cd - amt));
    return amt;
  }
  lastPlayerDmg = 0;
  /** out-of-combat clock: last time the player dealt or took damage */
  lastCombatT = -1e9;
  private dodgeBuffUntil = -1; frameNo = 0; private killRefundFrame = -1; private killRefundsThisFrame = 0; private killRefundLog: Array<[number, number]> = [];
  /** Re-derive talent bonuses + player stats after a build change (keeps HP ratio). */
  refreshBuild(): void {
    this.bon = this.build.bonuses(); const p = this.player; if (!p) return;
    const ratio = (p.hp ?? 1) / Math.max(1, p.maxHp ?? 1); const st = this.playerStats();
    p.stats = st; p.maxHp = st.maxHp; p.hp = Math.max(1, Math.round(st.maxHp * ratio));
  }
  private jewelSeq = 0;
  /** Roll a jewel: legendary share from jewel-rules.json, normal jewels get 2-3 affixes. */
  rollJewel(kind?: string): JewelItem {
    const legendary = kind && kind !== 'normal' ? kind : undefined;
    const uid = `j${Math.floor(this.time * 1000)}_${this.jewelSeq++}`;
    const legs = Object.keys(JEWEL_RULES.legendary);
    if (legendary || (kind !== 'normal' && this.rng.next() < JEWEL_RULES.drops.legendaryShare)) return { uid, base: legendary ?? legs[this.rng.int(0, legs.length - 1)]! };
    const pool = [...JEWEL_RULES.normal.affixPool]; const n = this.rng.int(2, 3); const affixes: { effectType: string; value: number }[] = [];
    for (let i = 0; i < n && pool.length; i++) { const a = pool.splice(this.rng.int(0, pool.length - 1), 1)[0]!; affixes.push({ effectType: a.effectType, value: this.rng.int(Math.min(a.min, a.max), Math.max(a.min, a.max)) }); }
    return { uid, base: 'normal', affixes };
  }
  jewelCap(): number { return JEWEL_RULES.inventoryCap; }
  jewelsFull(): boolean { return this.build.s.board.jewels.length >= this.jewelCap(); }
  private jewelFullSaidAt = -99;
  /** Add a jewel to the inventory, or leave it on the ground at (x, y) when the inventory is full (cap from jewel-rules.json). */
  giveJewel(j: JewelItem, x = this.player.x, y = this.player.y): boolean {
    if (!this.jewelsFull()) { this.build.s.board.jewels.push(j); this.bus.emit('build:gain', { what: `jewel:${j.base}` }); return true; }
    this.world.spawn({ kind: 'item', x: x + this.rng.range(-12, 12), y: y + this.rng.range(-12, 12), r: 10, jewel: j });
    this.sayJewelFull(); return false;
  }
  private sayJewelFull(): void { if (this.time - this.jewelFullSaidAt < 3) return; this.jewelFullSaidAt = this.time; this.bus.emit('build:gain', { what: 'jewelFull' }); }
  private maybeDropJewel(boss: boolean, x?: number, y?: number): void {
    if (this.rng.next() >= (boss ? JEWEL_RULES.drops.chanceBoss : JEWEL_RULES.drops.chancePerKill)) return;
    this.giveJewel(this.rollJewel(), x, y);
  }
  /** Debug: one of each legendary jewel + two normal jewels. */
  debugGrantJewels(): void { for (const id of Object.keys(JEWEL_RULES.legendary)) this.giveJewel(this.rollJewel(id)); for (let i = 0; i < 2; i++) this.giveJewel(this.rollJewel('normal')); }
  /** Debug: talent points + one of each gem + respec materials. */
  debugGrantBuild(): void {
    this.debugSun(0); const b = this.build.s; b.bonusPoints += 5; b.gems.push(...Object.keys(GEMS)); b.ashShards += 3; b.gold += 2000; }

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
    this.time += dt; this.frameNo++;
    const p = this.player;
    this.hash.clear();
    for (const m of this.world.query('monster')) this.hash.insert(m);
    this.energy = Math.min(BALANCE.energyMax, this.energy + BALANCE.energyRegen * (1 + this.bon.ppRegenPct / 100) * dt);
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
    this.sunT = Math.max(0, this.sunT - dt);
    this.reactedThisFrame.clear();
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
      if (!d.moveId && this.bon.keystones.has('ks_skyGlide')) { this.moveTrail += d.speed * dt; if (this.moveTrail >= 28) { this.moveTrail = 0; this.spawnGround('fire', p.x, p.y, 3, p.id); } } // ks_skyGlide
      if (d.moveId) { this.dashHits(p); this.dashExtras(p, d.speed * dt, d.t <= 0); }
      if (!d.moveId) this.dodgeStep(p, d, dt);
      if (d.t <= 0) p.dash = undefined;
      return;
    }
    if (cmd.dodge && this.dodgeCd <= 0) {
      const len = Math.hypot(cmd.moveX, cmd.moveY) || 1;
      const dx = cmd.moveX || Math.cos(p.rot); const dy = cmd.moveY || Math.sin(p.rot);
      p.dash = { t: 0.2, dirX: dx / (cmd.moveX || cmd.moveY ? len : 1), dirY: dy / (cmd.moveX || cmd.moveY ? len : 1), speed: 650, hit: false };
      if (this.bon.asc.flight) { p.dash.flight = true; p.iframes = Math.max(p.iframes ?? 0, this.bon.asc.flight.invulnSec); }
      this.dodgeIgnited.clear();
      p.iframes = Math.max(p.iframes ?? 0, 0.3); if (this.bon.onDodgeSpeed) this.dodgeBuffUntil = this.time + 0.2 + this.bon.onDodgeSpeed.sec; this.dodgeCd = 0.9 * Math.max(0.2, 1 - dodgeCdrPct(this.bon, this.mech).value / 100);
      return;
    }
    if (cmd.moveTo) this.orderMove(cmd.moveTo.x, cmd.moveTo.y);
    if (cmd.attackTarget !== undefined) this.order = { kind: 'attack', target: cmd.attackTarget, path: [], repath: 0 };
    const len = Math.hypot(cmd.moveX, cmd.moveY);
    if (len > 0) { this.order = null; const sp = this.moveSpeed() * dt; this.moveEntity(p, (cmd.moveX / len) * sp, (cmd.moveY / len) * sp); this.walkTrail(sp); }
    else if (cmd.forceAttack) { this.order = null; const a = this.primaryAttack(); if (a && this.moveUsable(a)) this.tryCast(a, cmd.aimX, cmd.aimY); }
    else this.followOrder(dt);
    const dashTaps = this.dashTaps; this.dashTaps = [false, false, false, false, false];
    this.slots.forEach((id, i) => { if (id && (cmd.slots[i] || cmd.taps?.[i] || dashTaps[i])) { if (this.moveUsable(id)) this.tryCast(id, cmd.aimX, cmd.aimY); else this.bus.emit('build:gain', { what: 'locked:' + id }); } });
    if (cmd.items?.[0]) this.usePotion(0);
  }

  usePotion(slot: number): boolean {
    const p = this.player; const n = this.potions[slot] ?? 0;
    if (slot !== 0 || n <= 0 || this.potionCd > 0 || p.dead || !p.maxHp || (p.hp ?? 0) >= p.maxHp) return false;
    this.potions[0] = n - 1; this.potionCd = POTION_CD;
    p.hp = Math.min(p.maxHp, (p.hp ?? 0) + p.maxHp * POTION_HEAL * (1 + this.bon.consumablePct / 100));
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
  /** trailIgnite: walking leaves short-lived fire (direct dmg scaled by trailDmgPct). */
  private walkTrail(dist: number): void {
    if (this.bon.trailIgnite <= 0) return; this.moveTrail += dist; if (this.moveTrail < 40) return; this.moveTrail = 0;
    this.spawnGround('fire', this.player.x, this.player.y, this.mech.trailLifeSec, this.player.id, 0.08 * (1 + trailDmgPct(this.bon, this.mech).value / 100));
  }
  private stepAlong(path: Pt[], dt: number): void {
    const p = this.player; let budget = this.moveSpeed() * dt;
    while (budget > 0 && path.length) {
      const wp = path[0] as Pt; const dx = wp.x - p.x, dy = wp.y - p.y; const d = Math.hypot(dx, dy);
      this.walkTrail(Math.min(d, budget));
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
      p.rot = Math.atan2(tgt.y - p.y, tgt.x - p.x); if (this.moveUsable(atk)) this.tryCast(atk, tgt.x, tgt.y); return;
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

  landedAt = -9; private aura = 0; private auraPrimed = false; private ragingUntil = -9; private dodgeIgnited = new Set<number>(); private flightTrailAcc = 0;
  get dragonAura(): number { return this.aura; }
  /** dodge per-frame extras: 流星步 ignite on pass-through, 烈焰之翼 flight trail + landing impact */
  private dodgeStep(p: Entity, d: NonNullable<Entity['dash']>, dt: number): void {
    if (this.bon.dodgeIgnite > 0) for (const m of this.hash.near(p.x, p.y, p.r + 30)) if (!m.dead && !this.dodgeIgnited.has(m.id) && Math.hypot(m.x - p.x, m.y - p.y) < m.r + p.r) { this.dodgeIgnited.add(m.id); this.applyBurn(m, p.id); }
    const A = this.bon.asc; if (!d.flight || !A.flight) return;
    if (A.flightTrail) { this.flightTrailAcc += d.speed * dt; if (this.flightTrailAcc >= 28) { this.flightTrailAcc = 0; this.spawnGround('fire', p.x, p.y, 2, p.id); } }
    if (d.t <= 0) { // landing: fire impact (% of basic attack), radius grows with airborne area
      this.landedAt = this.time;
      this.world.spawn({ kind: 'blast', x: p.x, y: p.y, r: 60 * (1 + (A.airborneAreaPct ?? 0) / 100), team: 'player', owner: p.id, moveId: BASIC, life: 0.05, delay: 0.05, dmgMult: A.flight.landingFireDmgPctOfBasic / 100 });
      this.bus.emit('reaction', { id: 'flight_landing', x: p.x, y: p.y, r: 60 });
    }
  }
  /** v4 move trunk: trunk moves need rank >= 1 to be cast from slots (non-trunk moves always usable). */
  moveUsable(id: string): boolean { return this.build.moveRank(id) !== 0; }
  tryCast(id: string, ax: number, ay: number): boolean {
    const m = moveData(id); const p = this.player; const eq = this.equipStats();
    if (this.cooldownLeft(id) > 0) return false;
    const lowHp = (p.hp ?? 0) < (p.maxHp ?? 1) * 0.25;
    const cost = eq.allIn && lowHp ? 0 : energyCost(m);
    if (this.energy < cost) return false;
    this.energy -= cost;
    this.cooldowns.set(id, moveCooldown(m, eq.cdr) * this.talentCdMult(id));
    const spec = this.moveSpec(id, eq);
    const A = this.bon.asc;
    if (A.airborneAreaPct && (p.dash?.flight || this.time - this.landedAt <= 0.35)) spec.areaPct += A.airborneAreaPct; // 高空俯衝: cast in/just after flight
    const forceCrit = this.auraPrimed; if (forceCrit) { this.auraPrimed = false; this.aura = 0; }
    const mods: MoveMods = { powerBonus: eq.power, leech: eq.leech + spec.leech, kindling: eq.kindling, spec, forceCrit };
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
        const nb = Math.max(1, Math.round(spec.beams + spec.projectiles - 1)); const step = (spec.beamSpreadDeg * Math.PI) / 180;
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
        if (m.shape === 'zone') { const fol = !!spec.flags.followCaster; this.world.spawn({ kind: 'zone', x: fol ? p.x : x, y: fol ? p.y : y, r: (pr.r ?? 80) * area, team: 'player', owner: p.id, moveId: id, life: pr.duration ?? 4, tick: pr.tick ?? 0.5, tickT: 0, mods, follow: fol, hitSet: new Set() }); }
        else this.world.spawn({ kind: 'blast', x, y, r: (pr.r ?? 100) * area, team: 'player', owner: p.id, moveId: id, life: pr.delay ?? 0.4, delay: pr.delay ?? 0.4, mods });
        break;
      }
      case 'dash': {
        const spd = pr.speed ?? 1000;
        p.dash = { t: (pr.distance ?? 200) / spd, dirX: Math.cos(ang), dirY: Math.sin(ang), speed: spd, hit: false, moveId: id };
        p.iframes = Math.max(p.iframes ?? 0, p.dash.t); p.hitSet = new Set(); p.mods = mods; this.trailAcc = 0; this.dashHitCount.clear();
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
  private spawnProjectile(id: string, x: number, y: number, a: number, mods: MoveMods, hitSet: Set<number>, pierce: number, chain: number, fork: number, dmgMult = 1, chainJumps = 0): void {
    const pr = mods.spec?.params ?? moveData(id).params; const spd = (pr.speed ?? 500) * (1 + projSpeedPct(this.bon, this.mech).value / 100);
    this.world.spawn({ kind: 'projectile', x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, rot: a, r: pr.radius ?? 8, team: 'player', owner: this.player.id,
      moveId: id, life: (pr.range ?? 400) / spd, hitSet, pierce, chain, fork, mods, dmgMult, chainJumps });
  }

  private dashExtras(p: Entity, step: number, ending: boolean): void {
    const sp = p.mods?.spec; if (!sp) return;
    if (sp.flags.trailFire) { this.trailAcc += step; if (this.trailAcc >= 28) { this.trailAcc = 0; this.spawnGround('fire', p.x, p.y, sp.flags.trailFire, p.id); } }
    for (const rule of reactionsFor('dash')) {
      if (rule.requires !== 'zone:own' || !triggerMatches(rule.trigger, sp.tags, sp.moveId, sp.variant)) continue;
      for (const z of this.world.query('zone')) if (!z.follow && z.team === 'player' && Math.hypot(z.x - p.x, z.y - p.y) < z.r) {
        z.follow = true; z.scale = this.num(rule, 'scale', 0.7); z.r *= z.scale; this.bus.emit('reaction', { id: rule.id, x: p.x, y: p.y, r: z.r, vfx: rule.vfx });
      }
    }
    if (ending && sp.flags.ramPull) {
      const R = sp.flags.ramPull * areaFactor(sp);
      for (const m of this.hash.near(p.x, p.y, R + 20)) {
        if (m.dead) continue; const dx = p.x - m.x, dy = p.y - m.y; const d = Math.hypot(dx, dy); if (d > R) continue;
        const pull = Math.max(0, d - 28); if (d > 0) this.moveEntity(m, (dx / d) * pull, (dy / d) * pull);
        if (m.isBoss) { if (sp.flags.ramBossVulnPct) this.applyStatus(m, 'dmg-vuln', 3, p.id); } else if (sp.flags.ramStun) this.applyStatus(m, 'stun', sp.flags.ramStun * (1 + this.bon.stunDurPct / 100), p.id);
      }
      this.bus.emit('vfx', { key: 'fc-ram', x: p.x, y: p.y, r: R });
    }
  }

  private dashHits(p: Entity): void {
    const id = p.dash?.moveId; if (!id) return;
    const w = (moveData(id).params.width ?? 40) / 2;
    for (const m of this.hash.near(p.x, p.y, w + 40)) {
      // flameChargeHits: each enemy can be hit 1 + N times per charge (>= 0.06 s apart)
      const hc = this.dashHitCount.get(m.id); const maxHits = 1 + this.bon.flameChargeHits;
      if (m.dead || Math.hypot(m.x - p.x, m.y - p.y) > w + m.r || (hc && (hc.n >= maxHits || this.time - hc.t < 0.06))) continue;
      this.dashHitCount.set(m.id, { n: (hc?.n ?? 0) + 1, t: this.time }); p.hitSet?.add(m.id);
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
    if (target.statuses?.['fire-vuln'] && moveData(moveId).type === 'fire') mult *= 1 + (spec?.flags.bossFireVulnPct ?? 20) / 100;
    if (target.statuses?.['dmg-vuln'] && src.team === 'player') mult *= 1.1;
    // snapshot statuses that existed BEFORE this hit: settle-stage reactions may only consume these (never a status this hit applies)
    const pre: PreHit = { burn: target.burn ? { ...target.burn } : undefined, statuses: new Set(Object.keys(target.statuses ?? {})) };
    const m = moveData(moveId);
    const a = src.stats; const d = target.stats;
    if (!a || !d) return 0;
    const phys = m.category === 'physical';
    const mine = src.team === 'player'; const kb = this.bon.keystones;
    const forced = mine && !!mods?.forceCrit;
    const isCrit = forced || this.rng.next() < BALANCE.critChance + (mine ? (this.bon.critPct + (m.type === 'fire' ? this.bon.fireCritPct : 0)) / 100 : 0);
    if (mine) {
      if (isCrit) mult *= 1 + this.bon.critDmgPct / 100 + (forced ? (this.bon.asc.auraCritDmgPct ?? 0) / 100 : 0);
      if (m.type === 'fire' && this.bon.fireDmgPct) mult *= 1 + this.bon.fireDmgPct / 100;
      if (phys && this.time < this.ragingUntil && this.bon.onHitTakenAtk) mult *= 1 + this.bon.onHitTakenAtk.pct / 100; // 逆鱗
      // 龍之血脈: part of fire damage becomes dragon-type (ignores fire resistance)
      const conv = this.bon.asc.fireToDragonPct ?? 0;
      if (conv > 0 && m.type === 'fire') { const fe = typeMult('fire', target.types ?? []); const de = typeMult('dragon', target.types ?? []); if (fe > 0) mult *= 1 - conv / 100 + (conv / 100) * (de / fe); }
      // 龍氣: physical hits stack; at max the next cast is a guaranteed crit
      if (this.bon.asc.fireToDragonPct !== undefined && phys && target.kind === 'monster') { const max = 5 + (this.bon.asc.auraMaxDelta ?? 0); this.aura = Math.min(max, this.aura + 1); if (this.aura >= max) this.auraPrimed = true; }
      // ks_blaze: +6% fire dmg per 10% HP lost (max +45%)
      if (kb.has('ks_blaze') && m.type === 'fire' && src.maxHp) mult *= 1 + Math.min(0.45, Math.floor((1 - (src.hp ?? 0) / src.maxHp) * 10) * 0.06);
      // ks_solarPower: special attack x1.5 during Sunny Day
      if (kb.has('ks_solarPower') && this.sunT > 0 && m.category === 'special') mult *= 1.5;
      // comboStack: consecutive hits (<1.5 s apart) stack +2%/stack per rank, max 10 stacks
      if (this.bon.comboStack > 0 && target.kind === 'monster') { this.combo = this.time - this.comboT < this.mech.comboResetSec ? Math.min(10, this.combo + 1) : 1; this.comboT = this.time; mult *= 1 + 0.02 * this.combo * this.bon.comboStack; }
    }
    const tierDmg = src.team === 'enemy' ? BALANCE.tierDmg ** (this.floorNo - 1) : 1;
    const { dmg, typeEff } = calcDamage({ level: src.level ?? 1, power: m.power, atk: phys ? a.atk : a.spa, def: phys ? d.def : d.spd, moveType: m.type,
      attackerTypes: src.types ?? [], defenderTypes: target.types ?? [], isCrit, roll: this.rng.next(), bonus: mods?.powerBonus ?? 0, mult: mult * tierDmg,
      burnedPhysical: phys && !!src.burn });
    if (target.kind === 'player' || src.team === 'player') this.lastCombatT = this.time;
    if (target.kind === 'player' && target.maxHp) { // additive damage-taken sum, then capped (meta.mechanics)
      const A = this.bon.asc; const extra = (A.postFlightDr && this.time - this.landedAt <= A.postFlightDr.sec ? A.postFlightDr.pct : 0) + (A.auraDrPerStack ?? 0) * this.aura;
      if (this.bon.onHitTakenAtk) this.ragingUntil = this.time + this.bon.onHitTakenAtk.sec;
      const dr = damageReductionPct(this.bon, this.mech, (target.hp ?? 0) / target.maxHp, extra).value; const scaled = Math.max(1, Math.round(dmg * (1 - dr / 100)));
      target.hp -= scaled; this.lastPlayerDmg = scaled;
    } else target.hp -= dmg;
    if (target.kind === 'player') target.iframes = BALANCE.playerIFrames;
    this.bus.emit('damage:dealt', { target: target.id, amount: dmg, isCrit, typeEff, x: target.x, y: target.y - target.r });
    if (mods && mods.leech > 0 && src.hp !== undefined && src.maxHp) src.hp = Math.min(src.maxHp, src.hp + dmg * mods.leech);
    // status
    const st = m.status;
    let burnChance = spec ? spec.burnChance : st?.id === 'burn' ? st.chance / 100 : 0;
    // Fixed hit-resolution order (director modifierOrder): settle pre-existing statuses -> on-hit spawners -> apply NEW statuses
    if (spec && !target.dead) {
      // settle: reactions may only consume statuses from the pre-hit snapshot
      if (!mods?.noReact) this.reactions(src, target, spec, mods, chain, pre);
      // on-hit: delayed marks, seeds (never detonated by the same hit)
      if (!mods?.fromMark && spec.flags.delayedMark && !target.statuses?.marked) {
        this.applyStatus(target, 'marked', 1, src.id);
        this.world.spawn({ kind: 'blast', sub: 'sticky', x: target.x, y: target.y, r: 60 * areaFactor(spec), team: 'player', owner: src.id, moveId, life: 1, delay: 1, dmgMult: 0.5, mods: { ...(mods ?? { powerBonus: 0, leech: 0, kindling: false }), fromMark: true } });
      }
      if (!mods?.fromMark && spec.flags.seedGround) this.spawnGround('seed', target.x, target.y, spec.flags.seedGround, src.id);
    }
    // apply new statuses last
    if (spec && !target.dead) for (const ap of spec.applies) if (this.rng.next() < ap.chance) this.applyStatus(target, ap.status, ap.duration, src.id);
    if (mods?.kindling && m.type === 'fire' && canTrigger(chain, 'kindling', target.id)) burnChance += 0.15;
    if (burnChance > 0 && !target.dead && this.rng.next() < burnChance) this.applyBurn(target, src.id);
    if (moveId === 'fire-spin') target.bound = { t: 1, src: src.id };
    if (target.hp <= 0 && !target.dead) { this.kill(target, src.id, 'hit', chain); if (spec?.flags.energyOnKill) this.energy = Math.min(BALANCE.energyMax, this.energy + spec.flags.energyOnKill); }
    return dmg;
  }

  applyStatus(t: Entity, id: string, duration: number, src: number): void {
    const def = STATUSES[id]; const cur = t.statuses?.[id];
    (t.statuses ??= {})[id] = { t: Math.max(cur?.t ?? 0, duration || def?.duration || 3), stacks: Math.min(def?.maxStacks ?? 1, (cur?.stacks ?? 0) + 1), src };
  }
  private num = (r: ReactionRule, k: string, d: number): number => { const v = r.effect[k]; return typeof v === 'number' ? v : d; };
  /** Stage-5 'hit' reactions (rules: director-bindings.json). requires: ground:seed | status:<id> | mark:sticky */
  private reactions(src: Entity, target: Entity, spec: MoveSpec, mods: MoveMods | undefined, chain: ChainContext, pre: PreHit): void {
    if (chain.depth >= REACTION_RULES.maxDepth) return;
    for (const rule of reactionsFor('hit')) {
      if (spec.reactionsOff.has(rule.id) || !triggerMatches(rule.trigger, spec.tags, spec.moveId, spec.variant)) continue;
      const once = `${rule.id}:${target.id}`; if (REACTION_RULES.oncePerObjectPerFrame && this.reactedThisFrame.has(once)) continue;
      const req = rule.requires;
      if (req === 'ground:seed') {
        const seed = this.world.query('ground').find((g) => g.sub === 'seed' && !g.dead && Math.hypot(g.x - target.x, g.y - target.y) < 40 + target.r);
        if (!seed || !canTrigger(chain, `reaction:${rule.id}`, seed.id)) continue; this.reactedThisFrame.add(once);
        this.detonateSeeds(seed, src, spec, mods, rule, chain);
      } else if (req === 'status:burn') {
        const b = target.burn; if (!b || !pre.burn || target.hp === undefined || !target.maxHp) continue; this.reactedThisFrame.add(once);
        const left = target.maxHp * (target.isBoss ? BALANCE.burnPctBoss : BALANCE.burnPctPerSec) * b.stacks * b.t * (1 + burnBonusPct(this.bon, this.mech, this.sunT > 0).value / 100) * this.num(rule, 'mult', 1.5) * (1 + this.bon.burnConsumeMultPct / 100);
        target.burn = undefined; target.hp -= left;
        this.bus.emit('damage:dealt', { target: target.id, amount: Math.round(left), isCrit: true, typeEff: 1, x: target.x, y: target.y - target.r });
        this.bus.emit('reaction', { id: rule.id, x: target.x, y: target.y, r: 50, vfx: rule.vfx });
        if (target.hp <= 0) this.kill(target, src.id, 'burn', chain);
      } else if (req.startsWith('status:')) {
        const st = req.slice(7); if (!target.statuses?.[st] || !pre.statuses.has(st)) continue; this.reactedThisFrame.add(once);
        delete target.statuses[st]; this.bus.emit('reaction', { id: rule.id, x: target.x, y: target.y, r: this.num(rule, 'r', 60), vfx: rule.vfx });
        this.burst(src, target.x, target.y, this.num(rule, 'r', 60), spec.moveId, this.num(rule, 'mult', 0.5), mods, chain);
      } else if (req === 'mark:sticky') {
        if (mods?.fromMark) continue;
        for (const bl of this.world.query('blast')) if (bl.sub === 'sticky' && bl.mods?.spec !== spec && (bl.life ?? 0) > 0.02 && Math.hypot(bl.x - target.x, bl.y - target.y) < bl.r) {
          bl.life = 0.0001; this.bus.emit('reaction', { id: rule.id, x: bl.x, y: bl.y, r: bl.r * 0.5, vfx: rule.vfx });
        }
      }
    }
  }
  private burst(src: Entity, x: number, y: number, r: number, moveId: string, mult: number, mods: MoveMods | undefined, chain: ChainContext): void {
    // director reactionRules: reaction-generated hits may trigger further reactions at depth+1 (max depth guards loops)
    const bm: MoveMods = { ...(mods ?? { powerBonus: 0, leech: 0, kindling: false }), noReact: !REACTION_RULES.reactionGeneratedHitsCanTrigger, fromMark: true };
    for (const t of this.hash.near(x, y, r + 30)) if (!t.dead && Math.hypot(t.x - x, t.y - y) < r + t.r) this.hit(src, t, moveId, mult, bm, childChain(chain));
  }
  /** seed_detonate: explode the seed, then chain-detonate seeds within chainRange (BFS). */
  private detonateSeeds(first: Entity, src: Entity, spec: MoveSpec, mods: MoveMods | undefined, rule: ReactionRule, chain: ChainContext): void {
    const r = this.num(rule, 'r', 72) * areaFactor(spec), mult = this.num(rule, 'mult', 0.7), range = this.num(rule, 'chainRange', 96);
    const queue: [Entity, Entity | null][] = [[first, null]]; first.dead = true;
    while (queue.length) {
      const [s0, from] = queue.shift() as [Entity, Entity | null];
      this.bus.emit('reaction', { id: rule.id, x: s0.x, y: s0.y, r, vfx: rule.vfx, x2: from?.x, y2: from?.y });
      this.burst(src, s0.x, s0.y, r, spec.moveId, mult, mods, chain);
      for (const g of this.world.query('ground')) if (g.sub === 'seed' && !g.dead && Math.hypot(g.x - s0.x, g.y - s0.y) < range) { g.dead = true; queue.push([g, s0]); }
    }
  }
  spawnGround(sub: 'seed' | 'fire', x: number, y: number, life: number, owner: number, dmgMult?: number): void {
    let sunlit = false;
    if (sub === 'fire' && this.sunT > 0) for (const rule of reactionsFor('ground')) if (rule.requires === 'weather:sun') { life *= this.num(rule, 'mult', 2); sunlit = true; }
    const list = this.world.query('ground').filter((g) => g.sub === sub);
    if (list.length >= (sub === 'seed' ? 12 : 40)) { const old = list[0]; if (old) old.dead = true; }
    this.world.spawn({ kind: 'ground', sub, x, y, r: sub === 'seed' ? 14 : 30, team: 'player', owner, life, tick: 0.5, tickT: 0, sunlit, dmgMult });
  }
  /** Damage multiplier for one chain jump: variant step (ft_focus -20%) + sun_chain bonus. */
  private chainStepMult(spec: MoveSpec | undefined, from: Entity, to: Entity): number {
    let k = 1 + (spec?.flags.chainDmgStep ?? 0);
    let sun = false;
    if (this.sunT > 0) for (const rule of reactionsFor('chain')) if (rule.requires === 'weather:sun') { k += this.num(rule, 'perJump', 0.1); sun = true; this.bus.emit('reaction', { id: rule.id, x: to.x, y: to.y, r: 20, vfx: rule.vfx, x2: from.x, y2: from.y }); }
    if (!sun) this.bus.emit('vfx', { key: 'chain-line', x: to.x, y: to.y, x2: from.x, y2: from.y }); // under sun the sun-chain line replaces it
    return k;
  }
  /** start Sunny Day (晴空延長 sunDurationPct scales it) */
  setSun(sec: number): void { this.sunT = sec * (1 + this.bon.sunDurationPct / 100) + this.bon.sunDurationSec; }
  debugSun(sec = 10): void { this.setSun(sec); }

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
    this.onKillRefund();
    if (this.bon.keystones.has('ks_solarPower') && this.sunT > 0) { const P = this.player; if (P.maxHp && P.hp !== undefined) P.hp = Math.min(P.maxHp, P.hp + P.maxHp * 0.03); }
    this.gainXp(Math.round(((sp.baseExp * (t.level ?? 1)) / 7) * md.xpMult));
    // build currencies: gold always, ash shard / support gem sometimes (TUNE)
    const b = this.build.s; b.gold += Math.round((t.level ?? 1) * (t.isBoss ? 20 : 2));
    if (this.rng.next() < (t.isBoss ? 1 : 0.06)) { b.ashShards++; this.bus.emit('build:gain', { what: 'ash_shard' }); }
    this.maybeDropJewel(!!t.isBoss, t.x, t.y);
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
            const owner = this.world.get(e.owner ?? -1); if (owner) this.hit(owner, m, e.moveId ?? BASIC, e.dmgMult ?? 1, e.mods, newChain(this.rootSeq++));
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
          let far: Entity | null = null; let farAlong = 0; const inBeam: [Entity, number][] = [];
          for (const t of this.hash.near(p.x + cx * len / 2, p.y + cy * len / 2, len / 2 + 40)) {
            const rx = t.x - p.x, ry = t.y - p.y; const along = rx * cx + ry * cy; const perp = Math.abs(-rx * cy + ry * cx);
            const sp = e.mods?.spec; const dur = sp?.params.duration ?? 0.8; const w = (e.width ?? 22) * (1 + (sp?.widenOverLife ?? 0) * Math.max(0, 1 - (e.life ?? 0) / dur));
            if (!t.dead && along > 0 && along < len && perp < w / 2 + t.r) inBeam.push([t, along]);
          }
          // ft_focus: beam hits only the nearest 1 + pierce targets (inherent pierce 2; pierce gem = +2 extra)
          inBeam.sort((x, y) => x[1] - y[1]); const cap = e.mods?.spec?.flags.beamPierceCap ? 1 + (e.mods.spec.pierce ?? 0) : Infinity;
          for (const [t, along] of inBeam.slice(0, cap)) { this.hit(p, t, m.id, perTick, e.mods, newChain(this.rootSeq++)); if (!far || along > farAlong) { far = t; farAlong = along; } }
          // beam chain (gem 'chain' on a beam with the projectile tag, e.g. ft_focus): jump from the farthest target hit
          const sp2 = e.mods?.spec; let cur = far; let mul = perTick; const hitIds = new Set<number>(cur ? [cur.id] : []);
          for (let k = 0; cur && sp2 && k < sp2.chain; k++) {
            let best: Entity | null = null; let bd = sp2.chainRange;
            for (const o of this.hash.near(cur.x, cur.y, bd)) { if (o.dead || hitIds.has(o.id)) continue; const d = Math.hypot(o.x - cur.x, o.y - cur.y); if (d < bd) { bd = d; best = o; } }
            if (!best) break; mul *= this.chainStepMult(sp2, cur, best); hitIds.add(best.id); this.hit(p, best, m.id, mul, e.mods, newChain(this.rootSeq++)); cur = best;
          }
        }
        const gf = e.mods?.spec?.flags.groundFire;
        if (gf && e.life <= 0) { const a = p.rot + e.rot; const L = e.reach ?? e.len ?? 200; for (const f of [0.55, 0.95]) this.spawnGround('fire', p.x + Math.cos(a) * L * f, p.y + Math.sin(a) * L * f, gf, p.id); }
        const ex = e.mods?.spec?.endExplosion;
        if (ex && e.life <= 0) { const a = p.rot + e.rot; const L = e.reach ?? e.len ?? 300;
          this.world.spawn({ kind: 'blast', x: p.x + Math.cos(a) * L, y: p.y + Math.sin(a) * L, r: ex.r * areaFactor(e.mods?.spec ?? baseSpec('', [], {}, 0)), team: 'player', owner: p.id, moveId: e.moveId, life: 0.05, delay: 0.05, dmgMult: ex.mult, mods: e.mods }); }
      } else if (e.kind === 'zone') {
        if (e.follow) { e.x = p.x; e.y = p.y; }
        e.tickT = (e.tickT ?? 0) - dt;
        if (e.tickT <= 0) {
          e.tickT += e.tick ?? 0.5;
          const m = moveData(e.moveId ?? 'fire-spin');
          const perTick = ((e.tick ?? 0.5) / (m.params.duration ?? 4)) * BALANCE.sustainedComp * 3; // TUNE: zone is the main DoT tool
          const pris = e.mods?.spec?.flags.prison ?? 0;
          for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) {
            if (pris > 0) { if (t.isBoss) this.applyStatus(t, 'fire-vuln', (e.tick ?? 0.5) + 0.1, p.id); else if (!e.hitSet?.has(t.id)) { e.hitSet?.add(t.id); this.applyStatus(t, 'root', pris, p.id); } }
            this.hit(p, t, m.id, perTick, e.mods, newChain(this.rootSeq++));
          }
        }
      } else if (e.kind === 'blast') {
        if (e.life <= 0) {
          for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) this.hit(p, t, e.moveId ?? 'fire-blast', e.dmgMult ?? 1, e.mods, newChain(this.rootSeq++));
          const sp = e.mods?.spec; const n = e.sub === 'sticky' ? 0 : Math.round((sp?.flags.starBolts ?? 0) + (sp?.flags.starBolts ? (sp.projectiles - 1) : 0));
          for (let i = 0; i < n && sp && e.mods; i++) this.spawnProjectile(e.moveId ?? 'fire-blast', e.x, e.y, (i / n) * Math.PI * 2 - Math.PI / 2, e.mods, new Set(), sp.pierce, sp.chain, sp.fork, 0.5);
        }
      }
      else if (e.kind === 'ground' && e.sub === 'fire') {
        e.tickT = (e.tickT ?? 0) - dt;
        if (e.tickT <= 0) { e.tickT += e.tick ?? 0.5; for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) { this.applyBurn(t, p.id); if (e.dmgMult && this.trailCanHit(t.id)) this.hit(p, t, BASIC, e.dmgMult, undefined, newChain(this.rootSeq++)); } }
      }
      if (e.life <= 0) e.dead = true;
    }
  }

  /** Projectile hit resolution, fixed order: pierce (prehit) -> fork -> chain (onhit) -> expire. Returns true if this projectile is done. */
  projectileOnHit(e: Entity, m: Entity): boolean {
    if ((e.pierce ?? 0) > 0) { e.pierce = (e.pierce ?? 0) - 1; return false; }
    const mods = e.mods ?? { powerBonus: 0, leech: 0, kindling: false }; const a = Math.atan2(e.vy, e.vx); const id = e.moveId ?? BASIC;
    if ((e.fork ?? 0) > 0) {
      for (const d of [-0.5, 0.5]) this.spawnProjectile(id, m.x, m.y, a + d, mods, new Set(e.hitSet), 0, e.chain ?? 0, (e.fork ?? 0) - 1, e.dmgMult ?? 1, e.chainJumps ?? 0);
      e.dead = true; return true;
    }
    if ((e.chain ?? 0) > 0) {
      const range = mods.spec?.chainRange ?? 180; let best: Entity | null = null; let bd = range;
      for (const o of this.hash.near(m.x, m.y, range)) { if (o.dead || o === m || e.hitSet?.has(o.id)) continue; const d = Math.hypot(o.x - m.x, o.y - m.y); if (d < bd) { bd = d; best = o; } }
      if (best) { this.spawnProjectile(id, m.x, m.y, Math.atan2(best.y - m.y, best.x - m.x), mods, new Set(e.hitSet), 0, (e.chain ?? 0) - 1, 0, (e.dmgMult ?? 1) * this.chainStepMult(mods.spec, m, best), (e.chainJumps ?? 0) + 1); }
    }
    e.dead = true; return true;
  }

  private statusStep(dt: number): void {
    const P = this.player;
    const oc = this.bon.oocRegen; if (oc && !P.dead && P.maxHp && P.hp !== undefined && this.time - this.lastCombatT >= oc.delaySec) P.hp = Math.min(P.maxHp, P.hp + P.maxHp * oc.pct / 100 * dt); // 再燃
    if (this.bon.keystones.has('ks_solarPower') && this.sunT > 0 && !P.dead && P.maxHp && P.hp !== undefined) P.hp = Math.max(1, P.hp - P.maxHp * 0.01 * dt); // solar drain
    for (const e of [...this.world.query('monster'), this.player]) {
      if (e.dead || e.hp === undefined || !e.maxHp) continue;
      if (e.burn) {
        const bmul = e.kind === 'monster' ? (1 + burnBonusPct(this.bon, this.mech, this.sunT > 0).value / 100) : 1;
        e.hp -= e.maxHp * (e.isBoss ? BALANCE.burnPctBoss : BALANCE.burnPctPerSec) * e.burn.stacks * dt * bmul; if (e.kind === 'player' || e.burn.src === this.player.id) this.lastCombatT = this.time;
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
      if (m.statuses?.stun) continue; // stunned: no move, no attack
      let speed = (m.stats?.moveSpeed ?? 150) * 0.75 * (m.bound ? 0.5 : 1) * (m.statuses?.root ? 0 : 1);
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
      if (it.jewel && Math.hypot(it.x - p.x, it.y - p.y) <= BALANCE.pickupRadius + p.r) {
        if (this.jewelsFull()) { this.sayJewelFull(); continue; }
        this.build.s.board.jewels.push(it.jewel); it.dead = true; this.bus.emit('build:gain', { what: `jewel:${it.jewel.base}` }); continue;
      }
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
