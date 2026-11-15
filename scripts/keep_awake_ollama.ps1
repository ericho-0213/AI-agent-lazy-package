<#
.SYNOPSIS
    背景防系統休眠守護 + Ollama 本機服務啟動器
    (允許螢幕依電源計畫關閉省電，但保持系統與網路持續連線不被 Modern Standby 暫停)
#>
$ErrorActionPreference = 'Continue'
$workDir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$rootDrive = Split-Path -Qualifier $workDir
if (-not $rootDrive) { $rootDrive = 'D:' }

$modelsDir = if ($env:OLLAMA_MODELS) { $env:OLLAMA_MODELS } else { Join-Path $rootDrive 'OllamaModels' }
New-Item -ItemType Directory -Force -Path $modelsDir | Out-Null
$env:OLLAMA_MODELS = $modelsDir

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PowerAwakeHelper {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
}
'@ -ErrorAction SilentlyContinue

# ES_CONTINUOUS (0x80000000) | ES_SYSTEM_REQUIRED (0x00000001)
$ES_SYSTEM_CONTINUOUS = [uint32]2147483649
[void][PowerAwakeHelper]::SetThreadExecutionState($ES_SYSTEM_CONTINUOUS)

$ollamaExe = Join-Path $env:LOCALAPPDATA 'Programs\Ollama\ollama.exe'
if (-not (Test-Path $ollamaExe)) {
    $cmd = Get-Command ollama -ErrorAction SilentlyContinue
    if ($cmd) { $ollamaExe = $cmd.Source }
}
if (-not (Test-Path $ollamaExe)) {
    throw "找不到 ollama.exe"
}

Write-Output "[Awake-Guard] ES_CONTINUOUS | ES_SYSTEM_REQUIRED 已啟用"
Write-Output "[Awake-Guard] OLLAMA_MODELS=$modelsDir"
Write-Output "[Awake-Guard] 啟動 Ollama Serve (127.0.0.1:11434)..."

$proc = Start-Process -FilePath $ollamaExe -ArgumentList 'serve' -NoNewWindow -PassThru
while (-not $proc.HasExited) {
    [void][PowerAwakeHelper]::SetThreadExecutionState($ES_SYSTEM_CONTINUOUS)
    Start-Sleep -Seconds 30
}
