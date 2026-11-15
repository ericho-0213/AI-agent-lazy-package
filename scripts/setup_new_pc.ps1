<#
.SYNOPSIS
    新電腦一鍵部署 Mini-Antigravity 本機自主 AI Agent 中樞
    自動完成：OLLAMA_MODELS 設定 -> npm install -> Ollama 檢核/安裝 -> 模型斷點續傳 -> Local SD-LCM 部署 -> ICO 快取與桌面捷徑 -> 啟動服務與全端驗證
#>
param(
    [string]$Model = 'qwen2.5:3b',
    [switch]$SkipPull,
    [switch]$SkipSd,
    [switch]$SkipVerify
)

$ErrorActionPreference = 'Stop'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom

$workDir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
Set-Location $workDir

function Write-Step {
    param([string]$Title)
    Write-Output ""
    Write-Output "=================================================="
    Write-Output "[Setup] $Title"
    Write-Output "=================================================="
}

function Find-OllamaExe {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'),
        'C:\Program Files\Ollama\ollama.exe'
    )
    foreach ($p in $candidates) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    return $null
}

# 1. 基礎環境檢查 (Node.js / npm)
Write-Step "1/7 檢查 Node.js 與專案工作目錄 ($workDir)"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "找不到 node.exe，請先安裝 Node.js v18 以上版本後再執行本腳本。"
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "找不到 npm，請確認 Node.js 安裝完整。"
}
Write-Output ("Node 版本: " + (& node -v))

# 2. 動態設定模型儲存目錄 (優先固定磁碟 D:\OllamaModels，保護 C 槽)
Write-Step "2/7 配置非系統槽模型存放路徑 (OLLAMA_MODELS)"
$rootDrive = Split-Path -Qualifier $workDir
if (-not $rootDrive) { $rootDrive = 'C:' }

$hasWritableD = $false
try {
    $dDrive = [System.IO.DriveInfo]::new('D')
    if ($dDrive.IsReady -and $dDrive.DriveType -eq [System.IO.DriveType]::Fixed) {
        $hasWritableD = $true
    }
} catch {}

$fallbackModelsDir = Join-Path $rootDrive 'OllamaModels'
$preferredDir = if ($hasWritableD) { 'D:\OllamaModels' } else { $fallbackModelsDir }
$modelsDir = if ($env:OLLAMA_MODELS -and $env:OLLAMA_MODELS.Trim()) { $env:OLLAMA_MODELS.Trim() } else { $preferredDir }

New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$env:OLLAMA_MODELS = $modelsDir
[Environment]::SetEnvironmentVariable('OLLAMA_MODELS', $modelsDir, 'User')
Write-Output "OLLAMA_MODELS 已設定為: $modelsDir"

# 3. 安裝 Node.js 相依套件
Write-Step "3/7 安裝 Node.js 專案相依套件 (npm install)"
if (-not (Test-Path (Join-Path $workDir 'node_modules'))) {
    & npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install 失敗 (exit=$LASTEXITCODE)" }
} else {
    Write-Output "已偵測到 node_modules，略過重複安裝。"
}

# 4. 檢查與安裝 Ollama 引擎並確保 Port 11434 運行
Write-Step "4/7 檢查與啟動 Ollama 本機 LLM 引擎"
$ollamaExe = Find-OllamaExe
if (-not $ollamaExe) {
    $setupPath = Join-Path $env:TEMP 'OllamaSetup.exe'
    Write-Output "未偵測到 Ollama，正在從官方下載 OllamaSetup.exe..."
    & curl.exe -fL --retry 3 -o $setupPath 'https://ollama.com/download/OllamaSetup.exe'
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $setupPath)) {
        throw "無法下載 OllamaSetup.exe，請手動安裝 Ollama 後重新執行本腳本。"
    }
    Write-Output "正在靜默安裝 Ollama..."
    $instProc = Start-Process -FilePath $setupPath -ArgumentList '/SILENT' -Wait -PassThru
    if ($instProc.ExitCode -ne 0) {
        throw "Ollama 安裝回傳非零退出碼: $($instProc.ExitCode)"
    }
    Start-Sleep -Seconds 3
    $ollamaExe = Find-OllamaExe
    if (-not $ollamaExe) {
        throw "安裝後仍找不到 ollama.exe，請重新開啟終端機再試。"
    }
}
Write-Output "已找到 Ollama: $ollamaExe"

