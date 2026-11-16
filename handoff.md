# 專案交接與進度追蹤 (handoff.md)

## 最新狀態 (2026-11-17)
- **目前階段**：完成首輪夜間 150 題全實機演練（覆蓋 `150/150`、通過率由 `40%` 升至 `61%`），並已完成全部失敗根因修復與「單輪直達加速」升級（`node scripts/verify.js` 13/13 通過）
- **今日新增完成項目 (2026-11-17)**：
  - [x] **夜間 `00:00 ~ 02:55` 首輪自動演練完成**：實測覆蓋達 `150/150 (100%)`、通過率 `91/150 (61%)`（目錄探索與安全/算數/格式領域達 `100%`）。
  - [x] **含空格 Windows 路徑抓取 & `lastCursor` 跳題修正**：實作 `extractWindowsPathFromMessage()` 完整支援 `D:\Antigravity Project\...` 等含空格路徑；修正 `ollamaTrainer.js` 迴圈內 `startCursor` 鎖定以消除跳題。
  - [x] **專屬領域消歧 & `secondbrain_tool` 保底**：於 `selectRelevantTools()` 排除通用動詞誤掛 `file_ops` / `web_search` / `scan_local_projects`，並於 `inferDeterministicToolCall()` 補齊 `secondbrain_tool`（`lint`/`list_hubs`/`read`/`search`）保底分派。
  - [x] **單輪直達加速 (`Zero-Waste Pre-Fetch`) + 防睡眠守護 + `ollama調效.md` 十大配方**：先預取確定性單工具實證數據讓 `Ollama` 只跑 1 輪總結，並加入 `2400` 字元截斷、`num_predict: 640` 節流與繁中輸出錨點；於 `ollamaTrainer.js` 內建 `startSleepGuard()` 防系統睡眠（允許關螢幕、不登出）；更新 `ollama調效.md` 為十大實戰調校配方。
- **昨日已完成項目 (2026-11-16)**：
  - [x] **Ollama 端口衝突自癒與背景拉起 (`ensureOllamaRunning`)**：解決 RealVNC 等程式佔用 `127.0.0.1:11434` 導致 `WSAEACCES` 與 `fetch failed` 問題；依序探測 `[11434, 11435, 11436, 11440, 18434]` 自動切換可用埠並背景靜默啟動 `ollama.exe serve`（實測自動切換至 `11435`）。
  - [x] **Windows 路徑工具呼叫容錯與防吞字修復**：`callOllamaChat()` 移除原生 `payload.tools`（改由 `buildSystemPrompt` 動態注入當次篩選工具 Schema 與 `<tool_call>` 協定），避免 Ollama Go 層解析 Windows 反斜線路徑失敗吞成空字串；實作 `tryParseJsonWithBackslashRepair()`、`parseLooseToolJson()`、`normalizeToolCallObj()`、`inferDeterministicToolCall()` 與 `formatFallbackReplyFromResults()`，並於 `fileOps()` 自動過濾 `~$` 暫存鎖定檔。
  - [x] **建立兩份可攜式調校資產**：
    - `ollama調效.md`：七大實戰調校配方、Hydrogen 模型鎖定規範、150 題熟練度儀表板與演化日誌。
    - `離線AI_Agent調效考題教材.md`：Few-Shot 正反例教材＋8 大領域 150 道實戰考題與驗收準則（供未來導入其他離線 AI Agent 調校使用）。
  - [x] **建置每日 `00:00 ~ 03:00` 自主演練與自癒引擎 (`server/ollamaTrainer.js`、`scripts/daily_ollama_trainer.js`)**：
    - 不依賴 Antigravity `Automations`，內建於本地伺服器排程器（設定自 `2026-11-17` 起每日 `00:00 ~ 03:00` 自動執行）。
    - 嚴格鎖定僅可使用 `Gemini 4 Hydrogen (gemini-4-hydrogen-high)` 作為測試模型；具備使用者對話讓道機制、熱更新 `memory/ollama_auto_tuning.json`，以及「100% 覆蓋＋≥98% 通過率＋連續 50 題零修補」自動畢業停機機制。
    - 戰情室新增演練進度條、`⚡ 立即試跑一輪` 與 `📘 檢視 ollama調效.md` 檢視視窗。
