# Mini-Antigravity 本機自主 AI Agent 從零到落地建置懶人包

> 本懶人包完整收錄「**Mini-Antigravity 本機自主 AI Agent 中樞**」的架構全貌、跨電腦一鍵部署流程、給另一台電腦 Antigravity 直接執行的 One-Shot 指令、手工 8 步驟實戰 SOP，以及今天親測排除的所有關鍵踩坑解法。  
> **GitHub 儲存庫**：`https://github.com/ericho-0213/AI-agent-lazy-package`

---

## 一、 系統架構與核心能力總覽

| 模組層級 | 核心技術與本機檔案 | 主要解決的痛點 |
| :--- | :--- | :--- |
| **雙腦熱切換大腦** | Ollama (`127.0.0.1:11434`, `qwen2.5:3b`) ⇄ Gemini 雲端協同腦<br>([server/agentCore.js](./server/agentCore.js)) | 離線零審查、無 API 次數與 Token 費用上限；複雜長篇推理可於戰情室一鍵切換雲端 Gemini |
| **本機無限制生圖 & 隱私無痕工坊** | `Local SD-LCM` (`dreamshaper-7-lcm-q4_0.gguf`) ＋ 雲端 `Flux/Turbo` ＋ 離線 `Local SVG` ＋ AI 改圖協作<br>([server/imageEngine.js](./server/imageEngine.js)) | 雲端模式自動 `+64px` 裁除底部 `pollinations.ai` 浮水印；提供「🕶️ 隱私無痕」與「🗑️ 清除歷史對話（`DELETE /api/image/history`）」徹底抹除提示詞與偏好記憶 |
| **工業級 Sobel 幾何量測畫布** | 前端 Canvas + 3×3 Sobel 梯度算子<br>([public/app.js](./public/app.js)) | 端點自動邊緣吸附與幾何切線化、動態切向虛線對齊、比例尺（μm/mm/px）換算與可拖曳不遮蔽尺寸框 |
| **10 大實戰自主工具與跨磁碟智慧路徑** | [server/projectTools.js](./server/projectTools.js) & [server/xlsxSafeReader.js](./server/xlsxSafeReader.js) | `parse_excel_safe` / `file_ops` 支援 `C:\`、`D:\`、`T:\` 等任意非敏感路徑、省略 `.xlsx` 自動補齊、小模型腦補子路徑向上救援、資料夾清單與最新台帳自動解析（寫入嚴限工作區、封鎖 `.env` 等憑證） |
| **Zero-OOM Excel 安全解析** | `JSZip` 按需解壓 ＋ 4-Byte 檔頭預檢 ＋ Last-Value 截斷 | 徹底避免人員選取整欄造成 60MB+ / 104 萬空白列引發 Node.js Heap Out of Memory 崩潰 |
| **Hermes 記憶・成長治理・長對話壓縮** | `memory/SOUL.md`、`USER.md`、`MEMORY.md`、`learning_governance.json`、`context_summary.json` | 永久保護 `🔴` 核心鐵律不可刪除；記憶學習支援 Git Diff 提案預覽、核准寫入與單筆**原子回退**；上下文水位計清楚拆解「系統 ＋ 對話」並於 `80%` 自動檢查點摘要壓縮 |
| **企業級靜默啟動與純 DIB 圖示** | [啟動系統(無黑窗背景執行).vbs](./啟動系統(無黑窗背景執行).vbs)、[scripts/build_icon.ps1](./scripts/build_icon.ps1)、`runtime/ai_agent.ico` | 無黑窗背景執行；純微軟 DIB 編碼（16/32/48/64）快取至 `%LOCALAPPDATA%\AI-Agent-Cache`，桌面與網路磁碟永不變白紙 |

---

## 二、 另一台電腦使用前準備（基本環境需求）

請先確認目標電腦（Windows 10 / 11 x64）已安裝以下基礎環境：
1. **Node.js (v18 LTS 或以上，建議 v20+)**：需含 `node` 與 `npm`。
2. **Git**：可執行 `git clone` 下載本專案。
3. **磁碟空間**：建議預留 **至少 6 GB 以上可用空間**（優先放於 **`D:\OllamaModels`**，避免佔滿 `C:` 槽；若該電腦無 `D:` 槽，一鍵腳本會自動改用專案所在磁碟根目錄下的 `\OllamaModels`）。
4. **（選用）Gemini 雲端協同腦**：若需啟用戰情室右上角 Gemini 熱切換，只需於專案根目錄新增 `.env` 填入 `GEMINI_API_KEY=你的金鑰`（**嚴禁將 `.env` 提交至 Git**）。

---

## 三、 方式 A：另一台電腦「極速一鍵複製落地」（推薦，3 步驟完成）

這是最快的方式——直接把本專案與所有調校好的工具、懶人包腳本複製到新電腦執行：

### 步驟 1：克隆專案至本機磁碟（建議放 `D:` 槽）
```powershell
mkdir "D:\Antigravity Project" -Force | Out-Null
git clone https://github.com/ericho-0213/AI-agent-lazy-package.git "D:\Antigravity Project\AI agent"
cd "D:\Antigravity Project\AI agent"
```

### 步驟 2：執行全自動一鍵建置腳本
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\setup_new_pc.ps1"
```
> 若新電腦不需要本機 Stable Diffusion 寫實生圖模型（可省 1.6 GB 下載，改用雲端 `Flux/Turbo` 或離線 `SVG`），可改執行：  
> `powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\setup_new_pc.ps1" -SkipSd`

