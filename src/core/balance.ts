export const BALANCE = {
  FIXED_DT: 1 / 60,
  TILE: 32,
  critChance: 0.05, critMult: 1.5, stab: 1.5,
  energyMax: 100, energyRegen: 12,
  basicCooldown: 0.35,
  playerIFrames: 0.4,
  burnPctPerSec: 0.02, burnPctBoss: 0.005, burnMaxStacks: 3,
  cdrCap: 0.4,
  sustainedComp: 1.5,
  immuneMult: 0.25,
  tierHp: 1.15, tierDmg: 1.08,
  pickupRadius: 28, // TUNE
  dropChance: 0.35, // TUNE
  monsterAggro: 320, // TUNE
  monsterHpScale: 0.35, // TUNE: ARPG pacing, so trash dies in ~5 basic hits
} as const;
