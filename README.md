# PokeDungeon（原型）

一款 Diablo 風格的地城刷寶遊戲，玩家直接操控寶可夢（目前只有小火龍線）。技術棧：Phaser 3 + TypeScript + Vite。規格文件放在 `docs/`。

## 執行
```bash
npm install
npm run dev          # 開發伺服器 http://localhost:5173
npm run build        # typecheck + 靜態建置到 dist/（base 設為 './'，可直接部署到 GitHub Pages）
npm run preview      # 預覽 dist/
npm test             # Vitest
npm run lint && npm run typecheck && npm run validate-data
npm run data:fetch && npm run data:build   # 只在開發時抓 PokeAPI；data/raw 是 commit 進 repo 的快取
```
runtime 完全不連網，所有資料都打包在 `src/data/generated/*.json`。

## 操作
| 按鍵 | 動作 |
|---|---|
| WASD／方向鍵 | 移動 |
| 滑鼠 | 瞄準 |
| 左鍵 | 火花（普攻，投射物） |
| 右鍵或 1 | 噴射火焰（光束） |
| 2 | 火焰旋渦（地面區域，束縛） |
| 3 | 大字爆炎（延遲範圍爆炸） |
| 4 | 閃焰衝鋒（衝刺，有反傷） |
| Space | 閃避（無敵翻滾） |
| I | 背包／裝備（點擊物品即可裝備） |
| R | 死亡後重新挑戰本層 |
| 標題畫面 Enter／C | 新遊戲／繼續（localStorage 存檔） |

擊倒本層 60% 的怪物後，綠色出口會開啟；共有 5 層，第 5 層有大岩蛇 Boss（簡化版）。走過掉落物就會自動撿起。
