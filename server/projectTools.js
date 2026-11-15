/**
 * 本機專案特定功能橋接器 & Agent 自主工具實作 (Project & System Tools)
 * 所有路徑皆採用 __dirname、os.homedir() 及系統環境變數動態解析，嚴禁寫死本機絕對路徑。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const xlsxSafeReader = require('./xlsxSafeReader');

const execFileAsync = promisify(execFile);

const BASE_DIR = path.resolve(__dirname, '..');
const PROJECTS_ROOT = path.resolve(BASE_DIR, '..');
const MEMORY_DIR = path.join(BASE_DIR, 'memory');
const IMAGE_TASTE_PATH = path.join(MEMORY_DIR, 'image_taste.json');
const LEARNING_GOV_PATH = path.join(MEMORY_DIR, 'learning_governance.json');
const CONTEXT_SUMMARY_PATH = path.join(MEMORY_DIR, 'context_summary.json');

function resolveSecondbrainDir() {
  const candidates = [
    path.join(os.homedir(), 'Documents', 'Secondbrain'),
    path.join(os.homedir(), 'OneDrive', 'Documents', 'Secondbrain')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function isSensitivePath(targetPath) {
  const normalized = path.resolve(String(targetPath || '')).toLowerCase();
  const base = path.basename(normalized);
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (normalized.includes('credentials') || normalized.includes('id_rsa') || normalized.endsWith('.pem')) return true;
  if (normalized.includes(`${path.sep}.ssh${path.sep}`) || normalized.includes(`${path.sep}windows${path.sep}system32${path.sep}config`)) return true;
  return false;
}

function cleanUserPathInput(inputPath) {
  let raw = String(inputPath || '').trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  // 保留磁碟機根目錄 C:\ 的尾端反斜線，其餘路徑移除多餘尾端斜線
  if (raw.length > 3) {
    raw = raw.replace(/[\\/]+$/, '');
  }
  return raw;
}

function ensureSafePath(
  inputPath,
  { allowProjectsRoot = true, allowSecondbrain = true, allowAnyLocalRead = false } = {}
) {
  const raw = cleanUserPathInput(inputPath);
  if (!raw) throw new Error('路徑不可為空');
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(BASE_DIR, raw);
  if (isSensitivePath(resolved)) {
    throw new Error('基於安全規範，禁止存取機敏憑證或系統機密檔案');
  }

  if (allowAnyLocalRead && path.isAbsolute(raw)) {
    return resolved;
  }

  const allowedRoots = [BASE_DIR];
  if (allowProjectsRoot) allowedRoots.push(PROJECTS_ROOT);
  if (allowSecondbrain) allowedRoots.push(resolveSecondbrainDir());

  const lower = resolved.toLowerCase();
  const permitted = allowedRoots.some((root) => {
    const r = path.resolve(root).toLowerCase();
    return lower === r || lower.startsWith(r + path.sep);
  });

  if (!permitted) {
    throw new Error(`存取路徑超出允許工作範圍: ${resolved}`);
  }
  return resolved;
}

/**
 * 智慧路徑解析：處理未填寫 .xlsx 副檔名、或本機模型誤以為是資料夾而多猜一層檔名的情況
 */
function resolveSmartReadablePath(inputPath, { preferExcel = false } = {}) {
  const resolved = ensureSafePath(inputPath, {
    allowProjectsRoot: true,
    allowSecondbrain: true,
    allowAnyLocalRead: true
  });

  if (fs.existsSync(resolved)) {
    return { resolved, matchedBy: 'exact' };
  }

  // 情況 1：補上常見試算表/文件副檔名（例如 ...\良率資料-mapping 2026年10月 -> .xlsx）
  const exts = preferExcel ? ['.xlsx', '.xlsm', '.xls', '.csv'] : ['.xlsx', '.csv', '.txt', '.md', '.json'];
  for (const ext of exts) {
    if (fs.existsSync(`${resolved}${ext}`)) {
      return { resolved: `${resolved}${ext}`, matchedBy: `auto_ext(${ext})` };
    }
  }

  // 情況 2：模型把「無副檔名的 Excel 檔名」當資料夾並在後方自行編造一層檔名
  const parentPath = path.dirname(resolved);
  for (const ext of ['.xlsx', '.xlsm', '.xls', '.csv']) {
    if (fs.existsSync(`${parentPath}${ext}`)) {
      return { resolved: `${parentPath}${ext}`, matchedBy: `parent_file(${ext})` };
    }
  }

  // 情況 3：在已存在的上層目錄中模糊比對符合關鍵字的檔案
  if (fs.existsSync(parentPath) && fs.statSync(parentPath).isDirectory()) {
    const baseKey = path.basename(resolved).toLowerCase().replace(/\.(xlsx|xlsm|xls|csv)$/i, '');
    const candidates = fs.readdirSync(parentPath, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('~$'));
    const hit = candidates.find((e) => e.name.toLowerCase().includes(baseKey) && (!preferExcel || /\.(xlsx|xlsm)$/i.test(e.name)));
    if (hit) {
      return { resolved: path.join(parentPath, hit.name), matchedBy: 'fuzzy_match' };
    }
  }

  return { resolved, matchedBy: 'not_found' };
}

async function runPowerShellRaw(scriptText, timeoutMs = 20000) {
  const encoded = Buffer.from(scriptText, 'utf16le').toString('base64');
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
  );
  return { stdout: (stdout || '').trim(), stderr: (stderr || '').trim() };
}

/**
 * 工具 1：本機全專案健康巡檢
 */
