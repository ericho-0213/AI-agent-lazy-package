/**
 * Mini-Antigravity ReAct Agent 核心引擎
 * 1. 支援本機 Ollama (/api/chat) 與 Gemini API 雙腦熱切換
 * 2. 支援原生 tools 協定與 <tool_call>...</tool_call> 結構化標籤雙重解析（確保 3B/7B 本地模型穩定觸發工具）
 * 3. 整合 10 大自主工具 + Hermes 三層記憶 (SOUL.md / USER.md / MEMORY.md)
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { spawn } = require('node:child_process');
const projectTools = require('./projectTools');
const imageEngine = require('./imageEngine');

const OLLAMA_CANDIDATE_PORTS = [11434, 11435, 11436, 11440, 18434];
let activeOllamaBase = process.env.OLLAMA_HOST
  ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`)
  : 'http://127.0.0.1:11434';
let startingPromise = null;

async function probeOllamaBase(baseUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!resp.ok) return { online: false, baseUrl, models: [] };
    const data = await resp.json();
    if (!data || !Array.isArray(data.models)) {
      return { online: false, baseUrl, models: [] };
    }
    return { online: true, baseUrl, models: data.models };
  } catch {
    return { online: false, baseUrl, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

function canBindPort(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const srv = net.createServer();
    srv.once('error', () => done(false));
    srv.once('listening', () => {
      srv.close(() => done(true));
    });
    try {
      srv.listen(port, '127.0.0.1');
    } catch {
      done(false);
    }
  });
}

function findOllamaExecutable() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  }
  candidates.push(path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Ollama', 'ollama.exe'));
  candidates.push('C:\\Program Files\\Ollama\\ollama.exe');
  for (const exePath of candidates) {
    if (exePath && fs.existsSync(exePath)) return exePath;
  }
  return '';
}

async function ensureOllamaRunning() {
  if (startingPromise) return startingPromise;

  const current = await probeOllamaBase(activeOllamaBase);
  if (current.online) return current;

  startingPromise = (async () => {
    try {
      for (const port of OLLAMA_CANDIDATE_PORTS) {
        const candidateUrl = `http://127.0.0.1:${port}`;
        if (candidateUrl === activeOllamaBase) continue;
        const probe = await probeOllamaBase(candidateUrl, 800);
        if (probe.online) {
          activeOllamaBase = candidateUrl;
          return probe;
        }
      }

      const ollamaExe = findOllamaExecutable();
      if (!ollamaExe) {
        return { online: false, models: [], baseUrl: activeOllamaBase };
      }

      let freePort = null;
      for (const port of OLLAMA_CANDIDATE_PORTS) {
        if (await canBindPort(port)) {
          freePort = port;
          break;
        }
      }
      if (!freePort) {
        return { online: false, models: [], baseUrl: activeOllamaBase };
      }

      const modelsDir = process.env.OLLAMA_MODELS || path.join(path.parse(projectTools.BASE_DIR).root || 'D:\\', 'OllamaModels');
      const targetUrl = `http://127.0.0.1:${freePort}`;
      const child = spawn(ollamaExe, ['serve'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          OLLAMA_HOST: `127.0.0.1:${freePort}`,
          OLLAMA_MODELS: modelsDir
        }
      });
      child.unref();

      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const probe = await probeOllamaBase(targetUrl, 1000);
        if (probe.online) {
          activeOllamaBase = targetUrl;
          return probe;
        }
      }

      return { online: false, models: [], baseUrl: activeOllamaBase };
    } finally {
      startingPromise = null;
    }
  })();

  return startingPromise;
}

/**
 * 安全讀取 Gemini API 金鑰（僅於伺服器端記憶中使用，絕不外洩至前端或 API 回傳）
 */
function resolveGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const candidates = [
    path.join(projectTools.BASE_DIR, '.env'),
    path.join(projectTools.PROJECTS_ROOT, 'AI代理團隊', '.env')
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const m = content.match(/^GEMINI_API_KEY\s*=\s*(.+)$/m);
      if (m && m[1]) {
        return m[1].trim().replace(/^["']|["']$/g, '');
      }
    } catch {
      // ignore
    }
  }
  return '';
}

/**
 * 10 大自主工具註冊表
 */
