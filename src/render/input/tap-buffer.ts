/** Latches key-down edges between frames so a tap shorter than one frame/tick still reaches the sim exactly once. */
export class TapBuffer {
  private pending: boolean[];
  constructor(private n: number) { this.pending = new Array<boolean>(n).fill(false); }
  press(i: number): void { if (i >= 0 && i < this.n) this.pending[i] = true; }
  /** Called once per sim tick: returns latched taps and clears them. */
  consume(): boolean[] { const out = this.pending; this.pending = new Array<boolean>(this.n).fill(false); return out; }
}
