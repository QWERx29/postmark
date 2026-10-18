@echo off
rem ============================================================
rem  Postmark launcher
rem ------------------------------------------------------------
rem  Starts the browser mode (local server + Chrome app window).
rem
rem  This entry point used to launch the Electron shell
rem  (scripts/start.js). Electron is no longer the primary shell.
rem
rem  Why the change: the Electron path's failure fallback passed
rem  --no-sandbox to Chromium. Under a restricted token the
rem  sandbox is what makes the window fail to appear in the first
rem  place, so that fallback both weakened the browser sandbox and
rem  did not reliably fix the symptom.
rem
rem  NOTE: this file deliberately stays pure ASCII and calls node
rem  directly instead of chaining to the other launcher. cmd.exe
rem  reads .cmd files using the console code page (GBK on a
rem  Chinese Windows), so a Chinese filename on a `call` line can
rem  be mis-decoded - and a file written as UTF-8 would make every
rem  comment above unreadable too. No non-ASCII bytes, no problem.
rem
rem  The Electron shell is still available for debugging:
rem    npm run start:electron
rem  (it reads %APPDATA%\postmark-system, not data\browser-chrome)
rem ============================================================
setlocal
cd /d "%~dp0"
title Postmark

echo ============================================================
echo  Postmark  -  browser mode
echo  dir: %CD%
echo.
echo  Electron shell (debug only): npm run start:electron
echo  note: it uses a DIFFERENT profile - %APPDATA%\postmark-system
echo ============================================================
echo.

where node >nul 2>&1
if not %ERRORLEVEL%==0 goto nonode

node launch.js %*
echo.
echo [info] launch.js exited with code %ERRORLEVEL%
echo.
pause
exit /b 0

:nonode
echo [ERROR] node not found in PATH.
echo         Install Node.js, then run "npm install" in this folder.
echo.
pause
exit /b 1