const TOOL_DEFINITIONS = [
  {
    name: 'generate_image',
    description: '圖片自由創建工具：預設使用本機 DreamShaper-7 LCM 離線寫實引擎 (local-sd，零浮水印、零審查)，亦可切換 flux / turbo 雲端生圖或 local-svg 離線向量圖，儲存於 outputs/images/。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '圖片內容描述（中文或英文皆可）' },
        engine: { type: 'string', enum: ['local-sd', 'flux', 'turbo', 'local-svg'], description: '生圖引擎：預設 local-sd（本機離線無限制），亦可選 flux / turbo / local-svg' },
        style: { type: 'string', enum: ['photorealistic', 'cyberpunk', 'illustration', 'blueprint', 'anime', 'none'], description: '圖片風格' },
        width: { type: 'number', description: '寬度像素，本機預設 512，雲端預設 1024' },
        height: { type: 'number', description: '高度像素，本機預設 512，雲端預設 1024' }
      },
      required: ['prompt']
    },
    execute: async (args, ctx) => {
      const targetEngine = args.engine || 'local-sd';
      const defaultDim = targetEngine === 'local-sd' ? 512 : 1024;
      return imageEngine.generateAiImage({
        prompt: args.prompt,
        engine: targetEngine,
        style: args.style || 'photorealistic',
        width: args.width || defaultDim,
        height: args.height || defaultDim,
        translatePromptFn: ctx.translatePromptFn
      });
    }
  },
  {
    name: 'parse_excel_safe',
    description: 'Zero-OOM Excel 安全解析工具：支援本機任意非敏感磁碟路徑（C:\\、D:\\、T:\\ 等）與資料夾讀取；會自動補齊省略的 .xlsx 副檔名，若傳入資料夾則自動列出內部 Excel 清單並解析最新檔案，執行 4-Byte 檔頭預檢與 Last-Value 截斷法讀取不溢位。',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: '本機或網路磁碟的 Excel (.xlsx) 檔案路徑（可省略 .xlsx）或資料夾路徑，留空則列出已掃描到的本機 .xlsx 檔案' },
        sheetName: { type: 'string', description: '指定工作表名稱（可選）' },
        maxRows: { type: 'number', description: '預覽最多列數，預設 25' }
      }
    },
    execute: async (args) => {
      if (!args.filePath) {
        return { success: true, files: projectTools.listLocalExcelFiles() };
      }
      return projectTools.parseExcelSafe({
        filePath: args.filePath,
        sheetName: args.sheetName || '',
        maxRows: args.maxRows || 25
      });
    }
  },
  {
    name: 'query_mes_spc',
    description: 'MES / IPQC 製程檢驗數據與 SPC 製程能力分析工具：讀取 Q004 批號量測明細，計算平均值 X-bar、全距 R、標準差 σ、Ca、Cp、Cpk 與超規數。',
    parameters: {
      type: 'object',
      properties: {
        lotNo: { type: 'string', description: '批號（例如 5LA261106-A10），留空或填 list 可取得目前可用批號' }
      }
    },
    execute: async (args) => projectTools.queryMesAndSpc({ lotNo: args.lotNo || '' })
  },
  {
    name: 'inspect_aoi_system',
    description: 'AOI 覆判系統案件與 KLA 缺陷座標查詢工具：讀取待覆判/已結案案件摘要與晶圓座標百分比 (xPct, yPct) 及缺陷面積。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '顯示最近幾筆案件，預設 10' }
      }
    },
    execute: async (args) => projectTools.inspectAoiSystem({ limit: args.limit || 10 })
  },
  {
    name: 'query_outlook_safe',
    description: 'Outlook 郵件與行事曆唯讀安全檢索工具（嚴守紅旗/待處理郵件絕不移動鐵律）。',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['calendar', 'mail'], description: 'calendar 查未來行程；mail 查收件匣' },
        keyword: { type: 'string', description: '搜尋關鍵字（僅 mail 模式有效）' },
        days: { type: 'number', description: '未來天數，預設 14 天' }
      }
    },
    execute: async (args) => projectTools.queryOutlookSafe(args)
  },
  {
    name: 'scan_local_projects',
    description: '本機全專案健康巡檢工具：掃描工作區上層目錄內所有專案（如 AI代理團隊、AOI覆判系統、IPQC檢驗系統、管家團隊等）之 AGENTS.md、Git、無黑窗 VBS 與運行端口狀態。',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => projectTools.scanLocalProjects()
  },
  {
    name: 'secondbrain_tool',
    description: 'Obsidian 第二大腦 (Secondbrain) 連接器：搜尋筆記 (search)、列出專案導航HUB (list_hubs)、讀取筆記 (read)、寫入筆記 (write) 或執行知識庫健康檢查 (lint)。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list_hubs', 'search', 'read', 'write', 'lint'], description: '操作類型' },
        query: { type: 'string', description: '搜尋關鍵字（search 時必填）' },
        notePath: { type: 'string', description: '筆記相對路徑（read 時必填）' },
        folder: { type: 'string', enum: ['知識庫', '每日筆記', '創作庫', 'Clippings'], description: '寫入目錄' },
        title: { type: 'string', description: '新筆記標題' },
        content: { type: 'string', description: '新筆記 Markdown 內容' }
      },
      required: ['action']
    },
    execute: async (args) => projectTools.secondbrainTool(args)
  },
  {
    name: 'file_ops',
    description: '本機檔案系統安全讀寫工具：list/read 支援本機任意非敏感磁碟路徑（C:\\、D:\\、T:\\ 等）與自動 .xlsx 副檔名補齊及目錄列出；write 僅限寫入 AI agent 工作區內檔案。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'read', 'write'], description: '操作類型' },
        targetPath: { type: 'string', description: '本機任意非敏感磁碟路徑（list/read，支援自動補齊 .xlsx 與資料夾列出）或工作區內相對路徑（write）' },
        content: { type: 'string', description: '寫入內容（write 時使用）' }
      },
      required: ['action', 'targetPath']
    },
    execute: async (args) => projectTools.fileOps(args)
  },
  {
    name: 'run_powershell',
    description: 'PowerShell 終端機執行器：執行本機診斷、磁碟檢測、檔案查詢或腳本指令。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要執行的 PowerShell 指令' }
      },
      required: ['command']
    },
    execute: async (args) => projectTools.runPowerShellTool(args)
  },
  {
    name: 'web_search',
    description: '即時聯網搜尋工具：突破本機模型知識截止時間，查詢網路最新資訊或技術文件。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜尋關鍵字' }
      },
      required: ['query']
    },
    execute: async (args) => projectTools.webSearch(args)
  },
  {
    name: 'memory_tool',
    description: 'Hermes 長期記憶管理工具：僅在使用者明確要求「記住、寫入記憶、以後都這樣」時呼叫 append，或要求讀取記憶時呼叫 read。一般問答與數學計算嚴禁呼叫。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['read', 'append'], description: 'read 讀取記憶；append 追加紀錄' },
        file: { type: 'string', enum: ['MEMORY', 'USER', 'SOUL'], description: '目標記憶檔' },
        appendText: { type: 'string', description: '要追加的記憶內容' }
      },
      required: ['action']
    },
    execute: async (args, ctx) => {
      if (args && args.action === 'append') {
        const userMsg = String((ctx && ctx.userMessage) || '');
        const memoryIntentRe = /(記住|記憶|以後|往後|之後都|一律|習慣|偏好|鐵律|寫入|存起來|備忘|memory|soul|user)/i;
        if (!memoryIntentRe.test(userMsg)) {
          return { success: true, skipped: true, message: '單次問答無需寫入長期記憶' };
        }
      }
      return projectTools.memoryTool(args);
    }
  }
];

function getToolByName(name) {
  return TOOL_DEFINITIONS.find((t) => t.name === name);
}

const TOOL_MATCH_RULES = [
  { name: 'generate_image', pattern: /畫|生圖|圖片|照片|繪製|創作.*圖|生成.*圖|寫實|視覺|svg|flux|sd|image|draw/i },
  { name: 'parse_excel_safe', pattern: /excel|xlsx|試算表|台帳|工作表|欄位|\.xls/i },
  { name: 'query_mes_spc', pattern: /mes|ipqc|spc|cpk|ca|cp|批號|黏度|檢驗|製程|標準差|全距|5LA|Q004/i },
  { name: 'inspect_aoi_system', pattern: /aoi|kla|覆判|缺陷|晶圓|瑕疵/i },
  { name: 'query_outlook_safe', pattern: /outlook|郵件|信件|信箱|行事曆|行程|會議|紅旗|mail|calendar/i },
  { name: 'scan_local_projects', pattern: /專案|巡檢|健康|端口|port|git|vbs|agents\.md/i },
  { name: 'secondbrain_tool', pattern: /obsidian|secondbrain|第二大腦|筆記|知識庫|專案導航|hub|clippings|lint/i },
  { name: 'file_ops', pattern: /檔案|目錄|資料夾|讀取|寫入|列出|路徑|桌面|下載|[c-z]:\\|file|folder/i },
  { name: 'run_powershell', pattern: /powershell|終端機|指令|腳本|診斷|磁碟|記憶體|cpu|process|netstat|cmd/i },
  { name: 'web_search', pattern: /搜尋|上網|聯網|網路|最新|新聞|網站|google|search|天氣|匯率|股價/i },
  { name: 'memory_tool', pattern: /記住|記憶|鐵律|習慣|偏好|以後都|往後|memory\.md|soul\.md|user\.md/i }
];

const AUTO_TUNING_PATH = path.join(projectTools.MEMORY_DIR, 'ollama_auto_tuning.json');

const DEFAULT_AUTO_TUNING = {
  updatedAt: null,
  customKeywords: {
    file_ops: ['資料夾', '目錄清單'],
    parse_excel_safe: ['月報', '良率表']
  },
  toolAliases: {
    list: 'file_ops',
    dir: 'file_ops',
    ls: 'file_ops',
    read: 'file_ops',
    excel: 'parse_excel_safe',
    spc: 'query_mes_spc'
  },
  argAliases: {
    path: 'targetPath',
    dir: 'targetPath',
    folder: 'targetPath',
    directory: 'targetPath',
    sheet: 'sheetName',
    lot: 'lotNo'
  },
  promptRules: [
    '列出資料夾或檔案時，請直接使用工具回傳的真實檔名，嚴禁自行在檔名前方加上 ~$ 符號。',
    '回覆請全程使用繁體中文（Taiwan），嚴禁夾雜簡體字（如「请告诉我」應寫為「請告訴我」）。'
  ]
};

/**
 * 讀取動態自我調校規則庫（memory/ollama_auto_tuning.json），支援演練引擎即時熱更新
 */
