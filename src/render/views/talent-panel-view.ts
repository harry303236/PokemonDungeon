import type { Sim } from '../../core/sim';
import { TALENTS, fullResetCost, RESPEC_FREE_BEFORE } from '../../core/build/build';
import { canAllocate, unhandledEffectTypes } from '../../core/build/talents';

const fmtVal = (v: number | string, t: string): string => (typeof v === 'number' ? `${t} ${v > 0 ? '+' : ''}${v}` : `${t}: ${v}`);

/** Minimal DOM talent tree (key T). Click = allocate, right-click = refund. Functional over pretty. */
export class TalentPanelView {
  private el: HTMLDivElement; open = false; private msg = '';
  constructor(private sim: () => Sim, private onChange: () => void) {
    this.el = document.createElement('div'); this.el.id = 'talent-panel';
    Object.assign(this.el.style, { position: 'fixed', left: '50%', top: '40px', transform: 'translateX(-50%)', background: 'rgba(20,16,28,.96)', border: '1px solid #665',
      padding: '10px 14px', display: 'none', fontSize: '12px', zIndex: '12', userSelect: 'none', color: '#ddd', maxHeight: 'calc(100vh - 300px)', overflow: 'auto' });
    document.body.appendChild(this.el);
  }
  setOpen(v: boolean): void { this.open = v; this.el.style.display = v ? 'block' : 'none'; if (v) this.render(); }
  toggle(): void { this.setOpen(!this.open); }
  render(): void {
    const sim = this.sim(); const b = sim.build; const a = b.s.talents; const lvl = sim.progress.level;
    const ctx = { level: lvl, evoStage: sim.evoStage + 1, bonusPoints: b.s.bonusPoints };
    const unhandled = new Set(unhandledEffectTypes(TALENTS));
    const branches = [...new Set(TALENTS.nodes.map((n) => n.branch))];
    const col = (br: string): string => {
      const tiers = [...new Set(TALENTS.nodes.filter((n) => n.branch === br).map((n) => n.tier))].sort((x, y) => x - y);
      return `<div style="flex:1;min-width:230px"><div style="color:#fc6;font-weight:bold;margin-bottom:4px">${br}</div>${tiers.map((t) => `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">
        <span style="color:#776;width:18px">T${t}</span>${TALENTS.nodes.filter((n) => n.branch === br && n.tier === t).map((n) => {
          const r = a[n.id] ?? 0; const can = canAllocate(TALENTS, a, n.id, ctx).ok;
          const border = r >= n.maxRank ? '#fc6' : r > 0 ? '#c84' : can ? '#6a6' : '#443';
          const stub = n.effectType === 'keystone' || unhandled.has(n.effectType) ? ' <i style="color:#a66">(未實裝)</i>' : '';
          return `<div data-node="${n.id}" title="${n.id} · ${n.effectType} · 需 ${n.requires.join('+') || '—'} · 進化階段 ${n.evoStage}" style="cursor:pointer;border:2px solid ${border};border-radius:5px;padding:3px 5px;background:${r ? '#3a2416' : '#1c1814'};opacity:${r || can ? 1 : 0.5}">
            <b>${n.name ?? n.id}</b> ${r}/${n.maxRank}<br><small>${fmtVal(n.value, n.effectType)}${stub}</small></div>`;
        }).join('')}</div>`).join('')}</div>`;
    };
    const paid = lvl >= RESPEC_FREE_BEFORE();
    this.el.innerHTML = `<div style="display:flex;justify-content:space-between;gap:16px;margin-bottom:6px"><b style="color:#fc6">天賦樹（T 關閉）</b>
      <span>剩餘點數 <b id="tp-points" style="color:#9f9">${b.pointsLeft()}</b> · 灰燼碎片 ${b.s.ashShards} · 金幣 ${b.s.gold}</span>
      <button id="tp-reset" style="background:#2a1a14;color:#fc6;border:1px solid #886644">全部重置（${fullResetCost(lvl) || '免費'}${fullResetCost(lvl) ? ' 金' : ''}）</button></div>
      <div style="color:#999;margin-bottom:6px">左鍵配點，右鍵退點（${paid ? '每點消耗 1 灰燼碎片' : `Lv${RESPEC_FREE_BEFORE()} 前免費`}）${this.msg ? ` · <span style="color:#f88">${this.msg}</span>` : ''}</div>
      <div style="display:flex;gap:14px">${branches.map(col).join('')}</div>`;
    this.el.querySelectorAll<HTMLDivElement>('[data-node]').forEach((d) => {
      const id = d.dataset.node ?? '';
      d.addEventListener('click', () => this.after(b.allocate(id)));
      d.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.after(b.refund(id)); });
    });
    this.el.querySelector('#tp-reset')?.addEventListener('click', () => this.after(b.fullReset()));
  }
  private after(r: { ok: boolean; reason?: string }): void { this.msg = r.ok ? '' : `無法：${r.reason}`; this.sim().refreshBuild(); this.onChange(); this.render(); }
  destroy(): void { this.el.remove(); }
}
