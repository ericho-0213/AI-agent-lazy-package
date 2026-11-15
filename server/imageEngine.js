/**
 * 圖片自由創建引擎 (Image Creation Engine)
 * 1. 本機無限制寫實生圖引擎 (Local SD-LCM: stable-diffusion.cpp + dreamshaper-7-lcm-q4_0.gguf) — 100% 離線、零審查、無浮水印
 * 2. 雲端免金鑰 AI 自由生圖 (Flux / Turbo) — 支援中文 Prompt 自動英譯增強 + 高度加採樣無損切除底部浮水印
 * 3. 本機離線工程向量圖生成 (Local SVG Poster / Wafer Diagram) — 斷網亦可用於生成高解析向量圖檔
 * 4. 圖庫管理 (儲存至 outputs/images/ 並記錄於 memory/image_gallery.json)
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const BASE_DIR = path.resolve(__dirname, '..');
const OUTPUT_IMG_DIR = path.join(BASE_DIR, 'outputs', 'images');
const GALLERY_PATH = path.join(BASE_DIR, 'memory', 'image_gallery.json');

function resolveOllamaModelsRoot() {
  if (process.env.OLLAMA_MODELS && fs.existsSync(process.env.OLLAMA_MODELS)) {
    return process.env.OLLAMA_MODELS;
  }
  const rootDrive = path.parse(BASE_DIR).root;
  const candidates = [
    path.join(rootDrive, 'OllamaModels'),
    path.resolve(BASE_DIR, '..', '..', 'OllamaModels')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function getLocalSdStatus() {
  const ollamaRoot = resolveOllamaModelsRoot();
  const cliPath = path.join(ollamaRoot, 'sd', 'bin', 'sd-cli.exe');
  const modelPath = path.join(ollamaRoot, 'sd', 'models', 'dreamshaper-7-lcm-q4_0.gguf');
  const cliExists = fs.existsSync(cliPath);
  const modelExists = fs.existsSync(modelPath);
  let modelSizeMB = 0;
  if (modelExists) {
    try {
      modelSizeMB = Math.round((fs.statSync(modelPath).size / (1024 * 1024)) * 10) / 10;
    } catch {
      modelSizeMB = 0;
    }
  }
  return {
    installed: cliExists && modelExists && modelSizeMB > 1400,
    cliExists,
    modelExists,
    cliPath,
    modelPath,
    modelSizeMB
  };
}

function fallbackKeywordTranslate(zhText) {
  const dict = [
    ['夕陽', 'golden sunset'], ['日落', 'warm sunset'], ['湖面', 'calm lake surface'], ['水波紋', 'gentle water ripples and reflections'],
    ['水波', 'water ripples'], ['大海', 'ocean waves'], ['星空', 'starry night sky'], ['森林', 'lush misty forest'],
    ['山脈', 'majestic mountain peaks'], ['櫻花', 'cherry blossoms'], ['雪景', 'snowy winter landscape'],
    ['晶圓', 'silicon semiconductor wafer'], ['微米', 'microscopic precision'], ['缺陷', 'surface inspection detail'],
    ['顯微', 'macro optical microscope view'], ['無塵室', 'futuristic semiconductor cleanroom'], ['機械手臂', 'precision robotic arm'],
    ['賽博龐克', 'cyberpunk neon'], ['未來', 'futuristic sci-fi'], ['機器人', 'high-tech humanoid robot'],
    ['貓', 'cute fluffy cat'], ['狗', 'lovely golden retriever dog'], ['少女', 'young woman portrait'], ['女孩', 'young woman portrait'],
    ['美女', 'beautiful woman portrait, natural lighting'], ['風景', 'scenic landscape photography'],
    ['夜景', 'vibrant night cityscape'], ['雨天', 'rainy neon street reflections'], ['咖啡廳', 'cozy warm cafe interior'],
    ['宇宙', 'deep space nebula and stars'], ['跑車', 'sleek sports car'], ['建築', 'modern architectural photography'],
    ['特寫', 'close-up macro shot'], ['寫實', 'photorealistic photography'], ['光影', 'dramatic volumetric lighting'],
    ['金色', 'golden warm tones'], ['藍色', 'deep cyan and blue tones'], ['紅色', 'vivid crimson glow']
  ];
  const hits = [];
  for (const [zh, en] of dict) {
    if (zhText.includes(zh)) hits.push(en);
  }
  const asciiParts = zhText.match(/[A-Za-z0-9][A-Za-z0-9\s,._-]{1,}/g) || [];
  const combined = [...hits, ...asciiParts.map((s) => s.trim())].filter(Boolean);
  if (combined.length > 0) {
    return `${combined.join(', ')}, masterpiece, high detail`;
  }
  return 'cinematic high detail composition, natural studio lighting, sharp focus';
}

function stripBottomWatermark(filePath, cropHeight = 0, padPixels = 64) {
  return new Promise((resolve) => {
    if (!fs.existsSync(filePath)) return resolve({ stripped: false, reason: 'file missing' });
    const tmpOut = `${filePath}.clean${path.extname(filePath)}`;
    const psScript = `
      Add-Type -AssemblyName System.Drawing
      $srcPath = $env:IMG_SRC
      $dstPath = $env:IMG_DST
      $targetH = [int]$env:IMG_TARGET_H
      $pad = [int]$env:IMG_PAD
      $img = [System.Drawing.Image]::FromFile($srcPath)
      try {
        $w = $img.Width
        $h = $img.Height
        if ($targetH -gt 0 -and $h -gt $targetH) {
          $cropH = $targetH
        } elseif ($h -gt ($pad + 128)) {
          $cropH = $h - $pad
        } else {
          $cropH = $h
        }
        $bmp = New-Object System.Drawing.Bitmap($w, $cropH)
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $srcRect = New-Object System.Drawing.Rectangle(0, 0, $w, $cropH)
        $dstRect = New-Object System.Drawing.Rectangle(0, 0, $w, $cropH)
        $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
        $g.Dispose()
        $ext = [System.IO.Path]::GetExtension($srcPath).ToLower()
        if ($ext -eq '.png') {
          $bmp.Save($dstPath, [System.Drawing.Imaging.ImageFormat]::Png)
        } else {
          $enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
          $ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
          $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]95)
          $bmp.Save($dstPath, $enc, $ep)
        }
        $bmp.Dispose()
        Write-Output "$w,$cropH"
      } finally {
        $img.Dispose()
      }
    `;
    execFile(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
      {
        env: {
          ...process.env,
          IMG_SRC: filePath,
          IMG_DST: tmpOut,
          IMG_TARGET_H: String(cropHeight || 0),
          IMG_PAD: String(padPixels || 64)
        },
        timeout: 25000
      },
      (err, stdout) => {
        if (err || !fs.existsSync(tmpOut)) {
          try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch {}
          return resolve({ stripped: false, reason: err ? err.message : 'output missing' });
        }
        try {
          fs.renameSync(tmpOut, filePath);
          const dims = String(stdout || '').trim().split(',').map(Number);
          return resolve({ stripped: true, width: dims[0] || undefined, height: dims[1] || undefined });
        } catch (e) {
          return resolve({ stripped: false, reason: e.message });
        }
      }
    );
  });
}

function ensureDirs() {
  fs.mkdirSync(OUTPUT_IMG_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(GALLERY_PATH), { recursive: true });
}

function readGallery() {
  ensureDirs();
  if (!fs.existsSync(GALLERY_PATH)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(GALLERY_PATH, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeGallery(items) {
  ensureDirs();
  fs.writeFileSync(GALLERY_PATH, JSON.stringify(items.slice(0, 120), null, 2), 'utf8');
}

function appendGalleryItem(item) {
  const list = readGallery();
  list.unshift(item);
  writeGallery(list);
  return item;
}

function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 產生高質感本機離線 SVG 圖片（免聯網、100% 即時生成）
 */
