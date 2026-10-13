@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or newer is required.
  pause
  exit /b 1
)
if not exist node_modules\stripe\package.json (
  call npm ci --no-audit --no-fund
  if errorlevel 1 exit /b 1
)
call npm start
pause
