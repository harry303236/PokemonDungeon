import type Phaser from 'phaser';
import type { Sim } from '../../core/sim';
import { fullResetCost, RESPEC_FREE_BEFORE, engineMoveId } from '../../core/build/build';
import {
  BOARD, ascPointsTotal, boardPointsSpent, canAllocNode, canRefundNode, canAllocAsc, conversionsFor, previewConversion, isLegendary,
  type BoardNode, type Effect, type JewelItem, type Conversion,
} from '../../core/build/board';
import { emptyPlan, mergedState, planEmpty, planCost, planRefunds, stageAddNode, stageRemoveNode, stageMove, applyPlan, type BoardPlan } from '../../core/build/board-plan';
import { effectLine, capLine, isTplEffect } from '../../core/build/talent-plan';
import { fmtVal } from './talent-panel-view';
import type { TalentNode } from '../../core/build/talents';
import DIRECTOR from '../../data/build/charmander-moves-gems.json';
import type { TalentBoardScene } from '../scenes/talent-board-scene';

export type NodeVisual = 'start' | 'on' | 'plan' | 'remove' | 'avail' | 'off';
const ART = 'assets/hud/talents/';
const DMOVES = (DIRECTOR as unknown as { moves: { id: string; name: string; variants: { id: string; name: string; desc?: string }[] }[] }).moves;
const KIND: Record<BoardNode['kind'], string> = { start: '起點', small: '小型天賦', notable: '核心天賦', keystone: '基石', jewel: '珠寶孔' };
const LEG = new Map(BOARD.raw.jewels.legendary.map((j) => [j.id, j]));
const split = (s: string): { title: string; desc: string } => { const i = s.indexOf('：'); return i < 0 ? { title: s, desc: '' } : { title: s.slice(0, i), desc: s.slice(i + 1) }; };
const asNode = (id: string, e: Effect, maxRank = 1): TalentNode => ({ id, effectType: e.effectType, value: (e.value ?? 0) as TalentNode['value'], maxRank, branch: '', tier: 0, evoStage: 1, requires: [], exclusiveGroup: null });
const effText = (e: Effect): string => { const t = effectLine(asNode('x', e), 1); return t.replace(/：目前 /, ' ').replace(/（已滿）/, ''); };
const jewelName = (j: JewelItem): string => (isLegendary(j) ? LEG.get(j.base)?.name ?? j.base : '珠寶');
const esc = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const BTN = 'background:#2a1a10;color:#ffc75a;border:1px solid #8a6a3a;padding:3px 10px;cursor:pointer;font-size:13px;pointer-events:auto';
const PANEL = 'background:rgba(14,9,6,.92);border:1px solid #5a4228;border-radius:6px;pointer-events:auto';

