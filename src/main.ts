import Phaser from 'phaser';
import { BootScene } from './render/scenes/boot-scene';
import { TitleScene } from './render/scenes/title-scene';
import { DungeonScene } from './render/scenes/dungeon-scene';
import { TalentBoardScene } from './render/scenes/talent-board-scene';

new Phaser.Game({
  type: Phaser.AUTO, parent: 'game', backgroundColor: '#0d0b10',
  pixelArt: true,
  render: { pixelArt: true, antialias: false, roundPixels: true },
  scale: { mode: Phaser.Scale.RESIZE, width: 1280, height: 720 },
  scene: [BootScene, TitleScene, DungeonScene, TalentBoardScene],
});
