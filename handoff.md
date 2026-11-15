# 專案交接與進度追蹤 (handoff.md)

## 最新狀態 (2026-11-15)
- **目前階段**：Phase 1 ~ Phase 4 建置與專案初始化完成，並通過全端驗證（`node scripts/verify.js` 13/13 通過）
- **已完成項目**：
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
