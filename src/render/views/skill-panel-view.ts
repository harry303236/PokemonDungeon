import type { Sim } from '../../core/sim';
import { KNOWN_MOVES, SLOT_COUNT } from '../../core/moves/loadout';
import { move as moveData } from '../../data/registry';
import { moveCooldown, energyCost } from '../../core/moves/cooldown';
import { SLOT_LABELS } from '../input/input-map';
import { t } from '../../i18n/t';
import { GEMS, SKILL_UPGRADES, moveTags, tagLabel } from '../../core/build/build';

const gemIcon = (g: string, px: number): string => { const ic = GEMS[g]?.icon; return ic ? `<img src="assets/hud/gems/${ic}.png" width="${px}" height="${px}" draggable="false" style="vertical-align:middle;pointer-events:none" onerror="this.style.display='none'">` : (GEMS[g]?.name ?? '?').slice(0, 2); };
const SHAPE_COLOR: Record<string, string> = { projectile: '#ff9a3c', beam: '#ff5a1f', zone: '#e8462a', 'aoe-target': '#ffcc33', dash: '#d0302a' };

/** DOM skill panel: drag a move icon (or a slot) onto a slot to place/swap; or click icon, then click slot. */
export class SkillPanelView {
  private el: HTMLDivElement;
  private picked: string | null = null;
  private gemMsg = '';
  open = false;
  constructor(private sim: () => Sim, private onChange: () => void) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, { position: 'fixed', left: '50%', bottom: '250px', transform: 'translateX(-50%)', background: 'rgba(20,16,28,.95)',
      border: '1px solid #665', padding: '12px 16px', display: 'none', fontSize: '13px', zIndex: '11', userSelect: 'none', minWidth: '520px' });
    document.body.appendChild(this.el);
  }
  setOpen(v: boolean): void { this.open = v; this.el.style.display = v ? 'block' : 'none'; this.picked = null; if (v) this.render(); }
  toggle(): void { this.setOpen(!this.open); }

  private icon(id: string | null, attrs: string, extra = ''): string {
    if (!id) return `<div ${attrs} style="width:84px;height:64px;border:2px dashed #554;display:flex;align-items:center;justify-content:center;color:#776">${t('skills.empty')}</div>`;
    const m = moveData(id); const sel = this.picked === id ? 'outline:3px solid #fff;' : '';
    return `<div ${attrs} draggable="true" title="${t(`move.${id}`)}" style="${sel}width:84px;height:64px;border:2px solid #886644;border-radius:6px;cursor:grab;
      background:radial-gradient(circle at 50% 35%, ${SHAPE_COLOR[m.shape] ?? '#f80'}, #2a1a14 75%);display:flex;flex-direction:column;align-items:center;justify-content:flex-end;padding-bottom:3px;box-sizing:border-box">
      <b style="text-shadow:0 0 3px #000">${t(`move.${id}`)}</b><small style="color:#ddd">${moveCooldown(m).toFixed(1)}s · ${energyCost(m)}⚡${extra}</small></div>`;
  }

  render(): void {
    const sim = this.sim(); const slots = sim.slots;
    const slotHtml = Array.from({ length: SLOT_COUNT }, (_, i) =>
      `<div style="text-align:center"><div style="color:#fc6;font-weight:bold">${SLOT_LABELS[i]}</div>${this.icon(slots[i] ?? null, `data-slot="${i}" data-move="${slots[i] ?? ''}"`)}</div>`).join('');
    const b = sim.build;
    const sockHtml = (id: string): string => `<div style="display:flex;gap:3px;justify-content:center;margin-top:3px">${b.sockets(id).map((g, i) =>
      `<div data-socket="${id}:${i}" title="${g ? `${GEMS[g]?.name}：${GEMS[g]?.desc}（右鍵取下）` : '拖曳輔助寶石到這裡'}" style="width:26px;height:26px;border-radius:50%;border:2px solid ${g ? '#6cf' : '#554'};background:${g ? 'radial-gradient(circle,#bdf,#247 70%)' : '#15121a'};font-size:10px;line-height:26px;color:#fff;overflow:hidden">${g ? gemIcon(g, 22) : ''}</div>`).join('')}</div>`;
    const upHtml = (id: string): string => (SKILL_UPGRADES[id] ?? []).map((g) => `<div style="display:flex;gap:2px;justify-content:center;margin-top:3px">${g.options.map((o) => {
      const on = b.s.upgrades[id]?.[g.group] === o.id; const lock = g.group === 'variant' && !b.canChooseVariant(id);
      return `<button ${lock ? 'disabled ' : ''}data-up="${id}|${g.group}|${o.id}" title="${o.desc}${o.rules.length ? '\n規則：' + o.rules.join('；') : ''}${o.stub ? '\n(未實裝)' : ''}${lock ? '\n（天賦盤招式主幹升到第 3 級才能選）' : ''}" style="font-size:10px;padding:1px 3px;${lock ? 'opacity:.4;' : ''}background:${on ? '#6a3a14' : '#221a14'};color:${on ? '#fc6' : '#aaa'};border:1px solid #664">${o.name}</button>`; }).join('')}</div>`).join('');
    const poolHtml = KNOWN_MOVES.map((id) => `<div style="text-align:center;width:90px">${this.icon(id, `data-pool="${id}" data-move="${id}"`)}<small style="color:#999">${slots.includes(id) ? SLOT_LABELS[slots.indexOf(id)] : '—'}</small>${sockHtml(id)}${upHtml(id)}<div style="color:#776;font-size:10px">${moveTags(id).map(tagLabel).join('・')}</div></div>`).join('');
    const bagHtml = b.s.gems.length ? b.s.gems.map((g, i) => `<div data-gem="${g}" data-gi="${i}" draggable="true" title="${GEMS[g]?.desc ?? ''}（適用：${(GEMS[g]?.tagsAny ?? []).map(tagLabel).join('/') || '全部'}）" style="cursor:grab;padding:2px 7px 2px 2px;border:1px solid #47a;border-radius:12px;background:#123;color:#bdf;display:flex;align-items:center;gap:4px">${gemIcon(g, 20)}${GEMS[g]?.name ?? g}${GEMS[g]?.stub ? '<i style="color:#a66">(未實裝)</i>' : ''}</div>`).join('') : '<span style="color:#666">（空。K 鍵除錯取得寶石）</span>';
    this.el.innerHTML = `<div style="color:#fc6;margin-bottom:6px">${t('skills.title')}</div><div style="display:flex;gap:10px">${slotHtml}</div>
      <div style="margin:10px 0 6px;color:#aaa">${t('skills.pool')}</div><div style="display:flex;gap:10px">${poolHtml}</div>
      <div style="margin:10px 0 4px;color:#aaa">輔助寶石背包（拖到招式下方插槽；插槽數依進化階段 1/2/3，寶石跟著招式走）${this.gemMsg ? ` <span style="color:#f88">${this.gemMsg}</span>` : ''}</div><div style="display:flex;gap:6px;flex-wrap:wrap">${bagHtml}</div>
      <div style="color:#888;margin-top:8px">${t('skills.hint')}</div>`;
    this.el.querySelectorAll<HTMLDivElement>('[data-gem]').forEach((d) => d.addEventListener('dragstart', (ev) => { ev.dataTransfer?.setData('text/plain', JSON.stringify({ gem: d.dataset.gem })); }));
    this.el.querySelectorAll<HTMLDivElement>('[data-socket]').forEach((d) => {
      const [mid = '', si = '0'] = (d.dataset.socket ?? '').split(':');
      d.addEventListener('dragover', (ev) => ev.preventDefault());
      d.addEventListener('drop', (ev) => { ev.preventDefault(); ev.stopPropagation();
        try { const p = JSON.parse(ev.dataTransfer?.getData('text/plain') ?? '') as { gem?: string }; if (!p.gem) return;
          const res = b.socket(mid, Number(si), p.gem); this.gemMsg = res.ok ? '' : res.reason === 'incompatible' ? `${GEMS[p.gem]?.name} 不適用於此招式` : `無法鑲嵌：${res.reason}`; this.render(); this.onChange();
        } catch { /* foreign drop */ } });
      d.addEventListener('contextmenu', (ev) => { ev.preventDefault(); ev.stopPropagation(); b.unsocket(mid, Number(si)); this.render(); this.onChange(); });
    });
    this.el.querySelectorAll<HTMLButtonElement>('[data-up]').forEach((d) => d.addEventListener('click', () => {
      const [mid = '', g = '', o = ''] = (d.dataset.up ?? '').split('|'); b.chooseUpgrade(mid, g, b.s.upgrades[mid]?.[g] === o ? null : o); this.render(); this.onChange(); }));
    this.el.querySelectorAll<HTMLDivElement>('[data-move]').forEach((d) => {
      d.addEventListener('dragstart', (ev) => { ev.dataTransfer?.setData('text/plain', JSON.stringify({ move: d.dataset.move, fromSlot: d.dataset.slot ?? null })); });
    });
    this.el.querySelectorAll<HTMLDivElement>('[data-pool]').forEach((d) => d.addEventListener('click', () => { this.picked = d.dataset.pool ?? null; this.render(); }));
    this.el.querySelectorAll<HTMLDivElement>('[data-slot]').forEach((d) => {
      const slot = Number(d.dataset.slot);
      d.addEventListener('dragover', (ev) => ev.preventDefault());
      d.addEventListener('drop', (ev) => {
        ev.preventDefault();
        try { const p = JSON.parse(ev.dataTransfer?.getData('text/plain') ?? '') as { move?: string }; if (p.move) this.assign(slot, p.move); } catch { /* ignore foreign drops */ }
      });
      d.addEventListener('click', () => { if (this.picked) this.assign(slot, this.picked); });
      d.addEventListener('contextmenu', (ev) => { ev.preventDefault(); this.assign(slot, null); });
    });
  }
  private assign(slot: number, id: string | null): void { this.sim().setSlot(slot, id); this.picked = null; this.render(); this.onChange(); }
  destroy(): void { this.el.remove(); }
}
