@echo off
title SkyBlock Dashboard - refreshing data
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is not installed. Get the free LTS installer from https://nodejs.org
  echo then run this file again.
  pause
  exit /b 1
)
echo Refreshing SkyBlock data...
node fetch-data.js
if errorlevel 1 (
  echo.
  echo Something went wrong - see the message above.
  echo The dashboard will still open and show the error details.
  timeout /t 5 >nul
)
start "" "%~dp0dashboard.html"
