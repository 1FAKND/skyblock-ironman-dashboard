@echo off
title SkyBlock Dashboard - refreshing data
cd /d "%~dp0"

rem Prefer a portable node.exe sitting next to this file (USB-stick mode),
rem otherwise use the Node.js installed on this computer.
set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
if not exist "%~dp0node.exe" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js was not found on this computer.
    echo.
    echo Option 1: install it from https://nodejs.org  ^(free LTS installer^)
    echo Option 2: portable use - download the Windows Binary ^(.zip^) from
    echo           https://nodejs.org/en/download , unzip it, and copy the
    echo           node.exe file into this folder next to this script.
    echo.
    pause
    exit /b 1
  )
)

echo Refreshing SkyBlock data...
"%NODE%" fetch-data.js
if errorlevel 1 (
  echo.
  echo Something went wrong - see the message above.
  echo The dashboard will still open and show the error details.
  timeout /t 5 >nul
)
start "" "%~dp0dashboard.html"
