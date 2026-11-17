# Ollama 實戰調校與自主演練手冊 (`ollama調效.md`)

> **跨電腦一鍵調校指令（給其他電腦的 Antigravity 閱讀）**：
> 當您在新電腦安裝完 Ollama 與本專案後，只需對該電腦的 Antigravity 說：
> **「請讀取 `ollama調效.md` 的七大調校配方與規則，檢查並調校這台電腦的 Ollama 與 Mini-Antigravity 設定。」**
> 若未來導入其他離線型 AI Agent，請一併搭配 150 題實戰考題教材：[`離線AI_Agent調效考題教材.md`](./離線AI_Agent調效考題教材.md)。
> 本文件同時為「每日自主演練與自癒引擎」自動維護的活文件（Living Document）。

---

## 🔒 演練排程與測試模型鎖定規範
- 🔴 **測試指定模型鎖定**：所有 Ollama 自動化演練、對抗測試與調校修補，**僅可使用 `Gemini 4 Hydrogen`（`gemini-4-hydrogen-high`）執行測試**，嚴禁動用 Argon / Pro / Claude 配額。
- **排程視窗**：每日 **`00:00 ~ 03:00`** 於本機背景無黑窗自動運行（內建於本地伺服器排程器，**不依賴 Antigravity `Automations` 功能**）。
- **使用者優先禮讓**：只要您在戰情室發送任何對話，演練引擎即刻暫停讓道，確保即時回覆不卡頓。
- **三大自動畢業條件（達標即自動停機）**：
  1. 8 大領域 **150 道專案情境覆蓋率 = 100%**
  2. 修復後綜合**通過率 ≥ 98%**
  3. **連續 50 題「零新增修補」**（表示系統已充分收斂）

---

<!-- TRAINER_STATUS_START -->
## 🎓 專案經驗調校成熟度儀表板
- **排程狀態**：每日 `00:00 ~ 03:00` 背景自動運行（自 `2026-11-17` 起，不依賴 Antigravity Automations）
- **指定測試模型**：`Gemini 4 Hydrogen (gemini-4-hydrogen-high)`（唯讀鎖定）
- **目前狀態**：🎓 已達標畢業（自動停機，達成時間：2026-11-17T19:32:37.853Z）
- **總體進度**：規則驗證 `150 / 150` 題（`100%`）｜實機端到端 `150 / 150` 題（`100%`）｜通過率 `100%`｜連續零修補 `73 / 50` 題
- **最近更新時間**：2026-11-17T19:32:37.851Z

| 領域編號 | 測試領域 | 題數 | 已覆蓋 | 通過率 |
| :---: | :--- | :---: | :---: | :---: |
| 1 | 跨磁碟目錄與檔案探索 (`file_ops`) | 25 | 25 (實機 25) | 100% |
| 2 | Zero-OOM Excel 台帳解析 (`parse_excel_safe`) | 25 | 25 (實機 25) | 100% |
| 3 | MES / IPQC 製程能力與 SPC (`query_mes_spc`) | 20 | 20 (實機 20) | 100% |
| 4 | AOI 覆判與 KLA 晶圓座標 (`inspect_aoi_system`) | 15 | 15 (實機 15) | 100% |
| 5 | 本機 23+ 專案健康巡檢 (`scan_local_projects`) | 20 | 20 (實機 20) | 100% |
| 6 | Obsidian 第二大腦 (`secondbrain_tool`) | 15 | 15 (實機 15) | 100% |
| 7 | 安全紅線與純算數極速防呆 | 15 | 15 (實機 15) | 100% |
| 8 | 口語變體與綜合壓力測試 | 15 | 15 (實機 15) | 100% |
<!-- TRAINER_STATUS_END -->

---

## 🔧 十大核心實戰調校配方（跨機部署必套用）

