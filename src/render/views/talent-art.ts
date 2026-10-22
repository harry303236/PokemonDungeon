import ICONS from '../../data/build/talent-icons-v4.json';
/** Artist-delivered talent v4 art paths (relative to assets/hud/talents/). */
export const JEWEL_ART_KEYS = ['jw_solar_lens', 'jw_dragon_heart', 'jw_tailwind', 'jw_normal'] as const;
/** Jewel icon by base id ('normal' -> jw_normal). */
export const jewelArt = (base: string): string => `jewels/${base === 'normal' ? 'jw_normal' : base}.png`;
/** Ascendancy badge path from the icon manifest (entries: ascendancy/<id>.png; sub-nodes: ascendancy/asc-<id>.png). */
export const ascArt = (id: string): string => (ICONS as Record<string, string | null>)[id] ?? `ascendancy/asc-${id}.png`;
