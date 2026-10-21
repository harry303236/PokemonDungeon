import type { TypeId } from '../../data/schemas';

/** Shared HUD palette + font (also used by damage numbers). */
export const HUD_FONT = 'Georgia, "Noto Serif CJK TC", "Noto Serif TC", "Times New Roman", serif';
export const PALETTE = {
  text: '#f3e6c8', textDim: '#a89878', key: '#e8c878', shadow: '#000000',
  dmg: '#fff4dc', dmgSuper: '#ffd23c', dmgWeak: '#9a9a9a', dmgPlayer: '#ff5040', heal: '#7dff7a',
  xp: 0x4dff6a, xpGlow: 0x1fd04a, iron: 0x2a2a30, ironHi: 0x6a6a74,
} as const;

export interface HudTheme {
  /** rim glow tint behind the shared orb frame */ accent: number;
  /** liquid texture key (artist slice) and optional tint */ fillKey: string; fillTint?: number;
}
/** HP orb theme is driven by the player's primary type; water/grass ready for other starters. */
export const TYPE_THEMES: Partial<Record<TypeId, HudTheme>> & { default: HudTheme } = {
  default: { accent: 0xd8342a, fillKey: 'hud-orb-hp-fill' },
  fire: { accent: 0xff4a1c, fillKey: 'hud-orb-hp-fill' },
  water: { accent: 0x2a8cff, fillKey: 'hud-orb-hp-fill', fillTint: 0x60a0ff }, // until artist ships a blue fill
  grass: { accent: 0x3ccf4a, fillKey: 'hud-orb-hp-fill', fillTint: 0x70ff70 },
};
export const PP_THEME: HudTheme = { accent: 0xf0b030, fillKey: 'hud-orb-pp-fill' };
export const themeForType = (t: TypeId | undefined): HudTheme => (t && TYPE_THEMES[t]) || TYPE_THEMES.default;