function loadAutoTuning() {
  if (!fs.existsSync(AUTO_TUNING_PATH)) {
    return JSON.parse(JSON.stringify(DEFAULT_AUTO_TUNING));
  }
  try {
    const raw = JSON.parse(fs.readFileSync(AUTO_TUNING_PATH, 'utf8'));
    return {
      updatedAt: raw.updatedAt || null,
      customKeywords: { ...DEFAULT_AUTO_TUNING.customKeywords, ...(raw.customKeywords || {}) },
      toolAliases: { ...DEFAULT_AUTO_TUNING.toolAliases, ...(raw.toolAliases || {}) },
      argAliases: { ...DEFAULT_AUTO_TUNING.argAliases, ...(raw.argAliases || {}) },
      promptRules: Array.isArray(raw.promptRules) && raw.promptRules.length > 0
        ? raw.promptRules
        : [...DEFAULT_AUTO_TUNING.promptRules]
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_AUTO_TUNING));
  }
}

/**
 * 寫入動態自我調校規則庫（memory/ollama_auto_tuning.json）
 */
function saveAutoTuning(nextTuning) {
  fs.mkdirSync(path.dirname(AUTO_TUNING_PATH), { recursive: true });
  const payload = {
    updatedAt: new Date().toISOString(),
    customKeywords: nextTuning.customKeywords || {},
    toolAliases: nextTuning.toolAliases || {},
    argAliases: nextTuning.argAliases || {},
    promptRules: Array.isArray(nextTuning.promptRules) ? nextTuning.promptRules : []
  };
  fs.writeFileSync(AUTO_TUNING_PATH, JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/**
 * 智慧工具意圖分流：依使用者指令按需掛載工具 Schema，純對話與數學計算回傳空陣列以極速回應
 */
function selectRelevantTools(message, enableTools = true) {
  const msg = String(message || '').trim();
  if (!msg) return [];

  const hasWindowsPath = /[a-zA-Z]:\\/.test(msg);
  if (!enableTools && !hasWindowsPath) return [];

  const pureMathRe = /^(請|幫我|請問)?\s*(計算|算一下|算|算數)?\s*[\d\s+\-*/().%=^×÷,，。？?]+(等於多少|是多少)?\s*[?？]*$/i;
  const domainKeywordRe = /(檔案|批號|spc|excel|xlsx|aoi)/i;
  if (pureMathRe.test(msg) && !domainKeywordRe.test(msg)) {
    return [];
  }

  const matchedNames = new Set(
    TOOL_MATCH_RULES.filter((r) => r.pattern.test(msg)).map((r) => r.name)
  );

  const tuning = loadAutoTuning();
  const msgLower = msg.toLowerCase();
  for (const [toolName, keywords] of Object.entries(tuning.customKeywords || {})) {
    if (!Array.isArray(keywords)) continue;
    if (keywords.some((kw) => kw && msgLower.includes(String(kw).toLowerCase()))) {
      matchedNames.add(toolName);
    }
  }

  if (hasWindowsPath) {
    matchedNames.add('file_ops');
    if (/\.(xlsx|xlsm|xls)/i.test(msg)) {
      matchedNames.add('parse_excel_safe');
    }
  }
  if (matchedNames.size === 0) return [];
  return TOOL_DEFINITIONS.filter((t) => matchedNames.has(t.name));
}

function readHandoffSummary() {
  const handoffPath = path.join(projectTools.BASE_DIR, 'handoff.md');
  if (!fs.existsSync(handoffPath)) return '';
  try {
    const raw = fs.readFileSync(handoffPath, 'utf8');
    const m = raw.match(/<!-- BRIDGE_SYNC_START -->([\s\S]*?)<!-- BRIDGE_SYNC_END -->/);
    if (!m) return '';
    return m[1].replace(/^###.*$/gm, '').trim().slice(0, 360);
  } catch {
    return '';
  }
}

function writeBridgeSnapshot({ message, provider, model, trace = [], reply = '' }) {
  try {
    const bridgePath = path.join(projectTools.MEMORY_DIR, 'antigravity_bridge.md');
    fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
    const toolsUsed = trace.map((t) => `${t.toolName}(${t.success ? 'ok' : 'err'})`).join(', ') || '無';
    const entry = [
      `## [${new Date().toISOString()}] ${provider}/${model}`,
      `- **使用者指令**：${String(message || '').replace(/\r?\n/g, ' ').slice(0, 200)}`,
      `- **呼叫工具**：${toolsUsed}`,
      `- **回覆摘要**：${String(reply || '').replace(/\r?\n/g, ' ').slice(0, 450)}`,
      ''
    ].join('\n');

    let prev = '';
    if (fs.existsSync(bridgePath)) {
      const old = fs.readFileSync(bridgePath, 'utf8');
      const sections = old.split(/\n(?=## \[)/).filter((s) => s.startsWith('## ['));
      prev = sections.slice(0, 7).join('\n');
    }

    const header = '# Antigravity ⇄ 本機 Ollama 雙向交接紀錄 (antigravity_bridge.md)\n\n';
    fs.writeFileSync(bridgePath, `${header}${entry}\n${prev}`.trim() + '\n', 'utf8');
  } catch {
    // ignore bridge write errors
  }
}

/**
 * 輕量精準的中英文 Token 估算器
 */
function estimateTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  const cjkMatches = s.match(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const nonCjkCount = s.length - cjkCount;
  return Math.ceil(cjkCount * 0.85 + nonCjkCount * 0.3);
}

function buildSystemPrompt(activeToolsOrBool = true, provider = 'ollama') {
  const mem = projectTools.readMemoryFiles();
  const handoffSnippet = readHandoffSummary();
  const ctxState = projectTools.readContextState();
  const tuning = loadAutoTuning();

  const activeTools = Array.isArray(activeToolsOrBool)
    ? activeToolsOrBool
    : (activeToolsOrBool
        ? (provider === 'ollama' ? TOOL_DEFINITIONS.slice(0, 1) : TOOL_DEFINITIONS)
        : []);

  let toolInstructions = '';
  if (activeTools.length > 0) {
    const toolMenu = activeTools
      .map((t) => `- ${t.name}: ${t.description}\n  參數 Schema: ${JSON.stringify((t.parameters && t.parameters.properties) || {})}`)
      .join('\n');

    toolInstructions = `\n\n## 可用自主工具清單
${toolMenu}

## 工具呼叫協定 (極重要)
當你需要取得本機實證資料、查看資料夾、讀取檔案、生圖或計算 SPC 時，請直接輸出以下格式呼叫工具（Windows 路徑請寫雙反斜線 \\\\）：
<tool_call>{"name": "工具名稱", "arguments": {"參數名": "參數值"}}</tool_call>
注意：
1. 工具未回傳前，嚴禁編造任何數據或檔案清單。
2. 取得工具結果後，再用繁體中文（Taiwan）精簡清楚地向「您」彙報結果。`;
  }

  const tuningSection = Array.isArray(tuning.promptRules) && tuning.promptRules.length > 0
    ? `\n\n## 本機調校附加守則\n${tuning.promptRules.map((r) => `- ${r}`).join('\n')}`
    : '';

  const taste = projectTools.readImageTaste();
  const tasteLine = taste.summaryText ? `\n- 近期生圖視覺審美偏好（自主學習）：${taste.summaryText}` : '';
  const handoffSection = handoffSnippet ? `\n\n## Antigravity 最新交接脈絡\n${handoffSnippet}` : '';
  const rollingSection = ctxState.rollingSummary
    ? `\n\n## 📦 對話前情提要（自動壓縮記憶膠囊）\n${ctxState.rollingSummary}`
    : '';
  return `${mem.SOUL}\n\n## 使用者背景\n${mem.USER}${tasteLine}\n\n## 長期記憶與鐵律\n${mem.MEMORY}${tuningSection}${handoffSection}${rollingSection}${toolInstructions}`;
}

/**
 * 計算目前對話的上下文 Token 水位與壓縮警戒狀態
 */
function computeContextStatus({ history = [], provider = 'ollama', enableTools = true } = {}) {
  const ctxState = projectTools.readContextState();
  const systemPrompt = buildSystemPrompt(enableTools, provider);
  const summaryTokens = estimateTokens(ctxState.rollingSummary || '');
  const systemTokens = estimateTokens(systemPrompt);
  const systemBaseTokens = Math.max(0, systemTokens - summaryTokens);

  const validHistory = Array.isArray(history)
    ? history.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    : [];

  let historyTokens = 0;
  for (const m of validHistory) {
    historyTokens += estimateTokens(m.content) + 4;
  }

  const totalTokens = systemTokens + historyTokens;
  const budgetTokens = ctxState.budgetTokens || 4096;
  const thresholdPct = ctxState.thresholdPct || 80;
  const usagePct = Math.round((totalTokens / budgetTokens) * 100);

  return {
    totalTokens,
    systemTokens,
    systemBaseTokens,
    summaryTokens,
    historyTokens,
    budgetTokens,
    thresholdPct,
    usagePct,
    needsCompaction: usagePct >= thresholdPct,
    historyCount: validHistory.length,
    rollingSummary: ctxState.rollingSummary || '',
    compactedCount: ctxState.compactedCount || 0,
    savedTokens: ctxState.savedTokens || 0,
    lastCompactedAt: ctxState.lastCompactedAt || null
  };
}

const LIST_ACTION_ALIASES = new Set(['list', 'ls', 'dir', 'list_dir', 'list_files']);
const READ_ACTION_ALIASES = new Set(['read', 'read_file', 'cat', 'open']);

/**
 * 標準化工具名稱與參數（相容 3B 模型常見別名與別稱欄位）
 */
function normalizeToolCallObj(rawName, rawArgs = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};
  let name = String(rawName || '').trim();
  const lower = name.toLowerCase();
  const tuning = loadAutoTuning();

  if (tuning.toolAliases && tuning.toolAliases[lower]) {
    if (LIST_ACTION_ALIASES.has(lower)) args.action = args.action || 'list';
    if (READ_ACTION_ALIASES.has(lower)) args.action = args.action || 'read';
    name = tuning.toolAliases[lower];
  } else if (LIST_ACTION_ALIASES.has(lower)) {
    name = 'file_ops';
    args.action = 'list';
  } else if (READ_ACTION_ALIASES.has(lower)) {
    name = 'file_ops';
    args.action = 'read';
  }

  for (const [aliasKey, targetKey] of Object.entries(tuning.argAliases || {})) {
    if (args[aliasKey] !== undefined && args[targetKey] === undefined) {
      args[targetKey] = args[aliasKey];
    }
  }

  if (name === 'file_ops') {
    args.targetPath = args.targetPath || args.path || args.filePath || args.dir || args.directory || args.folder || '.';
    args.action = ['list', 'read', 'write'].includes(args.action) ? args.action : 'list';
  } else if (name === 'parse_excel_safe') {
    args.filePath = args.filePath || args.targetPath || args.path || '';
  }

  if (!getToolByName(name)) return null;
  return { name, arguments: args };
}

function tryParseJsonWithBackslashRepair(rawStr) {
  const s = String(rawStr || '').trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    const repaired = s
      .replace(/"([a-zA-Z]:[^"\r\n]*)"/g, (_, p) => `"${p.replace(/(?<!\\)\\(?!\\)/g, '\\\\')}"`)
      .replace(/\\(?![\\"/bfnrtu])/g, '\\\\');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

/**
 * 容錯解析模型輸出的工具呼叫（支援標準 JSON、未跳脫 Windows 路徑反斜線及寬鬆鍵值）
 */
function parseLooseToolJson(rawStr) {
  const text = String(rawStr || '').trim();
  if (!text) return null;

  const parsed = tryParseJsonWithBackslashRepair(text);
  if (parsed && parsed.name) {
    return normalizeToolCallObj(parsed.name, parsed.arguments || parsed.args || {});
  }

  const nameMatch = text.match(/["']?name["']?\s*:\s*["']?([a-zA-Z0-9_]+)["']?/);
  if (!nameMatch) return null;

  const args = {};
  const argsBlockMatch = text.match(/["']?(?:arguments|args)["']?\s*:\s*(\{[\s\S]*\})/);
  if (argsBlockMatch) {
    const candidate = argsBlockMatch[1].trim();
    const parsedArgs = tryParseJsonWithBackslashRepair(candidate)
      || tryParseJsonWithBackslashRepair(candidate.replace(/\}\s*$/, ''));
    if (parsedArgs && typeof parsedArgs === 'object') {
      Object.assign(args, parsedArgs);
    }
  }

  const extractField = (fieldNames) => {
    for (const key of fieldNames) {
      const quoted = text.match(new RegExp(`["']?${key}["']?\\s*:\\s*"([^"\\r\\n]+)"`));
      if (quoted) return quoted[1].replace(/\\\\/g, '\\');
      const singleQuoted = text.match(new RegExp(`["']?${key}["']?\\s*:\\s*'([^'\\r\\n]+)'`));
      if (singleQuoted) return singleQuoted[1].replace(/\\\\/g, '\\');
      const unquoted = text.match(new RegExp(`["']?${key}["']?\\s*:\\s*([^,}\\r\\n\\]]+)`));
      if (unquoted) return unquoted[1].trim();
    }
    return '';
  };

  if (!args.targetPath) args.targetPath = extractField(['targetPath', 'path', 'dir', 'directory', 'folder']);
  if (!args.filePath) args.filePath = extractField(['filePath']);
  if (!args.action) args.action = extractField(['action']);
  if (!args.lotNo) args.lotNo = extractField(['lotNo']);
  if (!args.query) args.query = extractField(['query']);
  if (!args.command) args.command = extractField(['command']);

  for (const k of Object.keys(args)) {
    if (!args[k]) delete args[k];
  }
  return normalizeToolCallObj(nameMatch[1], args);
}

/**
 * 解析文本中可能出現的 <tool_call>...</tool_call>（含未閉合標籤）、中括號或 JSON 工具呼叫
 */
function extractFallbackToolCalls(text) {
  if (!text) return [];
  const calls = [];

  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)(?:<\/tool_call>|$)/gi)) {
    const call = parseLooseToolJson(m[1]);
    if (call) calls.push(call);
  }
  if (calls.length > 0) return calls;

  for (const m of text.matchAll(/\[([a-zA-Z0-9_]+)\s*:\s*(\{[\s\S]*?\})\s*\]/gi)) {
    const call = parseLooseToolJson(`name: ${m[1]}, arguments: ${m[2]}`);
    if (call) calls.push(call);
  }
  if (calls.length > 0) return calls;

  // 若模型將 JSON 包在 ```json ... ``` 中且僅有單一工具呼叫
  for (const m of text.matchAll(/```(?:json)?\s*(\{[\s\S]*?["']?name["']?\s*:[\s\S]*?\})\s*```/gi)) {
    const call = parseLooseToolJson(m[1]);
    if (call) calls.push(call);
  }
  return calls;
}

function cleanDisplayText(text) {
  if (!text) return '';
  return text
    .replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/gi, '')
    .replace(/\[(?:file_ops|parse_excel_safe|query_mes_spc|inspect_aoi_system|query_outlook_safe|scan_local_projects|secondbrain_tool|run_powershell|web_search|memory_tool|generate_image)\s*:[\s\S]*?\]/gi, '')
    .trim();
}

async function callOllamaChat({ model, messages, tools, timeoutMs = 300000 }) {
  const ollamaStatus = await ensureOllamaRunning();
  if (!ollamaStatus.online) {
    throw new Error(`無法啟動或連線至本機 Ollama (${activeOllamaBase})，請確認 Ollama 是否已安裝或本機端口是否可用`);
  }

  const ctxState = projectTools.readContextState();
  const payload = {
    model,
    messages,
    stream: false,
    keep_alive: '30m',
    options: {
      temperature: 0.3,
      num_ctx: ctxState.budgetTokens || 4096
    }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let resp;
    try {
      resp = await fetch(`${activeOllamaBase}/api/chat`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } catch (err) {
      if (err && err.name === 'AbortError') {
        throw new Error(`本機 Ollama (${activeOllamaBase}) 回應逾時 (${Math.round(timeoutMs / 1000)}s)`);
      }
      throw new Error(`無法連線至本機 Ollama (${activeOllamaBase})：${err.message}`);
    }

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Ollama API 錯誤 (${resp.status}): ${errText}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function callGeminiChat({ model, systemPrompt, messages, tools }) {
  const apiKey = resolveGeminiApiKey();
  if (!apiKey) {
    throw new Error('找不到 GEMINI_API_KEY（請於本機 .env 設定，或切回本機 Ollama 離線模型）');
  }

  const preferred = model && model.startsWith('gemini') ? model : 'gemini-3-flash-preview';
  const fallbackList = [preferred, 'gemini-3-flash-preview', 'gemini-flash-lite-latest', 'gemini-flash-latest', 'gemini-pro-latest'];
  const candidates = [...new Set(fallbackList)];

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          parts: [{ text: `[工具 ${m.toolName || 'tool'} 回傳結果]\n${m.content}` }]
        };
      }
      const fallbackCallText = Array.isArray(m.tool_calls) && m.tool_calls.length > 0
        ? `[呼叫工具: ${m.tool_calls.map((c) => (c.function && c.function.name) || '').join(', ')}]`
        : '(empty)';
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content && String(m.content).trim() ? String(m.content) : fallbackCallText }]
      };
    });

  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { temperature: 0.3 }
  };

  if (tools && tools.length > 0) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }))
    }];
  }

  let data = null;
  let lastErr = '';
  for (const targetModel of candidates) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${targetModel}:generateContent?key=${encodeURIComponent(apiKey)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });

      if (resp.ok) {
        data = await resp.json();
        break;
      }
      const errText = await resp.text();
      lastErr = `Gemini API 錯誤 (${targetModel} / ${resp.status}): ${errText.slice(0, 300)}`;
      if (resp.status !== 404 && resp.status !== 429 && resp.status !== 503) {
        throw new Error(lastErr);
      }
    } catch (err) {
      if (err.message && err.message.startsWith('Gemini API 錯誤')) {
        throw err;
      }
      lastErr = `Gemini 連線逾時或錯誤 (${targetModel}): ${err.message}`;
      continue;
    }
  }
  if (!data) {
    throw new Error(lastErr || 'Gemini 所有候選模型皆暫時無法回應');
  }
  const cand = data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];

  let text = '';
  const toolCalls = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) {
      toolCalls.push({
        function: {
          name: p.functionCall.name,
          arguments: p.functionCall.args || {}
        }
      });
    }
  }
  return { message: { role: 'assistant', content: text, tool_calls: toolCalls } };
}

