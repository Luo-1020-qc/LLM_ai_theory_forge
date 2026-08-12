@echo off
setlocal
title AI Theory Forge Practice Dashboard
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto :no_node

echo.
echo Starting AI Theory Forge local practice dashboard...
echo Your browser will open automatically. Press Ctrl+C here to stop.
echo.
node "%~dp0local_server.mjs" %*
if errorlevel 1 goto :failed
exit /b 0

:no_node
echo.
echo Node.js was not found.
echo Install Node.js 22 or newer from https://nodejs.org/ and try again.
echo.
pause
exit /b 1

:failed
echo.
echo The dashboard could not start. Keep this window open to read the error.
pause
exit /b 1
