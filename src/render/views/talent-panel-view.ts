import type { Sim } from '../../core/sim';
import { TALENTS, fullResetCost, RESPEC_FREE_BEFORE } from '../../core/build/build';
import DIRECTOR from '../../data/build/charmander-moves-gems.json';
for (const mv of (DIRECTOR as unknown as { moves: { id: string; name?: string }[] }).moves) MOVE_NAMES[mv.id] ??= mv.name ?? mv.id;
import { isImplemented, levelPoints, debugPoints, type Alloc, type TalentNode } from '../../core/build/talents';
import { capLine, isTplEffect, MOVE_NAMES, TPL_EXTRA, nodeKind, KIND_LABEL, splitName, effectLine, merged, stageAdd, stageRemove, pendingAdds, pendingRefunds, planCost, statusLine, type NodeKind } from '../../core/build/talent-plan';
import LABELS from '../../data/build/talent-labels.json';

export const fmtVal = (v: number | string, t: string): string => {
  const l = (LABELS as unknown as Record<string, { label: string; fmt: string }>)[t]; if (!l) return `${t} ${v}`;
  if (l.fmt === 'none') return ''; if (l.fmt === 'flag' || typeof v !== 'number') return l.label;
  const x = l.fmt === 'frac' ? Math.round(v * 1000) / 10 : v; return `${l.label} ${x > 0 ? '+' : ''}${x}${l.fmt === 'pct' || l.fmt === 'frac' ? '%' : ''}`;
};

const UI = TALENTS.meta.ui ?? {};
const ART = 'assets/hud/talents/';
const W = 1280, H = 720;
const SIZE: Record<NodeKind, number> = { small: 50, notable: 64, keystone: 96, root: 66 };
const FRAME: Record<NodeKind, string> = { small: 'small', notable: 'notable', keystone: 'keystone', root: 'notable' };
const COLX = [300, 640, 980];
// rows (bottom→top growth): root, T1 pair, T1 mid, T2 pair, T2 mid, T3 pair, keystone
const ROWY = { ks: 112, t3: 198, t2mid: 250, t2: 302, t1mid: 354, t1: 406, root: 486 };
const TITLE_CSS = 'color:#ffc75a;font-size:22px;font-weight:bold;letter-spacing:2px;text-shadow:0 0 8px #a50';
const BUS_Y = 448; // orthogonal 'bus' between root and the T1 row (elbow connectors)
const UTIL_ROWS = [530, 578, 626], UTIL_X0 = 112, UTIL_DX = 102;

/** Utility branch (meta.ui.utilityBranchLayout): subtrees hang off root and spread left/right horizontally below the main branches.
 *  Tier-1 subtrees are balanced across sides; depth -> x step outward; each leaf path gets its own row. */
function utilityLayout(nodes: TalentNode[], util: Set<string>): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>(); const kids = (id: string) => nodes.filter((c) => util.has(c.id) && c.requires.includes(id) && !c.uiPlacement);
  const size = (id: string): number => 1 + kids(id).reduce((s, c) => s + size(c.id), 0);
  const roots = nodes.filter((n) => util.has(n.id) && !n.uiPlacement && n.requires.every((r) => !util.has(r)));
  const sides: [TalentNode[], TalentNode[]] = [[], []]; const tot = [0, 0];
  for (const t of roots) { const i = tot[0]! <= tot[1]! ? 0 : 1; sides[i]!.push(t); tot[i]! += size(t.id); }
  sides.forEach((list, si) => { let row = 0; const dir = si === 0 ? -1 : 1;
    const place = (n: TalentNode, depth: number): void => { const r0 = row; const ks = kids(n.id); out.set(n.id, { x: W / 2 + dir * (UTIL_X0 + depth * UTIL_DX), y: UTIL_ROWS[Math.min(r0, UTIL_ROWS.length - 1)]! });
      if (!ks.length) { row++; return; } ks.forEach((c) => place(c, depth + 1)); };
    list.forEach((t) => place(t, 0)); });
  return out;
}
function center(n: TalentNode, branches: string[]): { x: number; y: number } {
  if (n.branch === 'core') return { x: W / 2, y: ROWY.root };
  const x = COLX[branches.indexOf(n.branch)] ?? W / 2; const k = nodeKind(n);
  if (k === 'keystone') return { x, y: UI.keystonePinnedTop === false ? ROWY.root - 80 : ROWY.ks };
  const sub = n.id.endsWith('_0') ? -1 : n.id.endsWith('_1') ? 1 : 0;
  const y = k === 'notable' ? (n.tier === 1 ? ROWY.t1mid : ROWY.t2mid) : n.tier === 1 ? ROWY.t1 : n.tier === 2 ? ROWY.t2 : ROWY.t3;
  return { x: x + sub * 66, y };
}