async function scanLocalProjects() {
  const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));

  let listeningPorts = [];
  try {
    const { stdout } = await runPowerShellRaw(
      'netstat -ano | Select-String "LISTENING" | ForEach-Object { $_.ToString().Trim() }'
    );
    listeningPorts = stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    listeningPorts = [];
  }

  const knownPortHints = {
    'AI agent': 8790,
    'AI代理團隊': 8765,
    'AOI覆判系統': 3000,
    '管家團隊總監督長': 8788
  };

  const projects = dirs.map((d) => {
    const pDir = path.join(PROJECTS_ROOT, d.name);
    const hasAgents = fs.existsSync(path.join(pDir, 'AGENTS.md'));
    const hasGit = fs.existsSync(path.join(pDir, '.git'));
    const hasVbs = fs.readdirSync(pDir).some((f) => f.toLowerCase().endsWith('.vbs'));
    const hasPkg = fs.existsSync(path.join(pDir, 'package.json'));
    const hasReq = fs.existsSync(path.join(pDir, 'requirements.txt')) || fs.existsSync(path.join(pDir, '.venv'));
    const hintPort = knownPortHints[d.name] || null;
    const isPortActive = hintPort
      ? listeningPorts.some((line) => line.includes(`:${hintPort} `))
      : false;

    return {
      name: d.name,
      path: pDir,
      hasAgents,
      hasGit,
      hasVbs,
      stack: hasPkg ? 'Node.js' : (hasReq ? 'Python' : 'Scripts/Docs'),
      port: hintPort,
      portActive: isPortActive
    };
  });

  return {
    success: true,
    projectsRoot: PROJECTS_ROOT,
    totalCount: projects.length,
    withAgentsCount: projects.filter((p) => p.hasAgents).length,
    withVbsCount: projects.filter((p) => p.hasVbs).length,
    withGitCount: projects.filter((p) => p.hasGit).length,
    projects
  };
}

/**
 * 工具 2：MES / IPQC 數據與 SPC 製程能力分析
 */
function calculateSpcMetrics(values, usl, lsl) {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const minVal = Math.min(...values);
  const maxVal = Math.max(...values);
  const range = maxVal - minVal;
  const variance = n > 1
    ? values.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (n - 1)
    : 0;
  const stdDev = Math.sqrt(variance);

  let mrSum = 0;
  for (let i = 1; i < n; i++) {
    mrSum += Math.abs(values[i] - values[i - 1]);
  }
  const mrBar = n > 1 ? mrSum / (n - 1) : 0;

  let cp = null;
  let ca = null;
  let cpk = null;
  let outOfSpecCount = 0;

  const hasUsl = Number.isFinite(usl);
  const hasLsl = Number.isFinite(lsl);
  if (hasUsl || hasLsl) {
    for (const v of values) {
      if ((hasUsl && v > usl) || (hasLsl && v < lsl)) outOfSpecCount++;
    }
  }

  if (hasUsl && hasLsl && stdDev > 0) {
    const tol = usl - lsl;
    const mid = (usl + lsl) / 2;
    cp = tol / (6 * stdDev);
    ca = ((mean - mid) / (tol / 2)) * 100;
    const cpu = (usl - mean) / (3 * stdDev);
    const cpl = (mean - lsl) / (3 * stdDev);
    cpk = Math.min(cpu, cpl);
  } else if (hasUsl && stdDev > 0) {
    cpk = (usl - mean) / (3 * stdDev);
  } else if (hasLsl && stdDev > 0) {
    cpk = (mean - lsl) / (3 * stdDev);
  }

  const r4 = (num) => (num === null || !Number.isFinite(num) ? null : Math.round(num * 1000) / 1000);
  return {
    n,
    values,
    mean: r4(mean),
    min: r4(minVal),
    max: r4(maxVal),
    range: r4(range),
    mrBar: r4(mrBar),
    stdDev: r4(stdDev),
    usl: hasUsl ? usl : null,
    lsl: hasLsl ? lsl : null,
    caPct: r4(ca),
    cp: r4(cp),
    cpk: r4(cpk),
    outOfSpecCount
  };
}

function queryMesAndSpc({ lotNo = '' } = {}) {
  const ipqcDataDir = path.join(PROJECTS_ROOT, 'IPQC檢驗系統', 'data');
  if (!fs.existsSync(ipqcDataDir)) {
    return { success: false, error: '找不到 IPQC檢驗系統/data 目錄' };
  }

  const files = fs.readdirSync(ipqcDataDir).filter((f) => f.toLowerCase().endsWith('.json'));
  if (!files.length) {
    return { success: false, error: 'IPQC data 目錄目前尚無 JSON 檢驗快取檔案', availableLots: [] };
  }

  const availableLots = files.map((f) => ({
    file: f,
    lotNo: f.replace(/^q004_/i, '').replace(/\.json$/i, '')
  }));

  const targetEntry = lotNo && lotNo !== 'list'
    ? availableLots.find((x) => x.lotNo.toLowerCase().includes(String(lotNo).trim().toLowerCase()))
    : availableLots[0];

  if (!targetEntry) {
    return {
      success: false,
      error: `查無批號「${lotNo}」之本地快取數據`,
      availableLots
    };
  }

  const raw = JSON.parse(fs.readFileSync(path.join(ipqcDataDir, targetEntry.file), 'utf8'));
  const items = Array.isArray(raw.items) ? raw.items : [];
  const analyzedItems = items.map((item) => {
    const vals = [];
    for (let i = 1; i <= 10; i++) {
      const k = `資料${i}`;
      if (item[k] !== undefined && String(item[k]).trim() !== '') {
        const num = Number(item[k]);
        if (Number.isFinite(num)) vals.push(num);
      }
    }
    const uslRaw = item['控制上限'];
    const lslRaw = item['控制下限'];
    const usl = uslRaw !== undefined && String(uslRaw).trim() !== '' ? Number(uslRaw) : NaN;
    const lsl = lslRaw !== undefined && String(lslRaw).trim() !== '' ? Number(lslRaw) : NaN;
    return {
      itemName: item['品管檢驗項目名稱'] || '未命名項目',
      dataType: item['資料型態'] || '',
      updater: (item['使用者 更新日期'] || '').replace(/\n/g, ' '),
      spc: calculateSpcMetrics(vals, usl, lsl)
    };
  });

  return {
    success: true,
    sourceFile: targetEntry.file,
    availableLots,
    info: raw.info || {},
    itemsCount: analyzedItems.length,
    analyzedItems
  };
}

/**
 * 工具 3：AOI 覆判系統案件與 KLA 座標摘要
 */
