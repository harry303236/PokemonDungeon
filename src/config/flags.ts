/** Global feature flags. */
export const FLAGS = {
  /** Single-player: opening the talent board / skill panel / inventory pauses the simulation (enemies, damage, cooldowns, statuses).
   *  Turn off for multiplayer, where the world must keep running. */
  pauseSimWhenUiOpen: true,
};
/** Whether the dungeon should advance the simulation this frame. */
export const shouldStepSim = (uiOpen: boolean, flags: { pauseSimWhenUiOpen: boolean } = FLAGS): boolean => !(uiOpen && flags.pauseSimWhenUiOpen);
