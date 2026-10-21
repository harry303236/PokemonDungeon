import type { Sim } from '../../core/sim';
import { KNOWN_MOVES, SLOT_COUNT } from '../../core/moves/loadout';
import { move as moveData } from '../../data/registry';
import { moveCooldown, energyCost } from '../../core/moves/cooldown';
import { SLOT_LABELS } from '../input/input-map';
import { t } from '../../i18n/t';

const SHAPE_COLOR: Record<string, string> = { projectile: '#ff9a3c', beam: '#ff5a1f', zone: '#e8462a', 'aoe-target': '#ffcc33', dash: '#d0302a' };

/** DOM skill panel: drag a move icon (or a slot) onto a slot to place/swap; or click icon, then click slot. */
export class SkillPanelView {
  private el: HTMLDivElement;
  private picked: string | null = null;
  open = false;
  constructor(private sim: () => Sim, private onChange: () => void) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, { position: 'fixed', left: '50%', bottom: '110px', transform: 'translateX(-50%)', background: 'rgba(20,16,28,.95)',
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
    const poolHtml = KNOWN_MOVES.map((id) => `<div style="text-align:center">${this.icon(id, `data-pool="${id}" data-move="${id}"`)}<small style="color:#999">${slots.includes(id) ? SLOT_LABELS[slots.indexOf(id)] : '—'}</small></div>`).join('');
    this.el.innerHTML = `<div style="color:#fc6;margin-bottom:6px">${t('skills.title')}</div><div style="display:flex;gap:10px">${slotHtml}</div>
      <div style="margin:10px 0 6px;color:#aaa">${t('skills.pool')}</div><div style="display:flex;gap:10px">${poolHtml}</div>
      <div style="color:#888;margin-top:8px">${t('skills.hint')}</div>`;
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