function inspectAoiSystem({ limit = 15 } = {}) {
  const aoiDir = path.join(PROJECTS_ROOT, 'AOI覆判系統');
  const casesPath = path.join(aoiDir, 'data', 'cases.json');
  if (!fs.existsSync(casesPath)) {
    return { success: false, error: '找不到 AOI覆判系統/data/cases.json' };
  }

  const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8'));
  const total = Array.isArray(cases) ? cases.length : 0;
  const pending = cases.filter((c) => c.status === '待覆判' || !c.decision);
  const closed = cases.filter((c) => c.decision === 'OK' || c.decision === 'NG');

  const recent = cases.slice(0, Math.max(1, Math.min(30, Number(limit) || 15))).map((c) => {
    const mc = c.mapCoordinates || {};
    const coordCounts = {
      rawGlass: Array.isArray(mc.rawGlass) ? mc.rawGlass.length : 0,
      softBake: Array.isArray(mc.softBake) ? mc.softBake.length : 0,
      hardBake: Array.isArray(mc.hardBake) ? mc.hardBake.length : 0,
      edge: Array.isArray(mc.edge) ? mc.edge.length : 0
    };
    const sampleDefects = (mc.hardBake || mc.rawGlass || []).slice(0, 3).map((d) => ({
      id: d.id,
      xPct: d.xPct,
      yPct: d.yPct,
      xSize: d.xSize,
      ySize: d.ySize,
      area: d.area
    }));

    return {
      id: c.id,
      type: c.type,
      reviewDate: c.reviewDate,
      productName: c.productName,
      cassetteSlot: c.cassetteSlot,
      issue: c.issue,
      remark: c.remark,
      status: c.status,
      decision: c.decision || '',
      coordCounts,
      sampleDefects
    };
  });

  return {
    success: true,
    totalCases: total,
    pendingCount: pending.length,
    closedCount: closed.length,
    recentCases: recent
  };
}

/**
 * 工具 4：列出本機專案與良率資料夾內 Excel (.xlsx) 檔案並以 Zero-OOM 解析
 */
function listLocalExcelFiles() {
  const results = [];
  const entries = fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true });
  for (const d of entries) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const pDir = path.join(PROJECTS_ROOT, d.name);
    let topFiles = [];
    try {
      topFiles = fs.readdirSync(pDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of topFiles) {
      if (f.isFile() && f.name.toLowerCase().endsWith('.xlsx') && !f.name.startsWith('~$')) {
        const full = path.join(pDir, f.name);
        const st = fs.statSync(full);
        results.push({
          project: d.name,
          name: f.name,
          path: full,
          sizeKB: Math.round((st.size / 1024) * 10) / 10
        });
      }
    }
  }

  // 一併掃描本機根目錄「良率資料」（如 D:\良率資料\2025、2026）
  const yieldRoot = path.join(path.parse(BASE_DIR).root, '良率資料');
  if (fs.existsSync(yieldRoot)) {
    try {
      const years = fs.readdirSync(yieldRoot, { withFileTypes: true });
      for (const y of years) {
        if (!y.isDirectory()) continue;
        const yDir = path.join(yieldRoot, y.name);
        const yEntries = fs.readdirSync(yDir, { withFileTypes: true });
        for (const f of yEntries) {
          if (f.isFile() && f.name.toLowerCase().endsWith('.xlsx') && !f.name.startsWith('~$')) {
            const full = path.join(yDir, f.name);
            const st = fs.statSync(full);
            results.push({
              project: `良率資料/${y.name}`,
              name: f.name,
              path: full,
              sizeKB: Math.round((st.size / 1024) * 10) / 10
            });
          }
        }
      }
    } catch {
      // ignore inaccessible subfolders
    }
  }
  return results;
}

