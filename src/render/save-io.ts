import { load, save } from '../core/save/save-manager';
import type { Progress } from '../core/sim';
export const loadProgress = (): Progress | null => { try { return load(window.localStorage); } catch { return null; } };
export const saveProgress = (p: Progress): void => { try { save(window.localStorage, p); } catch { /* storage unavailable */ } };