/** PoE/D4-style talent tree (key T). Click stages, right-click un-stages/refunds; Confirm applies. */
export class TalentPanelView {
  private el: HTMLDivElement; open = false; private msg = ''; private pend: Alloc = {}; private hover: string | null = null;
  constructor(private sim: () => Sim, private onChange: () => void) {
    this.el = document.createElement('div'); this.el.id = 'talent-panel';
    Object.assign(this.el.style, { position: 'fixed', left: '50%', top: '50%', width: `${W}px`, height: `${H}px`, transform: 'translate(-50%,-50%)', display: 'none', zIndex: '12',
      userSelect: 'none', color: '#ddd', fontSize: '13px', background: 'radial-gradient(ellipse at 50% 55%, rgba(52,26,12,.97), rgba(10,6,4,.99) 70%)', backgroundColor: 'rgba(10,6,4,.96)', overflow: 'hidden' });
    document.body.appendChild(this.el);
  }
  setOpen(v: boolean): void { this.open = v; if (!v) { this.pend = {}; this.hover = null; } this.el.style.display = v ? 'block' : 'none'; if (v) this.render(); }
  toggle(): void { this.setOpen(!this.open); }
  render(): void {
    const sim = this.sim(); TPL_EXTRA.limit = sim.mech.onKillCdRefundMaxSecPerSec; const b = sim.build; const a = b.s.talents; const lvl = sim.progress.level; const ctx = b.tctx();
    const m = merged(a, this.pend);
    const branches = [...new Set(TALENTS.nodes.filter((n) => n.effectType === 'keystone').map((n) => n.branch))]; // main columns = branches with a keystone
    const nodes = TALENTS.nodes.filter((n) => !(UI.hideUnimplemented && !isImplemented(n)));
    const util = new Set(nodes.filter((n) => n.branch !== 'core' && !branches.includes(n.branch)).map((n) => n.id));
    const pos = new Map(nodes.filter((n) => !util.has(n.id)).map((n) => [n.id, center(n, branches)]));
    for (const [id, p] of utilityLayout(nodes, util)) pos.set(id, p);
    for (const n of nodes) if (n.uiPlacement?.startsWith('between:')) { const [x, y] = n.uiPlacement.slice(8).split('|').map((id) => pos.get(id)); if (x && y) pos.set(n.id, { x: (x.x + y.x) / 2, y: (x.y + y.y) / 2 }); }
    const st = (id: string): 'on' | 'plan' | 'off' => ((a[id] ?? 0) > 0 && (m[id] ?? 0) > 0 ? 'on' : (m[id] ?? 0) > 0 ? 'plan' : 'off');
    const lines = UI.drawPrereqLines === false ? '' : nodes.flatMap((n) => [...n.requires, ...(n.requiresAny ?? [])].filter((r) => pos.has(r)).map((r) => {
      const p = pos.get(n.id)!, q = pos.get(r)!; const s1 = st(n.id), s2 = st(r);
      const on = s1 !== 'off' && s2 !== 'off'; const plan = on && (s1 === 'plan' || s2 === 'plan');
      // root -> main-branch T1: elbow via the bus so no long diagonal crosses other nodes
      const elbow = r === 'root' && !util.has(n.id) ? `${q.x},${q.y} ${q.x},${BUS_Y} ${p.x},${BUS_Y} ${p.x},${p.y}` : '';
      return `<${elbow ? `polyline fill="none" stroke-linejoin="round" points="${elbow}"` : `line x1="${q.x}" y1="${q.y}" x2="${p.x}" y2="${p.y}"`} stroke="${plan ? '#7fd8ff' : on ? '#f0a83a' : '#5a4a3a'}" stroke-width="${on ? 4 : 2.5}" ${plan ? 'stroke-dasharray="8 6"' : ''} ${on ? 'filter="url(#tglow)"' : 'opacity=".75"'}/>`;
    })).join('');
    const badge = (n: TalentNode): string => {
      const p = pos.get(n.id)!; const k = nodeKind(n); const s = SIZE[k]; const r = m[n.id] ?? 0; const state = st(n.id);
      const icon = s * (k === 'keystone' ? 0.5 : 0.58);
      const refund = (this.pend[n.id] ?? 0) < 0;
      const ring = refund ? 'border:2px dashed #ff6a5a;box-shadow:0 0 12px 3px rgba(255,90,70,.65);animation:tpPulse 1s ease-in-out infinite alternate;' : state === 'on' ? `box-shadow:0 0 14px 4px rgba(255,140,30,.85), inset 0 0 10px rgba(255,160,40,.6);border:2px solid #ffb040;`
        : state === 'plan' ? 'border:2px dashed #7fd8ff;box-shadow:0 0 12px 3px rgba(110,200,255,.6);animation:tpPulse 1s ease-in-out infinite alternate;' : '';
      const grey = state === 'off' ? 'filter:grayscale(1) brightness(.6);' : '';
      const rank = k === 'root' || k === 'keystone' && n.maxRank === 1 ? '' : `<div style="position:absolute;left:${p.x + s / 2 - 10}px;top:${p.y + s / 2 - 12}px;font:bold 14px sans-serif;color:${r ? '#ffe2a0' : '#d8d0c4'};background:rgba(8,5,3,.82);border:1px solid ${r ? '#a0702a' : '#4a4038'};border-radius:8px;padding:0 5px;line-height:17px;text-shadow:0 0 2px #000">${r}/${n.maxRank}</div>`;
      return `<div data-node="${n.id}" style="position:absolute;left:${p.x - s / 2}px;top:${p.y - s / 2}px;width:${s}px;height:${s}px;cursor:pointer">
        <div style="position:absolute;left:${(s - icon) / 2}px;top:${(s - icon) / 2}px;width:${icon}px;height:${icon}px;border-radius:50%;${ring}"></div>
        <img src="${ART}icons/talent-${n.id}.png" onerror="this.onerror=null;this.src='${ART}icons/talent-root.png';this.style.opacity='.35'" style="position:absolute;left:${(s - icon) / 2}px;top:${(s - icon) / 2}px;width:${icon}px;height:${icon}px;border-radius:50%;${grey}" draggable="false">
        <img src="${ART}talent-frame-${FRAME[k]}.png" style="position:absolute;left:0;top:0;width:${s}px;height:${s}px;${state === 'off' ? 'filter:brightness(.55) saturate(.6);' : ''}" draggable="false">
      </div>${rank}`;
    };
    const tip = (): string => {
      const n = nodes.find((x) => x.id === this.hover); if (!n) return '';
      const p = pos.get(n.id)!; const k = nodeKind(n); const { title, desc } = splitName(n); const eff = effectLine(n, m[n.id] ?? 0); const cl = capLine(n, sim.bon, sim.mech, (sim.player.hp ?? 1) / Math.max(1, sim.player.maxHp ?? 1));
      const sl = statusLine(TALENTS, a, this.pend, n, ctx); const col = { ok: '#7fe07f', plan: '#7fd8ff', bad: '#9a948c', hint: '#ccc' }[sl.tone];
      void p;
      return `<div id="tp-tip" style="position:absolute;left:-9999px;top:0;opacity:.9;width:330px;box-sizing:border-box;padding:26px 30px 22px;pointer-events:none;
        border:44px solid transparent;border-image:url(${ART}talent-frame-tooltip.png) 90 fill / 44px stretch;margin:-44px">
        <div style="text-align:center;color:#ffc75a;font-size:17px;font-weight:bold">${title}</div>
        <div style="text-align:center;color:#a99;font-size:11px;margin:2px 0 8px">${KIND_LABEL[k]}${n.branch !== 'core' ? ` · ${n.branch}` : ''}</div>
        ${desc && !(eff && isTplEffect(n.effectType)) ? `<div style="margin-bottom:4px">${desc}</div>` : ''}${eff ? `<div style="color:#f2e2c0">${eff}</div>` : ''}${cl ? `<div style="color:${cl.includes('已達上限') ? '#ffb070' : '#b8ab98'};font-size:12px;margin-top:3px">${cl}</div>` : ''}
        ${n.drawback ? `<div style="color:#ff5a4a;margin-top:4px">代價：${n.drawback}</div>` : ''}
        <div style="color:${col};margin-top:10px">${sl.text}</div></div>`;
    };
    const lp = levelPoints(TALENTS, lvl), dp = debugPoints(TALENTS, ctx), left = b.pointsLeft() - pendingAdds(this.pend) + pendingRefunds(this.pend);
    const paid = lvl >= RESPEC_FREE_BEFORE(); const cost = planCost(this.pend, paid); const anyPend = Object.keys(this.pend).length > 0;
    const sum = Object.entries(this.pend).map(([id, d]) => { const n = TALENTS.nodes.find((x) => x.id === id)!; const e = typeof n.value === 'object' ? '' : fmtVal(typeof n.value === 'number' ? n.value * d : n.value, n.effectType);
      return `<span style="color:${d > 0 ? '#9fe0ff' : '#ff9a8a'}">${d > 0 ? '+' : '−'}${splitName(n).title}${Math.abs(d) > 1 ? `×${Math.abs(d)}` : ''}${e && n.effectType !== 'keystone' ? `（${e}）` : ''}</span>`; }).join('、');
    const btn = 'background:#2a1a10;color:#ffc75a;border:1px solid #8a6a3a;padding:4px 12px;cursor:pointer;font-size:13px';
    this.el.innerHTML = `<style>@keyframes tpPulse{from{opacity:.55}to{opacity:1}}</style>
      <svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;pointer-events:none"><defs><filter id="tglow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${lines}</svg>
      ${branches.map((br, i) => `<div style="position:absolute;left:${(COLX[i] ?? 0) - 120}px;top:34px;width:240px;text-align:center;${TITLE_CSS}">${br}</div>`).join('')}
      <div style="position:absolute;left:16px;top:10px;right:16px;display:flex;justify-content:space-between;color:#cba">
        <span><b style="color:#ffc75a">天賦樹</b>（T 關閉 · 左鍵規劃 · 右鍵退點/取消）</span>
        <span>等級 ${lvl}−1 = <b>${lp}</b>${b.debug && dp ? ` <span style="color:#8cf">除錯 +${dp}</span>` : ''} · 灰燼碎片 ${b.s.ashShards} · 金幣 ${b.s.gold}
        <button id="tp-reset" style="${btn};margin-left:8px">全部重置（${fullResetCost(lvl) || '免費'}${fullResetCost(lvl) ? ' 金' : ''}）</button></span></div>
      ${util.size ? `<div style="position:absolute;left:${W / 2 - 120}px;top:${Math.max(...[...pos.entries()].filter(([id]) => util.has(id)).map(([, q]) => q.y)) + 34}px;width:240px;text-align:center;${TITLE_CSS}">${[...new Set(nodes.filter((n) => util.has(n.id)).map((n) => n.branch))][0] ?? '通用'}</div>` : ''}
      ${nodes.map(badge).join('')}
      <div style="position:absolute;left:24px;bottom:18px;font-size:17px;color:#e8d6b0">剩餘點數 <b id="tp-points" style="color:#ffd27a">${left}</b>${this.msg ? ` <span style="font-size:13px;color:#f88">${this.msg}</span>` : ''}</div>
      ${anyPend ? `<div id="tp-plan" style="position:absolute;right:12px;bottom:12px;width:310px;flex-wrap:wrap;background:rgba(14,10,8,.92);border:1px solid #6a5232;padding:8px 12px;display:flex;gap:12px;align-items:center">
        <div style="font-size:12px;line-height:1.5"><b style="color:#7fd8ff">規劃中</b> ${sum}<br><span style="color:#cba">花費：灰燼碎片 ${cost.ashShards} · 金幣 ${cost.gold} · 點數 ${pendingAdds(this.pend)}</span></div>
        <button id="tp-ok" style="${btn};border-color:#c90">確認</button><button id="tp-cancel" style="${btn}">取消</button></div>` : ''}
      <div id="tp-tipwrap">${tip()}</div>`;
    this.tipFn = tip;
    this.el.querySelectorAll<HTMLDivElement>('[data-node]').forEach((d) => {
      const id = d.dataset.node ?? '';
      d.addEventListener('click', () => this.after(stageAdd(TALENTS, a, this.pend, id, ctx)));
      d.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.after(stageRemove(TALENTS, a, this.pend, id)); });
      d.addEventListener('mouseenter', () => { this.hover = id; this.renderTip(); });
      d.addEventListener('mouseleave', () => { if (this.hover === id) { this.hover = null; this.renderTip(); } });
    });
    this.el.onmousemove = (ev) => { const b = this.el.getBoundingClientRect(); this.mx = ev.clientX - b.left; this.my = ev.clientY - b.top; if (this.hover) this.placeTip(); };
    this.placeTip();
    this.el.querySelector('#tp-ok')?.addEventListener('click', () => this.confirm());
    this.el.querySelector('#tp-cancel')?.addEventListener('click', () => { this.pend = {}; this.msg = ''; this.render(); });
    this.el.querySelector('#tp-reset')?.addEventListener('click', () => { this.pend = {}; const r = b.fullReset(); this.msg = r.ok ? '' : `無法：${r.reason}`; this.sim().refreshBuild(); this.onChange(); this.render(); });
  }
  private tipFn: () => string = () => '';
  private mx = 0; private my = 0;
  private renderTip(): void { const w = this.el.querySelector('#tp-tipwrap'); if (w) { w.innerHTML = this.tipFn(); this.placeTip(); } }
  /** Follow cursor with an offset; flip at edges; prefer staying below the branch titles (y >= 84). */
  private placeTip(): void {
    const t = this.el.querySelector<HTMLDivElement>('#tp-tip'); if (!t) return;
    const tw = t.offsetWidth, th = t.offsetHeight, OFF = 18; // visual box = offset box shifted by the -44px margin
    let x = this.mx + OFF; if (x + tw > W - 8) x = this.mx - OFF - tw;
    let y = this.my + OFF; if (y + th > H - 8) y = this.my - OFF - th;
    y = Math.max(th + 84 < this.my - OFF ? 84 : 8, Math.min(H - 8 - th, y)); x = Math.max(8, x);
    t.style.left = `${x + 44}px`; t.style.top = `${y + 44}px`;
  }
  /** Apply staged refunds (paying ash shards) then staged allocations in data (topological) order. */
  confirm(): void {
    const sim = this.sim(); const b = sim.build; const cost = planCost(this.pend, sim.progress.level >= RESPEC_FREE_BEFORE());
    if (b.s.ashShards < cost.ashShards) { this.msg = '無法：灰燼碎片不足'; this.render(); return; }
    const order = TALENTS.nodes.map((n) => n.id);
    for (const id of [...order].reverse()) for (let i = 0; i < -(this.pend[id] ?? 0); i++) b.refund(id);
    for (const id of order) for (let i = 0; i < (this.pend[id] ?? 0); i++) b.allocate(id);
    this.pend = {}; this.msg = ''; sim.refreshBuild(); this.onChange(); this.render();
  }
  private after(r: { ok: boolean; reason?: string }): void { this.msg = r.ok ? '' : `無法：${r.reason}`; this.render(); }
  destroy(): void { this.el.remove(); }
}