- **先前已完成項目 (2026-11-15)**：
  - [x] 建立 `D:\OllamaModels` 模型存放目錄並配置使用者環境變數 `OLLAMA_MODELS`。
  - [x] 安裝 Ollama (`v0.40.16`，CPU + Vulkan 精簡執行環境，42 個檔案於 `%LOCALAPPDATA%\Programs\Ollama`）。
  - [x] 完成 `scripts/fast_pull_ollama.ps1` 4 連線平行 HTTP Range 斷點續傳與完整檔案 SHA-256 嚴格校驗，正式下載並註冊完整版 `qwen2.5:3b`（`1,929,912,432 bytes` / `3.1B` Q4_K_M / `tools` 支援）至 `D:\OllamaModels`（同時保留輕量極速 `qwen2.5:0.5b` / `494.03M` 供低延遲測試）。
  - [x] 最佳化 `server/agentCore.js`（針對 Ollama 避免重複注入工具文字菜單、`num_ctx: 4096`、`keep_alive: 30m`、超時上限 `300s`），並完成真實 `qwen2.5:3b` ReAct 工具呼叫實測。
  - [x] 建立專案標準結構（`AGENTS.md`、`ANTIGRAVITY.md`、`README.md`、`.gitignore`、`package.json`）。
  - [x] 建立 Hermes 三層記憶架構（`memory/SOUL.md`、`memory/USER.md`、`memory/MEMORY.md` 含 `🔴` 鐵律寫入保護）。
  - [x] 完成 11 項實戰自主工具（圖片生成 Flux/Turbo 與斷網 SVG、Sobel 幾何切線量測畫布、Zero-OOM Excel 解析、MES SPC 分析、AOI 與 KLA 座標、Outlook 唯讀紅旗保護檢索、23 個本機專案巡檢、Obsidian Secondbrain 連接、安全檔案讀寫、PowerShell、Hermes 記憶與聯網搜尋）。
  - [x] 完成 Antigravity ⇄ 本機 Ollama 三向切換機制（`scripts/ask_local_agent.js`、`memory/antigravity_bridge.md` 與 `/api/bridge/sync` 交接、戰情室 Ollama ⇄ Gemini 雲端熱切換）並實測雙軌工具呼叫成功。
  - [x] 建立 `啟動系統(無黑窗背景執行).vbs`、純 DIB 4 圖層 `runtime/ai_agent.ico`（含 `%LOCALAPPDATA%\AI-Agent-Cache` 本機快取）、桌面捷徑與 Obsidian `專案導航HUB\AI agent.md` 連動。
  - [x] 完成 `scripts/install_local_sd.ps1` 部署本機離線寫實生圖引擎 (`D:\OllamaModels\sd\bin\sd-cli.exe` + `dreamshaper-7-lcm-q4_0.gguf` `1,625,041,920 bytes` / MD5 `03661e588d8728a4ec6141f64bd69842`)，將 `local-sd` 整合為圖片工坊首選並實測出圖 (`ai_localsd_1794737100923_778899.png`)。
  - [x] 實作雲端 `Flux`/`Turbo` 高度加採樣 (`+64px`) 無損切除底部 `pollinations.ai` 浮水印並清理既有圖庫 6 張圖片；新增圖片工坊「🤖 AI Agent 即時反饋 & 改圖對話」面板 (`POST /api/image/assist`)。
  - [x] 完成離線 AI Agent **「全自動自主學習迴圈 (Auto-Learning Loop)」**：支援對話糾正自動萃取寫入 `MEMORY.md` / `USER.md`、生圖審美偏好自動累積 (`memory/image_taste.json`)、以及記憶頁籤「✨ 讓 AI 從近期對話自主總結並學習」(`POST /api/memory/auto-learn`)。
  - [x] 完成 **「記憶學習 Diff 提案核准（成長治理）＋ 長對話上下文 80% 自動摘要壓縮」**升級：支援 `review`（Git Diff 提案預覽、微調、單筆/批次核准與拒絕）⇄ `auto` 雙政策及單筆規則**原子回退 (Rollback)** (`memory/learning_governance.json`)；戰情室新增**即時上下文 Token 水位計（`4096`/`8192`/`16384` 預算切換）**、**80% 安全檢查點自動摘要壓縮**與「📦 前情提要記憶膠囊」(`memory/context_summary.json`)。
  - [x] 完成 **本機跨磁碟非敏感路徑開放與智慧解析**：更新 `server/projectTools.js` 與 `server/agentCore.js`，使 `parse_excel_safe` 與 `file_ops`（`list`/`read`）支援任意非敏感磁碟路徑（如 `D:\良率資料\...`）、省略 `.xlsx` 自動補齊、模型腦補子路徑向上回退救援與資料夾列出/最新檔案解析（同時保留工作區外禁止寫入與 `.env`/機敏憑證封鎖）。
  - [x] 完成 **圖片創建工坊「🗑️ 清除歷史對話 (`DELETE /api/image/history`)」與「🕶️ 隱私無痕模式 (`privateMode`)」**：支援一鍵清空前端對話、Prompt、`memory/image_taste.json`、`memory/image_gallery.json` 及對話歷史內的圖片提示詞（保留圖片檔本體供檢視量測），事前開啟無痕模式亦不落盤審美記憶與提示詞。
  - [x] 完成 **上下文水位計基底精簡與 Token 估算校正**：`readHandoffSummary()` 改為僅擷取 `BRIDGE_SYNC` 交接區塊、`estimateTokens()` 校正為符合 Qwen2.5 詞表的中文 `0.85`／非中文 `0.3` 係數、`DELETE /api/chat/history` 一併清除交接殘留，並於介面顯示「系統 ＋ 對話」明細（空載降至 `1,150 / 4,096 tok`，`28%・充裕`），且通過 `node scripts/verify.js` **13/13** 全端驗證。
  - [x] 完成 **跨電腦落地建置懶人包與 GitHub 開源發布**：撰寫 [`本機自主AI_Agent建置懶人包.md`](./本機自主AI_Agent建置懶人包.md)、[`scripts/setup_new_pc.ps1`](./scripts/setup_new_pc.ps1) 與跨機容錯版 [`scripts/verify.js`](./scripts/verify.js)（`13/13` 通過），去敏提交（`05c644c`）並建立公開儲存庫 `https://github.com/ericho-0213/AI-agent-lazy-package` 推送完成。
  - [x] 完成 **智慧工具意圖分流 (`selectRelevantTools`) 與 `memory_tool` 寫入防呆優化**：於 `server/agentCore.js` 實作依指令意圖按需掛載工具 Schema（純算數與一般對話回傳 `[]`，不再注入 11 個工具 Schema 與 `<tool_call>` 提示），並於 `memory_tool` 攔截無記憶意圖之 `append` 呼叫，將 `請計算1+98` 回應時間由 `106.2 秒` 降至預熱後 `1.4 秒`（`node scripts/verify.js` `13/13` 通過）。

## 下一步待辦 (Next Steps)
- [ ] **驗收 `2026-11-18 00:00 ~ 03:00` 修復後全量重測戰報**：確認套用單輪直達加速與專屬領域消歧後，150 題通過率是否大幅提升至 `≥ 98%` 並達標畢業停機。
- [ ] **另一台電腦實機驗證**：於目標 Windows 電腦執行 `git clone https://github.com/ericho-0213/AI-agent-lazy-package.git` 後執行 `.\scripts\setup_new_pc.ps1`，並可搭配 `ollama調效.md` 一鍵調校。
- [ ] **選配擴充進階模型**：依需求透過 `scripts/fast_pull_ollama.ps1` 或戰情室中控台拉取 `qwen2.5:7b`、`deepseek-r1:7b` 等模型。
- [ ] **依現場需求擴充專案工具**：於 `server/projectTools.js` 擴充其他系統之自動化數據分析或報表工作流。

## 踩坑與決策紀錄 (Decisions & Pitfalls)
1. **模型拉取防卡死（4 連線平行 HTTP Range 斷點續傳）**：官方 `ollama pull` 預設 16 連線併發易觸發連線重置卡死；改採 `scripts/fast_pull_ollama.ps1`（4 連線 Range 續傳＋SHA-256 校驗＋`curl.exe -C -` 保底）搭配 `keep_awake_ollama.ps1`（`SetThreadExecutionState`）防休眠。
2. **上下文水位基底瘦身（`63%` → `28%`）**：Ollama 改走原生 `tools` 不再於 System Prompt 重複傾倒文字菜單、`readHandoffSummary()` 僅擷取 `BRIDGE_SYNC` 區塊並校正 Qwen2.5 中文 Token 估算係數（`0.85`），空載佔用由 `2,584` 降至 `1,150 / 4,096 tok`。
3. **跨磁碟唯讀與腦補路徑救援**：實作 `resolveSmartReadablePath()` 與 `allowAnyLocalRead`，支援 `C:\`、`D:\`、`T:\` 等非敏感磁碟唯讀、省略 `.xlsx` 自動補齊、腦補子路徑向上回退救援與資料夾列出／最新檔案解析（寫入嚴限工作區，封鎖 `.env` 與憑證）。
4. **記憶治理與圖片工坊隱私**：提供 `learning_governance.json` Diff 提案核准與單筆原子回退，並於圖片工坊實作「🕶️ 隱私無痕模式 (`privateMode`)」與 `DELETE /api/image/history` 一鍵抹除提示詞與偏好紀錄。
5. **智慧工具分流消除 3B 模型過度調用與 CPU Prefill 瓶頸（106.2s → 1.4s）**：3B 模型在掛載全部 11 個工具時易對簡單算數誤觸發 `memory_tool` 造成兩輪 CPU 長上下文重算並污染 `MEMORY.md`；改由 `selectRelevantTools()` 按需注入工具並加入 `memory_tool` 意圖防呆後，徹底解決延遲與 KV Cache 失效問題。
