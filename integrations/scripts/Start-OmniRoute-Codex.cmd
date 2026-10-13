@echo off
setlocal
cd /d "%~dp0\..\.."
if not defined OMNIROUTE_API_KEY (
  echo Configure the OmniRoute gateway key securely in this terminal environment first.
  exit /b 1
)
node integrations\scripts\check-mcp.mjs
if errorlevel 1 (
  echo Gateway MCP not connected. Start OmniRoute and enable its MCP transport first.
  exit /b 1
)
codex --profile omniroute