/**
 * 若使用者輸入中文生圖描述，嘗試請目前 LLM 轉為精簡英文繪圖 Prompt
 */
function createPromptTranslator(provider, model) {
  return async (zhPrompt) => {
    const sys = 'Translate the following image description into a concise, vivid English Stable Diffusion / Flux prompt. Output ONLY the English prompt, no explanation.';
    try {
      if (provider === 'gemini') {
        const res = await callGeminiChat({
          model,
          systemPrompt: sys,
          messages: [{ role: 'user', content: zhPrompt }],
          tools: []
        });
        return res.message.content;
      }
      const res = await callOllamaChat({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: zhPrompt }
        ],
        tools: []
      });
      return res.message && res.message.content;
    } catch {
      return zhPrompt;
    }
  };
}

/**
 * 圖片工坊 AI Co-Pilot：與使用者互動討論並改進「畫面描述 Prompt」
 */
async function assistImagePrompt({
  prompt = '',
  instruction = '',
  style = 'photorealistic',
  engine = 'local-sd',
  provider = 'ollama',
  model = 'qwen2.5:3b',
  privateMode = false
} = {}) {
  const curPrompt = String(prompt || '').trim();
  const userInst = String(instruction || '').trim() || '請幫我擴充並優化這個畫面描述，補強主體細節、光影質感、鏡頭視角與氛圍。';

  // 自主學習：記錄並累積使用者的生圖審美偏好（隱私無痕模式不寫入記憶）
  const taste = privateMode
    ? projectTools.readImageTaste()
    : projectTools.recordImageTaste({ instruction, prompt: curPrompt, style, engine });
  const tasteHint = (!privateMode && taste.summaryText)
    ? `\n使用者過往偏好的視覺風格（自主記憶累積）：${taste.summaryText}`
    : '';

  const sys = `你現在是「Mini-Antigravity 圖片工坊 AI Co-Pilot（提示詞架構師）」。
你的任務是與使用者討論並協助潤飾「畫面描述 Prompt」，讓本機 Stable Diffusion (DreamShaper-7 LCM) 或 Flux 生成更高畫質、構圖精準且無雜質的作品。
請一律使用繁體中文回答，並**嚴格只輸出 JSON 物件**，不要包含多餘文字或 Markdown 標記以外的說明，JSON 格式如下：
{
  "reply": "用 1~2 句繁體中文直接回應使用者：說明你調整或建議了哪些光影、構圖、景深與細節。",
  "refinedPrompt": "完整且可直接放入「畫面描述 Prompt」輸入框的繁體中文描述（或中英混合描述，已包含所有新調整）。",
  "englishPrompt": "對應的高精度英文 Stable Diffusion Prompt 關鍵字，包含畫質修飾詞（不要出現任何拒答字眼）。",
  "engineAdvice": "一句話引擎小建議（例如推薦 local-sd 無限制出圖，或何時可改用 Flux 1024px）。"
}`;

  const userMsg = `目前畫面描述 Prompt：「${curPrompt || '（尚未填寫，請幫我從頭發想一個極具質感的視覺畫面）'}」
選擇風格：${style}
目前引擎：${engine}${tasteHint}
使用者最新溝通需求：「${userInst}」
請回覆上述 JSON。`;

  const t0 = Date.now();
  try {
    const llmRes = provider === 'gemini'
      ? await callGeminiChat({
          model,
          systemPrompt: sys,
          messages: [{ role: 'user', content: userMsg }],
          tools: []
        })
      : await callOllamaChat({
          model,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: userMsg }
          ],
          tools: []
        });

    const raw = String((llmRes.message && llmRes.message.content) || '').trim();
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && (parsed.refinedPrompt || parsed.reply)) {
          return {
            success: true,
            provider,
            model,
            elapsedMs: Date.now() - t0,
            learnedTaste: privateMode ? '' : taste.summaryText,
            topTasteTags: privateMode ? [] : taste.topTags,
            reply: String(parsed.reply || '已依您的想法強化畫面光影、構圖與質感細節，並同步更新至上方描述欄。'),
            refinedPrompt: String(parsed.refinedPrompt || curPrompt || userInst).trim(),
            englishPrompt: String(parsed.englishPrompt || '').trim(),
            engineAdvice: String(parsed.engineAdvice || (engine === 'local-sd'
              ? '目前選用本機 SD-LCM 引擎，100% 離線、零浮水印且無生成次數與內容限制。'
              : '若不希望受雲端 45 秒冷卻限制，建議切換「Local SD-LCM」離線秒級生圖。'))
          };
        }
      } catch {
        // fall through to graceful fallback
      }
    }

    // LLM 未回傳標準 JSON 時的穩健保底整合
    const mergedZh = curPrompt
      ? (instruction ? `${curPrompt}，${userInst}，豐富光影層次與高畫質微距細節` : `${curPrompt}，高解析寫實光影細節、柔和景深與電影級構圖`)
      : `${userInst}，高解析寫實光影細節、柔和景深與電影級構圖`;
    return {
      success: true,
      provider,
      model,
      elapsedMs: Date.now() - t0,
      learnedTaste: privateMode ? '' : taste.summaryText,
      topTasteTags: privateMode ? [] : taste.topTags,
      reply: cleanDisplayText(raw) || `已依據「${userInst}」整合進上方畫面描述，您可以直接點擊「立即自由創建圖片」或繼續與我微調！`,
      refinedPrompt: mergedZh,
      englishPrompt: '',
      engineAdvice: engine === 'local-sd'
        ? '本機 SD-LCM 引擎就緒，無浮水印、無冷卻時間。'
        : '雲端模式已啟用自動去浮水印；若需無限制離線生圖可切換至 Local SD-LCM。'
    };
  } catch (err) {
    const mergedZh = curPrompt
      ? (instruction ? `${curPrompt}，${userInst}` : `${curPrompt}，電影級自然光影、高解析寫實細節`)
      : userInst;
    return {
      success: true,
      fallback: true,
      elapsedMs: Date.now() - t0,
      learnedTaste: privateMode ? '' : taste.summaryText,
      topTasteTags: privateMode ? [] : taste.topTags,
      reply: `已完成描述整併（模型暫忙，採用快速視覺公式補強）：已將「${userInst}」融入描述欄，歡迎繼續微調或直接出圖。`,
      refinedPrompt: mergedZh,
      englishPrompt: '',
      engineAdvice: err.message
    };
  }
}

