@echo off
rem Daily router report for dsh-model-router. Called by Windows Task Scheduler.
rem Output: reports\latest.md plus a log line in reports\daily.log (zero tokens).
setlocal
cd /d "%~dp0.."
mkdir "%~dp0..\reports" 2>nul

set "NODE_BIN="
if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"
if not defined NODE_BIN if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_BIN=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_BIN if exist "C:\Users\kongy\.agent-reach\tools\node\node.exe" set "NODE_BIN=C:\Users\kongy\.agent-reach\tools\node\node.exe"
if not defined NODE_BIN set "NODE_BIN=node"

"%NODE_BIN%" "%~dp0router-report.mjs" --hours 24 >> "%~dp0..\reports\daily.log" 2>&1
exit /b %errorlevel%