$ollamaListening = Get-NetTCPConnection -LocalPort 11434 -State Listen -ErrorAction SilentlyContinue
if (-not $ollamaListening) {
    Write-Output "正在背景啟動 Ollama Serve (127.0.0.1:11434)..."
    Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-RestMethod -Uri 'http://127.0.0.1:11434/api/tags' -TimeoutSec 2
            if ($resp) { break }
        } catch {}
    }
}

# 5. 4 連線斷點續傳拉取主力模型
if (-not $SkipPull) {
    Write-Step "5/7 4 連線平行斷點續傳拉取主力模型 ($Model)"
    $fastPull = Join-Path $workDir 'scripts\fast_pull_ollama.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $fastPull -Model $Model
    if ($LASTEXITCODE -ne 0) { throw "fast_pull_ollama.ps1 執行失敗 (exit=$LASTEXITCODE)" }
} else {
    Write-Step "5/7 略過模型拉取 (-SkipPull)"
}

# 6. 部署本機離線無限制生圖引擎 Local SD-LCM
if (-not $SkipSd) {
    Write-Step "6/7 部署本機無限制寫實生圖引擎 Local SD-LCM"
    $installSd = Join-Path $workDir 'scripts\install_local_sd.ps1'
    & powershell -NoProfile -ExecutionPolicy Bypass -File $installSd
    if ($LASTEXITCODE -ne 0) { throw "install_local_sd.ps1 執行失敗 (exit=$LASTEXITCODE)" }
} else {
    Write-Step "6/7 略過 Local SD-LCM 部署 (-SkipSd)"
}

# 7. 快取純 DIB 圖示、建立桌面捷徑、啟動 8790 服務並驗收
Write-Step "7/7 建立圖示快取、桌面捷徑並啟動戰情室 (http://localhost:8790)"
$cacheDir = Join-Path $env:LOCALAPPDATA 'AI-Agent-Cache'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
$srcIco = Join-Path $workDir 'runtime\ai_agent.ico'
$dstIco = Join-Path $cacheDir 'ai_agent.ico'
if (Test-Path $srcIco) {
    Copy-Item -Path $srcIco -Destination $dstIco -Force
    Write-Output "純 DIB 圖示已快取至: $dstIco"
}

$vbsPath = Join-Path $workDir '啟動系統(無黑窗背景執行).vbs'
$desktopDir = [Environment]::GetFolderPath('Desktop')
$ws = New-Object -ComObject WScript.Shell
foreach ($lnkTargetDir in @($workDir, $desktopDir)) {
    if ($lnkTargetDir -and (Test-Path $lnkTargetDir)) {
        $lnkPath = Join-Path $lnkTargetDir 'Mini-Antigravity AI Agent.lnk'
        $sc = $ws.CreateShortcut($lnkPath)
        $sc.TargetPath = 'wscript.exe'
        $sc.Arguments = "`"$vbsPath`""
        $sc.WorkingDirectory = $workDir
        $sc.IconLocation = '%LOCALAPPDATA%\AI-Agent-Cache\ai_agent.ico,0'
        $sc.Description = 'Mini-Antigravity 本機自主 AI Agent 中樞'
        $sc.Save()
        Write-Output "已建立啟動捷徑: $lnkPath"
    }
}

$webListening = Get-NetTCPConnection -LocalPort 8790 -State Listen -ErrorAction SilentlyContinue
if (-not $webListening) {
    $logsDir = Join-Path $workDir 'logs'
    New-Item -ItemType Directory -Force -Path $logsDir | Out-Null
    Write-Output "正在背景啟動 Mini-Antigravity 戰情室服務 (Port 8790)..."
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c cd /d `"$workDir`" && set `"OLLAMA_MODELS=$modelsDir`" && node `"server\server.js`" > `"logs\server.log`" 2>&1" -WindowStyle Hidden | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 400
        try {
            $st = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/api/status' -TimeoutSec 2
            if ($st.success) { break }
        } catch {}
    }
}

if (-not $SkipVerify) {
    Write-Output "正在執行全端自動化驗證 (node scripts/verify.js)..."
    & node (Join-Path $workDir 'scripts\verify.js')
    if ($LASTEXITCODE -ne 0) { throw "verify.js 驗證未全數通過 (exit=$LASTEXITCODE)" }
}

Write-Output ""
Write-Output "✅ Mini-Antigravity 本機自主 AI Agent 部署完成！請開啟 http://localhost:8790 或雙擊桌面捷徑使用。"
