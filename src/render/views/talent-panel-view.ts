import type { Sim } from '../../core/sim';
import { TALENTS, fullResetCost, RESPEC_FREE_BEFORE } from '../../core/build/build';
import { canAllocate, isImplemented, levelPoints, debugPoints, pointsSpent, type TalentNode } from '../../core/build/talents';

import LABELS from '../../data/build/talent-labels.json';
type Lbl = { label: string; fmt: 'pct' | 'flat' | 'flag' | 'none' };
/** Data-driven effect label (talent-labels.json). Returns '' for effectType none. */
export const fmtVal = (v: number | string, t: string): string => {
  const l = (LABELS as unknown as Record<string, Lbl>)[t]; if (!l) return `${t} ${v}`;
  if (l.fmt === 'none') return ''; if (l.fmt === 'flag' || typeof v !== 'number') return l.label;
  return `${l.label} ${v > 0 ? '+' : ''}${v}${l.fmt === 'pct' ? '%' : ''}`;
};
const UI = TALENTS.meta.ui ?? {};
const NW = 116, NH = 40, COLW = 388, ROWH = 62, TOP = 8;

/** Row index per node: keystone row pinned at top (meta.ui.keystonePinnedTop), root at bottom. */
function slot(n: TalentNode, branches: string[]): { x: number; y: number } {
  const T = 3; // non-keystone tiers; rows top→bottom: ks 0, T3 1, T2mid 2, T2 3, T1mid 4, T1 5, root 6
  if (n.branch === 'core') return { x: (COLW * branches.length) / 2 - NW / 2, y: TOP + ROWH * 6 };
  const bx = branches.indexOf(n.branch) * COLW + COLW / 2;
  const row = n.effectType === 'keystone' ? (UI.keystonePinnedTop === false ? 6 : 0) : (T - n.tier) * 2 + (n.id.endsWith('_mid') ? 0 : 1);
  const sub = n.id.endsWith('_0') ? -1 : n.id.endsWith('_1') ? 1 : 0;
  return { x: bx + sub * (NW / 2 + 18) - NW / 2, y: TOP + ROWH * row };
}

