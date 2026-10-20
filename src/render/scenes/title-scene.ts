import Phaser from 'phaser';
import { species } from '../../data/registry';
import { t } from '../../i18n/t';
import { loadProgress } from '../save-io';
import { newProgress } from '../../core/sim';
export class TitleScene extends Phaser.Scene {
  constructor() { super('title'); }
  create(): void {
    const { width: w, height: h } = this.scale;
    this.add.text(w / 2, h / 2 - 120, 'PokeDungeon', { fontSize: '56px', color: '#ffb347' }).setOrigin(0.5);
    this.add.text(w / 2, h / 2 - 60, t('title.subtitle'), { fontSize: '20px', color: '#ccc' }).setOrigin(0.5);
    const g = this.add.graphics(); g.fillStyle(0xf08030).fillCircle(w / 2, h / 2 + 10, 22); g.fillStyle(0xffd040).fillTriangle(w / 2 + 18, h / 2 + 20, w / 2 + 34, h / 2 + 4, w / 2 + 30, h / 2 + 26);
    this.add.text(w / 2, h / 2 + 50, species('charmander').names['zh-Hant'], { fontSize: '28px', color: '#fff' }).setOrigin(0.5);
    this.add.text(w / 2, h / 2 + 110, t('title.new'), { fontSize: '20px', color: '#fff' }).setOrigin(0.5);
    const saved = loadProgress();
    if (saved) this.add.text(w / 2, h / 2 + 145, t('title.continue', { level: saved.level, floor: saved.bestFloor }), { fontSize: '20px', color: '#9f9' }).setOrigin(0.5);
    const kb = this.input.keyboard;
    kb?.once('keydown-ENTER', () => this.scene.start('dungeon', { progress: newProgress(Date.now() % 1e9) }));
    if (saved) kb?.once('keydown-C', () => this.scene.start('dungeon', { progress: saved }));
  }
}