這個腳本會自動為您依序完成：
1. 設定環境變數 `OLLAMA_MODELS`（User 級＋目前工作階段）指向 `D:\OllamaModels`（若無 `D:` 槽則指向專案所在磁碟 `\OllamaModels`）。
2. 執行 `npm install` 安裝 `express`、`cors`、`dotenv`、`jszip`。
3. 檢測 `ollama.exe`；若未安裝則自動從官方下載 `OllamaSetup.exe` 並執行 `/SILENT` 靜默安裝。
4. 啟動本機 Ollama 服務（Port `11434`），呼叫 [scripts/fast_pull_ollama.ps1](./scripts/fast_pull_ollama.ps1) 以 **4 連線平行 HTTP Range 斷點續傳 ＋ SHA-256 嚴格校驗** 下載並註冊 `qwen2.5:3b`（`1.93 GB`）。
5. 呼叫 [scripts/install_local_sd.ps1](./scripts/install_local_sd.ps1) 部署 `stable-diffusion.cpp` (`sd-cli.exe` Win CPU x64) 與 `dreamshaper-7-lcm-q4_0.gguf`（`1,625,041,920 bytes` / MD5 `03661e588d8728a4ec6141f64bd69842`）。
6. 將純 DIB 4 圖層 [runtime/ai_agent.ico](./runtime/ai_agent.ico) 快取至 `%LOCALAPPDATA%\AI-Agent-Cache\ai_agent.ico`，並於桌面與專案資料夾建立「`Mini-Antigravity AI Agent.lnk`」捷徑。
7. 透過 [啟動系統(無黑窗背景執行).vbs](./啟動系統(無黑窗背景執行).vbs) 啟動服務並自動執行 `node scripts/verify.js` 驗收。

### 步驟 3：啟動使用
- 雙擊桌面捷徑 **`Mini-Antigravity AI Agent`**（或專案內 [啟動系統(無黑窗背景執行).vbs](./啟動系統(無黑窗背景執行).vbs)），瀏覽器會自動開啟戰情室 **`http://localhost:8790`**。
- 若需將本機 Ollama 作為視窗 CLI 代理使用，亦可執行：`node scripts/ask_local_agent.js "請列出目前電腦內的專案狀態"`。

---

## 四、 方式 B：直接交給另一台電腦的 Antigravity 自動建置（One-Shot Prompt）

若您在另一台電腦有使用 **Antigravity**，只需開啟一個新對話並貼上以下提示詞，即可讓另一台電腦的 AI 照本懶人包幫您全自動部署到好：

```text
請幫我把我的本機自主 AI Agent 中樞部署到這台電腦：
1. 將 GitHub 專案 https://github.com/ericho-0213/AI-agent-lazy-package.git 克隆到 D:\Antigravity Project\AI agent（若無 D 槽則放到使用者自訂開發目錄，但腳本與路徑必須保持動態解析）。
2. 執行 .\scripts\setup_new_pc.ps1 完成環境變數 OLLAMA_MODELS 設定、npm install、Ollama 安裝與 qwen2.5:3b 斷點續傳拉取、Local SD-LCM 生圖引擎部署、純 DIB 圖示快取與桌面捷徑建立。
3. 以 .\啟動系統(無黑窗背景執行).vbs 啟動 http://localhost:8790 服務後，執行 node scripts/verify.js 並向我回報所有測試項目的實際驗證結果與本機檔案連結。
```

---

## 五、 方式 C：從零開始手工建置 8 大實戰步驟詳解（今天實際執行的 SOP）

若您想理解每一項零件是如何從無到有搭建起來（或在新環境逐項排錯），可依照以下 8 個步驟操作：

### Step 1：規劃非系統槽模型庫與設定 `OLLAMA_MODELS`
避免幾個 GB 的大模型塞爆 `C:` 槽系統碟，先建立 `D:\OllamaModels` 並寫入使用者環境變數：
```powershell
New-Item -ItemType Directory -Force -Path "D:\OllamaModels" | Out-Null
[Environment]::SetEnvironmentVariable("OLLAMA_MODELS", "D:\OllamaModels", "User")
$env:OLLAMA_MODELS = "D:\OllamaModels"
```

