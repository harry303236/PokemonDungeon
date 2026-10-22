import { canAllocate, canRefund, isImplemented, unlockLevel, moveSpeedPct, cdrPct, damageReductionPct, type PlayerBonuses, type TalentMechanics, type Capped, type Alloc, type TalentData, type TalentNode, type TalentCtx } from './talents';
import LABELS from '../../data/build/talent-labels.json';

type Lbl = { label: string; fmt: 'pct' | 'frac' | 'flat' | 'flag' | 'none' | 'tpl'; tpl?: string; cap?: string; stat?: 'moveSpeed' | 'cdr' | 'dr'; inv?: boolean; arrow?: boolean };
const LBL = LABELS as unknown as Record<string, Lbl>;
export type NodeKind = 'root' | 'small' | 'notable' | 'keystone';
export const nodeKind = (n: TalentNode): NodeKind => (n.branch === 'core' ? 'root' : n.effectType === 'keystone' ? 'keystone' : n.id.endsWith('_mid') || n.id.includes('_n_') ? 'notable' : 'small');
export const KIND_LABEL: Record<NodeKind, string> = { root: '起點', small: '小型天賦', notable: '中型天賦', keystone: '關鍵天賦' };
/** Names are "標題：描述" in the data; split for title + description line. */
export const splitName = (n: TalentNode): { title: string; desc: string } => {
  const s = n.name ?? n.id; const i = s.indexOf('：'); return i < 0 ? { title: s, desc: n.desc ?? '' } : { title: s.slice(0, i), desc: n.desc ?? s.slice(i + 1) };
};
const fmtN = (l: Lbl, v: number): string => { const x = l.fmt === 'frac' ? v * 100 : v; return `${x > 0 ? '+' : ''}${Math.round(x * 100) / 100}${l.fmt === 'pct' || l.fmt === 'frac' ? '%' : ''}`; };
/** '特攻：目前 +4%，下一級 +8%' (current/next rank). '' for none/keystone. */
export function effectLine(n: TalentNode, rank: number): string {
  const l = LBL[n.effectType]; if (!l || l.fmt === 'none' || n.effectType === 'keystone') return '';
  if (l.fmt === 'tpl' && l.tpl) {
    const v = typeof n.value === 'object' ? n.value : { v: n.value }; const rk = Math.max(1, rank);
    const fill = (k: number): string => l.tpl!.replace(/\{(\w+)\}/g, (_m, key: string) => {
      if (key === 'moveName') return MOVE_NAMES[String(v.move)] ?? String(v.move);
      if (key === 'limit') return String(TPL_EXTRA.limit ?? '?');
      const x = v[key]; if (typeof x !== 'number') return String(x ?? '?');
      const y = l.inv && key === 'pct' ? -x : x; return String(key === 'pct' || key === 'v' ? Math.round(y * k * 100) / 100 : y);
    });
    return rank >= n.maxRank || n.maxRank === 1 ? (rank ? fill(rk) : fill(1)) : `${fill(rk)}${rank ? `（下一級 ${fill(rank + 1)}）` : ''}`;
  }
  if (l.fmt === 'flag' || typeof n.value !== 'number') return l.label;
  if (l.arrow) { // reduction-style stats: '減傷 6% → 8%' (negatives shown as positive reductions)
    const u = (l.inv ? -1 : 1) * n.value; const f = (x: number): string => `${Math.round((l.fmt === 'frac' ? x * 100 : x) * 100) / 100}${l.fmt === 'flat' ? '' : '%'}`;
    return rank >= n.maxRank ? `${l.label} ${f(u * rank)}（已滿）` : `${l.label} ${f(u * rank)} → ${f(u * (rank + 1))}`;
  }
  const v = n.value; const cur = rank > 0 ? fmtN(l, v * rank) : '無';
  return rank >= n.maxRank ? `${l.label}：目前 ${cur}（已滿）` : `${l.label}：目前 ${cur}，下一級 ${fmtN(l, v * (rank + 1))}`;
}

/** Display names for director move ids in templates (set by the view from move data). */
/** Template effect lines already describe the node, so the name's description part is redundant. */
export const isTplEffect = (t: string): boolean => LBL[t]?.fmt === 'tpl';
export const MOVE_NAMES: Record<string, string> = {};
export const TPL_EXTRA: Record<string, number> = {};
/** Effective post-cap total for capped stats: '總計 +45% → 實際 +40%（已達上限 40%）'. '' when the effect type has no cap. */
export function capLine(n: TalentNode, b: PlayerBonuses, m: TalentMechanics, hpFrac = 1): string {
  const effectType = n.effectType; const l = LBL[effectType]; if (!l?.stat) return '';
  const c: Capped = l.stat === 'moveSpeed' ? moveSpeedPct(b, m, b.onDodgeSpeed?.pct ?? 0) : l.stat === 'cdr' ? cdrPct(b, m, typeof n.value === 'object' ? String(n.value.move) : undefined) : damageReductionPct(b, m, l.stat === 'dr' && effectType === 'lowHpDamageTakenPct' ? 0 : hpFrac);
  const name = l.stat === 'moveSpeed' ? '移動速度' : l.stat === 'cdr' ? '冷卻縮減' : '減傷';
  const f = (x: number): string => `${x >= 0 ? '+' : ''}${Math.round(x * 10) / 10}%`;
  return c.capped ? `${name}總計 ${f(c.raw)} → 實際 ${f(c.value)}（已達上限 ${c.cap}%）` : `${name}總計 ${f(c.value)}（上限 ${c.cap}%）`;
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
    case 'evoStage': return { text: `需要等級 ${unlockLevel(d, n)}`, tone: 'bad' };
    case 'points': return { text: `需要等級 ${ctx.level + 1}`, tone: 'bad' };
    case 'requires': return { text: `需要先點：${(n.requires.length ? n.requires : []).filter((p) => (m[p] ?? 0) < 1 && byId.has(p) && isImplemented(byId.get(p)!)).map((p) => splitName(byId.get(p)!).title).join('、')}${n.requiresAny?.length && !n.requiresAny.some((p) => (m[p] ?? 0) > 0) ? `${n.requires.some((p) => (m[p] ?? 0) < 1) ? '；' : ''}其一：${n.requiresAny.filter((p) => byId.has(p)).map((p) => splitName(byId.get(p)!).title).join(' 或 ')}` : ''}`, tone: 'bad' };
    default: return { text: c.reason, tone: 'bad' };
  }
}
