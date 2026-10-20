import Phaser from 'phaser';
import type { InputCommand } from '../../core/sim';
export class InputMap {
  private keys: Record<string, Phaser.Input.Keyboard.Key>;
  constructor(private scene: Phaser.Scene) {
    const kb = scene.input.keyboard;
    if (!kb) throw new Error('keyboard unavailable');
    this.keys = kb.addKeys('W,A,S,D,ONE,TWO,THREE,FOUR,SPACE,UP,DOWN,LEFT,RIGHT') as Record<string, Phaser.Input.Keyboard.Key>;
    scene.input.mouse?.disableContextMenu();
  }
  private down(k: string): boolean { return this.keys[k]?.isDown ?? false; }
  read(): InputCommand {
    const ptr = this.scene.input.activePointer; const wp = ptr.positionToCamera(this.scene.cameras.main) as Phaser.Math.Vector2;
    return {
      moveX: (this.down('D') || this.down('RIGHT') ? 1 : 0) - (this.down('A') || this.down('LEFT') ? 1 : 0),
      moveY: (this.down('S') || this.down('DOWN') ? 1 : 0) - (this.down('W') || this.down('UP') ? 1 : 0),
      aimX: wp.x, aimY: wp.y,
      basic: ptr.leftButtonDown(),
      slots: [this.down('ONE') || ptr.rightButtonDown(), this.down('TWO'), this.down('THREE'), this.down('FOUR')],
      dodge: this.down('SPACE'),
    };
  }
}