function generateLocalSvgImage({
  prompt = 'Mini-Antigravity AI Agent Blueprint',
  title = '',
  style = 'cyber-wafer',
  width = 1024,
  height = 1024,
  seed = Math.floor(Math.random() * 999999),
  privateMode = false
} = {}) {
  ensureDirs();
  const w = Math.max(512, Math.min(1920, Number(width) || 1024));
  const h = Math.max(512, Math.min(1920, Number(height) || 1024));
  const displayTitle = escapeXml(title || prompt.slice(0, 42));
  const displaySub = escapeXml(prompt.slice(0, 88));

  const palettes = {
    'cyber-wafer': { bg1: '#061121', bg2: '#0f2942', accent: '#38bdf8', glow: '#f59e0b', grid: '#1e3a5f' },
    'industrial': { bg1: '#0b0f17', bg2: '#1f2937', accent: '#10b981', glow: '#fbbf24', grid: '#334155' },
    'neon-purple': { bg1: '#0f0720', bg2: '#2e1065', accent: '#c084fc', glow: '#22d3ee', grid: '#4c1d95' }
  };
  const pal = palettes[style] || palettes['cyber-wafer'];

  // Deterministic pseudo-random defects / nodes based on seed
  let rng = Number(seed) || 12345;
  const nextRand = () => {
    rng = (rng * 1664525 + 1013904223) % 4294967296;
    return rng / 4294967296;
  };

  const cx = w / 2;
  const cy = h / 2 - 20;
  const radius = Math.min(w, h) * 0.28;

  let nodesSvg = '';
  for (let i = 0; i < 18; i++) {
    const angle = nextRand() * Math.PI * 2;
    const dist = (0.18 + nextRand() * 0.72) * radius;
    const nx = (cx + Math.cos(angle) * dist).toFixed(1);
    const ny = (cy + Math.sin(angle) * dist).toFixed(1);
    const nr = (4 + nextRand() * 9).toFixed(1);
    const isHighlight = i < 4;
    nodesSvg += `<circle cx="${nx}" cy="${ny}" r="${nr}" fill="${isHighlight ? pal.glow : pal.accent}" fill-opacity="0.85" stroke="#ffffff" stroke-width="1.2"/>`;
    if (isHighlight) {
      nodesSvg += `<circle cx="${nx}" cy="${ny}" r="${(Number(nr) + 8).toFixed(1)}" fill="none" stroke="${pal.glow}" stroke-width="1.5" stroke-dasharray="4 3"/>`;
    }
  }

  let gridLines = '';
  const step = 48;
  for (let gx = step; gx < w; gx += step) {
    gridLines += `<line x1="${gx}" y1="0" x2="${gx}" y2="${h}" stroke="${pal.grid}" stroke-width="1" stroke-opacity="0.35"/>`;
  }
  for (let gy = step; gy < h; gy += step) {
    gridLines += `<line x1="0" y1="${gy}" x2="${w}" y2="${gy}" stroke="${pal.grid}" stroke-width="1" stroke-opacity="0.35"/>`;
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${pal.bg1}"/>
      <stop offset="100%" stop-color="${pal.bg2}"/>
    </linearGradient>
    <radialGradient id="coreGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${pal.accent}" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="${pal.bg1}" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#bgGrad)"/>
  ${gridLines}
  <circle cx="${cx}" cy="${cy}" r="${(radius * 1.45).toFixed(1)}" fill="url(#coreGlow)"/>
  <circle cx="${cx}" cy="${cy}" r="${radius.toFixed(1)}" fill="${pal.bg1}" fill-opacity="0.65" stroke="${pal.accent}" stroke-width="3"/>
  <circle cx="${cx}" cy="${cy}" r="${(radius * 0.72).toFixed(1)}" fill="none" stroke="${pal.accent}" stroke-width="1.5" stroke-dasharray="10 6" stroke-opacity="0.7"/>
  <circle cx="${cx}" cy="${cy}" r="${(radius * 0.42).toFixed(1)}" fill="none" stroke="${pal.glow}" stroke-width="1.5" stroke-opacity="0.8"/>
  <line x1="${cx - radius * 1.15}" y1="${cy}" x2="${cx + radius * 1.15}" y2="${cy}" stroke="${pal.accent}" stroke-width="1" stroke-opacity="0.45"/>
  <line x1="${cx}" y1="${cy - radius * 1.15}" x2="${cx}" y2="${cy + radius * 1.15}" stroke="${pal.accent}" stroke-width="1" stroke-opacity="0.45"/>
  ${nodesSvg}
  <rect x="44" y="40" width="${w - 88}" height="82" rx="14" fill="#020617" fill-opacity="0.72" stroke="${pal.accent}" stroke-opacity="0.45"/>
  <text x="72" y="78" fill="#f8fafc" font-family="Segoe UI, Microsoft JhengHei, sans-serif" font-size="26" font-weight="bold">${displayTitle}</text>
  <text x="72" y="106" fill="${pal.accent}" font-family="Consolas, monospace" font-size="15">LOCAL VECTOR ENGINE | SEED ${seed} | ${w}x${h}</text>
  <rect x="44" y="${h - 104}" width="${w - 88}" height="64" rx="12" fill="#020617" fill-opacity="0.72" stroke="${pal.glow}" stroke-opacity="0.4"/>
  <text x="72" y="${h - 65}" fill="#cbd5e1" font-family="Segoe UI, Microsoft JhengHei, sans-serif" font-size="17">${displaySub}</text>
</svg>`;

  const filename = `svg_${Date.now()}_${seed}.svg`;
  const filePath = path.join(OUTPUT_IMG_DIR, filename);
  fs.writeFileSync(filePath, svg, 'utf8');

  const record = appendGalleryItem({
    id: `img_${Date.now()}`,
    filename,
    url: `/outputs/images/${filename}`,
    filePath,
    engine: 'local-svg',
    prompt: privateMode ? '[隱私無痕創作]' : prompt,
    translatedPrompt: privateMode ? '' : prompt,
    width: w,
    height: h,
    seed,
    createdAt: new Date().toISOString()
  });

  return { success: true, ...record };
}

function applyStyleSuffix(prompt, style) {
  const styleMap = {
    'none': '',
    'photorealistic': ', ultra detailed, photorealistic, 8k, sharp focus, studio lighting',
    'cyberpunk': ', cyberpunk neon futuristic industrial laboratory, glowing cyan and amber accents, highly detailed',
    'illustration': ', modern digital concept art illustration, clean linework, rich colors',
    'blueprint': ', precision semiconductor cleanroom engineering visualization, technical aesthetic, isometric high detail',
    'anime': ', high quality anime illustration, vibrant lighting, crisp details'
  };
  const suffix = styleMap[style] || '';
  return suffix ? `${prompt}${suffix}` : prompt;
}

/**
 * 檢查是否為有效圖片檔頭 (PNG / JPEG / WEBP / GIF)
 */
function detectImageExtension(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') return 'gif';
  return null;
}

async function translateToEnglishPrompt(cleanPrompt, translatePromptFn) {
  const hasNonAscii = /[^\x00-\x7F]/.test(cleanPrompt);
  if (!hasNonAscii) {
    return { prompt: cleanPrompt, method: 'original-en' };
  }
  if (typeof translatePromptFn === 'function') {
    try {
      const translated = await translatePromptFn(cleanPrompt);
      const t = translated ? translated.trim() : '';
      const isRefusal = /sorry|cannot|can't|unable|apolog|對不起|抱歉|無法/i.test(t);
      if (t.length > 4 && !isRefusal && !/[\u4e00-\u9fff]/.test(t)) {
        return { prompt: t, method: 'llm-translated' };
      }
    } catch {
      // fall through to keyword dictionary
    }
  }
  return { prompt: fallbackKeywordTranslate(cleanPrompt), method: 'keyword-fallback' };
}

/**
 * 使用本機 stable-diffusion.cpp (DreamShaper-7 LCM Q4_0) 離線無限制生圖
 */
async function generateLocalSdImage({
  prompt,
  style = 'photorealistic',
  width = 512,
  height = 512,
  seed = Math.floor(Math.random() * 999999),
  translatePromptFn = null,
  privateMode = false
} = {}) {
  ensureDirs();
  const tStart = Date.now();
  const sdStatus = getLocalSdStatus();
  if (!sdStatus.installed) {
    return {
      success: false,
      error: `本機 SD 引擎尚未安裝完成 (${sdStatus.cliExists ? '執行檔就緒' : '缺少 sd-cli.exe'} / 模型 ${sdStatus.modelSizeMB} MB)`,
      agentFeedback: [
        `檢查本機引擎：${sdStatus.cliExists ? '已找到 sd-cli.exe' : '缺少 sd-cli.exe'}`,
        `檢查模型檔案：DreamShaper-7 LCM (${sdStatus.modelSizeMB} MB)`
      ]
    };
  }

  const w = Number(width) || 512;
  const h = Number(height) || 512;
  let sdW = 512;
  let sdH = 512;
  let sizeNote = '512×512 (SD 1.5 原生最佳構圖與 CPU AVX2 極速解析度)';
  if (w > h) {
    sdW = 640;
    sdH = 384;
    sizeNote = '640×384 (16:9 本機寬螢幕優化解析度)';
  } else if (h > w) {
    sdW = 384;
    sdH = 640;
    sizeNote = '384×640 (9:16 本機直式優化解析度)';
  } else if (w >= 1024) {
    sdW = 512;
    sdH = 512;
    sizeNote = '512×512 (已依 SD 1.5 原生構圖自動最佳化，防止雙頭並加速 4 倍出圖)';
  }

  const tr = await translateToEnglishPrompt(prompt, translatePromptFn);
  const finalPrompt = applyStyleSuffix(tr.prompt, style);
  const negPrompt = 'blurry, low quality, worst quality, watermark, text, logo, signature, deformed, bad anatomy';
  const threads = Math.max(4, Math.min(10, os.cpus().length - 2));
  const filename = `ai_localsd_${Date.now()}_${seed}.png`;
  const filePath = path.join(OUTPUT_IMG_DIR, filename);

  const agentFeedback = [
    `🧠 提示詞解析 (${tr.method === 'llm-translated' ? '本機 LLM 語意轉譯' : tr.method === 'keyword-fallback' ? '雙語關鍵字字典保底轉譯' : '英文原意直通'}): ${finalPrompt}`,
    `⚙️ 本機引擎：DreamShaper-7 LCM (Q4_0) @ CPU AVX2 (${threads} 執行緒)｜尺寸：${sizeNote}｜Steps=5 / CFG=1.5 / Seed=${seed}`
  ];

  const args = [
    '-M', 'img_gen',
    '-m', sdStatus.modelPath,
    '-p', finalPrompt,
    '-n', negPrompt,
    '--sampling-method', 'lcm',
    '--scheduler', 'lcm',
    '--steps', '5',
    '--cfg-scale', '1.5',
    '-W', String(sdW),
    '-H', String(sdH),
    '-s', String(seed),
    '-t', String(threads),
    '-o', filePath
  ];

  try {
    await new Promise((resolve, reject) => {
      execFile(
        sdStatus.cliPath,
        args,
        { cwd: path.dirname(sdStatus.cliPath), timeout: 360000, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            return reject(new Error(stderr ? `${err.message}: ${stderr.slice(-240)}` : err.message));
          }
          if (!fs.existsSync(filePath)) {
            return reject(new Error('sd-cli.exe 未產出圖片檔案'));
          }
          resolve(stdout);
        }
      );
    });

    const elapsedSec = Math.round(((Date.now() - tStart) / 1000) * 10) / 10;
    const sizeKB = Math.round((fs.statSync(filePath).size / 1024) * 10) / 10;
    agentFeedback.push(`✅ 本機離線生圖完成（耗時 ${elapsedSec} 秒，檔案 ${sizeKB} KB），100% 零審查、零冷卻且無任何浮水印。`);

    const record = appendGalleryItem({
      id: `img_${Date.now()}`,
      filename,
      url: `/outputs/images/${filename}`,
      filePath,
      engine: 'local-sd',
      prompt: privateMode ? '[隱私無痕創作]' : prompt,
      translatedPrompt: privateMode ? '' : finalPrompt,
      width: sdW,
      height: sdH,
      seed,
      sizeKB,
      elapsedSec,
      watermarkStripped: true,
      agentFeedback: privateMode ? [] : agentFeedback,
      createdAt: new Date().toISOString()
    });

    return { success: true, ...record };
  } catch (err) {
    agentFeedback.push(`❌ 本機 SD 推理異常：${err.message}`);
    return {
      success: false,
      engine: 'local-sd',
      error: `本機 SD 生圖失敗: ${err.message}`,
      agentFeedback
    };
  }
}

/**
 * 自由建立 AI 圖片
 * - local-sd: 100% 本機離線無限制寫實生圖 (DreamShaper-7 LCM)
 * - flux / turbo: 免金鑰雲端生圖（請求高度 +64px 後無損裁除底部 pollinations.ai 浮水印）
 * - local-svg: 100% 離線工程向量圖
 */
async function generateAiImage({
  prompt,
  engine = 'local-sd',
  style = 'photorealistic',
  width = 512,
  height = 512,
  seed = Math.floor(Math.random() * 999999),
  translatePromptFn = null,
  privateMode = false
} = {}) {
  ensureDirs();
  if (!prompt || !String(prompt).trim()) {
    return { success: false, error: '請輸入圖片描述 (Prompt)' };
  }

  const cleanPrompt = String(prompt).trim();
  if (engine === 'local-svg') {
    const svgRes = generateLocalSvgImage({ prompt: cleanPrompt, style: 'cyber-wafer', width, height, seed, privateMode });
    return {
      ...svgRes,
      agentFeedback: privateMode ? [] : [
        '🖥️ 已選擇 100% 離線本機向量引擎 (Local SVG)，免聯網秒級出圖且無任何浮水印。'
      ]
    };
  }

  if (engine === 'local-sd') {
    return generateLocalSdImage({
      prompt: cleanPrompt,
      style,
      width,
      height,
      seed,
      translatePromptFn,
      privateMode
    });
  }

  const tStart = Date.now();
  const w = Math.max(256, Math.min(1536, Number(width) || 1024));
  const h = Math.max(256, Math.min(1536, Number(height) || 1024));
  const watermarkPad = 64;
  const reqHeight = Math.min(1600, h + watermarkPad);

  const tr = await translateToEnglishPrompt(cleanPrompt, translatePromptFn);
  const finalPrompt = applyStyleSuffix(tr.prompt, style);
  const encoded = encodeURIComponent(finalPrompt);
  const modelName = engine === 'turbo' ? 'turbo' : 'flux';
  const primaryUrl = `https://image.pollinations.ai/prompt/${encoded}?model=${modelName}&width=${w}&height=${reqHeight}&seed=${seed}&nologo=true`;

  const agentFeedback = [
    `🧠 提示詞解析 (${tr.method === 'llm-translated' ? '本機 LLM 語意轉譯' : tr.method === 'keyword-fallback' ? '雙語關鍵字保底轉譯' : '英文原意直通'}): ${finalPrompt}`,
    `☁️ 呼叫雲端 ${modelName.toUpperCase()} 端點，已啟用高採樣預留 (${w}×${reqHeight}) 以準備無損裁除底部浮水印...`
  ];

  let lastError = '未知網路錯誤';
  const maxAttempts = 3;
  let cooldownNotice = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 55000);
      const resp = await fetch(primaryUrl, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MiniAntigravity/1.0'
        }
      });
      clearTimeout(timer);

      if (resp.status === 402 || resp.status === 429) {
        const errText = await resp.text().catch(() => '');
        const retryMatch = errText.match(/Retry after (\d+)\s*s/i);
        const waitSec = retryMatch ? Math.min(48, Math.max(5, Number(retryMatch[1]))) : 20;
        lastError = resp.status === 402
          ? 'HTTP 402 (免費端點每 45 秒限生 1 張圖，冷卻重試後仍受限)'
          : `HTTP ${resp.status}`;
        if (attempt < maxAttempts) {
          cooldownNotice = `⏳ 偵測到免費端點 45 秒冷卻限制，已自動等候 ${waitSec + 2} 秒後重試成功。`;
          await new Promise((r) => setTimeout(r, (waitSec + 2) * 1000));
          continue;
        }
        break;
      }

      if (!resp.ok) {
        lastError = `HTTP ${resp.status}`;
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 2000));
        }
        continue;
      }

      const arrBuf = await resp.arrayBuffer();
      const buf = Buffer.from(arrBuf);
      const ext = detectImageExtension(buf);
      if (!ext) {
        lastError = '回傳內容非標準圖片格式';
        continue;
      }

      const filename = `ai_${modelName}_${Date.now()}_${seed}.${ext}`;
      const filePath = path.join(OUTPUT_IMG_DIR, filename);
      fs.writeFileSync(filePath, buf);

      const cropRes = await stripBottomWatermark(filePath, h, watermarkPad);
      const finalSizeKB = Math.round((fs.statSync(filePath).size / 1024) * 10) / 10;
      const elapsedSec = Math.round(((Date.now() - tStart) / 1000) * 10) / 10;

      if (cooldownNotice) agentFeedback.push(cooldownNotice);
      agentFeedback.push(
        cropRes.stripped
          ? `✂️ 已無損裁除底部 pollinations.ai 浮水印，保留乾淨畫質 ${cropRes.width || w}×${cropRes.height || h}（耗時 ${elapsedSec} 秒）。`
          : `✅ 雲端圖片產出完成（耗時 ${elapsedSec} 秒）。`
      );

      const record = appendGalleryItem({
        id: `img_${Date.now()}`,
        filename,
        url: `/outputs/images/${filename}`,
        filePath,
        engine: modelName,
        prompt: privateMode ? '[隱私無痕創作]' : cleanPrompt,
        translatedPrompt: privateMode ? '' : finalPrompt,
        width: cropRes.width || w,
        height: cropRes.height || h,
        seed,
        sizeKB: finalSizeKB,
        elapsedSec,
        watermarkStripped: cropRes.stripped,
        agentFeedback: privateMode ? [] : agentFeedback,
        createdAt: new Date().toISOString()
      });

      return { success: true, ...record };
    } catch (err) {
      lastError = err.name === 'AbortError' ? '生圖逾時 (55 秒)' : err.message;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // 若處於離線或外部端點受限，提供明確 fallback 本地工程向量圖以免流程中斷
  agentFeedback.push(`⚠️ 雲端端點受限 (${lastError})，已自動切換產出本機離線向量圖；建議改選「🏠 Local SD-LCM」即可離線免排隊生圖。`);
  const fallback = generateLocalSvgImage({
    prompt: privateMode ? '[隱私無痕創作]' : `${cleanPrompt} [離線自動備援]`,
    title: '離線備援工程視覺圖',
    style: 'cyber-wafer',
    width: w,
    height: h,
    seed,
    privateMode
  });
  return {
    ...fallback,
    fallbackUsed: true,
    cloudError: lastError,
    agentFeedback: privateMode ? [] : agentFeedback
  };
}