async function parseExcelSafe({ filePath, sheetName = '', maxRows = 35 } = {}) {
  const { resolved, matchedBy } = resolveSmartReadablePath(filePath, { preferExcel: true });
  if (!fs.existsSync(resolved)) {
    return { success: false, error: `找不到檔案或資料夾: ${resolved}` };
  }

  const st = fs.statSync(resolved);
  if (st.isDirectory()) {
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('~$') && !e.name.startsWith('.env'));
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    const excelFiles = entries
      .filter((e) => e.isFile() && /\.(xlsx|xlsm)$/i.test(e.name))
      .map((e) => {
        const full = path.join(resolved, e.name);
        const fst = fs.statSync(full);
        return {
          name: e.name,
          path: full,
          sizeKB: Math.round((fst.size / 1024) * 10) / 10,
          mtimeMs: fst.mtimeMs
        };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (excelFiles.length === 0) {
      return {
        success: true,
        isDirectory: true,
        path: resolved,
        subdirs,
        files: entries.filter((e) => e.isFile()).map((e) => e.name),
        note: '此資料夾根層尚無 .xlsx 檔案，請檢視上方子資料夾或檔案清單。'
      };
    }

    const latest = excelFiles[0];
    const workbookSummary = await xlsxSafeReader.summarizeWorkbook(latest.path, { sheetName, maxRows });
    return {
      ...workbookSummary,
      resolvedFromDirectory: resolved,
      matchedBy: 'directory_latest_excel',
      directorySubdirs: subdirs,
      directoryExcelFiles: excelFiles.map(({ name, path: fp, sizeKB }) => ({ name, path: fp, sizeKB }))
    };
  }

  const summary = await xlsxSafeReader.summarizeWorkbook(resolved, { sheetName, maxRows });
  return {
    ...summary,
    matchedBy
  };
}

/**
 * 工具 5：Outlook 郵件與行事曆唯讀安全檢索（嚴守不搬動紅旗/待處理郵件鐵律）
 */
async function queryOutlookSafe({ mode = 'calendar', keyword = '', days = 14, maxItems = 12 } = {}) {
  const safeDays = Math.max(1, Math.min(60, Number(days) || 14));
  const safeLimit = Math.max(1, Math.min(30, Number(maxItems) || 12));
  const safeKeyword = String(keyword || '').replace(/'/g, "''").trim();

  const script = mode === 'mail'
    ? `
      $ErrorActionPreference = 'Stop'
      $ol = New-Object -ComObject Outlook.Application
      $ns = $ol.GetNamespace('MAPI')
      $inbox = $ns.GetDefaultFolder(6)
      $items = $inbox.Items
      $items.Sort('[ReceivedTime]', $true)
      $kw = '${safeKeyword}'
      $out = @()
      $scanned = 0
      foreach ($it in $items) {
        if ($scanned -ge 200) { break }
        $scanned++
        try {
          $subj = [string]$it.Subject
          $sender = [string]$it.SenderName
          if ($kw -and ($subj -notlike "*$kw*" -and $sender -notlike "*$kw*")) { continue }
          $flagVal = 0
          try { $flagVal = [int]$it.FlagStatus } catch {}
          $out += [PSCustomObject]@{
            Subject = $subj
            Sender = $sender
            Received = ([datetime]$it.ReceivedTime).ToString('yyyy-MM-dd HH:mm')
            Unread = [bool]$it.UnRead
            FlaggedProtected = ($flagVal -eq 2)
          }
          if ($out.Count -ge ${safeLimit}) { break }
        } catch {}
      }
      $out | ConvertTo-Json -Depth 3 -Compress
    `
    : `
      $ErrorActionPreference = 'Stop'
      $ol = New-Object -ComObject Outlook.Application
      $ns = $ol.GetNamespace('MAPI')
      $cal = $ns.GetDefaultFolder(9)
      $items = $cal.Items
      $items.IncludeRecurrences = $true
      $items.Sort('[Start]')
      $startDt = (Get-Date).Date
      $endDt = $startDt.AddDays(${safeDays})
      $filter = "[Start] >= '" + $startDt.ToString('g') + "' AND [Start] <= '" + $endDt.ToString('g') + "'"
      $restricted = $items.Restrict($filter)
      $out = @()
      foreach ($ap in $restricted) {
        try {
          $out += [PSCustomObject]@{
            Subject = [string]$ap.Subject
            Start = ([datetime]$ap.Start).ToString('yyyy-MM-dd HH:mm')
            End = ([datetime]$ap.End).ToString('yyyy-MM-dd HH:mm')
            Location = [string]$ap.Location
            Organizer = [string]$ap.Organizer
          }
          if ($out.Count -ge ${safeLimit}) { break }
        } catch {}
      }
      $out | ConvertTo-Json -Depth 3 -Compress
    `;

  try {
    const { stdout } = await runPowerShellRaw(script, 15000);
    if (!stdout) return { success: true, mode, items: [] };
    const parsed = JSON.parse(stdout);
    return {
      success: true,
      mode,
      readOnlyPolicy: '嚴守紅旗/待處理郵件保護鐵律（僅唯讀檢索，不搬移任何信件）',
      items: Array.isArray(parsed) ? parsed : [parsed]
    };
  } catch (err) {
    return {
      success: false,
      mode,
      error: `無法連線本機 Outlook MAPI（可能 Outlook 未開啟或尚未設定帳號）: ${err.message}`
    };
  }
}

/**
 * 工具 6：Obsidian 第二大腦連接器 (搜尋 / 讀取 / 寫入 / Lint 健康檢查)
 */
function walkMarkdownFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, acc);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

function secondbrainTool({ action = 'list_hubs', query = '', notePath = '', folder = '知識庫', title = '', content = '' } = {}) {
  const vault = resolveSecondbrainDir();
  if (!fs.existsSync(vault)) {
    return { success: false, error: `找不到 Secondbrain 目錄: ${vault}` };
  }

  if (action === 'list_hubs') {
    const hubDir = path.join(vault, '專案導航HUB');
    if (!fs.existsSync(hubDir)) return { success: false, error: '找不到 專案導航HUB 目錄' };
    const hubs = fs.readdirSync(hubDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        const full = path.join(hubDir, f);
        const st = fs.statSync(full);
        return {
          name: f.replace(/\.md$/i, ''),
          file: f,
          path: full,
          updatedAt: st.mtime.toISOString()
        };
      });
    return { success: true, vault, count: hubs.length, hubs };
  }

  if (action === 'search') {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { success: false, error: '請提供搜尋關鍵字 query' };
    const files = walkMarkdownFiles(vault);
    const matches = [];
    for (const f of files) {
      const rel = path.relative(vault, f);
      const text = fs.readFileSync(f, 'utf8');
      const idx = text.toLowerCase().indexOf(q);
      if (rel.toLowerCase().includes(q) || idx >= 0) {
        const snippetStart = Math.max(0, idx - 60);
        const snippet = idx >= 0 ? text.slice(snippetStart, snippetStart + 200).replace(/\r?\n/g, ' ') : text.slice(0, 140).replace(/\r?\n/g, ' ');
        matches.push({ relativePath: rel, fullPath: f, snippet });
        if (matches.length >= 20) break;
      }
    }
    return { success: true, query, count: matches.length, matches };
  }

  if (action === 'read') {
    const target = path.isAbsolute(notePath) ? notePath : path.join(vault, notePath);
    const resolved = ensureSafePath(target, { allowProjectsRoot: false, allowSecondbrain: true });
    if (!fs.existsSync(resolved)) return { success: false, error: `找不到筆記: ${notePath}` };
    const text = fs.readFileSync(resolved, 'utf8');
    return {
      success: true,
      path: resolved,
      content: text.slice(0, 12000),
      truncated: text.length > 12000
    };
  }

  if (action === 'write') {
    const allowedFolders = ['知識庫', '每日筆記', '創作庫', 'Clippings'];
    const targetFolder = allowedFolders.includes(folder) ? folder : '知識庫';
    const safeTitle = String(title || `Agent筆記_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_');
    const outDir = path.join(vault, targetFolder);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, safeTitle.endsWith('.md') ? safeTitle : `${safeTitle}.md`);
    fs.writeFileSync(outFile, String(content || ''), 'utf8');
    return { success: true, path: outFile, folder: targetFolder };
  }

  if (action === 'lint') {
    const files = walkMarkdownFiles(vault);
    const existingNames = new Set(files.map((f) => path.basename(f, '.md').toLowerCase()));
    const inboundCount = new Map();
    const brokenLinks = [];

    for (const f of files) {
      const rel = path.relative(vault, f);
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
        const linkName = m[1].trim().toLowerCase();
        inboundCount.set(linkName, (inboundCount.get(linkName) || 0) + 1);
        if (!existingNames.has(linkName) && brokenLinks.length < 30) {
          brokenLinks.push({ source: rel, missingTarget: m[1].trim() });
        }
      }
    }

    const knowledgeFiles = walkMarkdownFiles(path.join(vault, '知識庫'));
    const orphans = knowledgeFiles
      .filter((f) => {
        const base = path.basename(f, '.md').toLowerCase();
        return base !== 'index' && base !== 'log' && (inboundCount.get(base) || 0) === 0;
      })
      .slice(0, 25)
      .map((f) => path.relative(vault, f));

    return {
      success: true,
      totalNotes: files.length,
      brokenLinksCount: brokenLinks.length,
      brokenLinks,
      knowledgeOrphansCount: orphans.length,
      knowledgeOrphans: orphans
    };
  }

  return { success: false, error: `不支援的 secondbrain action: ${action}` };
}

/**
 * 工具 7：本機檔案操作（唯讀開放全本機路徑與智慧 .xlsx 識別；寫入嚴格鎖定在 AI agent 工作區內）
 */
async function fileOps({ action = 'list', targetPath = '.', content = '' } = {}) {
  if (action === 'list' || action === 'read') {
    const { resolved, matchedBy } = resolveSmartReadablePath(targetPath, { preferExcel: false });
    if (!fs.existsSync(resolved)) return { success: false, error: `路徑不存在: ${resolved}` };

    const st = fs.statSync(resolved);
    if (st.isDirectory()) {
      const entries = fs.readdirSync(resolved, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.env') && e.name !== 'node_modules' && e.name !== '.venv')
        .slice(0, 120)
        .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : 'file' }));
      return { success: true, isDirectory: true, path: resolved, matchedBy, entries };
    }

    // 若目標為 Excel 檔案（無論模型傳 read 或 list），自動改以 Zero-OOM 安全解析
    if (/\.(xlsx|xlsm)$/i.test(resolved)) {
      const summary = await xlsxSafeReader.summarizeWorkbook(resolved, { maxRows: 35 });
      return {
        ...summary,
        matchedBy,
        note: '偵測到目標為 Excel (.xlsx) 檔案，已自動以 Zero-OOM 引擎安全解析內容'
      };
    }

    if (action === 'list') {
      return {
        success: true,
        isFile: true,
        path: resolved,
        matchedBy,
        sizeBytes: st.size,
        note: '指定路徑為單一檔案而非資料夾，如需閱讀內容請改用 action="read"。'
      };
    }

    const raw = fs.readFileSync(resolved, 'utf8');
    return {
      success: true,
      path: resolved,
      matchedBy,
      sizeBytes: st.size,
      content: raw.slice(0, 12000),
      truncated: raw.length > 12000
    };
  }

  if (action === 'write') {
    // 寫入嚴格限制在 AI agent 工作區內 (outputs / memory / scripts 等) 確保安全
    const resolved = ensureSafePath(targetPath, { allowProjectsRoot: false, allowSecondbrain: false, allowAnyLocalRead: false });
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, String(content || ''), 'utf8');
    return { success: true, path: resolved, bytesWritten: Buffer.byteLength(String(content || ''), 'utf8') };
  }

  return { success: false, error: `不支援的 fileOps action: ${action}` };
}

/**
 * 工具 8：PowerShell 安全執行器
 */
async function runPowerShellTool({ command = '' } = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) return { success: false, error: '請提供 PowerShell 指令' };
  const blockedPatterns = [
    /\.env\b/i,
    /GEMINI_API_KEY/i,
    /MES_PASS/i,
    /SEVI_PASS/i,
    /Remove-Item.*-Recurse.*C:\\/i,
    /Format-Volume/i
  ];
  if (blockedPatterns.some((re) => re.test(cmd))) {
    return { success: false, error: '指令觸及敏感憑證或高風險系統動作，已被安全閘門攔截' };
  }

  try {
    const { stdout, stderr } = await runPowerShellRaw(cmd, 25000);
    return {
      success: true,
      stdout: stdout.slice(0, 8000),
      stderr: stderr.slice(0, 2000)
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      stdout: (err.stdout || '').slice(0, 4000),
      stderr: (err.stderr || '').slice(0, 2000)
    };
  }
}

/**
 * 工具 9：即時聯網搜尋 (DuckDuckGo HTML / Wikipedia)
 */
async function webSearch({ query = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { success: false, error: '請提供搜尋關鍵字' };

  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    clearTimeout(timer);
    const html = await resp.text();
    const results = [];
    const blocks = html.split(/class="result__body"/).slice(1, 9);
    const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

    for (const b of blocks) {
      const titleM = b.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      const snipM = b.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      if (titleM) {
        results.push({
          title: stripTags(titleM[2]),
          url: titleM[1],
          snippet: snipM ? stripTags(snipM[1]) : ''
        });
      }
    }

    return {
      success: true,
      query: q,
      count: results.length,
      results
    };
  } catch (err) {
    return { success: false, query: q, error: `聯網搜尋失敗: ${err.message}` };
  }
}

/**
 * 工具 10：Hermes 長期記憶與靈魂管理 (含 🔴 鐵律防刪除保護)
 */
function readMemoryFiles() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const readOne = (name) => {
    const p = path.join(MEMORY_DIR, name);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  };
  return {
    SOUL: readOne('SOUL.md'),
    USER: readOne('USER.md'),
    MEMORY: readOne('MEMORY.md')
  };
}

function saveMemoryFile(fileKey, newContent) {
  const map = {
    SOUL: 'SOUL.md',
    USER: 'USER.md',
    MEMORY: 'MEMORY.md'
  };
  const filename = map[String(fileKey || '').toUpperCase()];
  if (!filename) return { success: false, error: '僅允許修改 SOUL / USER / MEMORY' };

  const target = path.join(MEMORY_DIR, filename);
  if (filename === 'MEMORY.md' && fs.existsSync(target)) {
    const oldLines = fs.readFileSync(target, 'utf8').split(/\r?\n/);
    const redLines = oldLines.filter((l) => l.includes('🔴'));
    for (const rl of redLines) {
      const normalized = rl.trim();
      if (normalized && !String(newContent || '').includes(normalized)) {
        return {
          success: false,
          error: `違反 🔴 核心鐵律保護原則：不可刪除既有鐵律「${normalized.slice(0, 60)}...」`
        };
      }
    }
  }

  fs.writeFileSync(target, String(newContent || ''), 'utf8');
  return { success: true, file: filename, path: target };
}

function memoryTool({ action = 'read', file = 'MEMORY', appendText = '' } = {}) {
  const files = readMemoryFiles();
  if (action === 'read') {
    return { success: true, files };
  }
  if (action === 'append') {
    const key = String(file || 'MEMORY').toUpperCase();
    const current = files[key] ?? '';
    const line = `\n- [${new Date().toISOString().slice(0, 10)}] ${String(appendText || '').trim()}\n`;
    return saveMemoryFile(key, current + line);
  }
  return { success: false, error: `不支援的 memoryTool action: ${action}` };
}

/**
 * 自主學習 1：生圖個人審美偏好儲存與讀取 (memory/image_taste.json)
 */
function readImageTaste() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  let data = {
    updatedAt: null,
    totalInteractions: 0,
    preferredEngine: 'local-sd',
    preferredStyle: 'photorealistic',
    tasteTags: {},
    recentInstructions: []
  };
  if (fs.existsSync(IMAGE_TASTE_PATH)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(IMAGE_TASTE_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = { ...data, ...parsed, tasteTags: parsed.tasteTags || {}, recentInstructions: Array.isArray(parsed.recentInstructions) ? parsed.recentInstructions : [] };
      }
    } catch {
      // ignore corrupted file
    }
  }
  const topTags = Object.entries(data.tasteTags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, count]) => ({ tag, count }));

  const summaryText = topTags.length > 0
    ? topTags.map((x) => `${x.tag}(${x.count})`).join('、')
    : '';

  return {
    ...data,
    topTags,
    summaryText
  };
}

function recordImageTaste({ instruction = '', prompt = '', style = '', engine = '' } = {}) {
  const cur = readImageTaste();
  const nextTags = { ...(cur.tasteTags || {}) };
  const combined = `${instruction || ''} ${prompt || ''}`.trim();

  const knownKeywords = [
    '柔焦散景', '柔和景深', '柔焦', '散景', '夕陽', '金黃色光芒', '金色光芒', '水波紋',
    '微距', '高解析', '寫實', '自然光影', '電影級', '光影層次', '高對比',
    '賽博龐克', '無塵室', '晶圓', '半導體', '機械手臂', '比例尺', '暗色調', '暖色調',
    '俯視角', '藍圖', '動漫', '柔和光線', '星光', '水面倒影'
  ];

  let added = 0;
  for (const kw of knownKeywords) {
    if (combined.includes(kw)) {
      nextTags[kw] = (nextTags[kw] || 0) + 1;
      added++;
    }
  }

  // 若使用者在改圖對話框輸入具體偏好指令（非內建按鈕萬用句），嘗試擷取關鍵片段記錄
  const cleanInst = String(instruction || '').trim();
  const isDefaultBtnText = !cleanInst || /請根據目前的畫面描述|強化細節並直接重新生圖/.test(cleanInst);
  const nextRecent = [...(cur.recentInstructions || [])];
  if (!isDefaultBtnText) {
    const snippet = cleanInst.replace(/[，。！？\s]+/g, ' ').trim().slice(0, 40);
    if (snippet && !nextRecent.includes(snippet)) {
      nextRecent.unshift(snippet);
    }
    if (added === 0 && cleanInst.length >= 2 && cleanInst.length <= 24) {
      const tagKey = cleanInst.replace(/^(請|幫我|加上|加入|改成|換成)/, '').trim().slice(0, 12);
      if (tagKey.length >= 2) {
        nextTags[tagKey] = (nextTags[tagKey] || 0) + 1;
      }
    }
  }

  const nextObj = {
    updatedAt: new Date().toISOString(),
    totalInteractions: (cur.totalInteractions || 0) + 1,
    preferredEngine: engine || cur.preferredEngine || 'local-sd',
    preferredStyle: style && style !== 'none' ? style : (cur.preferredStyle || 'photorealistic'),
    tasteTags: nextTags,
    recentInstructions: nextRecent.slice(0, 10)
  };
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(IMAGE_TASTE_PATH, JSON.stringify(nextObj, null, 2), 'utf8');
  return readImageTaste();
}

function clearImageTasteHistory() {
  const resetObj = {
    updatedAt: new Date().toISOString(),
    totalInteractions: 0,
    preferredEngine: 'local-sd',
    preferredStyle: 'photorealistic',
    tasteTags: {},
    recentInstructions: []
  };
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(IMAGE_TASTE_PATH, JSON.stringify(resetObj, null, 2), 'utf8');

  // 同步清理待審核提案中源自生圖偏好的項目
  const gov = readLearningGovernance();
  const beforeCount = gov.pendingProposals.length;
  gov.pendingProposals = gov.pendingProposals.filter(
    (p) => !/生圖|視覺偏好/.test(String(p.ruleText || '') + String(p.sourceMessage || ''))
  );
  const removedPendingProposalsCount = beforeCount - gov.pendingProposals.length;
  if (removedPendingProposalsCount > 0) {
    saveLearningGovernance(gov);
  }

  return {
    success: true,
    removedPendingProposalsCount,
    imageTaste: readImageTaste()
  };
}

/**
 * 正規化規則比對文字（去除標點與空白）
 */
function normalizeRuleText(text) {
  return String(text || '').replace(/[\s，。、；：「」"'()\[\]-]/g, '').toLowerCase();
}

function isRuleDuplicateInText(existingText, cleanRule) {
  const normRule = normalizeRuleText(cleanRule);
  if (!normRule) return false;
  for (const line of String(existingText || '').split(/\r?\n/)) {
    const normLine = normalizeRuleText(line);
    if (
      normLine.length > 6 &&
      (normLine.includes(normRule) ||
        normRule.includes(normLine.replace(/^\d{4}\d{2}\d{2}.*?(自主學習|總結學習|糾正學習|經驗)/, '')))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 自主學習 2：將萃取出的規則/偏好安全寫入 MEMORY.md 或 USER.md（自動去重並完整保留 🔴 鐵律）
 */
function appendLearnedRule({ target = 'MEMORY', ruleText = '', tag = '自主學習' } = {}) {
  const cleanRule = String(ruleText || '').replace(/\r?\n/g, ' ').trim();
  if (!cleanRule || cleanRule.length < 4) {
    return { success: false, skipped: true, reason: '規則內容過短' };
  }
  const key = String(target || 'MEMORY').toUpperCase() === 'USER' ? 'USER' : 'MEMORY';
  const files = readMemoryFiles();
  const existing = files[key] || '';

  if (isRuleDuplicateInText(existing, cleanRule)) {
    return { success: true, skipped: true, duplicate: true, file: `${key}.md`, ruleText: cleanRule };
  }

  const today = new Date().toISOString().slice(0, 10);
  const entry = `- [${today} ${tag}] ${cleanRule}`;
  const sectionHeader = key === 'MEMORY' ? '## 自主學習經驗沉澱' : '## 自主學習偏好';
  let updatedContent = existing.trimEnd();
  if (updatedContent.includes(sectionHeader)) {
    updatedContent = `${updatedContent}\n${entry}\n`;
  } else {
    updatedContent = `${updatedContent}\n\n${sectionHeader}\n${entry}\n`;
  }

  const saveRes = saveMemoryFile(key, updatedContent);
  if (!saveRes.success) return saveRes;
  return {
    success: true,
    skipped: false,
    file: `${key}.md`,
    ruleText: cleanRule,
    entry
  };
}

/**
 * 成長治理 (L4-09 概念)：記憶學習 Diff 提案、核准與原子回退 (learning_governance.json)
 */
function readLearningGovernance() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const defaults = {
    policy: 'review',
    updatedAt: null,
    pendingProposals: [],
    appliedHistory: []
  };
  if (!fs.existsSync(LEARNING_GOV_PATH)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(LEARNING_GOV_PATH, 'utf8'));
    return {
      policy: parsed.policy === 'auto' ? 'auto' : 'review',
      updatedAt: parsed.updatedAt || null,
      pendingProposals: Array.isArray(parsed.pendingProposals) ? parsed.pendingProposals : [],
      appliedHistory: Array.isArray(parsed.appliedHistory) ? parsed.appliedHistory : []
    };
  } catch {
    return defaults;
  }
}

function saveLearningGovernance(gov) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const next = {
    policy: gov.policy === 'auto' ? 'auto' : 'review',
    updatedAt: new Date().toISOString(),
    pendingProposals: (Array.isArray(gov.pendingProposals) ? gov.pendingProposals : []).slice(0, 30),
    appliedHistory: (Array.isArray(gov.appliedHistory) ? gov.appliedHistory : []).slice(0, 40)
  };
  fs.writeFileSync(LEARNING_GOV_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function setLearningPolicy(policy) {
  const normalized = policy === 'auto' ? 'auto' : 'review';
  const gov = readLearningGovernance();
  gov.policy = normalized;
  saveLearningGovernance(gov);
  return { success: true, policy: normalized, governance: getLearningStatus() };
}

function buildRuleDiffPreview({ targetKey, sectionHeader, entryLine }) {
  return [
    `--- a/memory/${targetKey}.md`,
    `+++ b/memory/${targetKey}.md`,
    `@@ ${sectionHeader} @@`,
    `+ ${entryLine}`
  ].join('\n');
}

function proposeOrApplyLearnedRule({
  target = 'MEMORY',
  ruleText = '',
  tag = '自主學習',
  sourceMessage = '',
  forceAuto = false
} = {}) {
  const cleanRule = String(ruleText || '').replace(/\r?\n/g, ' ').trim();
  if (!cleanRule || cleanRule.length < 4) {
    return { success: false, skipped: true, reason: '規則內容過短' };
  }
  const key = String(target || 'MEMORY').toUpperCase() === 'USER' ? 'USER' : 'MEMORY';
  const files = readMemoryFiles();
  if (isRuleDuplicateInText(files[key] || '', cleanRule)) {
    return { success: true, skipped: true, duplicate: true, file: `${key}.md`, ruleText: cleanRule };
  }

  const gov = readLearningGovernance();
  const normRule = normalizeRuleText(cleanRule);
  const dupPending = gov.pendingProposals.some(
    (p) => p.target === key && normalizeRuleText(p.ruleText).includes(normRule)
  );
  if (dupPending) {
    return { success: true, skipped: true, duplicate: true, file: `${key}.md`, ruleText: cleanRule };
  }

  const today = new Date().toISOString().slice(0, 10);
  const entry = `- [${today} ${tag}] ${cleanRule}`;
  const sectionHeader = key === 'MEMORY' ? '## 自主學習經驗沉澱' : '## 自主學習偏好';
  const diffPreview = buildRuleDiffPreview({ targetKey: key, sectionHeader, entryLine: entry });
  const applyNow = forceAuto || gov.policy === 'auto';

  if (applyNow) {
    const res = appendLearnedRule({ target: key, ruleText: cleanRule, tag });
    if (!res.success || res.skipped) return res;
    const appliedItem = {
      id: `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target: key,
      file: `${key}.md`,
      ruleText: cleanRule,
      entry: res.entry,
      tag,
      sourceMessage: String(sourceMessage || '').slice(0, 120),
      appliedAt: new Date().toISOString()
    };
    gov.appliedHistory.unshift(appliedItem);
    saveLearningGovernance(gov);
    return {
      success: true,
      status: 'applied',
      learned: true,
      pending: false,
      proposal: null,
      applied: appliedItem,
      file: `${key}.md`,
      ruleText: cleanRule,
      diffPreview
    };
  }

  const proposal = {
    id: `prop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    target: key,
    file: `${key}.md`,
    sectionHeader,
    ruleText: cleanRule,
    entry,
    diffPreview,
    tag,
    sourceMessage: String(sourceMessage || '').slice(0, 120),
    createdAt: new Date().toISOString()
  };
  gov.pendingProposals.unshift(proposal);
  saveLearningGovernance(gov);
  return {
    success: true,
    status: 'proposed',
    learned: false,
    pending: true,
    proposal,
    file: `${key}.md`,
    ruleText: cleanRule,
    diffPreview
  };
}

function approveLearningProposal(proposalId, { customRuleText, customTarget } = {}) {
  const gov = readLearningGovernance();
  const idx = gov.pendingProposals.findIndex((p) => p.id === proposalId);
  if (idx === -1) {
    return { success: false, error: '找不到指定的待核准提案' };
  }
  const prop = gov.pendingProposals[idx];
  const finalRule = customRuleText
    ? String(customRuleText).replace(/\r?\n/g, ' ').trim()
    : prop.ruleText;
  if (!finalRule || finalRule.length < 4) {
    return { success: false, error: '規則文字不可為空或少於 4 個字元' };
  }
  const finalTarget = customTarget
    ? (String(customTarget).toUpperCase() === 'USER' ? 'USER' : 'MEMORY')
    : prop.target;

  const res = appendLearnedRule({
    target: finalTarget,
    ruleText: finalRule,
    tag: prop.tag || '自主學習'
  });
  if (!res.success && !res.skipped) return res;

  gov.pendingProposals.splice(idx, 1);
  let appliedItem = null;
  if (!res.duplicate && !res.skipped) {
    appliedItem = {
      id: `app_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      target: finalTarget,
      file: `${finalTarget}.md`,
      ruleText: finalRule,
      entry: res.entry,
      tag: prop.tag || '自主學習',
      sourceMessage: prop.sourceMessage || '',
      appliedAt: new Date().toISOString(),
      fromProposalId: proposalId
    };
    gov.appliedHistory.unshift(appliedItem);
  }
  saveLearningGovernance(gov);

  return {
    success: true,
    duplicate: Boolean(res.duplicate),
    applied: appliedItem,
    files: readMemoryFiles(),
    governance: getLearningStatus()
  };
}

