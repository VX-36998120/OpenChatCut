@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo OpenChatCut Windows x64 installer builder
echo.

if not exist "package.json" (
  echo ERROR: Run this file from the OpenChatCut source folder.
  goto :fail
)

where node >nul 2>&1
if errorlevel 1 (
  echo ERROR: Node.js 24.x x64 is required. Install it, then reopen this window.
  goto :fail
)

where npm >nul 2>&1
if errorlevel 1 (
  echo ERROR: npm was not found. Reinstall Node.js 24.x x64 with npm enabled.
  goto :fail
)

node -e "if (process.platform !== 'win32' || !process.versions.node.startsWith('24.') || process.arch !== 'x64') { console.error('ERROR: This build needs Node.js 24.x x64 on Windows. Current: ' + process.platform + ' ' + process.arch + ' Node ' + process.versions.node); process.exit(1); }"
if errorlevel 1 goto :fail

set "ONNXRUNTIME_NODE_INSTALL=skip"

echo [1/3] Installing locked dependencies...
call npm ci --no-audit --no-fund
if errorlevel 1 goto :fail

echo.
echo [2/3] Building the Windows x64 installer...
call npm run desktop:dist:win
if errorlevel 1 goto :fail

echo.
echo [3/3] Checking packaged export components and AAC encoding...
node scripts\windows-export-runtime.verify.mjs
if errorlevel 1 goto :fail

for /f "delims=" %%V in ('node -p "require('./package.json').version"') do set "INSTALLER=release\OpenChatCut-%%V-x64.exe"

echo.
echo Build complete:
echo %INSTALLER%
echo This script only creates a local installer. It does not publish a GitHub Release.
pause
exit /b 0

:fail
set "BUILD_EXIT_CODE=%ERRORLEVEL%"
if "%BUILD_EXIT_CODE%"=="0" set "BUILD_EXIT_CODE=1"
echo.
echo Build failed. Review the error above; no installer is confirmed.
pause
exit /b %BUILD_EXIT_CODE%