/**
 * 自主學習 3：單輪對話自動反思與糾正/偏好捕捉（依治理政策產生 Diff 提案或自動套用）
 */
async function autoLearnFromTurn({ message = '', provider = 'ollama', model = 'qwen2.5:3b' } = {}) {
  const msg = String(message || '').trim();
  const triggerRe = /(請記住|幫我記住|記住|以後|往後|之後都|請一律|不要再|別再|我習慣|我喜歡|我偏好|預設用|應該先|優先標示|優先顯示|改用|不對，應該)/;
  if (!msg || msg.length < 6 || msg.length > 350 || !triggerRe.test(msg)) {
    return null;
  }

  const isUserStyle = /(我習慣|我喜歡|我偏好|語氣|簡短|條列|稱呼|回答方式)/.test(msg);
  const targetFile = isUserStyle ? 'USER' : 'MEMORY';
  let distilledRule = msg
    .replace(/^(請幫我記住|幫我記住|請記住|記住|請注意|以後請|往後請)[：:，,\s]*/i, '')
    .trim();

  // 若句子稍長且口語，快速請大腦凝練成 1 句明確規範（逾時或失敗則退回乾淨原句）
  if (distilledRule.length > 24) {
    try {
      const sys = '將以下使用者的糾正或長期習慣要求，精簡改寫為「一句不超過 45 個繁體中文字的明確規則」；嚴禁多餘客套話，只輸出規則句子本身。';
      const llmRes = provider === 'gemini'
        ? await callGeminiChat({ model, systemPrompt: sys, messages: [{ role: 'user', content: msg }], tools: [] })
        : await callOllamaChat({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: msg }], tools: [], timeoutMs: 20000 });
      const candidate = cleanDisplayText((llmRes.message && llmRes.message.content) || '')
        .split(/\r?\n/)[0]
        .replace(/^[-*•\d.\s]+/, '')
        .trim();
      if (candidate.length >= 6 && candidate.length <= 90 && !/無法|sorry|cannot/i.test(candidate)) {
        distilledRule = candidate;
      }
    } catch {
      // keep trimmed original sentence
    }
  }

  const res = projectTools.proposeOrApplyLearnedRule({
    target: targetFile,
    ruleText: distilledRule,
    tag: '自主學習',
    sourceMessage: msg
  });
  if (res.success && !res.duplicate && !res.skipped) {
    return {
      learned: Boolean(res.learned),
      pending: Boolean(res.pending),
      status: res.status,
      file: res.file,
      ruleText: res.ruleText,
      diffPreview: res.diffPreview,
      proposal: res.proposal || null,
      applied: res.applied || null
    };
  }
  return null;
}