function approveAllLearningProposals() {
  const gov = readLearningGovernance();
  const ids = gov.pendingProposals.map((p) => p.id);
  const appliedList = [];
  for (const id of ids) {
    const r = approveLearningProposal(id);
    if (r.success && r.applied) {
      appliedList.push(r.applied);
    }
  }
  return {
    success: true,
    approvedCount: appliedList.length,
    appliedList,
    files: readMemoryFiles(),
    governance: getLearningStatus()
  };
}

function rejectLearningProposal(proposalId) {
  const gov = readLearningGovernance();
  const prevLen = gov.pendingProposals.length;
  gov.pendingProposals = gov.pendingProposals.filter((p) => p.id !== proposalId);
  if (gov.pendingProposals.length === prevLen) {
    return { success: false, error: '找不到指定的待核准提案' };
  }
  saveLearningGovernance(gov);
  return {
    success: true,
    rejectedId: proposalId,
    governance: getLearningStatus()
  };
}

function rollbackAppliedRule(appliedId) {
  const gov = readLearningGovernance();
  const idx = gov.appliedHistory.findIndex((a) => a.id === appliedId);
  if (idx === -1) {
    return { success: false, error: '找不到指定的已套用記憶紀錄' };
  }
  const item = gov.appliedHistory[idx];
  if (String(item.entry || item.ruleText || '').includes('🔴')) {
    return { success: false, error: '基於 🔴 核心鐵律保護原則，禁止回退受保護規則' };
  }

  const key = String(item.target || 'MEMORY').toUpperCase() === 'USER' ? 'USER' : 'MEMORY';
  const files = readMemoryFiles();
  const content = files[key] || '';
  const lines = content.split(/\r?\n/);

  let removed = false;
  const targetEntry = String(item.entry || '').trim();
  const nextLines = lines.filter((line) => {
    if (removed || line.includes('🔴')) return true;
    const trimmed = line.trim();
    if (targetEntry && trimmed === targetEntry) {
      removed = true;
      return false;
    }
    if (!targetEntry && item.ruleText && trimmed.startsWith('- [') && trimmed.includes(item.ruleText)) {
      removed = true;
      return false;
    }
    return true;
  });

  if (removed) {
    const saveRes = saveMemoryFile(key, nextLines.join('\n').replace(/\n{3,}/g, '\n\n'));
    if (!saveRes.success) return saveRes;
  }

  gov.appliedHistory.splice(idx, 1);
  saveLearningGovernance(gov);

  return {
    success: true,
    removedFromFile: removed,
    alreadyAbsent: !removed,
    rolledBack: item,
    files: readMemoryFiles(),
    governance: getLearningStatus()
  };
}

