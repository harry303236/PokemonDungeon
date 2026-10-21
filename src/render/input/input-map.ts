import Phaser from 'phaser';
import type { InputCommand } from '../../core/sim';

/** Hotbar keys in slot order (slot 0 = right mouse button). */
export const SLOT_LABELS = ['RMB', 'Q', 'W', 'E', 'R'] as const;

/** Diablo-style: hold LMB to walk toward the cursor (arrow keys also move); RMB/Q/W/E/R cast slots. */
export class InputMap {
  private keys: Record<string, Phaser.Input.Keyboard.Key>;
  constructor(private scene: Phaser.Scene) {
    const kb = scene.input.keyboard;
    if (!kb) throw new Error('keyboard unavailable');
    this.keys = kb.addKeys('Q,W,E,R,SPACE,UP,DOWN,LEFT,RIGHT,TAB') as Record<string, Phaser.Input.Keyboard.Key>;
    scene.input.mouse?.disableContextMenu();
  }
  private down(k: string): boolean { return this.keys[k]?.isDown ?? false; }
  read(px: number, py: number): InputCommand {
    const ptr = this.scene.input.activePointer; const wp = ptr.positionToCamera(this.scene.cameras.main) as Phaser.Math.Vector2;
    let mx = (this.down('RIGHT') ? 1 : 0) - (this.down('LEFT') ? 1 : 0);
    let my = (this.down('DOWN') ? 1 : 0) - (this.down('UP') ? 1 : 0);
    if (!mx && !my && ptr.leftButtonDown() && Math.hypot(wp.x - px, wp.y - py) > 12) { mx = wp.x - px; my = wp.y - py; }
    return {
      moveX: mx, moveY: my, aimX: wp.x, aimY: wp.y,
      slots: [ptr.rightButtonDown(), this.down('Q'), this.down('W'), this.down('E'), this.down('R')],
      dodge: this.down('SPACE'),
    };
  }
}
