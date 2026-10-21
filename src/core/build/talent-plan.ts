import { canAllocate, canRefund, isImplemented, type Alloc, type TalentData, type TalentNode, type TalentCtx } from './talents';
import LABELS from '../../data/build/talent-labels.json';

type Lbl = { label: string; fmt: 'pct' | 'frac' | 'flat' | 'flag' | 'none' };
const LBL = LABELS as unknown as Record<string, Lbl>;
export type NodeKind = 'root' | 'small' | 'notable' | 'keystone';
export const nodeKind = (n: TalentNode): NodeKind => (n.branch === 'core' ? 'root' : n.effectType === 'keystone' ? 'keystone' : n.id.endsWith('_mid') ? 'notable' : 'small');
export const KIND_LABEL: Record<NodeKind, string> = { root: '起點', small: '小型天賦', notable: '中型天賦', keystone: '關鍵天賦' };
/** Names are "標題：描述" in the data; split for title + description line. */
export const splitName = (n: TalentNode): { title: string; desc: string } => {
  const s = n.name ?? n.id; const i = s.indexOf('：'); return i < 0 ? { title: s, desc: n.desc ?? '' } : { title: s.slice(0, i), desc: n.desc ?? s.slice(i + 1) };
};
const fmtN = (l: Lbl, v: number): string => { const x = l.fmt === 'frac' ? v * 100 : v; return `${x > 0 ? '+' : ''}${Math.round(x * 100) / 100}${l.fmt === 'pct' || l.fmt === 'frac' ? '%' : ''}`; };
/** '特攻：目前 +4%，下一級 +8%' (current/next rank). '' for none/keystone. */
export function effectLine(n: TalentNode, rank: number): string {
  const l = LBL[n.effectType]; if (!l || l.fmt === 'none' || n.effectType === 'keystone') return '';
  if (l.fmt === 'flag' || typeof n.value !== 'number') return l.label;
  const v = n.value; const cur = rank > 0 ? fmtN(l, v * rank) : '無';
  return rank >= n.maxRank ? `${l.label}：目前 ${cur}（已滿）` : `${l.label}：目前 ${cur}，下一級 ${fmtN(l, v * (rank + 1))}`;
}

export const merged = (a: Alloc, pend: Alloc): Alloc => { const o: Alloc = { ...a }; for (const [k, v] of Object.entries(pend)) { o[k] = (o[k] ?? 0) + v; if (!o[k]) delete o[k]; } return o; };

/** Stage +1 rank (or cancel a staged refund). Nothing is spent. */
export function stageAdd(d: TalentData, a: Alloc, pend: Alloc, id: string, ctx: TalentCtx): { ok: boolean; reason?: string } {
  if ((pend[id] ?? 0) < 0) { pend[id]! += 1; if (!pend[id]) delete pend[id]; return { ok: true }; }
  const r = canAllocate(d, merged(a, pend), id, ctx); if (!r.ok) return r;
  pend[id] = (pend[id] ?? 0) + 1; return { ok: true };
}
/** Stage -1 rank: un-stage a pending add first, else stage a refund. */
export function stageRemove(d: TalentData, a: Alloc, pend: Alloc, id: string): { ok: boolean; reason?: string } {
  const m = merged(a, pend);
  if ((pend[id] ?? 0) > 0) { // can't unstage if a staged child depends on it
    if (m[id] === 1 && d.nodes.some((c) => (m[c.id] ?? 0) > 0 && c.requires.includes(id))) return { ok: false, reason: 'hasDependents' };
    pend[id]! -= 1; if (!pend[id]) delete pend[id]; return { ok: true };
  }
  const r = canRefund(d, m, id); if (!r.ok) return r;
  pend[id] = (pend[id] ?? 0) - 1; return { ok: true };
}
export const pendingAdds = (pend: Alloc): number => Object.values(pend).reduce((s, v) => s + Math.max(0, v), 0);
export const pendingRefunds = (pend: Alloc): number => Object.values(pend).reduce((s, v) => s + Math.max(0, -v), 0);
export const planCost = (pend: Alloc, refundPaid: boolean): { ashShards: number; gold: number } => ({ ashShards: refundPaid ? pendingRefunds(pend) : 0, gold: 0 });

/** Tooltip status line (data-driven reasons). */
export function statusLine(d: TalentData, a: Alloc, pend: Alloc, n: TalentNode, ctx: TalentCtx): { text: string; tone: 'ok' | 'plan' | 'bad' | 'hint' } {
  if ((pend[n.id] ?? 0) > 0) return { text: '規劃中（待確認）', tone: 'plan' };
  if ((pend[n.id] ?? 0) < 0) return { text: '將退點（待確認）', tone: 'plan' };
  const r = a[n.id] ?? 0; if (r >= n.maxRank) return { text: '已習得', tone: 'ok' };
  const m = merged(a, pend);
  if (n.exclusiveGroup && d.nodes.some((o) => o.id !== n.id && o.exclusiveGroup === n.exclusiveGroup && (m[o.id] ?? 0) > 0)) return { text: '已選擇其他關鍵天賦', tone: 'bad' };
  const c = canAllocate(d, m, n.id, ctx);
  if (c.ok) return { text: r > 0 ? `已習得 ${r}/${n.maxRank} · 左鍵規劃下一級` : '左鍵規劃配點', tone: r > 0 ? 'ok' : 'hint' };
  const byId = new Map(d.nodes.map((x) => [x.id, x]));
  switch (c.reason) {
    case 'exclusive': return { text: '已選擇其他關鍵天賦', tone: 'bad' };
    case 'evoStage': return { text: `需要等級 ${d.meta.evoStageUnlock[String(n.evoStage)] ?? '?'}`, tone: 'bad' };
    case 'points': return { text: `需要等級 ${ctx.level + 1}`, tone: 'bad' };
    case 'requires': return { text: `需要先點：${n.requires.filter((p) => (m[p] ?? 0) < 1 && byId.has(p) && isImplemented(byId.get(p)!)).map((p) => splitName(byId.get(p)!).title).join('、')}`, tone: 'bad' };
    default: return { text: c.reason, tone: 'bad' };
  }
}
