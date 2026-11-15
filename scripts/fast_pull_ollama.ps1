<#
.SYNOPSIS
    高速斷點續傳拉取 Ollama 模型腳本 (4 連線平行 Range 下載大檔 + SHA-256 嚴格校驗 + curl 降級備援)
    解決 Ollama 預設 16 連線併發於企業/家用網路環境易造成連線池重置卡頓之問題
#>
param(
    [string]$Model = 'qwen2.5',
    [string]$Tag = '3b'
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

if ($Model -match '^([^:]+):(.+)$') {
    $Model = $Matches[1]
    $Tag = $Matches[2]
}

$workDir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$rootDrive = Split-Path -Qualifier $workDir
if (-not $rootDrive) { $rootDrive = 'D:' }

$modelsDir = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $rootDrive 'OllamaModels' }
$blobsDir = Join-Path $modelsDir 'blobs'
New-Item -ItemType Directory -Force -Path $blobsDir | Out-Null
$env:OLLAMA_MODELS = $modelsDir

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PullAwakeHelper {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue
[void][PullAwakeHelper]::SetThreadExecutionState([uint32]2147483649)

function Invoke-ParallelRangeDownload {
    param(
        [string]$Url,
        [string]$OutPath,
        [long]$ExpectedSize,
        [string]$Digest
    )

    $nodeScript = @'
process.exitCode = 1;

const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');

dns.setDefaultResultOrder('ipv4first');

const [blobUrl, blobPath, expectedSizeStr, digest] = process.argv.slice(2);
const expectedSize = Number(expectedSizeStr);
const expectedSha256 = String(digest || '').replace(/^sha256:/i, '').toLowerCase();
const progressPath = `${blobPath}.progress.json`;
const WORKERS = 4;

if (!blobUrl || !blobPath || !Number.isFinite(expectedSize) || expectedSize <= 0) {
  console.error('[FastPull-Node] 無效參數');
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
  if (fs.existsSync(progressPath) && fs.existsSync(blobPath) && fs.statSync(blobPath).size === expectedSize) {
    try {
      const saved = JSON.parse(fs.readFileSync(progressPath, 'utf8'));
      if (
        saved &&
        saved.digest === digest &&
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
        console.log(`[FastPull] 偵測到續傳進度檔：已完成 ${(baseCompleted / (1024 * 1024)).toFixed(1)} MB，剩餘 ${remMB} MB 分配給 ${rebalanced.length} 條連線...`);
        const nextState = { digest, expectedSize, baseCompleted, ranges: rebalanced };
        fs.writeFileSync(progressPath, JSON.stringify(nextState, null, 2), 'utf8');
        return nextState;
      }
    } catch {}
  }

  const fdInit = fs.openSync(blobPath, 'w+');
  fs.ftruncateSync(fdInit, expectedSize);
  fs.closeSync(fdInit);

  const partSize = Math.floor(expectedSize / WORKERS);
  const ranges = [];
  for (let i = 0; i < WORKERS; i++) {
    const start = i * partSize;
    const end = i === WORKERS - 1 ? expectedSize - 1 : (i + 1) * partSize - 1;
    ranges.push({ id: i + 1, start, end, pos: start });
  }
  const state = { digest, expectedSize, baseCompleted: 0, ranges };
  fs.writeFileSync(progressPath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function saveProgress(state) {
  try {
    fs.writeFileSync(progressPath, JSON.stringify(state), 'utf8');
  } catch {}
}

function requestRange(targetUrl, start, end, redirectDepth = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'http:' ? http : https;
    const req = transport.request(
      parsed,
      {
        method: 'GET',
        family: 4,
        headers: {
          Range: `bytes=${start}-${end}`,
          'User-Agent': 'ollama/0.40.16'
        }
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
          res.resume();
          if (redirectDepth >= 6) {
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

function verifyFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

(async () => {
  const state = loadOrInitProgress();
  const fd = fs.openSync(blobPath, 'r+');
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
      console.log(`[FastPull] 進度: ${pct.toFixed(1)}% (${doneMB} / ${totalMB} MB) | 速度: ${speedMBs.toFixed(2)} MB/s`);
    }
  }

  maybeReportProgress(true);

  async function runWorker(range) {
    let attempts = 0;
    while (range.pos <= range.end) {
      if (fatalStatusError) return;
      try {
        const { req, res } = await requestRange(blobUrl, range.pos, range.end);
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
        if ((sc === 403 || sc === 416 || sc === 429) && attempts >= 3) {
          fatalStatusError = err;
          return;
        }
        if (attempts >= 15) {
          fatalStatusError = err;
          return;
        }
        const waitMs = Math.min(12000, attempts * 1500);
        console.log(`[FastPull-W${range.id}] 連線中斷 (${err.message})，${(waitMs / 1000).toFixed(1)}s 後續傳 (${attempts}/15)...`);
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
    console.error(`[FastPull-Node] 平行 Range 下載失敗: ${fatalStatusError.message}`);
    process.exit(3);
  }

  const completed = calcCompleted();
  if (completed !== expectedSize || fs.statSync(blobPath).size !== expectedSize) {
    console.error(`[FastPull-Node] 位元組數不一致: completed=${completed}, expected=${expectedSize}`);
    process.exit(4);
  }

  console.log('[FastPull] 正在計算完整檔案 SHA-256 校驗碼...');
  const actualSha256 = await verifyFileSha256(blobPath);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    console.error(`[FastPull-Node] SHA-256 校驗失敗! expected=${expectedSha256}, actual=${actualSha256}`);
    process.exit(5);
  }

  if (fs.existsSync(progressPath)) {
    fs.unlinkSync(progressPath);
  }
  maybeReportProgress(true);
  console.log(`[FastPull] SHA-256 校驗通過 (${actualSha256})！`);
  process.exitCode = 0;
})().catch((err) => {
  console.error('[FastPull-Node] 未預期錯誤:', err.message);
  process.exit(1);
});
'@

    $nodeScript | & node - $Url $OutPath $ExpectedSize $Digest | ForEach-Object { [Console]::WriteLine($_) }
    $code = $LASTEXITCODE
    return $code
}

$manifestUrl = "https://registry.ollama.ai/v2/library/$Model/manifests/$Tag"
Write-Output "[FastPull] 讀取 Manifest: $manifestUrl"
$manifestJson = curl.exe -fsSL -H "Accept: application/vnd.docker.distribution.manifest.v2+json" $manifestUrl
$manifest = $manifestJson | ConvertFrom-Json

$items = @()
if ($manifest.config) { $items += $manifest.config }
if ($manifest.layers) { $items += $manifest.layers }

$parallelThresholdBytes = 20MB

foreach ($item in $items) {
    $digest = [string]$item.digest
    $expectedSize = [long]$item.size
    $expectedHash = ($digest -replace '^sha256:', '').ToUpperInvariant()
    $blobName = $digest.Replace(':', '-')
    $blobPath = Join-Path $blobsDir $blobName
    $progressPath = "$blobPath.progress.json"
    $blobUrl = "https://registry.ollama.ai/v2/library/$Model/blobs/$digest"

    $needDownload = $true
    if ((Test-Path $blobPath) -and -not (Test-Path $progressPath)) {
        $curLen = (Get-Item $blobPath).Length
        if ($curLen -eq $expectedSize) {
            $curHash = (Get-FileHash -Path $blobPath -Algorithm SHA256).Hash.ToUpperInvariant()
            if ($curHash -eq $expectedHash) {
                Write-Output "[FastPull] 已存在完整且 SHA-256 吻合之 Blob: $blobName ($expectedSize bytes)"
                $needDownload = $false
            } else {
                Write-Output "[FastPull] 警告：既存 Blob 雜湊值不符 ($curHash != $expectedHash)，將重新下載..."
                Remove-Item $blobPath -Force -ErrorAction SilentlyContinue
            }
        }
    }

    if ($needDownload) {
        $mb = [math]::Round($expectedSize / 1MB, 1)
        $usedParallelOk = $false

        if ($expectedSize -gt $parallelThresholdBytes) {
            Write-Output "[FastPull] 啟動 4 連線平行 HTTP Range 下載 $blobName ($mb MB)..."
            [void][PullAwakeHelper]::SetThreadExecutionState([uint32]2147483649)
            $parallelExit = Invoke-ParallelRangeDownload -Url $blobUrl -OutPath $blobPath -ExpectedSize $expectedSize -Digest $digest
            if ($parallelExit -eq 0) {
                $usedParallelOk = $true
            } elseif ($parallelExit -eq 5) {
                Write-Output "[FastPull] SHA-256 校驗失敗，清除毀損檔案後改用單執行緒 curl.exe 重新下載..."
                if (Test-Path $progressPath) { Remove-Item $progressPath -Force -ErrorAction SilentlyContinue }
                if (Test-Path $blobPath) { Remove-Item $blobPath -Force -ErrorAction SilentlyContinue }
            } elseif (Test-Path $progressPath) {
                throw "平行下載中斷 (exit=$parallelExit)，續傳進度已保留於 $progressPath ，請重新執行以從斷點接續。"
            } else {
                Write-Output "[FastPull] 平行下載未完成 (exit=$parallelExit)，降級為單執行緒 curl.exe 續傳..."
                if (Test-Path $blobPath) { Remove-Item $blobPath -Force -ErrorAction SilentlyContinue }
            }
        }

        if (-not $usedParallelOk) {
            Write-Output "[FastPull] 開始單執行緒下載 $blobName ($mb MB)..."
            for ($attempt = 1; $attempt -le 5; $attempt++) {
                [void][PullAwakeHelper]::SetThreadExecutionState([uint32]2147483649)
                curl.exe -fL -C - --retry 5 --retry-delay 3 --speed-time 30 --speed-limit 1024 -o $blobPath $blobUrl
                if ($LASTEXITCODE -eq 0 -and (Test-Path $blobPath) -and ((Get-Item $blobPath).Length -eq $expectedSize)) {
                    break
                }
                Write-Output "[FastPull] 第 $attempt 次嘗試未完成，3 秒後斷點續傳..."
                Start-Sleep -Seconds 3
            }
            if ((Test-Path $blobPath) -and ((Get-Item $blobPath).Length -eq $expectedSize)) {
                $curHash = (Get-FileHash -Path $blobPath -Algorithm SHA256).Hash.ToUpperInvariant()
                if ($curHash -ne $expectedHash) {
                    Remove-Item $blobPath -Force -ErrorAction SilentlyContinue
                    throw "Blob $blobName 單執行緒下載後 SHA-256 不符 ($curHash != $expectedHash)"
                }
            }
        }

        $actualLen = if (Test-Path $blobPath) { (Get-Item $blobPath).Length } else { -1 }
        if ($actualLen -ne $expectedSize) {
            throw "Blob $blobName 大小不符 (expected=$expectedSize, actual=$actualLen)"
        }
        Write-Output "[FastPull] 下載與 SHA-256 校驗完成: $blobName"
    }
}

$ollamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path $ollamaExe)) { $ollamaExe = 'ollama' }

Write-Output "[FastPull] 註冊模型至 Ollama ($Model`:$Tag)..."
& $ollamaExe pull "$Model`:$Tag"
Write-Output "[FastPull] 完成！模型已註冊於 $modelsDir"
