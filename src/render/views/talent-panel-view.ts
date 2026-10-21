import type { Sim } from '../../core/sim';
import { TALENTS, fullResetCost, RESPEC_FREE_BEFORE } from '../../core/build/build';
import { isImplemented, levelPoints, debugPoints, type Alloc, type TalentNode } from '../../core/build/talents';
import { nodeKind, KIND_LABEL, splitName, effectLine, merged, stageAdd, stageRemove, pendingAdds, pendingRefunds, planCost, statusLine, type NodeKind } from '../../core/build/talent-plan';
import LABELS from '../../data/build/talent-labels.json';

export const fmtVal = (v: number | string, t: string): string => {
  const l = (LABELS as unknown as Record<string, { label: string; fmt: string }>)[t]; if (!l) return `${t} ${v}`;
  if (l.fmt === 'none') return ''; if (l.fmt === 'flag' || typeof v !== 'number') return l.label;
  const x = l.fmt === 'frac' ? Math.round(v * 1000) / 10 : v; return `${l.label} ${x > 0 ? '+' : ''}${x}${l.fmt === 'pct' || l.fmt === 'frac' ? '%' : ''}`;
};

const UI = TALENTS.meta.ui ?? {};
const ART = 'assets/hud/talents/';
const W = 1280, H = 720;
const SIZE: Record<NodeKind, number> = { small: 54, notable: 70, keystone: 108, root: 70 };
const FRAME: Record<NodeKind, string> = { small: 'small', notable: 'notable', keystone: 'keystone', root: 'notable' };
const COLX = [300, 640, 980];
// rows (bottom→top growth): root, T1 pair, T1 mid, T2 pair, T2 mid, T3 pair, keystone
const ROWY = { ks: 128, t3: 236, t2mid: 302, t2: 368, t1mid: 434, t1: 500, root: 590 };

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
      userSelect: 'none', color: '#ddd', fontSize: '13px', background: 'radial-gradient(ellipse at 50% 55%, rgba(52,26,12,.97), rgba(10,6,4,.98) 70%)', overflow: 'hidden' });
    document.body.appendChild(this.el);
  }
  setOpen(v: boolean): void { this.open = v; if (!v) { this.pend = {}; this.hover = null; } this.el.style.display = v ? 'block' : 'none'; if (v) this.render(); }
  toggle(): void { this.setOpen(!this.open); }
  render(): void {
    const sim = this.sim(); const b = sim.build; const a = b.s.talents; const lvl = sim.progress.level; const ctx = b.tctx();
    const m = merged(a, this.pend);
    const branches = [...new Set(TALENTS.nodes.filter((n) => n.branch !== 'core').map((n) => n.branch))];
    const nodes = TALENTS.nodes.filter((n) => !(UI.hideUnimplemented && !isImplemented(n)));
    const pos = new Map(nodes.map((n) => [n.id, center(n, branches)]));
    const st = (id: string): 'on' | 'plan' | 'off' => ((a[id] ?? 0) > 0 && (m[id] ?? 0) > 0 ? 'on' : (m[id] ?? 0) > 0 ? 'plan' : 'off');
    const lines = UI.drawPrereqLines === false ? '' : nodes.flatMap((n) => n.requires.filter((r) => pos.has(r)).map((r) => {
      const p = pos.get(n.id)!, q = pos.get(r)!; const s1 = st(n.id), s2 = st(r);
      const on = s1 !== 'off' && s2 !== 'off'; const plan = on && (s1 === 'plan' || s2 === 'plan');
      return `<line x1="${q.x}" y1="${q.y}" x2="${p.x}" y2="${p.y}" stroke="${plan ? '#7fd8ff' : on ? '#f0a83a' : '#5a4a3a'}" stroke-width="${on ? 4 : 2.5}" ${plan ? 'stroke-dasharray="8 6"' : ''} ${on ? 'filter="url(#tglow)"' : 'opacity=".75"'}/>`;
    })).join('');
    const badge = (n: TalentNode): string => {
      const p = pos.get(n.id)!; const k = nodeKind(n); const s = SIZE[k]; const r = m[n.id] ?? 0; const state = st(n.id);
      const icon = s * (k === 'keystone' ? 0.5 : 0.58);
      const refund = (this.pend[n.id] ?? 0) < 0;
      const ring = refund ? 'border:2px dashed #ff6a5a;box-shadow:0 0 12px 3px rgba(255,90,70,.65);animation:tpPulse 1s ease-in-out infinite alternate;' : state === 'on' ? `box-shadow:0 0 14px 4px rgba(255,140,30,.85), inset 0 0 10px rgba(255,160,40,.6);border:2px solid #ffb040;`
        : state === 'plan' ? 'border:2px dashed #7fd8ff;box-shadow:0 0 12px 3px rgba(110,200,255,.6);animation:tpPulse 1s ease-in-out infinite alternate;' : '';
      const grey = state === 'off' ? 'filter:grayscale(1) brightness(.6);' : '';
      const rank = k === 'root' || k === 'keystone' && n.maxRank === 1 ? '' : `<div style="position:absolute;left:${p.x + s / 2 - 6}px;top:${p.y + s / 2 - 12}px;font:bold 12px sans-serif;color:${r ? '#ffd27a' : '#998'};text-shadow:0 0 3px #000,0 0 3px #000">${r}/${n.maxRank}</div>`;
      return `<div data-node="${n.id}" style="position:absolute;left:${p.x - s / 2}px;top:${p.y - s / 2}px;width:${s}px;height:${s}px;cursor:pointer">
        <div style="position:absolute;left:${(s - icon) / 2}px;top:${(s - icon) / 2}px;width:${icon}px;height:${icon}px;border-radius:50%;${ring}"></div>
        <img src="${ART}icons/talent-${n.id}.png" onerror="this.onerror=null;this.src='${ART}icons/talent-root.png';this.style.opacity='.35'" style="position:absolute;left:${(s - icon) / 2}px;top:${(s - icon) / 2}px;width:${icon}px;height:${icon}px;border-radius:50%;${grey}" draggable="false">
        <img src="${ART}talent-frame-${FRAME[k]}.png" style="position:absolute;left:0;top:0;width:${s}px;height:${s}px;${state === 'off' ? 'filter:brightness(.55) saturate(.6);' : ''}" draggable="false">
      </div>${rank}`;
    };
    const tip = (): string => {
      const n = nodes.find((x) => x.id === this.hover); if (!n) return '';
      const p = pos.get(n.id)!; const k = nodeKind(n); const { title, desc } = splitName(n); const eff = effectLine(n, m[n.id] ?? 0);
      const sl = statusLine(TALENTS, a, this.pend, n, ctx); const col = { ok: '#7fe07f', plan: '#7fd8ff', bad: '#ff7a6a', hint: '#ccc' }[sl.tone];
      const left = p.x + 190 + 340 > W ? p.x - 380 : p.x + 50; const top = Math.max(50, Math.min(H - 260, p.y - 70));
      return `<div id="tp-tip" style="position:absolute;left:${left}px;top:${top}px;width:330px;box-sizing:border-box;padding:26px 30px 22px;pointer-events:none;
        border:44px solid transparent;border-image:url(${ART}talent-frame-tooltip.png) 90 fill / 44px stretch;margin:-44px">
        <div style="text-align:center;color:#ffc75a;font-size:17px;font-weight:bold">${title}</div>
        <div style="text-align:center;color:#a99;font-size:11px;margin:2px 0 8px">${KIND_LABEL[k]}${n.branch !== 'core' ? ` · ${n.branch}` : ''}</div>
        ${desc ? `<div style="margin-bottom:4px">${desc}</div>` : ''}${eff ? `<div style="color:#f2e2c0">${eff}</div>` : ''}
        ${n.drawback ? `<div style="color:#ff5a4a;margin-top:4px">代價：${n.drawback}</div>` : ''}
        <div style="color:${col};margin-top:10px">${sl.text}</div></div>`;
    };
    const lp = levelPoints(TALENTS, lvl), dp = debugPoints(TALENTS, ctx), left = b.pointsLeft() - pendingAdds(this.pend) + pendingRefunds(this.pend);
    const paid = lvl >= RESPEC_FREE_BEFORE(); const cost = planCost(this.pend, paid); const anyPend = Object.keys(this.pend).length > 0;
    const sum = Object.entries(this.pend).map(([id, d]) => { const n = TALENTS.nodes.find((x) => x.id === id)!; const e = fmtVal(typeof n.value === 'number' ? n.value * d : n.value, n.effectType);
      return `<span style="color:${d > 0 ? '#9fe0ff' : '#ff9a8a'}">${d > 0 ? '+' : '−'}${splitName(n).title}${Math.abs(d) > 1 ? `×${Math.abs(d)}` : ''}${e && n.effectType !== 'keystone' ? `（${e}）` : ''}</span>`; }).join('、');
    const btn = 'background:#2a1a10;color:#ffc75a;border:1px solid #8a6a3a;padding:4px 12px;cursor:pointer;font-size:13px';
    this.el.innerHTML = `<style>@keyframes tpPulse{from{opacity:.55}to{opacity:1}}</style>
      <svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;pointer-events:none"><defs><filter id="tglow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${lines}</svg>
      ${branches.map((br, i) => `<div style="position:absolute;left:${(COLX[i] ?? 0) - 120}px;top:44px;width:240px;text-align:center;color:#ffc75a;font-size:22px;font-weight:bold;letter-spacing:2px;text-shadow:0 0 8px #a50">${br}</div>`).join('')}
      <div style="position:absolute;left:16px;top:10px;right:16px;display:flex;justify-content:space-between;color:#cba">
        <span><b style="color:#ffc75a">天賦樹</b>（T 關閉 · 左鍵規劃 · 右鍵退點/取消）</span>
        <span>等級 ${lvl}−1 = <b>${lp}</b>${b.debug && dp ? ` <span style="color:#8cf">除錯 +${dp}</span>` : ''} · 灰燼碎片 ${b.s.ashShards} · 金幣 ${b.s.gold}
        <button id="tp-reset" style="${btn};margin-left:8px">全部重置（${fullResetCost(lvl) || '免費'}${fullResetCost(lvl) ? ' 金' : ''}）</button></span></div>
      ${nodes.map(badge).join('')}
      <div style="position:absolute;left:24px;bottom:18px;font-size:17px;color:#e8d6b0">剩餘點數 <b id="tp-points" style="color:#ffd27a">${left}</b>${this.msg ? ` <span style="font-size:13px;color:#f88">${this.msg}</span>` : ''}</div>
      ${anyPend ? `<div id="tp-plan" style="position:absolute;right:20px;bottom:14px;max-width:760px;background:rgba(14,10,8,.92);border:1px solid #6a5232;padding:8px 12px;display:flex;gap:12px;align-items:center">
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
    this.el.querySelector('#tp-ok')?.addEventListener('click', () => this.confirm());
    this.el.querySelector('#tp-cancel')?.addEventListener('click', () => { this.pend = {}; this.msg = ''; this.render(); });
    this.el.querySelector('#tp-reset')?.addEventListener('click', () => { this.pend = {}; const r = b.fullReset(); this.msg = r.ok ? '' : `無法：${r.reason}`; this.sim().refreshBuild(); this.onChange(); this.render(); });
  }
  private tipFn: () => string = () => '';
  private renderTip(): void { const w = this.el.querySelector('#tp-tipwrap'); if (w) w.innerHTML = this.tipFn(); }
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
