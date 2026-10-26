@echo off
rem ============================================================
rem  Cloudport City - launcher
rem  Double-click this file. It bypasses the PowerShell script
rem  execution policy for this run only, then starts Vite.
rem  Open http://localhost:5173 in Chrome or Edge afterwards.
rem ============================================================
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set EXITCODE=%ERRORLEVEL%

echo.
if not "%EXITCODE%"=="0" (
  echo Launcher exited with code %EXITCODE%.
) else (
  echo Server stopped.
)
pause
