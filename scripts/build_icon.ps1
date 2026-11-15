<#
.SYNOPSIS
    為 Mini-Antigravity 本機自主 AI Agent 中樞建立微軟純 DIB 格式 ICO 圖示與桌面/目錄捷徑
#>
$ErrorActionPreference = 'Stop'

$workDir = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$icoHelper = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.gemini\config\skills\windows-app-icon-craft\scripts\ico_builder.ps1'

if (-not (Test-Path $icoHelper)) {
    throw "找不到 windows-app-icon-craft 工具腳本: $icoHelper"
}

. $icoHelper
Add-Type -AssemblyName System.Drawing

function New-AgentBrainBitmap {
    param([int]$Size)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $pad = [Math]::Max(1, [int]($Size * 0.06))
    $rect = New-Object System.Drawing.Rectangle($pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad))

    # 深藍科技圓角矩形底板
    $radius = [Math]::Max(3, [int]($Size * 0.22))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        (New-Object System.Drawing.Point(0, 0)),
        (New-Object System.Drawing.Point($Size, $Size)),
        [System.Drawing.Color]::FromArgb(255, 11, 27, 56),
        [System.Drawing.Color]::FromArgb(255, 37, 99, 235)
    )
    $g.FillPath($grad, $path)

    # 青色發光邊框
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(240, 56, 189, 248), [Math]::Max(1.0, $Size * 0.045))
    $g.DrawPath($borderPen, $path)

    # 晶片外框與引腳
    $chipSize = [int]($Size * 0.46)
    $chipX = [int](($Size - $chipSize) / 2)
    $chipY = [int](($Size - $chipSize) / 2)
    $pinPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(220, 125, 211, 252), [Math]::Max(1.0, $Size * 0.04))
    $pinLen = [Math]::Max(2, [int]($Size * 0.1))
    foreach ($offset in @(0.28, 0.50, 0.72)) {
        $px = [int]($chipX + $chipSize * $offset)
        $py = [int]($chipY + $chipSize * $offset)
        $g.DrawLine($pinPen, $px, $chipY - $pinLen, $px, $chipY)
        $g.DrawLine($pinPen, $px, $chipY + $chipSize, $px, $chipY + $chipSize + $pinLen)
        $g.DrawLine($pinPen, $chipX - $pinLen, $py, $chipX, $py)
        $g.DrawLine($pinPen, $chipX + $chipSize, $py, $chipX + $chipSize + $pinLen, $py)
    }

    $chipBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(230, 15, 23, 42))
    $g.FillRectangle($chipBrush, $chipX, $chipY, $chipSize, $chipSize)
    $g.DrawRectangle($borderPen, $chipX, $chipY, $chipSize, $chipSize)

    # 中央金色閃電核心 (Agent 自主能量)
    $boltPts = [System.Drawing.PointF[]]@(
        [System.Drawing.PointF]::new($Size * 0.54, $Size * 0.28),
        [System.Drawing.PointF]::new($Size * 0.39, $Size * 0.53),
        [System.Drawing.PointF]::new($Size * 0.50, $Size * 0.53),
        [System.Drawing.PointF]::new($Size * 0.45, $Size * 0.73),
        [System.Drawing.PointF]::new($Size * 0.62, $Size * 0.47),
        [System.Drawing.PointF]::new($Size * 0.51, $Size * 0.47)
    )
    $boltBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 251, 191, 36))
    $g.FillPolygon($boltBrush, $boltPts)

    $g.Dispose()
    return $bmp
}

$sizes = @(16, 32, 48, 64)
$bitmaps = @()
foreach ($sz in $sizes) {
    $bitmaps += (New-AgentBrainBitmap -Size $sz)
}

$runtimeIco = Join-Path $workDir 'runtime\ai_agent.ico'
$cacheDir = Join-Path $env:LOCALAPPDATA 'AI-Agent-Cache'
$cacheIco = Join-Path $cacheDir 'ai_agent.ico'

Save-WindowsDIBIco -Bitmaps $bitmaps -OutputPath $runtimeIco
Save-WindowsDIBIco -Bitmaps $bitmaps -OutputPath $cacheIco

foreach ($b in $bitmaps) { $b.Dispose() }

$vbsPath = Join-Path $workDir '啟動系統(無黑窗背景執行).vbs'
$desktopDir = [Environment]::GetFolderPath('Desktop')
$iconLoc = '%LOCALAPPDATA%\AI-Agent-Cache\ai_agent.ico'

$shortcutWork = Join-Path $workDir 'Mini-Antigravity AI Agent.lnk'
$shortcutDesktop = Join-Path $desktopDir 'Mini-Antigravity AI Agent.lnk'

New-StandardAppShortcut -ShortcutPath $shortcutWork -TargetPath 'wscript.exe' -Arguments "`"$vbsPath`"" -WorkingDirectory $workDir -IconPath $iconLoc -Description 'Mini-Antigravity 本機自主 AI Agent 中樞'
New-StandardAppShortcut -ShortcutPath $shortcutDesktop -TargetPath 'wscript.exe' -Arguments "`"$vbsPath`"" -WorkingDirectory $workDir -IconPath $iconLoc -Description 'Mini-Antigravity 本機自主 AI Agent 中樞'
Refresh-WindowsIconCache

Write-Output "ICO_CREATED: $runtimeIco"
Write-Output "CACHE_ICO: $cacheIco"
Write-Output "SHORTCUT_WORK: $shortcutWork"
Write-Output "SHORTCUT_DESKTOP: $shortcutDesktop"