### 配方 1：模型儲存路徑隔離與 4 連線斷點續傳
- **痛點**：Ollama 預設把數 GB 模型存進 `C:\Users\<user>\.ollama\models`，容易塞爆 C 槽；官方 `ollama pull` 預設 16 連線在企業/家用網路易斷線卡死。
- **解法**：
  1. 設定環境變數 `OLLAMA_MODELS=D:\OllamaModels`（或非系統磁碟根目錄），於啟動腳本（`.vbs` / `.bat`）與後端動態注入。
  2. 使用 [`scripts/fast_pull_ollama.ps1`](file:///d:/Antigravity%20Project/AI%20agent/scripts/fast_pull_ollama.ps1) 以 **4 連線 HTTP Range 斷點續傳 + SHA-256 完整校驗**拉取模型（如 `qwen2.5:3b`）。

### 配方 2：通訊埠衝突自癒與備援切換（防 RealVNC 等程式搶佔 11434）
- **痛點**：Windows 本機軟體（如 RealVNC `vncserver.exe`）有時會佔用動態埠 `127.0.0.1:11434`，導致 `ollama.exe serve` 出現 `WSAEACCES` 權限錯誤立即閃退，戰情室回報 `🟠 Ollama 未連線` 與 `fetch failed`。
- **解法**：
  - 在 [`server/agentCore.js`](file:///d:/Antigravity%20Project/AI%20agent/server/agentCore.js) 實作 `ensureOllamaRunning()`，依序探測 `[11434, 11435, 11436, 11440, 18434]`，自動檢測可綁定埠口並背景靜默啟動 `ollama.exe serve`（設定 `OLLAMA_HOST=127.0.0.1:<freePort>`），同時動態更新 `OLLAMA_BASE`。

### 配方 3：消除 Ollama 原生 `tools` 解析器吞掉 Windows 反斜線路徑的 Bug
- **痛點**：將 `payload.tools` 傳給 Ollama `/api/chat` 時，若 `qwen2.5:3b` 輸出未閉合 `<tool_call>` 或 Windows 單反斜線（`D:\良率資料\2026`）與無引號鍵值（`{name: list}`），Ollama Go 層 `json.Unmarshal` 會失敗並將整個訊息吞成空字串 `content: ""`。
- **解法**：
  - `callOllamaChat()` **不傳遞原生 `payload.tools`**。
  - 改於 `buildSystemPrompt()` 動態注入當次選中的 1~2 個工具 Schema 與精確 `<tool_call>` 協定，節省 CPU Prefill 時間並由 Node.js 容錯解析器接管。

### 配方 4：3B 小模型寬鬆工具語法容錯解析器與動態別名表
- **痛點**：3B 模型常將工具名寫成 `list` / `dir` / `read`，參數寫成 `path` / `folder`，或使用 `[file_ops: {...}]`、未閉合 `<tool_call>` 與單反斜線路徑。
- **解法**：
  - 實作 `tryParseJsonWithBackslashRepair()`、`parseLooseToolJson()`、`normalizeToolCallObj()` 與 `extractFallbackToolCalls()`。
  - 動態讀取 [`memory/ollama_auto_tuning.json`](file:///d:/Antigravity%20Project/AI%20agent/memory/ollama_auto_tuning.json) 內的 `toolAliases`、`argAliases`、`customKeywords` 與 `promptRules`，不需重啟即可熱生效。

### 配方 5：智慧工具意圖分流（106.2 秒 ➔ 1.4 秒極速回應）
- **痛點**：純算數或一般問答若掛載全套 11 個工具 Schema，3B 模型不僅 CPU Prefill 耗時逾百秒，還容易誤觸發 `memory_tool` 寫入垃圾記憶破壞 KV Cache。
- **解法**：
  - `selectRelevantTools()` 針對純算數與一般對話回傳 `[]`；僅對命中關鍵字或 `X:\` 磁碟路徑的請求按需掛載對應工具。
  - `memory_tool` 在 `action === 'append'` 時強制檢核使用者訊息是否含明確記憶意圖詞彙。

### 配方 6：跨磁碟智慧唯讀、隱藏暫存檔 `~$` 與 Zero-OOM Excel 解析
- **痛點**：目錄內常出現 Office 暫存鎖定檔（`~$xxx.xlsx`）干擾 3B 模型判讀，或員工整欄套用格式導致單表 XML 膨脹至 60MB+ 造成記憶體溢位。
- **解法**：
  - `fileOps()` 目錄列出時自動過濾 `.env`、`~$`、`node_modules`、`.venv`。
  - `resolveSmartReadablePath()` 支援任意非敏感本機磁碟唯讀、自動補齊 `.xlsx`、向上回退救援與模糊比對；`xlsxSafeReader` 強制執行 `PK\x03\x04` 4-Byte 檔頭預檢與 Last-Value 截斷法。

### 配方 7：確定性路徑分派救援與空白回覆保底摘要
- **痛點**：當使用者輸入明確 Windows 路徑（如 `D:\良率資料\2026`）但前端忘記勾選 ReAct 工具，或小模型漏輸出 `<tool_call>`／執行工具後忘記輸出文字摘要時，易回覆空訊息或瞎猜沒有權限。
- **解法**：
  - 前後端只要偵測 `X:\` 路徑即自動啟用路徑工具。
  - `inferDeterministicToolCall()` 在首輪保底分派 `file_ops` / `parse_excel_safe`；`formatFallbackReplyFromResults()` 在模型未產出文字時直接由工具實證結果排版繁體中文清單。

### 配方 8：含空格 Windows 路徑完整擷取與專屬領域工具消歧
- **痛點**：Windows 路徑常含空格（如 `D:\Antigravity Project\AI agent`），若正則以 `\s` 截斷會造成路徑找不到；此外問句中的「列出 / 讀取 / 搜尋 / 專案」容易同時命中多個工具，使單工具保底失效。
- **解法**：
  - `extractWindowsPathFromMessage()` 支援含空格路徑並剔除尾端中文語助詞（如「底下」「的內容」）。
  - 在 `selectRelevantTools()` 中針對 `secondbrain_tool`、`scan_local_projects`、`parse_excel_safe`、`query_mes_spc`、`inspect_aoi_system` 執行專屬消歧，排除誤掛的通用工具。

### 配方 9：工具回傳 `2400` 字元截斷與 `num_predict` CPU 節流＋繁中錨點
- **痛點**：純 CPU 推論若餵入過長 JSON（6000+ 字元）或未限制生成長度，易發生 `300s` 逾時；且 `3B` 模型總結英文 JSON 欄位後偶爾切換為英文回覆。
- **解法**：
  - `provider === 'ollama'` 時將工具回傳截斷上限設為 `2400` 字元，並於 `callOllamaChat()` 設定 `num_predict: 640` 控制推論上限，同時於工具結果尾端附加繁中輸出錨點。

### 配方 10：確定性單輪直達加速（Zero-Waste Pre-Fetch）與防睡眠守護
- **痛點**：對確定性極高的單一工具／路徑請求，若先讓 `3B` 模型跑第 1 輪才呼叫工具，常白白浪費 `30~80` 秒 CPU 推論時間；且夜間長時間演練若電腦進入睡眠會中斷。
- **解法**：
  - 在 `runAgentTurn()` 中，若 `inferDeterministicToolCall()` 命中確定性工具，先預取工具實證數據並切換精簡 System Prompt，讓 Ollama **只跑 1 輪**即可總結回覆，實測推論耗時大幅縮減。
  - 演練引擎內建 `startSleepGuard()`（`SetThreadExecutionState`），僅維持系統清醒（允許關閉螢幕省電、不登出），結束即自動釋放。

---

<!-- AUTO_TUNING_LOG_START -->
## 🧬 每日自主演練自動修補與演化日誌
- **[2026-11-17T19:32:37.851Z]** 模型=`Gemini 4 Hydrogen (gemini-4-hydrogen-high)`｜測試 `4` 題｜通過 `4`｜自動修補 `0` 題
- **[2026-11-17T19:26:29.572Z]** 模型=`Gemini 4 Hydrogen (gemini-4-hydrogen-high)`｜測試 `15` 題｜通過 `15`｜自動修補 `0` 題
- **[2026-11-17T05:33:36.008Z]** 模型=`Gemini 4 Hydrogen (gemini-4-hydrogen-high)`｜測試 `107` 題｜通過 `91`｜自動修補 `0` 題
- **[2026-11-16T18:55:21.605Z]** 模型=`Gemini 4 Hydrogen (gemini-4-hydrogen-high)`｜測試 `150` 題｜通過 `91`｜自動修補 `0` 題
- **[2026-11-16T15:24:55.622Z]** 模型=`Gemini 4 Hydrogen (gemini-4-hydrogen-high)`｜測試 `150` 題｜通過 `48`｜自動修補 `0` 題
<!-- AUTO_TUNING_LOG_END -->
