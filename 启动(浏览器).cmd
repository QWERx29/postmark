@echo off
rem ============================================================
rem  Postmark launcher (browser mode)
rem ------------------------------------------------------------
rem  Starts the local server and opens the app in a dedicated
rem  Chrome app window. No Electron, no installer, no packaging.
rem
rem  Data lives in data\browser-chrome (its own profile), so the
rem  records stay untouched by your everyday browser.
rem
rem  Keep this file's console window open: it is the only place
rem  startup errors are reported.
rem ============================================================
setlocal
cd /d "%~dp0"
title Postmark (browser mode)

echo ============================================================
echo  Postmark  -  browser mode
echo  dir: %CD%
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