/**
 * 自主學習 4：從近期對話與生圖偏好紀錄中一鍵總結並產出 Diff 提案或直接沉澱
 */
async function summarizeRecentChatsAndLearn({ history = [], provider = 'ollama', model = 'qwen2.5:3b' } = {}) {
  const t0 = Date.now();
  const recentUsers = (Array.isArray(history) ? history : [])
    .filter((m) => m && m.role === 'user' && m.content)
    .slice(-12);

  const bridgePath = path.join(projectTools.MEMORY_DIR, 'antigravity_bridge.md');
  const bridgeText = fs.existsSync(bridgePath) ? fs.readFileSync(bridgePath, 'utf8').slice(0, 1800) : '';
  const taste = projectTools.readImageTaste();
  const mem = projectTools.readMemoryFiles();

  const digestParts = [];
  if (recentUsers.length > 0) {
    digestParts.push('【近期使用者對話】\n' + recentUsers.map((m, i) => `${i + 1}. ${String(m.content).slice(0, 180)}`).join('\n'));
  }
  if (bridgeText) {
    digestParts.push(`【跨介面橋接摘要】\n${bridgeText.slice(0, 900)}`);
  }
  if (taste.summaryText) {
    digestParts.push(`【生圖視覺偏好統計】\n常見風格關鍵字：${taste.summaryText}；近期指令：${(taste.recentInstructions || []).join(' / ')}`);
  }

  if (digestParts.length === 0) {
    return {
      success: true,
      elapsedMs: Date.now() - t0,
      addedRules: [],
      proposedRules: [],
      learningStatus: projectTools.getLearningStatus(),
      message: '目前尚無足夠的新對話或生圖紀錄可歸納，歡迎先多與本機 Agent 互動後再一鍵總結！'
    };
  }

  const sys = `你是 Mini-Antigravity 的「自主反思與記憶整理師」。
請閱讀以下近期互動紀錄與現有記憶，萃取出「1 到 3 條值得長期記住的新使用者偏好或工作經驗規則」（不要重複現有記憶已寫過的 🔴 鐵律）。
請嚴格只輸出 JSON 陣列，格式如下：
[
  {"target": "MEMORY", "rule": "繁體中文精簡經驗規則（不超過 50 字）"},
  {"target": "USER", "rule": "繁體中文精簡個人習慣偏好（不超過 50 字）"}
]`;

  const userPrompt = `${digestParts.join('\n\n')}\n\n【現有 MEMORY 尾端摘要】\n${(mem.MEMORY || '').slice(-600)}\n\n請回傳 JSON 陣列：`;

  let candidates = [];
  try {
    const llmRes = provider === 'gemini'
      ? await callGeminiChat({ model, systemPrompt: sys, messages: [{ role: 'user', content: userPrompt }], tools: [] })
      : await callOllamaChat({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }], tools: [], timeoutMs: 25000 });
    const raw = String((llmRes.message && llmRes.message.content) || '').trim();
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) {
      const parsed = JSON.parse(arrMatch[0]);
      if (Array.isArray(parsed)) {
        candidates = parsed
          .filter((x) => x && x.rule && String(x.rule).trim().length >= 5)
          .slice(0, 4)
          .map((x) => ({
            target: String(x.target || 'MEMORY').toUpperCase() === 'USER' ? 'USER' : 'MEMORY',
            rule: String(x.rule).trim()
          }));
      }
    }
  } catch {
    // fallback rule extraction below
  }

  if (candidates.length === 0 && taste.summaryText) {
    candidates.push({
      target: 'USER',
      rule: `生圖與視覺偏好經常包含：${taste.topTags.slice(0, 5).map((x) => x.tag).join('、')}`
    });
  }

  const addedRules = [];
  const proposedRules = [];
  for (const c of candidates) {
    const r = projectTools.proposeOrApplyLearnedRule({
      target: c.target,
      ruleText: c.rule,
      tag: '總結學習',
      sourceMessage: '近期對話與生圖偏好反思總結'
    });
    if (r.success && !r.duplicate && !r.skipped) {
      if (r.pending && r.proposal) {
        proposedRules.push(r.proposal);
      } else {
        addedRules.push({ file: r.file, ruleText: r.ruleText });
      }
    }
  }

  let messageText = '已檢視近期互動，重要規範與偏好皆已存在於記憶庫或待審核佇列中（無重複新增）。';
  if (proposedRules.length > 0) {
    messageText = `已萃取 ${proposedRules.length} 條學習 Diff 提案，請於下方「待核准提案台」檢視差異並核准寫入！`;
  } else if (addedRules.length > 0) {
    messageText = `已完成自主反思，新萃取並沉澱 ${addedRules.length} 條經驗記憶（支援隨時原子回退）！`;
  }

  return {
    success: true,
    elapsedMs: Date.now() - t0,
    addedRules,
    proposedRules,
    learnedCount: addedRules.length,
    proposedCount: proposedRules.length,
    learningStatus: projectTools.getLearningStatus(),
    files: projectTools.readMemoryFiles(),
    message: messageText
  };
}