### Step 2：安裝 Ollama 執行環境與防休眠守護
1. 確認 `%LOCALAPPDATA%\Programs\Ollama\ollama.exe` 已安裝（無則由官網下載 `OllamaSetup.exe /SILENT`）。
2. 啟動 `scripts/keep_awake_ollama.ps1`（使用 Windows API `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`），防止筆電/電腦於大型模型下載或長推理中途進入 Modern Standby 斷網或休眠，並啟動 `ollama serve`（`127.0.0.1:11434`）。

### Step 3：4 連線平行斷點續傳拉取模型（避開官方卡頓）
直接使用內建的 4 連線 HTTP Range 斷點續傳腳本（含進度檔 `.progress.json`、SHA-256 自動校驗與單執行緒 `curl.exe -C -` 降級備援）：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\fast_pull_ollama.ps1" -Model "qwen2.5" -Tag "3b"
```
- 主力模型建議：`qwen2.5:3b`（約 `1.93 GB` Q4_K_M，原生支援 Function Calling `tools`）。
- 選配加裝：`qwen2.5:7b`、`qwen2.5-coder:7b`、`deepseek-r1:7b`（皆可直接用同腳本或於戰情室「中控台」一鍵拉取）。

### Step 4：部署 100% 離線免審查本機寫實生圖引擎（Local SD-LCM）
執行 [scripts/install_local_sd.ps1](./scripts/install_local_sd.ps1)：
```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\install_local_sd.ps1"
```
該腳本會自動完成：
- 下載並解壓 `stable-diffusion.cpp` (`sd-cli.exe`，約 `17.4 MB`) 至 `%OLLAMA_MODELS%\sd\bin`。
- 4 連線平行 HTTP Range 下載 `dreamshaper-7-lcm-q4_0.gguf`（`1,625,041,920 bytes`）並校驗 **MD5 = `03661e588d8728a4ec6141f64bd69842`**。
- 參數針對 CPU AVX2 最佳化：`--sampling-method lcm --scheduler lcm --steps 5 --cfg-scale 1.5`。

### Step 5：啟動 Node.js 伺服器與 10 大實戰自主工具
安裝套件並確認各核心模組：
```powershell
npm install
node --check server/server.js
```
核心程式架構：
- [server/server.js](./server/server.js)：Express 主服務（Port `8790`），提供 `/api/status`、`/api/chat`、`/api/chat/compact`、`/api/memory/*`、`/api/image/*`（含 `DELETE /api/image/history`）、`/api/tools/*`。
- [server/agentCore.js](./server/agentCore.js)：雙腦 ReAct 迴圈、Ollama / Gemini 切換、圖片協作與提示詞英譯、上下文水位計算與 80% 自動摘要壓縮。
- [server/projectTools.js](./server/projectTools.js)：10 大工具實作、跨磁碟非敏感路徑解析、Hermes 記憶讀取與 `🔴` 鐵律保護、成長治理提案/核准/原子回退、`image_taste.json` 管理。
- [server/imageEngine.js](./server/imageEngine.js)：Local SD-LCM、Pollinations Flux/Turbo 高度加採樣無損去浮水印、斷網 Local SVG 與無痕/隱私提示詞清洗。
- [server/xlsxSafeReader.js](./server/xlsxSafeReader.js)：Zero-OOM Excel XML 串流裁切引擎。

### Step 6：配置 Hermes 靈魂記憶與成長治理邊界
檢查並自訂 `memory/` 目錄的三份核心 Markdown（皆可在戰情室「🧬 靈魂人格 & 記憶鐵律」頁籤即時編修並熱生效）：
- [memory/SOUL.md](./memory/SOUL.md)：定義 Agent 身分、繁中台灣語氣、數據誠信與 ReAct 原則。
- [memory/USER.md](./memory/USER.md)：記載您的環境、領域（品質保證、自動化等）與個人介面習慣。
- [memory/MEMORY.md](./memory/MEMORY.md)：核心業務鐵律（**凡含 `🔴` 標記之行受程式層鎖定保護，嚴禁刪除或覆蓋**）。

### Step 7：建立微軟純 DIB 圖示快取與無黑窗背景啟動
1. 圖示檔案 [runtime/ai_agent.ico](./runtime/ai_agent.ico) 採用純微軟 BITMAPINFOHEADER DIB（`16×16`、`32×32`、`48×48`、`64×64`）封裝，避免 Windows 檔案總管因 PNG 壓縮圖示顯示為空白白紙；如需重繪圖示可執行 [scripts/build_icon.ps1](./scripts/build_icon.ps1)。
2. 透過 [啟動系統(無黑窗背景執行).vbs](./啟動系統(無黑窗背景執行).vbs) 啟動：
   - 自動將 `runtime\ai_agent.ico` 複製至本機快取 `%LOCALAPPDATA%\AI-Agent-Cache\ai_agent.ico`（跨機與網路磁碟防白紙規範）。
   - 使用 `netstat -ano` 檢查 Port `11434` 與 `8790` 是否已啟動，避免重複佔用端口。
   - 以 `ws.Run ..., 0, False` 完全隱藏黑窗背景啟動服務後，自動於預設瀏覽器開啟 `http://localhost:8790`。

### Step 8：執行全端自動化驗收
服務啟動後執行：
```powershell
node scripts/verify.js
```
確認輸出 **`總結: 13/13 通過`**（在全新無鄰近企業資料夾的電腦上，`verify.js` 會自動驗證 API 結構與回傳格式，不會因缺少其他專案資料夾而誤報失敗）。

---

## 六、 今日實戰踩坑與關鍵調校紀錄（重要經驗沉澱）

1. **為何不用官方預設 `ollama pull` 直接下載大模型？**
   - 官方 CLI 預設開啟 16 連線併發，在企業防火牆或家用 Wi-Fi 下極易在最後幾 % 觸發連線池重置卡死、甚至重頭再來。
   - **解法**：使用 [scripts/fast_pull_ollama.ps1](./scripts/fast_pull_ollama.ps1) 的「4 連線平行 HTTP Range + `.progress.json` 續傳 + SHA-256 校驗 + 單執行緒 `curl.exe -C -` 保底」，搭配 `SetThreadExecutionState` 防休眠守護。
2. **為何 `qwen2.5:3b` 空載上下文水位原本高達 `63%（偏高）`且推理偏慢？**
   - 原本在 Ollama 模式下不僅傳了原生 `tools` 陣列，還把所有工具菜單文字與 `handoff.md` 前 1,200 字工程筆記重複塞進 System Prompt，加上中文 Token 估算採用高估的 `1.45` 倍係數，使空載就佔用 `2,584 / 4,096 tok`。
   - **解法**：Ollama 走原生 `tools` 欄位、`readHandoffSummary()` 改為僅擷取 `<!-- BRIDGE_SYNC_START -->...<!-- BRIDGE_SYNC_END -->` 交接區塊、中文估算係數校正為 `0.85`、清空對話歷史一併清除交接殘留，且介面拆解顯示 `系統 X + 對話 Y`——空載直接降至 **`1,150 / 4,096 tok（28%・充裕）`**。
3. **為何小模型（`qwen2.5:3b`）讀取省略副檔名的本機 Excel 路徑會失敗？**
   - 例如輸入 `D:\良率資料\2026\良率資料-mapping 2026年10月` 時，模型會誤以為這是資料夾並自行「腦補」出不存在的子檔名，同時被原本僅限工作區的沙盒白名單阻擋。
   - **解法**：於 `projectTools.js` 實作 `allowAnyLocalRead: true`（開放任意非敏感磁碟路徑唯讀，同時嚴守工作區外禁止寫入與 `.env` 憑證封鎖）及 `resolveSmartReadablePath()`（自動補齊 `.xlsx`、向上回退救援腦補子路徑、支援資料夾列出與自動解析最新台帳）。
4. **如何兼顧「自主學習成長」與「創作隱私・誤學回退」？**
   - **記憶治理**：在「🧬 靈魂人格 & 記憶鐵律」頁籤提供「🟡 提案審核模式（Git Diff 預覽 → 人工微調核准）」⇄「🟢 自動套用模式」，以及所有已沉澱規則的一鍵「↩️ 原子回退 (Rollback)」。
   - **圖片工坊隱私**：提供「🕶️ 隱私無痕」即時遮罩寫入，與「🗑️ 清除歷史對話 (`DELETE /api/image/history`)」一鍵清空畫面、審美記憶 `image_taste.json`、圖庫與對話中所有提示詞文字。

---

## 七、 其他電腦接手後常用檢查指令速查

```powershell
# 1. 一鍵驗證全部 13 項核心功能與 API
node scripts/verify.js

# 2. 檢查所有 JS 語法是否正常
node --check server/server.js; node --check server/agentCore.js; node --check server/projectTools.js; node --check server/imageEngine.js

# 3. 檢查本機已註冊之 Ollama 模型
ollama list

# 4. 在不開瀏覽器的情況下，直接從 CLI 呼叫本機 Ollama Agent
node scripts/ask_local_agent.js "請用 scan_local_projects 巡檢本機專案"
```
