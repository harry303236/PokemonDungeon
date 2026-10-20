import Phaser from 'phaser';
export class BootScene extends Phaser.Scene {
  constructor() { super('boot'); }
  create(): void { this.scene.start('title'); } // all data is bundled JSON; nothing to fetch
}