/** DOM talent tree (key T), fully driven by meta.ui. Click = allocate, right-click = refund. */
export class TalentPanelView {
  private el: HTMLDivElement; open = false; private msg = '';
  constructor(private sim: () => Sim, private onChange: () => void) {
    this.el = document.createElement('div'); this.el.id = 'talent-panel';
    Object.assign(this.el.style, { position: 'fixed', left: '50%', top: '8px', transform: 'translateX(-50%)', background: 'rgba(16,12,22,.97)', border: '1px solid #665', borderRadius: '6px',
      padding: '8px 12px', display: 'none', fontSize: '12px', zIndex: '12', userSelect: 'none', color: '#ddd', maxHeight: 'calc(100vh - 16px)', overflow: 'auto' });
    document.body.appendChild(this.el);
  }
  setOpen(v: boolean): void { this.open = v; this.el.style.display = v ? 'block' : 'none'; if (v) this.render(); }
  toggle(): void { this.setOpen(!this.open); }
  render(): void {
    const sim = this.sim(); const b = sim.build; const a = b.s.talents; const lvl = sim.progress.level; const ctx = b.tctx();
    const branches = [...new Set(TALENTS.nodes.filter((n) => n.branch !== 'core').map((n) => n.branch))];
    const hidden = (n: TalentNode): boolean => !!UI.hideUnimplemented && !isImplemented(n);
    const nodes = TALENTS.nodes.filter((n) => !hidden(n));
    const pos = new Map(nodes.map((n) => [n.id, slot(n, branches)]));
    const W = COLW * branches.length, H = Math.max(...[...pos.values()].map((p) => p.y)) + NH + 6;
    const lines = UI.drawPrereqLines === false ? '' : nodes.flatMap((n) => n.requires.filter((r) => pos.has(r)).map((r) => {
      const p = pos.get(n.id)!, q = pos.get(r)!; const lit = (a[n.id] ?? 0) > 0 && (a[r] ?? 0) > 0; const ksEdge = n.effectType === 'keystone';
      const x1 = q.x + NW / 2, y1 = q.y, x2 = p.x + NW / 2, y2 = p.y + NH;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${lit ? '#ffb040' : ksEdge ? '#7a4a78' : '#4a4038'}" stroke-width="${lit ? 3 : ksEdge ? 2.5 : 2}"${lit ? ' filter="url(#glow)"' : ''}/>`;
    })).join('');
    const box = (n: TalentNode): string => {
      const p = pos.get(n.id)!; const r = a[n.id] ?? 0; const chk = canAllocate(TALENTS, a, n.id, ctx); const can = chk.ok;
      const unimpl = !isImplemented(n); const ks = n.effectType === 'keystone';
      const border = unimpl ? '#333' : r >= n.maxRank ? '#ffcc66' : r > 0 ? '#e0803a' : can ? '#6a6' : '#443';
      const eff = fmtVal(n.value, n.effectType);
      const tip = unimpl ? '尚未實裝' : `${n.name ?? n.id}${eff ? ` · ${eff}` : ''} · 需 ${n.requires.join('+') || '—'} · 進化階段 ${n.evoStage}${can ? '' : ` · ${chk.reason}`}`;
      return `<div data-node="${n.id}" title="${tip}" style="position:absolute;left:${p.x}px;top:${p.y}px;width:${NW}px;height:${NH}px;box-sizing:border-box;cursor:${unimpl ? 'not-allowed' : 'pointer'};
        border:2px solid ${border};border-radius:${ks ? 12 : 5}px;padding:2px 4px;background:${unimpl ? '#161616' : r ? '#3a2416' : ks ? '#241a2e' : '#1c1814'};opacity:${unimpl ? 0.4 : r || can ? 1 : 0.55};
        overflow:hidden;line-height:1.25;${unimpl ? 'filter:grayscale(1);' : ''}${r && ks ? 'box-shadow:0 0 10px #ffb040;' : ''}">
        <b style="font-size:11px;color:${ks ? '#f9c' : '#eee'}">${n.name ?? n.id}</b> <span style="color:#fc6">${r}/${n.maxRank}</span>${unimpl ? '<br><small style="color:#aaa">尚未實裝</small>' : eff && !ks ? `<br><small style="color:#aaa">${eff}</small>` : ''}</div>`;
    };
    const lp = levelPoints(TALENTS, lvl), dp = debugPoints(TALENTS, ctx), spent = pointsSpent(a);
    const paid = lvl >= RESPEC_FREE_BEFORE();
    this.el.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:4px"><b style="color:#fc6">天賦樹（T 關閉）</b>
      <span>等級 ${lvl}−1 = <b>${lp}</b>${dp ? ` <span style="color:#8cf">除錯 +${dp}</span>` : ''} · 已用 ${spent} · 剩餘 <b id="tp-points" style="color:#9f9">${b.pointsLeft()}</b> · 灰燼碎片 ${b.s.ashShards} · 金幣 ${b.s.gold}</span>
      <button id="tp-reset" style="background:#2a1a14;color:#fc6;border:1px solid #886644">全部重置（${fullResetCost(lvl) || '免費'}${fullResetCost(lvl) ? ' 金' : ''}）</button></div>
      <div style="color:#999;margin-bottom:4px">左鍵配點，右鍵退點（${paid ? '每點消耗 1 灰燼碎片' : `Lv${RESPEC_FREE_BEFORE()} 前免費`}）· 每系 29 點，終極天賦三選一${this.msg ? ` · <span style="color:#f88">${this.msg}</span>` : ''}</div>
      <div style="display:flex">${branches.map((br) => `<div style="width:${COLW}px;text-align:center;color:#fc6;font-weight:bold">${br}</div>`).join('')}</div>
      <div style="position:relative;width:${W}px;height:${H}px">
        <svg width="${W}" height="${H}" style="position:absolute;left:0;top:0;pointer-events:none"><defs><filter id="glow"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${lines}</svg>
        ${nodes.map(box).join('')}</div>`;
    this.el.querySelectorAll<HTMLDivElement>('[data-node]').forEach((d) => {
      const id = d.dataset.node ?? '';
      d.addEventListener('click', () => this.after(b.allocate(id)));
      d.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.after(b.refund(id)); });
    });
    this.el.querySelector('#tp-reset')?.addEventListener('click', () => this.after(b.fullReset()));
  }
  private after(r: { ok: boolean; reason?: string }): void { this.msg = r.ok ? '' : `無法：${r.reason === 'unimplemented' ? '尚未實裝' : r.reason}`; this.sim().refreshBuild(); this.onChange(); this.render(); }
  destroy(): void { this.el.remove(); }
}
