export interface ChainContext { rootId: number; depth: number; visited: Set<string> }
export interface GameEvents {
  'damage:dealt': { target: number; amount: number; isCrit: boolean; typeEff: number; x: number; y: number };
  'reaction': { id: string; x: number; y: number; r: number };
  'build:gain': { what: string };
  'entity:killed': { victim: number; killer: number; cause: 'hit' | 'burn' | 'bound'; chain: ChainContext };
  'move:cast': { caster: number; moveId: string };
  'loot:dropped': { itemId: number; x: number; y: number };
  'loot:picked': { itemId: number };
  'player:levelup': { level: number };
  'player:evolve': { speciesId: string; stage: number };
  'floor:cleared': { floor: number };
}
type Handler<K extends keyof GameEvents> = (p: GameEvents[K]) => void;
export class EventBus {
  private handlers: { [K in keyof GameEvents]?: Handler<K>[] } = {};
  on<K extends keyof GameEvents>(k: K, h: Handler<K>): () => void {
    const list = (this.handlers[k] ??= []) as Handler<K>[];
    list.push(h);
    return () => { const i = list.indexOf(h); if (i >= 0) list.splice(i, 1); };
  }
  emit<K extends keyof GameEvents>(k: K, p: GameEvents[K]): void {
    const list = this.handlers[k] as Handler<K>[] | undefined;
    list?.slice().forEach((h) => h(p));
  }
}
export const MAX_CHAIN_DEPTH = 3;
export function newChain(rootId: number): ChainContext { return { rootId, depth: 0, visited: new Set() }; }
export function childChain(c: ChainContext): ChainContext { return { rootId: c.rootId, depth: c.depth + 1, visited: c.visited }; }
export function canTrigger(c: ChainContext, affixId: string, target: number): boolean {
  if (c.depth >= MAX_CHAIN_DEPTH) return false;
  const key = `${affixId}:${target}`;
  if (c.visited.has(key)) return false;
  c.visited.add(key);
  return true;
}
