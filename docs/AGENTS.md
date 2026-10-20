# AGENTS.md：給 coding agent 的規則

## 絕對禁止
1. **runtime 不得呼叫 PokeAPI 或任何外部網路 API**。只能讀 `src/data/generated/*.json`（由 `scripts/fetch-pokeapi.ts` 在開發時產生並 commit）。
2. 不得複製 `pokemonpoe` repo 的任何程式碼、文字、圖片、音效。只能參考 `07` 中轉述的「概念」。
3. 不得把 Pokémon 官方美術／音效 commit 進 repo。只用 placeholder（程式生成的圖形）或 CC0 素材（Kenney），並在 `CREDITS.md` 記錄。
4. 遊戲邏輯（`src/core/**`）不得 import `phaser`。

## 慣例
- TypeScript `strict: true`、`noUncheckedIndexedAccess: true`。不准用 `any`（必要時 `unknown` + type guard）。
- 檔名 `kebab-case.ts`；型別／類別 `PascalCase`；函式／變數 `camelCase`；常數 `UPPER_SNAKE_CASE`；資料 id 用 `kebab-case`（與 PokeAPI 相同，如 `flare-blitz`）。
- 識別字、程式註解、commit message 用英文；玩家可見文字一律走 `src/i18n/zh-Hant.json`（預設語言），不准寫死在程式裡。
- **資料驅動**：招式、怪物、詞綴、掉落表、技能樹、地城都定義在 JSON；新增內容不應需要改 TS（詞綴新「效果類型」除外）。
- 隨機一律使用 `core/rng.ts` 的可 seed RNG（mulberry32），不准直接用 `Math.random()`（VFX 例外）。
- 固定步長模擬：邏輯 60 Hz（`FIXED_DT = 1/60`），渲染插值。
- 單位：距離 px（1 tile = 32 px），時間秒（float），角度弧度。

## 測試
- Vitest。`src/core/**` 每個模組要有單元測試；覆蓋率目標 ≥ 70%（core）。
- 必測：傷害公式、屬性倍率、冷卻計算、詞綴觸發與遞迴保護、掉落擲骰（固定 seed 快照）、存檔 migration、技能樹解鎖規則。
- `npm run validate-data`：用 zod schema 驗證所有 JSON，CI 必跑。
- 每個里程碑結束：`npm run lint && npm run typecheck && npm test && npm run build` 全綠。

## 工作方式
- 依 `06` 里程碑順序做；每完成一項就勾選 checklist（新 repo 的 `docs/progress.md`）。
- 不確定時：照 `07` 預設值做，追加 ADR 至 `docs/decisions.md`，不要停。
- 小步 commit，格式 `feat(combat): ...`／`fix(loot): ...`／`data: ...`／`docs: ...`。