function getLearningStatus() {
  const files = readMemoryFiles();
  const extractLearned = (text, fileLabel) => (text || '')
    .split(/\r?\n/)
    .filter((l) => /\[20\d{2}-\d{2}-\d{2}.*(自主學習|總結學習|糾正學習|經驗)\]/.test(l))
    .map((l) => ({ file: fileLabel, text: l.replace(/^- /, '').trim() }));

  const learnedRules = [
    ...extractLearned(files.MEMORY, 'MEMORY.md'),
    ...extractLearned(files.USER, 'USER.md')
  ];
  const redRuleCount = (files.MEMORY || '').split(/\r?\n/).filter((l) => l.includes('🔴')).length;
  const imageTaste = readImageTaste();
  const gov = readLearningGovernance();

  return {
    success: true,
    redRuleCount,
    learnedCount: learnedRules.length,
    learnedRules: learnedRules.slice(-20),
    imageTaste,
    policy: gov.policy,
    pendingCount: gov.pendingProposals.length,
    pendingProposals: gov.pendingProposals,
    appliedHistory: gov.appliedHistory
  };
}

/**
 * 長對話壓縮狀態與設定 (context_summary.json)
 */
function readContextState() {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  const defaults = {
    budgetTokens: 4096,
    thresholdPct: 80,
    rollingSummary: '',
    compactedCount: 0,
    savedTokens: 0,
    lastCompactedAt: null
  };
  if (!fs.existsSync(CONTEXT_SUMMARY_PATH)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(CONTEXT_SUMMARY_PATH, 'utf8'));
    const budget = Number(parsed.budgetTokens) || 4096;
    const thresh = Number(parsed.thresholdPct) || 80;
    return {
      budgetTokens: Math.min(32768, Math.max(2048, budget)),
      thresholdPct: Math.min(95, Math.max(50, thresh)),
      rollingSummary: String(parsed.rollingSummary || ''),
      compactedCount: Number(parsed.compactedCount) || 0,
      savedTokens: Number(parsed.savedTokens) || 0,
      lastCompactedAt: parsed.lastCompactedAt || null
    };
  } catch {
    return defaults;
  }
}

