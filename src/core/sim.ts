import { BALANCE } from './balance';
import { Rng } from './rng';
import { EventBus, childChain, canTrigger, newChain, type ChainContext } from './events/event-bus';
import { World, SpatialHash, type Entity, type MoveMods } from './ecs/world';
import { generateFloor, isWall, type FloorMap } from './dungeon/bsp-gen';
import { calcStats, xpToNext } from './stats/stat-calc';
import { calcDamage } from './combat/damage';
import { moveCooldown, energyCost } from './moves/cooldown';
import { rollItem, canEquip, type Item, type ItemSlot } from './loot/loot-roller';
import { monster as monsterData, move as moveData, species as speciesData, MONSTERS } from '../data/registry';

export interface InputCommand {
  moveX: number; moveY: number; aimX: number; aimY: number; // aim in world px
  basic: boolean; slots: [boolean, boolean, boolean, boolean]; dodge: boolean;
}
export interface Progress {
  level: number; xp: number; inventory: Item[]; equipped: Partial<Record<ItemSlot, Item>>;
  bestFloor: number; nextUid: number; seed: number;
}
export const newProgress = (seed: number): Progress => ({ level: 5, xp: 0, inventory: [], equipped: {}, bestFloor: 1, nextUid: 1, seed });

export const LOADOUT = ['flamethrower', 'fire-spin', 'fire-blast', 'flare-blitz'] as const;
export const BASIC = 'ember';
export const MAX_FLOOR = 5;
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
  totalMonsters = 0;
  killed = 0;
  exitOpen = false;
  bossAlive = false;
  victory = false;
  time = 0;
  private hash = new SpatialHash(64);
  private rootSeq = 1;

  constructor(public progress: Progress) {
    this.rng = new Rng(progress.seed);
    this.loadFloor(1);
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

  loadFloor(n: number): void {
    this.floorNo = n;
    this.world = new World();
    this.floor = generateFloor(new Rng(this.progress.seed * 31 + n * 7919));
    const sp = speciesData(this.speciesId);
    const st = calcStats(sp, this.progress.level);
    const keepHp = this.player?.hp;
    this.player = this.world.spawn({ kind: 'player', x: (this.floor.start.cx + 0.5) * T, y: (this.floor.start.cy + 0.5) * T, r: 12, team: 'player',
      hp: keepHp && keepHp > 0 ? Math.min(keepHp, st.maxHp) : st.maxHp, maxHp: st.maxHp, stats: st, level: this.progress.level, types: sp.types, speciesId: sp.id, iframes: 0 });
    this.energy = BALANCE.energyMax; this.cooldowns.clear();
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
    this.energy = Math.min(BALANCE.energyMax, this.energy + BALANCE.energyRegen * dt);
    for (const [k, v] of this.cooldowns) this.cooldowns.set(k, Math.max(0, v - dt));
    this.dodgeCd = Math.max(0, this.dodgeCd - dt);
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
      p.iframes = Math.max(p.iframes ?? 0, 0.3); this.dodgeCd = 0.9;
      return;
    }
    const len = Math.hypot(cmd.moveX, cmd.moveY);
    if (len > 0) { const sp = (p.stats?.moveSpeed ?? 160) * dt; this.moveEntity(p, (cmd.moveX / len) * sp, (cmd.moveY / len) * sp); }
    if (cmd.basic) this.tryCast(BASIC, cmd.aimX, cmd.aimY);
    cmd.slots.forEach((on, i) => { const id = LOADOUT[i]; if (on && id) this.tryCast(id, cmd.aimX, cmd.aimY); });
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
    const mods: MoveMods = { powerBonus: eq.power, leech: eq.leech, kindling: eq.kindling };
    const ang = Math.atan2(ay - p.y, ax - p.x);
    const pr = m.params;
    this.bus.emit('move:cast', { caster: p.id, moveId: id });
    switch (m.shape) {
      case 'projectile': {
        const n = id === BASIC && eq.extraProj ? 2 : 1;
        for (let i = 0; i < n; i++) {
          const a = ang + (n > 1 ? (i - (n - 1) / 2) * ((15 * Math.PI) / 180) : 0);
          const spd = pr.speed ?? 500;
          this.world.spawn({ kind: 'projectile', x: p.x, y: p.y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, rot: a, r: pr.radius ?? 8, team: 'player', owner: p.id,
            moveId: id, life: (pr.range ?? 400) / spd, hitSet: new Set(), pierce: id === BASIC && eq.pierce ? 2 : 0, mods });
        }
        break;
      }
      case 'beam': {
        const angles = id === 'flamethrower' && eq.split ? [-25, 0, 25].map((d) => ang + (d * Math.PI) / 180) : [ang];
        const lenMult = angles.length > 1 ? 0.6 : 1; const dmgMult = angles.length > 1 ? 0.5 : 1;
        for (const a of angles) this.world.spawn({ kind: 'beam', x: p.x, y: p.y, rot: a - ang, r: 0, team: 'player', owner: p.id, moveId: id,
          life: pr.duration ?? 0.8, tick: pr.tick ?? 0.1, tickT: 0, len: (pr.length ?? 300) * lenMult, width: pr.width ?? 22,
          mods: { ...mods, powerBonus: mods.powerBonus }, delay: dmgMult });
        break;
      }
      case 'zone': case 'aoe-target': {
        const maxR = pr.maxRange ?? 260; const d = Math.min(maxR, Math.hypot(ax - p.x, ay - p.y));
        const x = p.x + Math.cos(ang) * d; const y = p.y + Math.sin(ang) * d;
        if (m.shape === 'zone') this.world.spawn({ kind: 'zone', x, y, r: pr.r ?? 80, team: 'player', owner: p.id, moveId: id, life: pr.duration ?? 4, tick: pr.tick ?? 0.5, tickT: 0, mods });
        else this.world.spawn({ kind: 'blast', x, y, r: pr.r ?? 100, team: 'player', owner: p.id, moveId: id, life: pr.delay ?? 0.4, delay: pr.delay ?? 0.4, mods });
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
    const m = moveData(moveId);
    const a = src.stats; const d = target.stats;
    if (!a || !d) return 0;
    const phys = m.category === 'physical';
    const isCrit = this.rng.next() < BALANCE.critChance;
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
    let burnChance = st?.id === 'burn' ? st.chance / 100 : 0;
    if (mods?.kindling && m.type === 'fire' && canTrigger(chain, 'kindling', target.id)) burnChance += 0.15;
    if (burnChance > 0 && this.rng.next() < burnChance) this.applyBurn(target, src.id);
    if (moveId === 'fire-spin') target.bound = { t: 1, src: src.id };
    if (target.hp <= 0) this.kill(target, src.id, 'hit', chain);
    return dmg;
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
      pr.xp -= xpToNext(pr.level); pr.level++;
      const sp = speciesData(this.speciesId); const st = calcStats(sp, pr.level);
      const p = this.player; p.stats = st; p.level = pr.level; p.maxHp = st.maxHp; p.hp = st.maxHp; p.types = sp.types; p.speciesId = sp.id;
      this.bus.emit('player:levelup', { level: pr.level });
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
            if ((e.pierce ?? 0) <= 0) { e.dead = true; break; } e.pierce = (e.pierce ?? 0) - 1;
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
          const a = p.rot + e.rot; const cx = Math.cos(a), cy = Math.sin(a); const len = e.len ?? 300;
          for (const t of this.hash.near(p.x + cx * len / 2, p.y + cy * len / 2, len / 2 + 40)) {
            const rx = t.x - p.x, ry = t.y - p.y; const along = rx * cx + ry * cy; const perp = Math.abs(-rx * cy + ry * cx);
            if (!t.dead && along > 0 && along < len && perp < (e.width ?? 22) / 2 + t.r) this.hit(p, t, m.id, perTick, e.mods, newChain(this.rootSeq++));
          }
        }
      } else if (e.kind === 'zone') {
        e.tickT = (e.tickT ?? 0) - dt;
        if (e.tickT <= 0) {
          e.tickT += e.tick ?? 0.5;
          const m = moveData(e.moveId ?? 'fire-spin');
          const perTick = ((e.tick ?? 0.5) / (m.params.duration ?? 4)) * BALANCE.sustainedComp * 3; // TUNE: zone is the main DoT tool
          for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) this.hit(p, t, m.id, perTick, e.mods, newChain(this.rootSeq++));
        }
      } else if (e.kind === 'blast') {
        if (e.life <= 0) for (const t of this.hash.near(e.x, e.y, e.r + 30)) if (!t.dead && Math.hypot(t.x - e.x, t.y - e.y) < e.r + t.r) this.hit(p, t, e.moveId ?? 'fire-blast', 1, e.mods, newChain(this.rootSeq++));
      }
      if (e.life <= 0) e.dead = true;
    }
  }

  private statusStep(dt: number): void {
    for (const e of [...this.world.query('monster'), this.player]) {
      if (e.dead || e.hp === undefined || !e.maxHp) continue;
      if (e.burn) {
        e.hp -= e.maxHp * (e.isBoss ? BALANCE.burnPctBoss : BALANCE.burnPctPerSec) * e.burn.stacks * dt;
        e.burn.t -= dt;
        const src = e.burn.src;
        if (e.burn.t <= 0) e.burn = undefined;
        if (e.hp <= 0) this.kill(e, src, 'burn', newChain(this.rootSeq++));
      }
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
