# PokeDungeon（原型）

一款 Diablo 風格的地城刷寶遊戲，玩家直接操控寶可夢（目前只有小火龍線）。技術棧：Phaser 3 + TypeScript + Vite。規格文件放在 `docs/`。

## 美術素材（自動）
`npm install` 會透過 postinstall 自動執行 `scripts/fetch-assets.ts --if-missing`；`npm run dev` 和 `npm run build` 之前也會再檢查一次（已有快取就跳過）。
- 寶可夢動畫 sprite（Idle／Walk／Attack／Hurt，8 方向）來自 [PMD SpriteCollab](https://github.com/PMDCollab/SpriteCollab)；抓不到時改用 PokeAPI 靜態圖。存放在 `public/assets/skin/`，**已加入 .gitignore，不會 commit**。
- 地城 tileset：Kenney「Roguelike Caves & Dungeons」（CC0），commit 在 `public/assets/cc0/`。
- 強制重抓：`npm run fetch-assets`。若下載失敗（例如離線），遊戲會自動退回 placeholder 圖形。

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
| 左鍵點地面 | A* 尋路走到該點（會顯示點擊標記）；按住不放則跟著游標走 |
| 左鍵點敵人 | 走進射程後自動連續攻擊，直到目標死亡（用普攻；普攻不在欄位上時改用第一個攻擊招式） |
| Shift+左鍵 | 原地朝游標方向攻擊 |
| 方向鍵 | 直接移動（會取消點擊指令） |
| 滑鼠 | 瞄準 |
| 右鍵、Q、W、E、R | 施放 5 個欄位裡的招式（預設：火花、噴射火焰、火焰旋渦、大字爆炎、閃焰衝鋒） |
| 1 | 使用樹果（回復 35% HP，每層 3 顆，冷卻 4 秒）；2 號欄位目前是空的 |
| F1 | 顯示／隱藏操作說明 |
| Space | 閃避（無敵翻滾） |
| Tab | 招式面板：把招式拖到欄位上就能放入或交換；也可以先點招式再點欄位；在欄位上按右鍵可清空 |
| I | 背包／裝備（會一起打開招式面板） |
| L／Shift+L（除錯） | 等級 +1／跳到下一個進化等級 |
| R（死亡後） | 重新挑戰本層 |
| 標題畫面 Enter／C | 新遊戲／繼續（localStorage 存檔） |

普攻（火花）本身也是一個可以放進欄位的招式；5 個欄位裡最多只能放 4 個非普攻招式。欄位配置會一起存檔。

擊倒本層 60% 的怪物後，綠色出口會開啟；共有 5 層，第 5 層有大岩蛇 Boss（簡化版）。走過掉落物就會自動撿起。
