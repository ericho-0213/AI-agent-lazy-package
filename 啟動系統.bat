@echo off
chcp 65001 >nul
set "WORK_DIR=%~dp0"
if "%WORK_DIR:~-1%"=="\" set "WORK_DIR=%WORK_DIR:~0,-1%"
cd /d "%WORK_DIR%"

for %%I in ("%WORK_DIR%\..") do set "ROOT_DRIVE=%%~dI"
if not defined OLLAMA_MODELS set "OLLAMA_MODELS=%ROOT_DRIVE%\OllamaModels"
if not exist "%OLLAMA_MODELS%" mkdir "%OLLAMA_MODELS%"

echo [Mini-Antigravity] WORK_DIR=%WORK_DIR%
echo [Mini-Antigravity] OLLAMA_MODELS=%OLLAMA_MODELS%

set "OLLAMA_EXE="
where ollama >nul 2>nul && set "OLLAMA_EXE=ollama"
if not defined OLLAMA_EXE if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"

netstat -ano | findstr ":11434 " | findstr "LISTENING" >nul
if errorlevel 1 (
    if defined OLLAMA_EXE (
        echo [Mini-Antigravity] Starting Ollama Engine...
        start "Ollama Engine" /MIN "%OLLAMA_EXE%" serve
        timeout /t 2 >nul
    ) else (
        echo [WARNING] Ollama executable not found.
    )
)

echo [Mini-Antigravity] Starting Web Server on http://localhost:8790 ...
node "%WORK_DIR%\server\server.js"
pause