function saveContextState(patch = {}) {
  const cur = readContextState();
  const merged = { ...cur, ...patch };
  merged.budgetTokens = Math.min(32768, Math.max(2048, Number(merged.budgetTokens) || 4096));
  merged.thresholdPct = Math.min(95, Math.max(50, Number(merged.thresholdPct) || 80));
  merged.compactedCount = Math.max(0, Number(merged.compactedCount) || 0);
  merged.savedTokens = Math.max(0, Number(merged.savedTokens) || 0);
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(CONTEXT_SUMMARY_PATH, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

module.exports = {
  BASE_DIR,
  PROJECTS_ROOT,
  MEMORY_DIR,
  resolveSecondbrainDir,
  scanLocalProjects,
  queryMesAndSpc,
  inspectAoiSystem,
  listLocalExcelFiles,
  parseExcelSafe,
  queryOutlookSafe,
  secondbrainTool,
  fileOps,
  runPowerShellTool,
  webSearch,
  readMemoryFiles,
  saveMemoryFile,
  memoryTool,
  readImageTaste,
  recordImageTaste,
  clearImageTasteHistory,
  appendLearnedRule,
  readLearningGovernance,
  setLearningPolicy,
  proposeOrApplyLearnedRule,
  approveLearningProposal,
  approveAllLearningProposals,
  rejectLearningProposal,
  rollbackAppliedRule,
  getLearningStatus,
  readContextState,
  saveContextState
};