/**
 * 清理圖庫中既有雲端圖片底部殘留的 pollinations.ai 浮水印
 */
async function stripExistingWatermarksInGallery() {
  const list = readGallery();
  let cleanedCount = 0;
  for (const item of list) {
    if (!item || !item.filename) continue;
    if (item.watermarkStripped) continue;
    if (item.engine !== 'flux' && item.engine !== 'turbo') continue;
    const fp = path.join(OUTPUT_IMG_DIR, item.filename);
    if (!fs.existsSync(fp)) continue;
    const res = await stripBottomWatermark(fp, 0, 68);
    if (res.stripped) {
      item.width = res.width || item.width;
      item.height = res.height || item.height;
      item.sizeKB = Math.round((fs.statSync(fp).size / 1024) * 10) / 10;
      item.watermarkStripped = true;
      cleanedCount++;
    }
  }
  if (cleanedCount > 0) {
    writeGallery(list);
  }
  return { success: true, cleanedCount };
}

function listGallery() {
  const items = readGallery().filter((item) => {
    if (!item || !item.filename) return false;
    return fs.existsSync(path.join(OUTPUT_IMG_DIR, item.filename));
  });
  return items;
}

function deleteGalleryImage(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!safeName) return { success: false, error: '無效檔名' };
  const target = path.join(OUTPUT_IMG_DIR, safeName);
  if (fs.existsSync(target)) {
    fs.unlinkSync(target);
  }
  const next = readGallery().filter((x) => x.filename !== safeName);
  writeGallery(next);
  return { success: true, deleted: safeName };
}

function scrubGalleryPrompts() {
  const list = readGallery();
  let scrubbedCount = 0;
  const next = list.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const hasText =
      (item.prompt && item.prompt !== '[已清除隱私對話紀錄]' && item.prompt !== '[隱私無痕創作]') ||
      Boolean(item.translatedPrompt) ||
      (Array.isArray(item.agentFeedback) && item.agentFeedback.length > 0);
    if (hasText) scrubbedCount++;
    return {
      ...item,
      prompt: '[已清除隱私對話紀錄]',
      translatedPrompt: '',
      agentFeedback: [],
      privacyScrubbedAt: new Date().toISOString()
    };
  });
  writeGallery(next);
  return { success: true, scrubbedCount };
}

module.exports = {
  OUTPUT_IMG_DIR,
  getLocalSdStatus,
  generateAiImage,
  generateLocalSdImage,
  generateLocalSvgImage,
  stripExistingWatermarksInGallery,
  listGallery,
  deleteGalleryImage,
  scrubGalleryPrompts
};
