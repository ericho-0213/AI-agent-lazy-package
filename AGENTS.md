# AGENTS.md — Mini-Antigravity 本機自主 AI Agent 中樞

## 專案定位
本專案為「Mini-Antigravity 本機自主 AI Agent 中樞」，整合本機端 LLM（Ollama，模型存放於 `D:\OllamaModels`）與 Node.js ReAct 工具引擎，提供無限制本機對話、圖片自由創建、工業級 Sobel 幾何切線尺寸量測，以及跨專案專屬工具調度。

## 核心路徑與架構
- **工作目錄**：`D:\Antigravity Project\AI agent`
- **Obsidian 對應筆記**：`專案導航HUB\AI agent.md`（Vault：`%USERPROFILE%\Documents\Secondbrain`）
- **Web 服務端口**：`http://localhost:8790`
- **本機 LLM 引擎**：Ollama (`http://127.0.0.1:11434`)，環境變數 `OLLAMA_MODELS=D:\OllamaModels`
- **主力預設模型**：`qwen2.5:3b`（可於戰情室一鍵拉取 `qwen2.5:7b`、`deepseek-r1:7b` 等）
- **雙腦熱切換**：支援本機 Ollama（離線無限制）⇄ Gemini 雲端協同模型（動態讀取本機 `.env` 或相鄰團隊 `.env` 之 `GEMINI_API_KEY`）
- **成長治理與長對話脈絡管理**：支援記憶學習 Git Diff 提案核准與單筆原子回退（`memory/learning_governance.json`），以及長對話上下文水位計（區分 `系統基底 + 對話` 明細與 80% 自動摘要壓縮 `memory/context_summary.json`）

## 10 大內建自主工具
1. **圖片自由創建引擎 (`generate_image` / `generate_local_svg`)**：整合本機無限制寫實生圖 `Local SD-LCM`（`D:\OllamaModels\sd` DreamShaper-7 LCM）、無金鑰雲端 `Flux / Turbo`（自動裁除底部浮水印）、斷網本機 SVG 向量工程圖、AI 改圖協作（`POST /api/image/assist`）及工坊「🕶️ 隱私無痕模式／🗑️ 清除歷史對話（`DELETE /api/image/history`）」。
2. **Excel Zero-OOM 安全解析 (`parse_excel_safe`)**：支援本機任意非敏感磁碟路徑（`C:\`、`D:\`、`T:\` 等）、省略 `.xlsx` 自動補齊與資料夾列出／最新檔案解析；執行 4-Byte 檔頭預檢 + 按需工作表解壓 + Last-Value 智慧截斷。
3. **MES / IPQC 數據與 SPC 分析 (`query_mes_spc`)**：讀取 Q004 JSON 檢驗數據並計算 $\bar{X}$、$R$、$\sigma$、$C_a / C_p / C_{pk}$。
4. **AOI 覆判案件與 KLA 座標解析 (`inspect_aoi_system`)**：讀取覆判總表與 `Default.kla` 缺陷座標。
5. **Outlook 郵件與行事曆安全檢索 (`query_outlook_safe`)**：MAPI 唯讀檢索（嚴守紅旗/待處理郵件不自動搬動鐵律）。
6. **本機全專案巡檢 (`scan_local_projects`)**：動態盤點上層目錄所有專案與啟動/Git/端口狀態。
7. **Obsidian 第二大腦連接器 (`secondbrain_tool`)**：搜尋、讀取、寫入筆記與知識庫健康檢查（lint）。
8. **本機檔案讀寫 (`file_ops`)**：`list` / `read` 支援本機任意非敏感磁碟路徑、省略 `.xlsx` 自動補齊與資料夾列出（嚴格封鎖 `.env`、`credentials`、`id_rsa`、`.pem` 等機敏憑證與系統機密）；`write` 嚴格限制於工作區內。
9. **PowerShell 執行器 (`run_powershell`)**：執行系統查詢、自動化指令與環境檢測。
10. **Hermes 長期記憶與即時聯網搜尋 (`memory_tool` / `web_search`)**：維護 `SOUL.md`、`USER.md`、`MEMORY.md`（🔴 鐵律保護）與聯網資訊查詢。

## Antigravity ⇄ 本機 Ollama 雙向切換指令規範
1. **視窗內委派本機大腦**：當使用者在 Antigravity 對話中提及「**用本機模型跑**」、「**切地端模型**」或「**交給本機 Agent**」時，Antigravity 可直接執行：
   `node scripts/ask_local_agent.js "<任務描述>"`
   直接調用本機 `Ollama` (`127.0.0.1:11434`) 與 10 大工具箱處理任務（資料完全留在本機，不消耗雲端額度）。
2. **跨介面交接同步**：本機戰情室 (`http://localhost:8790`) 每次對話皆會讀取 `handoff.md` 並自動寫入 `memory/antigravity_bridge.md`。當使用者回到 Antigravity 說「**接手本機進度**」時，應優先讀取 `memory/antigravity_bridge.md` 與 `handoff.md` 無縫銜接。
3. **戰情室地雲雙軌熱切換**：使用者亦可在 `http://localhost:8790` 戰情室頂部隨時切換「🧠 本機 Ollama（離線零限制）」⇄「☁️ Gemini 雲端協同腦（與 Antigravity 同源之 Gemini 模型）」。

## 開發與維運規則 (Do / Don't)
- **Do**：所有腳本與程式碼一律動態解析自身基準路徑（`__dirname`、`$PSScriptRoot`、`%~dp0`、`WScript.ScriptFullName`），確保跨機移植性。
- **Do**：啟動 Web 服務優先透過 `啟動系統(無黑窗背景執行).vbs`，並使用 `runtime/ai_agent.ico` 微軟純 DIB 圖示快取機制。
- **Don't**：嚴禁在程式碼或腳本中寫死本機絕對路徑或 API 金鑰。
- **Don't**：嚴禁移動或修改 Outlook 帶有紅色旗標/待處理標記之郵件。