/**
 * 長對話自動摘要壓縮引擎 (L2-06 安全檢查點壓縮：保留最近幾輪原文，將早期對話濃縮為前情提要記憶膠囊)
 */
function buildFallbackCompactSummary(prevSummary, olderMessages) {
  const bullets = [];
  if (prevSummary) {
    for (const line of String(prevSummary).split(/\r?\n/)) {
      const t = line.trim();
      if (t && !bullets.includes(t)) bullets.push(t);
    }
  }
  for (const m of olderMessages) {
    const roleLabel = m.role === 'user' ? '使用者詢問/要求' : 'Agent 回覆重點';
    const clean = String(m.content || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    if (clean) {
      bullets.push(`- ${roleLabel}：${clean}${String(m.content || '').length > 90 ? '...' : ''}`);
    }
  }
  return bullets.slice(-8).join('\n').slice(0, 700);
}

async function compactChatHistory({
  history = [],
  provider = 'ollama',
  model = 'qwen2.5:3b',
  keepRecentMessages = 6,
  force = false
} = {}) {
  const valid = (Array.isArray(history) ? history : []).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant') && m.content
  );
  const ctxState = projectTools.readContextState();
  const statusBefore = computeContextStatus({ history: valid, provider });

  if (!force && !statusBefore.needsCompaction) {
    return {
      success: true,
      compacted: false,
      reason: `目前上下文水位 ${statusBefore.usagePct}% 尚未達到 ${statusBefore.thresholdPct}% 自動壓縮門檻`,
      remainingHistory: valid,
      contextStatus: statusBefore
    };
  }

  if (valid.length <= 2) {
    return {
      success: true,
      compacted: false,
      reason: '目前對話僅剩最後一輪以內，無早期對話可供壓縮',
      remainingHistory: valid,
      contextStatus: statusBefore
    };
  }

  const effectiveKeep = Math.min(keepRecentMessages, Math.max(2, valid.length - 2));
  const splitIdx = valid.length - effectiveKeep;
  if (splitIdx <= 0) {
    return {
      success: true,
      compacted: false,
      reason: '對話則數尚不足以切分早期與近期對話',
      remainingHistory: valid,
      contextStatus: statusBefore
    };
  }

  const older = valid.slice(0, splitIdx);
  const recent = valid.slice(splitIdx);

  const tokensBefore =
    older.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0) +
    estimateTokens(ctxState.rollingSummary || '');

  const digestText = older
    .map((m, idx) => `${idx + 1}. [${m.role === 'user' ? '使用者' : 'Agent'}] ${String(m.content).replace(/\s+/g, ' ').slice(0, 320)}`)
    .join('\n');

  const sys = `你是 Mini-Antigravity 的「對話上下文壓縮師」。
請將以下【既有前情提要】與【較早期的對話紀錄】，濃縮成一份精簡、不遺漏關鍵事實的繁體中文結構化摘要（總字數嚴格控制於 220 字以內）：
1. 【已確認結論與設定】
2. 【曾查詢過的批號、數據或檔案】
3. 【尚未完成或待跟進事項】
只輸出濃縮摘要本身，不要客套話。`;

  const userPrompt = `${ctxState.rollingSummary ? `【既有前情提要】\n${ctxState.rollingSummary}\n\n` : ''}【待壓縮之早期對話 (${older.length} 則)】\n${digestText}\n\n請輸出 220 字以內的結構化前情提要：`;

  let newSummary = '';
  let usedFallback = false;
  try {
    const llmRes = provider === 'gemini'
      ? await callGeminiChat({ model, systemPrompt: sys, messages: [{ role: 'user', content: userPrompt }], tools: [] })
      : await callOllamaChat({ model, messages: [{ role: 'system', content: sys }, { role: 'user', content: userPrompt }], tools: [], timeoutMs: 20000 });
    const candidate = cleanDisplayText((llmRes.message && llmRes.message.content) || '').trim();
    if (candidate.length >= 16 && candidate.length <= 900) {
      newSummary = candidate;
    } else {
      usedFallback = true;
      newSummary = buildFallbackCompactSummary(ctxState.rollingSummary, older);
    }
  } catch {
    usedFallback = true;
    newSummary = buildFallbackCompactSummary(ctxState.rollingSummary, older);
  }

  const tokensAfter = estimateTokens(newSummary);
  const savedTokensDelta = Math.max(0, tokensBefore - tokensAfter);

  projectTools.saveContextState({
    rollingSummary: newSummary,
    compactedCount: (ctxState.compactedCount || 0) + older.length,
    savedTokens: (ctxState.savedTokens || 0) + savedTokensDelta,
    lastCompactedAt: new Date().toISOString()
  });

  const statusAfter = computeContextStatus({ history: recent, provider });

  return {
    success: true,
    compacted: true,
    usedFallback,
    compactedMessagesCount: older.length,
    keptMessagesCount: recent.length,
    savedTokensDelta,
    rollingSummary: newSummary,
    remainingHistory: recent,
    contextStatus: statusAfter
  };
}

/**
 * 當小模型在首輪未輸出有效工具呼叫，但使用者明確指定 Windows 本機路徑時，確定性補救分派對應工具
 */
