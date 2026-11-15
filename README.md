# Mini-Antigravity 本機自主 AI Agent 中樞

整合 **本機端 LLM (Ollama)** 與 **Node.js ReAct 工具型 Agent** 的全能本機戰情室系統，專為品保工程管理、自動化開發與個人第二大腦打造。

> 📦 **新電腦從零到落地完全懶人包**：請直接參閱 [**本機自主AI_Agent建置懶人包.md**](./本機自主AI_Agent建置懶人包.md)（內含 3 步驟一鍵複製脚本、給另一台電腦 Antigravity 自動部署的 One-Shot 提示詞、完整 8 步驟手工 SOP 與今日踩坑紀錄）。

## ✨ 核心特色
- **本機 LLM 零限制引擎**：整合 Ollama，模型統一存放於 `D:\OllamaModels`（保護 `C:` 槽空間），支援本機離線推理與雲端雙腦熱切換。
- **10 大實戰自主工具與跨磁碟智慧路徑**：圖片自由創建、Zero-OOM Excel 台帳解析、MES/IPQC SPC 製程能力分析、AOI KLA 座標解析、Outlook 唯讀檢索、23 大專案健康巡檢、Obsidian 第二大腦讀寫、本機檔案系統、PowerShell 與聯網搜尋；`parse_excel_safe` 與唯讀檔案操作支援本機任意非敏感磁碟路徑（`C:\`、`D:\`、`T:\` 等）、省略 `.xlsx` 自動補齊與資料夾列出。
- **本機無限制寫實生圖與隱私無痕工坊**：預設整合 **Local SD-LCM**（`D:\OllamaModels\sd` DreamShaper-7 LCM 離線零審查・零浮水印）＋ 雲端 `Flux/Turbo` 自動裁除浮水印 ＋ AI 改圖協作，並配備「🕶️ 隱私無痕模式」與「🗑️ 清除歷史對話（`DELETE /api/image/history`）」徹底抹除特殊創作與對話提示詞紀錄。
- **工業級幾何切線量測工坊**：圖片生成後可直接在畫布啟用 Sobel 邊緣梯度切線化兩點量測、動態切向對齊虛線與自由拖曳尺寸框。
- **Hermes 記憶、成長治理與長對話 80% 自動壓縮**：透過 `SOUL.md`、`USER.md`、`MEMORY.md` 永久保護 `🔴` 核心鐵律，支援記憶學習 Git Diff 提案審核與單筆原子回退，並提供區分 `系統基底 + 對話` 的上下文水位計與 80% 自動摘要壓縮（「前情提要記憶膠囊」）。
- **企業級啟動標準**：配備無黑窗 VBS 啟動腳本與微軟純 DIB 格式（16/32/48/64）`.ico` 專屬圖示。

## 🚀 快速啟動（本機 ＆ 另一台電腦一鍵落地）
### 另一台電腦從零一鍵部署（3 步驟）
```powershell
git clone https://github.com/ericho-0213/AI-agent-lazy-package.git "D:\Antigravity Project\AI agent"
cd "D:\Antigravity Project\AI agent"
powershell -NoProfile -ExecutionPolicy Bypass -File ".\scripts\setup_new_pc.ps1"
```
> 更多詳盡步驟、給另一台 Antigravity 的自動部署提示詞與避坑紀錄請見：[本機自主AI_Agent建置懶人包.md](./本機自主AI_Agent建置懶人包.md)。

### 已安裝電腦日常啟動
1. 雙擊執行 `啟動系統(無黑窗背景執行).vbs`（或桌面捷徑 `Mini-Antigravity AI Agent`）。
2. 系統將自動確認 Ollama (Port `11434`) 與戰情室服務 (Port `8790`) 運行狀態，並於瀏覽器開啟 `http://localhost:8790`。

## 🧪 自動化驗證
執行 `node scripts/verify.js` 可進行全端 **13/13** 項自動化回歸測試（涵蓋雙腦狀態、23 專案巡檢、MES SPC、AOI KLA、Zero-OOM Excel、Obsidian、離線 SVG/雲端生圖、`🔴` 鐵律保護、純 DIB ICO 格式、成長治理 Diff/核准/回退、長對話壓縮與圖片工坊隱私無痕清除）。
