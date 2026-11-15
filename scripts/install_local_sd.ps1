<#
.SYNOPSIS
    於 D:\OllamaModels\sd 部署 100% 離線免審查本機 AI 生圖引擎 (stable-diffusion.cpp + DreamShaper-7 LCM Q4_0)
    支援 4 連線平行 HTTP Range 斷點續傳與 MD5 嚴格校驗，全程動態解析路徑且內建防休眠保護。
#>
$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

$workDir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$rootDrive = Split-Path -Qualifier $workDir
if (-not $rootDrive) { $rootDrive = 'D:' }

$modelsDir = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $rootDrive 'OllamaModels' }
$sdDir = Join-Path $modelsDir 'sd'
$binDir = Join-Path $sdDir 'bin'
$sdModelsDir = Join-Path $sdDir 'models'

New-Item -ItemType Directory -Force -Path $binDir, $sdModelsDir | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class SdAwakeHelper {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue
[void][SdAwakeHelper]::SetThreadExecutionState([uint32]2147483649)

function Invoke-ParallelRangeDownloadWithMd5 {
    param(
        [string]$Url,
        [string]$OutPath,
        [long]$ExpectedSize,
        [string]$ExpectedMd5
    )

    $nodeScript = @'
process.exitCode = 1;

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

dns.setDefaultResultOrder('ipv4first');

const [targetUrl, outPath, expectedSizeStr, expectedMd5Raw] = process.argv.slice(2);
const expectedSize = Number(expectedSizeStr);
const expectedMd5 = String(expectedMd5Raw || '').trim().toLowerCase();
const progressPath = `${outPath}.progress.json`;
const WORKERS = 4;

if (!targetUrl || !outPath || !Number.isFinite(expectedSize) || expectedSize <= 0) {
  console.error('[LocalSD-Node] 無效下載參數');
  process.exit(2);
}

function splitActiveRanges(intervals) {
  const list = intervals.map((x) => ({ start: x.start, end: x.end, pos: x.pos }));
  while (list.length < WORKERS) {
    let bestIdx = -1;
    let bestLen = 0;
    for (let i = 0; i < list.length; i++) {
      const rem = list[i].end - list[i].pos + 1;
      if (rem > bestLen) {
        bestLen = rem;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestLen < 8 * 1024 * 1024) break;
    const target = list[bestIdx];
    const rem = target.end - target.pos + 1;
    const half = Math.floor(rem / 2);
    const firstEnd = target.pos + half - 1;
    const secondStart = firstEnd + 1;
    const secondEnd = target.end;
    target.end = firstEnd;
    list.splice(bestIdx + 1, 0, { start: secondStart, end: secondEnd, pos: secondStart });
  }
  return list.map((r, idx) => ({ id: idx + 1, start: r.start, end: r.end, pos: r.pos }));
}

function loadOrInitProgress() {
  if (fs.existsSync(progressPath) && fs.existsSync(outPath) && fs.statSync(outPath).size === expectedSize) {
    try {
      const saved = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      if (
        saved &&
        saved.md5 === expectedMd5 &&
        saved.expectedSize === expectedSize &&
        Array.isArray(saved.ranges)
      ) {
        let baseCompleted = expectedSize;
        const active = [];
        for (const r of saved.ranges) {
          if (typeof r.pos === 'number' && typeof r.end === 'number' && r.pos <= r.end) {
            active.push({ start: r.pos, end: r.end, pos: r.pos });
            baseCompleted -= (r.end - r.pos + 1);
          }
        }
        const rebalanced = splitActiveRanges(active);
        const remMB = ((expectedSize - baseCompleted) / (1024 * 1024)).toFixed(1);
        console.log(`[LocalSD] 偵測到續傳進度檔：已完成 ${(baseCompleted / (1024 * 1024)).toFixed(1)} MB，剩餘 ${remMB} MB 分配給 ${rebalanced.length} 條連線...`);
        const nextState = { md5: expectedMd5, expectedSize, baseCompleted, ranges: rebalanced };
        fs.writeFileSync(progressPath, JSON.stringify(nextState, null, 2), 'utf8');
        return nextState;
      }
    } catch {}
  }

  const fdInit = fs.openSync(outPath, 'w+');
  fs.ftruncateSync(fdInit, expectedSize);
  fs.closeSync(fdInit);

  const partSize = Math.floor(expectedSize / WORKERS);
  const ranges = [];
  for (let i = 0; i < WORKERS; i++) {
    const start = i * partSize;
    const end = i === WORKERS - 1 ? expectedSize - 1 : (i + 1) * partSize - 1;
    ranges.push({ id: i + 1, start, end, pos: start });
  }
  const state = { md5: expectedMd5, expectedSize, baseCompleted: 0, ranges };
  fs.writeFileSync(progressPath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function saveProgress(state) {
  try {
    fs.writeFileSync(progressPath, JSON.stringify(state), 'utf8');
  } catch {}
}

function requestRange(urlStr, start, end, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.request(
      parsed,
      {
        method: 'GET',
        family: 4,
        headers: {
          Range: `bytes=${start}-${end}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MiniAntigravity/1.0'
        }
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (redirectDepth >= 8) {
            reject(Object.assign(new Error('Too many redirects'), { statusCode: code }));
            return;
          }
          const nextUrl = new URL(res.headers.location, parsed).toString();
          resolve(requestRange(nextUrl, start, end, redirectDepth + 1));
          return;
        }
        if (code !== 206) {
          res.resume();
          reject(Object.assign(new Error(`Unexpected HTTP status ${code}`), { statusCode: code }));
          return;
        }
        resolve({ req, res });
      }
    );
    req.setTimeout(25000, () => {
      req.destroy(new Error('Request connect timeout'));
    });
    req.on('error', (err) => reject(err));
    req.end();
  });
}

function verifyFileMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

(async () => {
  const state = loadOrInitProgress();
  const fd = fs.openSync(outPath, 'r+');
  const startTime = Date.now();
  let sessionBytes = 0;
  let bytesSinceSave = 0;
  let lastPrintedPct = -5;
  let fatalStatusError = null;

  function calcCompleted() {
    const workerDone = state.ranges.reduce((acc, r) => acc + Math.max(0, r.pos - r.start), 0);
    return (state.baseCompleted || 0) + workerDone;
  }

  function maybeReportProgress(force = false) {
    const done = calcCompleted();
    const pct = (done / expectedSize) * 100;
    if (force || pct >= lastPrintedPct + 5 || done === expectedSize) {
      lastPrintedPct = Math.floor(pct / 5) * 5;
      const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
      const speedMBs = sessionBytes / (1024 * 1024) / elapsedSec;
      const doneMB = (done / (1024 * 1024)).toFixed(1);
      const totalMB = (expectedSize / (1024 * 1024)).toFixed(1);
      console.log(`[LocalSD] 進度: ${pct.toFixed(1)}% (${doneMB} / ${totalMB} MB) | 速度: ${speedMBs.toFixed(2)} MB/s`);
    }
  }

  maybeReportProgress(true);

  async function runWorker(range) {
    let attempts = 0;
    while (range.pos <= range.end) {
      if (fatalStatusError) return;
      try {
        const { req, res } = await requestRange(targetUrl, range.pos, range.end);
        await new Promise((resolve, reject) => {
          let settled = false;
          let idleTimer = null;

          const onIdle = () => {
            if (!settled) {
              settled = true;
              saveProgress(state);
              req.destroy();
              res.destroy();
              reject(new Error('Stream idle timeout'));
            }
          };

          const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(onIdle, 25000);
          };

          resetIdle();

          res.on('data', (chunk) => {
            resetIdle();
            const remaining = range.end - range.pos + 1;
            if (remaining <= 0) return;
            const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
            fs.writeSync(fd, buf, 0, buf.length, range.pos);
            range.pos += buf.length;
            sessionBytes += buf.length;
            bytesSinceSave += buf.length;
            if (bytesSinceSave >= 2 * 1024 * 1024) {
              bytesSinceSave = 0;
              saveProgress(state);
            }
            maybeReportProgress(false);
            if (range.pos > range.end && !settled) {
              settled = true;
              clearTimeout(idleTimer);
              saveProgress(state);
              req.destroy();
              resolve();
            }
          });

          res.on('end', () => {
            clearTimeout(idleTimer);
            if (!settled) {
              settled = true;
              saveProgress(state);
              resolve();
            }
          });

          res.on('close', () => {
            clearTimeout(idleTimer);
            if (!settled) {
              settled = true;
              saveProgress(state);
              resolve();
            }
          });

          res.on('error', (err) => {
            clearTimeout(idleTimer);
            if (!settled) {
              settled = true;
              saveProgress(state);
              reject(err);
            }
          });
        });
        attempts = 0;
      } catch (err) {
        saveProgress(state);
        attempts++;
        const sc = err && err.statusCode;
        if ((sc === 403 || sc === 416 || sc === 429) && attempts >= 4) {
          fatalStatusError = err;
          return;
        }
        if (attempts >= 20) {
          fatalStatusError = err;
          return;
        }
        const waitMs = Math.min(12000, attempts * 1500);
        console.log(`[LocalSD-W${range.id}] 連線中斷 (${err.message})，${(waitMs / 1000).toFixed(1)}s 後續傳 (${attempts}/20)...`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  await Promise.all(state.ranges.map((r) => runWorker(r)));

  try {
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch {}

  if (fatalStatusError) {
    console.error(`[LocalSD-Node] 平行 Range 下載失敗: ${fatalStatusError.message}`);
    process.exit(3);
  }

  const completed = calcCompleted();
  if (completed !== expectedSize || fs.statSync(outPath).size !== expectedSize) {
    console.error(`[LocalSD-Node] 位元組數不一致: completed=${completed}, expected=${expectedSize}`);
    process.exit(4);
  }

  console.log('[LocalSD] 正在計算完整模型 MD5 校驗碼...');
  const actualMd5 = await verifyFileMd5(outPath);
  if (expectedMd5 && actualMd5 !== expectedMd5) {
    console.error(`[LocalSD-Node] MD5 校驗失敗! expected=${expectedMd5}, actual=${actualMd5}`);
    process.exit(5);
  }

  if (fs.existsSync(progressPath)) {
    fs.unlinkSync(progressPath);
  }
  maybeReportProgress(true);
  console.log(`[LocalSD] MD5 校驗通過 (${actualMd5})！`);
  process.exitCode = 0;
})().catch((err) => {
  console.error('[LocalSD-Node] 未預期錯誤:', err.message);
  process.exit(1);
});
'@

    $nodeScript | & node - $Url $OutPath $ExpectedSize $ExpectedMd5 | ForEach-Object { [Console]::WriteLine($_) }
    return $LASTEXITCODE
}

# 1. 下載並解壓 stable-diffusion.cpp (Win CPU AVX2/x64)
$zipUrl = 'https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1104-5dcfa79/sd-master-5dcfa79-bin-win-cpu-x64.zip'
$zipExpectedSize = 18279511
$zipPath = Join-Path $sdDir 'sd-win-cpu-x64.zip'

$existingExes = @(Get-ChildItem $binDir -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue)
if ($existingExes.Count -eq 0) {
    Write-Output "[LocalSD] 下載 stable-diffusion.cpp (17.4 MB)..."
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        [void][SdAwakeHelper]::SetThreadExecutionState([uint32]2147483649)
        curl.exe -fL -C - --retry 5 --retry-delay 3 --speed-time 30 --speed-limit 1024 -o $zipPath $zipUrl
        if ($LASTEXITCODE -eq 0 -and (Test-Path $zipPath) -and ((Get-Item $zipPath).Length -eq $zipExpectedSize)) {
            break
        }
        Write-Output "[LocalSD] ZIP 第 $attempt 次嘗試未完成，3 秒後續傳..."
        Start-Sleep -Seconds 3
    }
    if (-not (Test-Path $zipPath) -or ((Get-Item $zipPath).Length -ne $zipExpectedSize)) {
        throw "stable-diffusion.cpp ZIP 下載不完整"
    }
    Write-Output "[LocalSD] 解壓縮至 $binDir ..."
    Expand-Archive -Path $zipPath -DestinationPath $binDir -Force
    Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
}

$exes = @(Get-ChildItem $binDir -Filter '*.exe' -Recurse -ErrorAction SilentlyContinue)
Write-Output "[LocalSD] 已備妥執行檔："
$exes | ForEach-Object { Write-Output "  -> $($_.FullName)" }

# 2. 下載並校驗 DreamShaper-7 LCM Q4_0 GGUF (1,625,041,920 bytes)
$ggufUrl = 'https://huggingface.co/darkmaniac7/TokForge-DreamShaper-LCM-GGUF-q4/resolve/main/dreamshaper-7-lcm-q4_0.gguf'
$ggufExpectedSize = 1625041920
$ggufExpectedMd5 = '03661e588d8728a4ec6141f64bd69842'
$ggufPath = Join-Path $sdModelsDir 'dreamshaper-7-lcm-q4_0.gguf'
$progressPath = "$ggufPath.progress.json"

$needModel = $true
if ((Test-Path $ggufPath) -and -not (Test-Path $progressPath)) {
    if ((Get-Item $ggufPath).Length -eq $ggufExpectedSize) {
        $curMd5 = (Get-FileHash -Path $ggufPath -Algorithm MD5).Hash.ToLowerInvariant()
        if ($curMd5 -eq $ggufExpectedMd5) {
            Write-Output "[LocalSD] 已存在完整且 MD5 吻合之模型: $ggufPath ($curMd5)"
            $needModel = $false
        } else {
            Write-Output "[LocalSD] 既存模型 MD5 不符 ($curMd5 != $ggufExpectedMd5)，將重新下載..."
            Remove-Item $ggufPath -Force -ErrorAction SilentlyContinue
        }
    }
}

if ($needModel) {
    Write-Output "[LocalSD] 啟動 4 連線平行下載 DreamShaper-7 LCM Q4_0 (1549.8 MB)..."
    [void][SdAwakeHelper]::SetThreadExecutionState([uint32]2147483649)
    $exitCode = Invoke-ParallelRangeDownloadWithMd5 -Url $ggufUrl -OutPath $ggufPath -ExpectedSize $ggufExpectedSize -ExpectedMd5 $ggufExpectedMd5
    if ($exitCode -ne 0) {
        throw "DreamShaper-7 LCM Q4_0 下載或校驗失敗 (exit=$exitCode)"
    }
}

Write-Output "[LocalSD] 全部安裝與校驗完成！模型目錄：$sdModelsDir"