function inferDeterministicToolCall(message, activeTools) {
  if (!Array.isArray(activeTools) || activeTools.length === 0) return [];
  const pathMatch = String(message || '').match(/([a-zA-Z]:\\[^\s"'`<>|，,。？?]+)/);
  if (!pathMatch) return [];

  const targetPath = pathMatch[1];
  if (/\.(xlsx|xlsm|xls)$/i.test(targetPath) && activeTools.some((t) => t.name === 'parse_excel_safe')) {
    return [{ name: 'parse_excel_safe', arguments: { filePath: targetPath } }];
  }
  if (activeTools.some((t) => t.name === 'file_ops')) {
    return [{ name: 'file_ops', arguments: { action: 'list', targetPath } }];
  }
  return [];
}

/**
 * 若工具已執行完畢但模型未輸出最終文字，直接由工具實證結果產生繁體中文摘要
 */
function formatFallbackReplyFromResults(executedResults) {
  if (!Array.isArray(executedResults) || executedResults.length === 0) return '';
  const last = executedResults[executedResults.length - 1];
  const { toolName, result } = last;
  if (!result) return '';
  if (result.success === false) {
    return `⚠️ 工具 \`${toolName}\` 執行未成功：${result.error || '未知錯誤'}`;
  }
  if (toolName === 'file_ops' && result.isDirectory && Array.isArray(result.entries)) {
    const dirs = result.entries.filter((e) => e.type === 'dir');
    const files = result.entries.filter((e) => e.type !== 'dir');
    const lines = [`📂 路徑 \`${result.path}\` 共有 ${dirs.length} 個資料夾、${files.length} 個檔案：`];
    if (dirs.length > 0) {
      lines.push('', '**📁 資料夾**：');
      dirs.forEach((d) => lines.push(`- 📁 ${d.name}`));
    }
    if (files.length > 0) {
      lines.push('', '**📄 檔案**：');
      files.forEach((f) => lines.push(`- 📄 ${f.name}`));
    }
    if (dirs.length === 0 && files.length === 0) {
      lines.push('（此資料夾目前為空）');
    }
    return lines.join('\n');
  }
  const preview = JSON.stringify(result, null, 2).slice(0, 1500);
  return `已透過工具 \`${toolName}\` 取得以下結果：\n\`\`\`json\n${preview}\n\`\`\``;
}

/**
 * 執行完整 ReAct Agent 對話迴圈（含安全檢查點 80% 自動摘要壓縮）
 */
async function runAgentTurn({
  message,
  history = [],
  provider = 'ollama',
  model = 'qwen2.5:3b',
  enableTools = true
} = {}) {
  const tStart = Date.now();
  let activeHistory = Array.isArray(history) ? history : [];
  let compactionEvent = null;

  const ctxCheck = computeContextStatus({ history: activeHistory, provider, enableTools });
  if (ctxCheck.needsCompaction && activeHistory.length >= 6) {
    const cmp = await compactChatHistory({
      history: activeHistory,
      provider,
      model,
      keepRecentMessages: 4,
      force: true
    });
    if (cmp.compacted) {
      activeHistory = cmp.remainingHistory;
      compactionEvent = {
        compactedMessagesCount: cmp.compactedMessagesCount,
        keptMessagesCount: cmp.keptMessagesCount,
        savedTokensDelta: cmp.savedTokensDelta,
        rollingSummary: cmp.rollingSummary
      };
    }
  }

  const activeTools = selectRelevantTools(message, enableTools);
  const hasActiveTools = activeTools.length > 0;
  const systemPrompt = buildSystemPrompt(activeTools, provider);
  const messages = [{ role: 'system', content: systemPrompt }];

  for (const h of activeHistory.slice(-10)) {
    if (h && (h.role === 'user' || h.role === 'assistant') && h.content) {
      messages.push({ role: h.role, content: String(h.content) });
    }
  }
  messages.push({ role: 'user', content: String(message || '') });

  const trace = [];
  const executedResults = [];
  const generatedImages = [];
  const translatePromptFn = createPromptTranslator(provider, model);

  const MAX_STEPS = 5;
  let finalReply = '';

  for (let step = 1; step <= MAX_STEPS; step++) {
    const llmRes = provider === 'gemini'
      ? await callGeminiChat({ model, systemPrompt, messages, tools: activeTools })
      : await callOllamaChat({ model, messages, tools: activeTools });

    const assistantMsg = llmRes.message || {};
    const rawContent = String(assistantMsg.content || '');
    const nativeCalls = Array.isArray(assistantMsg.tool_calls) ? assistantMsg.tool_calls : [];

    let parsedCalls = nativeCalls.map((tc) => {
      const fn = tc.function || tc;
      let args = fn.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      return normalizeToolCallObj(fn.name, args) || { name: fn.name, arguments: args };
    }).filter((c) => c && c.name);

    if (parsedCalls.length === 0 && hasActiveTools) {
      parsedCalls = extractFallbackToolCalls(rawContent);
    }

    if (step === 1 && parsedCalls.length === 0 && hasActiveTools) {
      parsedCalls = inferDeterministicToolCall(message, activeTools);
    }

    if (parsedCalls.length === 0) {
      finalReply = cleanDisplayText(rawContent);
      break;
    }

    messages.push({
      role: 'assistant',
      content: rawContent || `<tool_call>${JSON.stringify(parsedCalls[0])}</tool_call>`,
      tool_calls: nativeCalls.length ? nativeCalls : undefined
    });

    for (const call of parsedCalls) {
      const toolDef = getToolByName(call.name);
      const tTool0 = Date.now();
      let result;
      if (!toolDef) {
        result = { success: false, error: `未知工具: ${call.name}` };
      } else {
        try {
          result = await toolDef.execute(call.arguments || {}, { translatePromptFn, userMessage: message });
        } catch (err) {
          result = { success: false, error: err.message };
        }
      }

      if (call.name === 'generate_image' && result && result.success && result.url) {
        generatedImages.push({
          url: result.url,
          filename: result.filename,
          engine: result.engine,
          prompt: result.prompt
        });
      }

      executedResults.push({ toolName: call.name, args: call.arguments || {}, result });

      const serialized = JSON.stringify(result);
      const trimmed = serialized.length > 6000 ? `${serialized.slice(0, 6000)}...(truncated)` : serialized;

      trace.push({
        step,
        thought: cleanDisplayText(rawContent),
        toolName: call.name,
        args: call.arguments || {},
        durationMs: Date.now() - tTool0,
        success: result && result.success !== false,
        preview: trimmed.slice(0, 800)
      });

      messages.push({
        role: 'tool',
        toolName: call.name,
        content: trimmed
      });
    }

    if (step === MAX_STEPS) {
      finalReply = cleanDisplayText(rawContent) || '已完成多步驟工具呼叫並彙整上述結果。';
    }
  }

  if (!finalReply && executedResults.length > 0) {
    finalReply = formatFallbackReplyFromResults(executedResults);
  }

  const finalOutput = finalReply || '（模型未回傳文字內容，請查看上方工具執行結果）';
  const alreadyCalledMemoryAppend = trace.some(
    (t) => t.toolName === 'memory_tool' && t.args && t.args.action === 'append' && t.success
  );
  const learned = alreadyCalledMemoryAppend
    ? null
    : await autoLearnFromTurn({ message, provider, model });

  writeBridgeSnapshot({
    message,
    provider,
    model,
    trace,
    reply: finalOutput
  });

  const nextPreviewHistory = [
    ...activeHistory,
    { role: 'user', content: String(message || '') },
    { role: 'assistant', content: finalOutput }
  ];

  return {
    success: true,
    provider,
    model,
    elapsedMs: Date.now() - tStart,
    trace,
    generatedImages,
    learned,
    compactionEvent,
    compactedHistory: compactionEvent ? activeHistory : null,
    contextStatus: computeContextStatus({ history: nextPreviewHistory, provider, enableTools }),
    reply: finalOutput
  };
}

module.exports = {
  get OLLAMA_BASE() {
    return activeOllamaBase;
  },
  getOllamaBase: () => activeOllamaBase,
  ensureOllamaRunning,
  AUTO_TUNING_PATH,
  loadAutoTuning,
  saveAutoTuning,
  TOOL_DEFINITIONS,
  selectRelevantTools,
  extractFallbackToolCalls,
  resolveGeminiApiKey,
  estimateTokens,
  computeContextStatus,
  compactChatHistory,
  runAgentTurn,
  createPromptTranslator,
  assistImagePrompt,
  autoLearnFromTurn,
  summarizeRecentChatsAndLearn,
  writeBridgeSnapshot
};
