import Phaser from 'phaser';
import { BootScene } from './render/scenes/boot-scene';
import { TitleScene } from './render/scenes/title-scene';
import { DungeonScene } from './render/scenes/dungeon-scene';

new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', backgroundColor: '#0d0b10',
  scale: { mode: Phaser.Scale.RESIZE, width: 1280, height: 720 },
  scene: [BootScene, TitleScene, DungeonScene],
});
