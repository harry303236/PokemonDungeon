import type { Sim } from '../../core/sim';
import type { Item } from '../../core/loot/loot-roller';
import { t } from '../../i18n/t';

const COLORS: Record<string, string> = { common: '#ddd', uncommon: '#5f5', rare: '#59f', epic: '#c6f', legendary: '#fa3' };
export function describeItem(it: Item): string {
  const aff = it.affixes.map((a) => t(`affix.${a.id}`, { pct: Math.round(a.value * 100) })).join('<br>');
  return `<b style="color:${COLORS[it.rarity] ?? '#fff'}">[${t(`rarity.${it.rarity}`)}] ${t(`slot.${it.slot}`)}</b><br><small>${aff}</small>`;
}
/** DOM overlay (ADR-012). Reads sim state, writes only via sim.equip(). */
export class InventoryView {
  private el: HTMLDivElement;
  open = false;
  constructor(private sim: () => Sim, private onChange: () => void) {
    this.el = document.createElement('div');
    Object.assign(this.el.style, { position: 'fixed', top: '40px', right: '40px', width: '420px', maxHeight: '80vh', overflow: 'auto', background: 'rgba(20,16,28,.95)',
      border: '1px solid #665', padding: '12px', display: 'none', fontSize: '14px', zIndex: '10' });
    document.body.appendChild(this.el);
  }
  toggle(): void { this.open = !this.open; this.el.style.display = this.open ? 'block' : 'none'; if (this.open) this.render(); }
  render(msg = ''): void {
    const pr = this.sim().progress;
    const eq = Object.values(pr.equipped).filter((x): x is Item => !!x);
    this.el.innerHTML = `<h3>${t('inv.equipped')}</h3>${eq.map((i) => `<div style="margin:4px 0">${describeItem(i)}</div>`).join('') || t('inv.empty')}
      <h3>${t('inv.title')}</h3><div style="color:#f66">${msg}</div>
      ${pr.inventory.map((i) => `<div data-uid="${i.uid}" style="cursor:pointer;margin:4px 0;padding:4px;border:1px solid #333">${describeItem(i)}</div>`).join('') || t('inv.empty')}
      <p style="color:#888">${t('inv.close')}</p>`;
    this.el.querySelectorAll<HTMLDivElement>('[data-uid]').forEach((d) => d.addEventListener('click', () => {
      const r = this.sim().equip(Number(d.dataset.uid));
      this.render(r.ok ? '' : t(`inv.err.${r.reason ?? ''}`)); this.onChange();
    }));
  }
  destroy(): void { this.el.remove(); }
}