/** Talent system v4 UI controller: launches the board scene and owns the DOM overlay (plan/confirm, trunk, jewels, ascendancy, tooltip, minimap). */
export class TalentBoardController {
  open = false; private scene?: TalentBoardScene; private root: HTMLDivElement; private plan: BoardPlan = emptyPlan();
  private hoverId: string | null = null; private hoverJewel: string | null = null; private mx = 0; private my = 0; private picked: string | null = null; private ascOpen = false; private msg = '';
  constructor(private host: Phaser.Scene, private sim: () => Sim, private onChange: () => void) {
    this.root = document.createElement('div'); this.root.id = 'talent-board-ui';
    Object.assign(this.root.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: '12', display: 'none', color: '#ddd', fontSize: '13px', userSelect: 'none', fontFamily: '"Noto Sans CJK TC", sans-serif' });
    document.body.appendChild(this.root);
  }
  setOpen(v: boolean): void {
    if (v === this.open) return; this.open = v; this.root.style.display = v ? 'block' : 'none';
    if (v) { this.host.scene.launch('talent-board', { ctrl: this }); this.host.scene.bringToTop('talent-board'); }
    else { this.host.scene.stop('talent-board'); this.scene = undefined; this.plan = emptyPlan(); this.picked = null; this.hoverId = null; this.ascOpen = false; this.msg = ''; }
    if (v) this.render();
  }
  toggle(): void { this.setOpen(!this.open); }
  attach(s: TalentBoardScene): void { this.scene = s; this.render(); }
  destroy(): void { this.root.remove(); }

  // ----- state helpers -----
  private get b() { return this.sim().build; }
  private total(): number { return this.b.pointsLeft() + boardPointsSpent(BOARD, this.b.s.board); }
  private merged() { return mergedState(this.b.s.board, this.plan); }
  private paid(): boolean { return this.sim().progress.level >= RESPEC_FREE_BEFORE(); }
  visuals(): Map<string, NodeVisual> {
    const cur = new Set(this.b.s.board.nodes); const m = this.merged(); const mm = new Set(m.nodes); const out = new Map<string, NodeVisual>();
    const left = this.total() - boardPointsSpent(BOARD, m);
    for (const n of BOARD.raw.nodes) {
      if (n.kind === 'start') { out.set(n.id, 'start'); continue; }
      out.set(n.id, this.plan.remove.includes(n.id) ? 'remove' : cur.has(n.id) ? 'on' : mm.has(n.id) ? 'plan' : canAllocNode(BOARD, m, n.id, { pointsLeft: left }).ok ? 'avail' : 'off');
    }
    return out;
  }
  highlights(): { socket: string | null; nodes: string[] } {
    const id = this.hoverId; const n = id ? BOARD.nodes.get(id) : undefined;
    if (!n || n.kind !== 'jewel') return { socket: null, nodes: [] };
    const j = this.pickedJewel() ?? this.socketed(n.id); if (!j) return { socket: n.id, nodes: [] };
    return { socket: n.id, nodes: previewConversion(BOARD, n.id, j, this.merged()).map((r) => r.id) };
  }
  private pickedJewel(): JewelItem | undefined { return this.b.s.board.jewels.find((j) => j.uid === this.picked); }
  private socketed(sock: string): JewelItem | undefined { const uid = this.b.s.board.sockets[sock]; return this.b.s.board.jewels.find((j) => j.uid === uid); }

  // ----- input from the scene -----
  hover(id: string | null, x: number, y: number): void { this.hoverId = id; this.hoverJewel = null; if (id) this.pointer(x, y); this.renderTip(); this.scene?.redraw(); }
  pointer(x: number, y: number): void { const r = this.host.game.canvas.getBoundingClientRect(); this.mx = x + r.left; this.my = y + r.top; this.placeTip(); }
  click(id: string, btn: 'left' | 'right'): void {
    const n = BOARD.nodes.get(id)!; const b = this.b; let r: { ok: boolean; reason?: string };
    if (n.kind === 'jewel' && btn === 'left' && this.picked) { r = b.socketJewel(id, this.picked); if (r.ok) { this.picked = null; this.after(); } }
    else if (n.kind === 'jewel' && btn === 'right' && this.socketed(id) && b.s.board.nodes.includes(id) && !this.plan.remove.includes(id)) { r = b.unsocketJewel(id); this.after(); }
    else if (btn === 'left') r = stageAddNode(BOARD, b.s.board, this.plan, id, this.total());
    else r = stageRemoveNode(BOARD, b.s.board, this.plan, id);
    this.msg = r.ok ? '' : `無法：${REASON[r.reason ?? ''] ?? r.reason}`; this.render();
  }
  cameraChanged(): void { this.drawMinimap(); const z = this.root.querySelector('#tb-zoom'); if (z && this.scene) z.textContent = `縮放 ${Math.round(this.scene.view().zoom * 100)}%`; this.placeTip(); }
  private after(): void { this.sim().refreshBuild(); this.onChange(); }

  // ----- DOM -----
  render(): void {
    const sim = this.sim(); const b = this.b; const lvl = sim.progress.level; const evo = sim.evoStage + 1; const m = this.merged();
    const left = this.total() - boardPointsSpent(BOARD, m); const lp = Math.min(BOARD.meta.totalPoints, lvl - 1); const dp = b.debug ? b.s.bonusPoints : 0;
    const cost = planCost(this.plan, this.paid());
    const trunk = [...BOARD.trunk.values()].map((t) => {
      const name = DMOVES.find((d) => d.id === t.move)?.name ?? t.move; const cur = b.s.board.moves[t.move] ?? 0; const r = m.moves[t.move] ?? 0; const locked = lvl < t.learnLevel;
      const pips = Array.from({ length: t.maxRank }, (_, i) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:3px;border:1px solid #c90;background:${i < cur ? '#ffb040' : i < r ? '#7fd8ff' : 'transparent'}"></span>`).join('');
      const eng = engineMoveId(t.move); const chosen = b.s.upgrades[eng]?.variant; const vs = DMOVES.find((d) => d.id === t.move)?.variants ?? [];
      const variant = cur >= t.variantAtRank ? `<div style="margin-top:3px;display:flex;gap:3px">${vs.map((v) => `<button data-var="${eng}|${v.id}" style="${BTN};padding:1px 6px;font-size:12px;${chosen === v.id ? 'background:#6a3a10;border-color:#ffb040' : ''}">${esc(v.name)}</button>`).join('')}</div>`
        : `<div style="color:#776;font-size:11px">第 ${t.variantAtRank} 級：二選一變體</div>`;
      return `<div style="padding:5px 8px;border-bottom:1px solid #3a2a1a;${locked ? 'opacity:.45' : ''}">
        <div style="display:flex;justify-content:space-between;align-items:center"><b style="color:#ffd27a">${esc(name)}</b><span style="font-size:11px;color:#a98">Lv${t.learnLevel}</span></div>
        <div style="display:flex;align-items:center;gap:4px;margin:2px 0">${pips}<button data-mv="${t.move}|-1" style="${BTN};padding:0 6px">−</button><button data-mv="${t.move}|1" style="${BTN};padding:0 6px">＋</button></div>
        <div style="font-size:11px;color:${r >= 2 ? '#f2e2c0' : '#776'}">第 2 級：${esc(t.enhance)}</div>${variant}</div>`;
    }).join('');
    const socketedUids = b.socketedUids();
    const jewels = b.s.board.jewels.map((j) => `<div data-jw="${j.uid}" style="${PANEL};cursor:pointer;display:flex;gap:6px;align-items:center;padding:4px 8px;min-width:120px;${this.picked === j.uid ? 'border-color:#ffe066;box-shadow:0 0 10px #ffe066' : ''}">
        <img src="${ART}jewels/jewel-${isLegendary(j) ? j.base : 'normal'}.png" style="width:30px;height:30px" draggable="false">
        <div style="font-size:12px;line-height:1.3"><b style="color:${isLegendary(j) ? '#ff9a3a' : '#9fd0ff'}">${esc(jewelName(j))}</b>${socketedUids.has(j.uid) ? ' <span style="color:#8c8;font-size:11px">已鑲嵌</span>' : ''}<br>
        <span style="color:#aaa">${isLegendary(j) ? '傳奇 · 轉換' : (j.affixes ?? []).map((a) => esc(fmtVal(a.value, a.effectType))).join('、')}</span></div></div>`).join('') || '<span style="color:#776;pointer-events:auto">尚無珠寶（地城掉落）</span>';
    const sum = [...this.plan.add.map((id) => `<span style="color:#9fe0ff">+${esc(split(BOARD.nodes.get(id)!.name).title)}</span>`), ...this.plan.remove.map((id) => `<span style="color:#ff9a8a">−${esc(split(BOARD.nodes.get(id)!.name).title)}</span>`),
      ...Object.entries(this.plan.moves).map(([mv, d]) => `<span style="color:${d > 0 ? '#9fe0ff' : '#ff9a8a'}">${d > 0 ? '+' : '−'}${esc(DMOVES.find((x) => x.id === mv)?.name ?? mv)}×${Math.abs(d)}</span>`)].join('、');
    this.root.innerHTML = `
      <div style="position:absolute;left:0;top:0;right:0;padding:8px 12px;background:#0d0805;border-bottom:1px solid #5a4228;display:flex;justify-content:space-between;align-items:center;gap:10px;pointer-events:none">
        <span style="pointer-events:auto"><b style="color:#ffc75a;font-size:16px">天賦盤</b> <span style="color:#a98">（T 關閉 · 左鍵規劃 · 右鍵退點 · 拖曳平移 · 滾輪縮放）</span></span>
        <span style="pointer-events:auto;display:flex;gap:8px;align-items:center">等級 ${lvl}−1 = <b>${lp}</b>${dp ? ` <span style="color:#8cf">除錯 +${dp}</span>` : ''} · 剩餘 <b id="tb-points" style="color:#ffd27a">${left}</b> · 灰燼碎片 ${b.s.ashShards} · 金幣 ${b.s.gold}
          <span id="tb-zoom" style="color:#9cf;min-width:72px">縮放 —</span>
          <button id="tb-fit" style="${BTN}">重置視角</button><button id="tb-asc" style="${BTN};${evo >= 3 ? 'border-color:#c9f;color:#e6c8ff' : 'opacity:.6'}">昇華 ${b.s.board.asc.length}/${ascPointsTotal(BOARD, lvl, evo)}</button>
          <button id="tb-reset" style="${BTN}">全部重置（${fullResetCost(lvl) || '免費'}${fullResetCost(lvl) ? ' 金' : ''}）</button></span></div>
      <div style="position:absolute;left:12px;top:46px;width:214px;${PANEL}"><div style="padding:6px 8px;color:#ffc75a;font-weight:bold;border-bottom:1px solid #5a4228">招式主幹 <span style="color:#a98;font-weight:normal;font-size:11px">（與盤面共用點數）</span></div>${trunk}</div>
      <canvas id="tb-mini" width="200" height="140" style="position:absolute;right:12px;top:46px;${PANEL};cursor:pointer"></canvas>
      <div style="position:absolute;left:240px;right:12px;bottom:10px;display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;pointer-events:none">
        <div style="pointer-events:auto;color:#ffc75a;font-weight:bold;margin-right:4px">珠寶${this.picked ? ' <span style="color:#ffe066;font-weight:normal">（點已點亮的珠寶孔鑲嵌）</span>' : ''}</div>${jewels}</div>
      ${this.msg ? `<div style="position:absolute;left:50%;top:44px;transform:translateX(-50%);color:#f88;${PANEL};padding:4px 10px">${esc(this.msg)}</div>` : ''}
      ${planEmpty(this.plan) ? '' : `<div id="tb-plan" style="position:absolute;right:12px;bottom:70px;width:330px;${PANEL};padding:8px 10px">
        <div style="font-size:12px;line-height:1.5"><b style="color:#7fd8ff">規劃中</b> ${sum}<br><span style="color:#cba">花費：灰燼碎片 ${cost.ashShards} · 金幣 ${cost.gold} · 點數 ${this.plan.add.length + Object.values(this.plan.moves).reduce((a, d) => a + Math.max(0, d), 0)}${planRefunds(this.plan) && !this.paid() ? '（Lv16 前退點免費）' : ''}</span></div>
        <div style="margin-top:6px;display:flex;gap:8px;justify-content:flex-end"><button id="tb-ok" style="${BTN};border-color:#c90">確認</button><button id="tb-cancel" style="${BTN}">取消</button></div></div>`}
      ${this.ascOpen ? this.ascHtml(lvl, evo) : ''}
      <div id="tb-tip"></div>`;
    this.wire(); this.renderTip(); this.cameraChanged(); this.scene?.redraw();
  }
  private ascHtml(lvl: number, evo: number): string {
    const b = this.b; const s = b.s.board; const tot = ascPointsTotal(BOARD, lvl, evo);
    const col = (entry: string, kids: string[]) => {
      const node = (id: string, big: boolean) => {
        const a = BOARD.asc.get(id)!; const on = s.asc.includes(id); const can = canAllocAsc(BOARD, s, id, { level: lvl, evoStage: evo }).ok; const sz = big ? 92 : 64;
        return `<div data-asc="${id}" data-tipasc="${id}" style="position:relative;width:${sz}px;height:${sz}px;cursor:pointer;margin:0 auto">
          <img src="${ART}ascendancy/asc-${id}.png" style="position:absolute;left:${sz * 0.2}px;top:${sz * 0.2}px;width:${sz * 0.6}px;height:${sz * 0.6}px;border-radius:50%;${on ? 'box-shadow:0 0 14px 4px rgba(230,120,255,.8)' : can ? '' : 'filter:grayscale(1) brightness(.55)'}" draggable="false">
          <img src="${ART}talent-frame-ascendancy.png" style="position:absolute;inset:0;width:${sz}px;height:${sz}px;${on || can ? '' : 'filter:brightness(.6)'}" draggable="false">
          <div style="position:absolute;top:${sz}px;left:-30px;right:-30px;text-align:center;font-size:12px;color:${on ? '#e6c8ff' : '#aaa'}">${esc(a.name)}</div></div>`;
      };
      const e = BOARD.asc.get(entry)!;
      return `<div style="flex:1;text-align:center"><div style="color:#e6c8ff;font-size:20px;font-weight:bold;margin-bottom:6px">${esc(e.name)}</div>${node(entry, true)}
        <div style="font-size:12px;color:#cbb;margin:22px 8px 10px;min-height:34px">${esc(e.desc ?? '')}</div><div style="display:flex;justify-content:space-around">${kids.map((k) => node(k, false)).join('')}</div></div>`;
    };
    const fw = BOARD.raw.ascendancy.filter((a) => a.id.startsWith('asc_fw')).map((a) => a.id); const db = BOARD.raw.ascendancy.filter((a) => a.id.startsWith('asc_db')).map((a) => a.id);
    return `<div id="tb-ascp" style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:640px;${PANEL};padding:14px 16px 30px;background:rgba(18,10,24,.97);border-color:#7a4a9a">
      <div style="display:flex;justify-content:space-between;margin-bottom:10px"><b style="color:#e6c8ff;font-size:17px">進化昇華</b><span>昇華點 <b style="color:#e6c8ff">${s.asc.length}/${tot}</b>（Lv36/42/48 各 1 點 · 二選一 · 入口即主效果）<button id="tb-ascx" style="${BTN};margin-left:8px">關閉</button></span></div>
      ${evo < 3 ? '<div style="color:#a98;text-align:center;margin:6px 0 10px">進化成噴火龍後解鎖</div>' : ''}
      <div style="display:flex;gap:20px">${col('asc_flame_wing', fw.filter((x) => x !== 'asc_flame_wing'))}<div style="width:1px;background:#5a3a6a"></div>${col('asc_dragon_blood', db.filter((x) => x !== 'asc_dragon_blood'))}</div></div>`;
  }
  private wire(): void {
    const $ = (s: string) => this.root.querySelector<HTMLElement>(s); const b = this.b; const sim = this.sim();
    $('#tb-ok')?.addEventListener('click', () => { const r = applyPlan(b, this.plan, this.paid()); this.msg = r.ok ? '' : `無法：${REASON[r.reason ?? ''] ?? r.reason}`; if (r.ok) this.plan = emptyPlan(); this.after(); this.render(); });
    $('#tb-cancel')?.addEventListener('click', () => { this.plan = emptyPlan(); this.msg = ''; this.render(); });
    $('#tb-fit')?.addEventListener('click', () => this.scene?.resetView());
    $('#tb-asc')?.addEventListener('click', () => { this.ascOpen = !this.ascOpen; this.render(); });
    $('#tb-ascx')?.addEventListener('click', () => { this.ascOpen = false; this.render(); });
    $('#tb-reset')?.addEventListener('click', () => { this.plan = emptyPlan(); const r = b.fullReset(); this.msg = r.ok ? '' : `無法：${REASON[r.reason ?? ''] ?? r.reason}`; this.after(); this.render(); });
    this.root.querySelectorAll<HTMLElement>('[data-mv]').forEach((e) => e.addEventListener('click', () => {
      const [mv = '', d = '1'] = (e.dataset.mv ?? '').split('|'); const r = stageMove(BOARD, b.s.board, this.plan, mv, Number(d) > 0 ? 1 : -1, { level: sim.progress.level, total: this.total() });
      this.msg = r.ok ? '' : `無法：${REASON[r.reason ?? ''] ?? r.reason}`; this.render(); }));
    this.root.querySelectorAll<HTMLElement>('[data-var]').forEach((e) => e.addEventListener('click', () => {
      const [eng = '', v = ''] = (e.dataset.var ?? '').split('|'); b.chooseUpgrade(eng, 'variant', b.s.upgrades[eng]?.variant === v ? null : v); this.after(); this.render(); }));
    this.root.querySelectorAll<HTMLElement>('[data-jw]').forEach((e) => {
      const uid = e.dataset.jw ?? '';
      e.addEventListener('click', () => { this.picked = this.picked === uid ? null : uid; this.render(); });
      e.addEventListener('mouseenter', (ev) => { this.hoverJewel = uid; this.hoverId = null; this.mx = ev.clientX; this.my = ev.clientY; this.renderTip(); });
      e.addEventListener('mousemove', (ev) => { this.mx = ev.clientX; this.my = ev.clientY; this.placeTip(); });
      e.addEventListener('mouseleave', () => { this.hoverJewel = null; this.renderTip(); });
    });
    this.root.querySelectorAll<HTMLElement>('[data-asc]').forEach((e) => {
      const id = e.dataset.asc ?? '';
      e.addEventListener('click', () => { const r = b.allocAsc(id); this.msg = r.ok ? '' : `無法：${REASON[r.reason ?? ''] ?? r.reason}`; this.after(); this.render(); });
      e.addEventListener('contextmenu', (ev) => { ev.preventDefault(); const r = b.refundAsc(id); this.msg = r.ok ? '' : `無法：${REASON[r.reason ?? ''] ?? r.reason}`; this.after(); this.render(); });
      e.addEventListener('mouseenter', (ev) => { this.hoverId = `asc:${id}`; this.mx = ev.clientX; this.my = ev.clientY; this.renderTip(); });
      e.addEventListener('mouseleave', () => { this.hoverId = null; this.renderTip(); });
    });
    const mini = $('#tb-mini') as HTMLCanvasElement | null;
    mini?.addEventListener('click', (ev) => { const r = mini.getBoundingClientRect(); const w = this.miniMap(); this.scene?.centerOn(w.x0 + (ev.clientX - r.left) / w.k, w.y0 + (ev.clientY - r.top) / w.k); });
  }
  private miniMap() { const xs = BOARD.raw.nodes.map((n) => n.pos.x), ys = BOARD.raw.nodes.map((n) => n.pos.y); const x0 = Math.min(...xs) - 60, y0 = Math.min(...ys) - 60, x1 = Math.max(...xs) + 60, y1 = Math.max(...ys) + 60; const k = Math.min(200 / (x1 - x0), 140 / (y1 - y0)); return { x0, y0, k }; }
  private drawMinimap(): void {
    const c = this.root.querySelector<HTMLCanvasElement>('#tb-mini'); const ctx = c?.getContext('2d'); if (!c || !ctx || !this.scene) return;
    const { x0, y0, k } = this.miniMap(); const P = (x: number, y: number) => [(x - x0) * k, (y - y0) * k] as const; const vis = this.visuals();
    ctx.clearRect(0, 0, c.width, c.height); ctx.strokeStyle = 'rgba(140,110,80,.5)'; ctx.lineWidth = 1;
    for (const [a, b] of BOARD.raw.edges) { const A = BOARD.nodes.get(a)!.pos, B2 = BOARD.nodes.get(b)!.pos; ctx.beginPath(); ctx.moveTo(...P(A.x, A.y)); ctx.lineTo(...P(B2.x, B2.y)); ctx.stroke(); }
    for (const n of BOARD.raw.nodes) { const v = vis.get(n.id); ctx.fillStyle = v === 'on' || v === 'start' ? '#ffa030' : v === 'plan' ? '#7fd8ff' : n.kind === 'jewel' ? '#6fa8ff' : '#6a5a4a'; const [x, y] = P(n.pos.x, n.pos.y); ctx.beginPath(); ctx.arc(x, y, n.kind === 'small' ? 1.6 : 2.6, 0, 7); ctx.fill(); }
    const v = this.scene.view(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; const [vx, vy] = P(v.x, v.y); ctx.strokeRect(vx, vy, v.w * k, v.h * k);
  }

  // ----- tooltip -----
  private renderTip(): void {
    const w = this.root.querySelector<HTMLDivElement>('#tb-tip'); if (!w) return; const html = this.tipHtml();
    w.innerHTML = html ? `<div id="tb-tipbox" style="position:fixed;left:-9999px;top:0;width:340px;box-sizing:border-box;padding:24px 28px 20px;pointer-events:none;opacity:.94;z-index:20;
      border:44px solid transparent;border-image:url(${ART}talent-frame-tooltip.png) 90 fill / 44px stretch;margin:-44px">${html}</div>` : ''; this.placeTip();
  }
  private placeTip(): void {
    const t = this.root.querySelector<HTMLDivElement>('#tb-tipbox'); if (!t) return; const W = window.innerWidth, H = window.innerHeight; const tw = t.offsetWidth, th = t.offsetHeight, OFF = 18;
    let x = this.mx + OFF; if (x + tw > W - 8) x = this.mx - OFF - tw; let y = this.my + OFF; if (y + th > H - 8) y = this.my - OFF - th;
    t.style.left = `${Math.max(8, x) + 44}px`; t.style.top = `${Math.max(8, Math.min(H - 8 - th, y)) + 44}px`;
  }
  private tipHtml(): string {
    const b = this.b; const sim = this.sim(); const s = b.s.board; const m = this.merged();
    const line = (t: string, c = '#f2e2c0', extra = '') => `<div style="color:${c};${extra}">${t}</div>`;
    const head = (title: string, sub: string) => `<div style="text-align:center;color:#ffc75a;font-size:17px;font-weight:bold">${esc(title)}</div><div style="text-align:center;color:#a99;font-size:11px;margin:2px 0 8px">${esc(sub)}</div>`;
    if (this.hoverJewel) {
      const j = s.jewels.find((x) => x.uid === this.hoverJewel); if (!j) return '';
      return head(jewelName(j), isLegendary(j) ? '傳奇珠寶 · 轉換型' : '珠寶 · 數值詞綴') + (isLegendary(j) ? line(esc(LEG.get(j.base)?.rule ?? '')) + line('只轉換範圍內已點亮的小型天賦；轉換後仍套用上限', '#a99', 'font-size:11px;margin-top:4px')
        : (j.affixes ?? []).map((a) => line(esc(fmtVal(a.value, a.effectType)))).join('')) + line(this.picked === j.uid ? '已選取：點擊已點亮的珠寶孔鑲嵌' : '點擊選取後鑲嵌到珠寶孔', '#7fd8ff', 'margin-top:8px');
    }
    if (this.hoverId?.startsWith('asc:')) {
      const a = BOARD.asc.get(this.hoverId.slice(4))!; const on = s.asc.includes(a.id); const r = canAllocAsc(BOARD, s, a.id, { level: sim.progress.level, evoStage: sim.evoStage + 1 });
      return head(a.name, `昇華 · ${a.entry ? '入口（主效果）' : '強化'}`) + (a.desc ? line(esc(a.desc), '#ddd') : '') + line(esc(effText(a))) +
        line(on ? '已習得' : r.ok ? '點擊習得（消耗 1 昇華點）' : s.asc.some((x) => ascTree(x) !== ascTree(a.id)) ? '已選擇另一個昇華' : ASC_REASON[r.reason ?? ''] ?? r.reason ?? '', on ? '#7fe07f' : r.ok ? '#ccc' : '#9a948c', 'margin-top:10px');
    }
    const id = this.hoverId; if (!id) return ''; const n = BOARD.nodes.get(id); if (!n) return '';
    const { title, desc } = split(n.name); let body = '';
    if (n.kind === 'jewel') {
      const sj = this.socketed(n.id); const pj = this.pickedJewel();
      body += sj ? line(`已鑲嵌：<b>${esc(jewelName(sj))}</b>`, '#9fd0ff') + (isLegendary(sj) ? '' : (sj.affixes ?? []).map((a) => line(esc(fmtVal(a.value, a.effectType)))).join('')) : line('空的珠寶孔', '#a99');
      const j = pj ?? sj;
      if (j && isLegendary(j)) {
        const rows = previewConversion(BOARD, n.id, j, m);
        body += line(`${pj ? '插入預覽' : '轉換'}（${esc(jewelName(j))}）：範圍內 ${rows.length} 個小型天賦`, '#ffe066', 'margin-top:6px');
        body += rows.length ? rows.map((r) => convRow(r)).join('') : line('範圍內沒有可轉換的小型天賦', '#9a948c', 'font-size:12px');
      } else if (pj) body += line('數值珠寶：詞綴直接生效，不轉換節點', '#a99', 'font-size:12px;margin-top:6px');
      body += line(pj ? (m.nodes.includes(n.id) ? '左鍵鑲嵌' : '需要先點亮此珠寶孔') : sj ? '右鍵取下珠寶' : '選取下方珠寶後點擊鑲嵌', '#7fd8ff', 'margin-top:8px');
    } else {
      if (desc && !isTplEffect(n.effectType)) body += line(esc(desc), '#ddd', 'margin-bottom:3px');
      const live = conversionsFor(BOARD, m).get(n.id) ?? this.inRadiusConversion(n.id, m);
      const eff: Effect = { effectType: n.effectType, value: n.value };
      if (live) {
        body += line(`<s style="color:#887">${esc(effText(eff))}</s>`); body += live.after.map((e) => line('→ ' + esc(effText(e)), live.active ? '#9fe08f' : '#8fa88a')).join('');
        body += line(`（${esc(jewelName(s.jewels.find((x) => x.uid === live.jewel)!))}${live.active ? '' : '：點亮後生效'}）`, '#a99', 'font-size:11px');
      } else if (n.effectType !== 'keystone' && n.effectType !== 'none') { const t = effectLine(asNode(n.id, eff), m.nodes.includes(n.id) ? 1 : 0); if (t) body += line(esc(t)); }
      const cl = n.effectType !== 'keystone' && !live ? capLine(asNode(n.id, eff), sim.bon, sim.mech, (sim.player.hp ?? 1) / Math.max(1, sim.player.maxHp ?? 1)) : '';
      if (cl) body += line(esc(cl), cl.includes('已達上限') ? '#ffb070' : '#b8ab98', 'font-size:12px;margin-top:2px');
      if (n.drawback) body += line(`代價：${esc(n.drawback)}`, '#ff5a4a', 'margin-top:4px');
      body += this.statusLine(n, m);
    }
    return head(title, `${KIND[n.kind]}${n.branch ? ` · ${n.branch}` : ''}`) + body;
  }
  private inRadiusConversion(id: string, m: ReturnType<TalentBoardController['merged']>): Conversion | undefined {
    for (const [sock, uid] of Object.entries(m.sockets)) { const j = m.jewels.find((x) => x.uid === uid); if (!j || !(BOARD.socketRadius.get(sock) ?? []).includes(id)) continue; const r = previewConversion(BOARD, sock, j, m).find((x) => x.id === id); if (r) return { ...r, active: r.active && m.nodes.includes(sock) }; }
    return undefined;
  }
  private statusLine(n: BoardNode, m: ReturnType<TalentBoardController['merged']>): string {
    const st = (t: string, c: string) => `<div style="color:${c};margin-top:10px">${esc(t)}</div>`;
    if (n.kind === 'start') return st('起點（免費）', '#7fe07f');
    if (this.plan.add.includes(n.id)) return st('規劃中（待確認）', '#7fd8ff');
    if (this.plan.remove.includes(n.id)) return st('將退點（待確認）', '#7fd8ff');
    if (m.nodes.includes(n.id)) { const r = canRefundNode(BOARD, m, n.id); return st(r.ok ? '已習得 · 右鍵規劃退點' : r.reason === 'requiredBy' ? '已習得 · 基石需要此節點，無法退點' : '已習得 · 退點會讓其他節點斷開', r.ok ? '#7fe07f' : '#9a948c'); }
    const r = canAllocNode(BOARD, m, n.id, { pointsLeft: this.total() - boardPointsSpent(BOARD, m) }); if (r.ok) return st('左鍵規劃配點', '#ccc');
    if (r.reason === 'requires') return st(`需要先點：${(n.requires ?? []).filter((x) => !m.nodes.includes(x)).map((x) => split(BOARD.nodes.get(x)!.name).title).join('、')}`, '#9a948c');
    if (r.reason === 'points') return st(`需要等級 ${this.sim().progress.level + 1}`, '#9a948c');
    return st(REASON[r.reason ?? ''] ?? r.reason ?? '', '#9a948c');
  }
}
const convRow = (r: Conversion): string => `<div style="font-size:12px;margin-top:2px;color:${r.active ? '#e8f0d8' : '#a8a89a'}">· ${esc(split(BOARD.nodes.get(r.id)!.name).title)}：<s style="color:#887">${esc(effText(r.before))}</s> → ${r.after.map((e) => esc(effText(e))).join(' + ')}${r.active ? '' : ' <span style="color:#887">（未點亮）</span>'}</div>`;
const REASON: Record<string, string> = {
  notAdjacent: '需要先連到已點亮的節點', requires: '需要先點前置節點', exclusive: '已選擇其他關鍵天賦', points: '點數不足', allocated: '已點亮', disconnects: '退點會讓其他節點斷開',
  requiredBy: '基石需要此節點', start: '起點不可變更', ashShard: '灰燼碎片不足', gold: '金幣不足', level: '等級不足', maxRank: '已達最高級', free: '基本攻擊至少保留 1 級',
  socketNotAllocated: '需要先點亮珠寶孔', notSocket: '不是珠寶孔', noJewel: '沒有這顆珠寶', notAllocated: '尚未點亮', empty: '珠寶孔是空的',
};
const ASC_REASON: Record<string, string> = { evoStage: '進化成噴火龍後解鎖', points: '昇華點不足（Lv36/42/48 各 1 點）', requires: '需要先點入口節點', exclusive: '已選擇另一個昇華', allocated: '已習得' };

const ascTree = (id: string): string => (id === 'asc_flame_wing' || id.startsWith('asc_fw') ? 'fw' : 'db');
