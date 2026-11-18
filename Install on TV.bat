@echo off
title SkyBlock Dashboard - install on LG TV
cd /d "%~dp0"

set "NODE=node"
if exist "%~dp0node.exe" set "NODE=%~dp0node.exe"
if not exist "%~dp0node.exe" (
  where node >nul 2>&1
  if errorlevel 1 (
    echo Node.js was not found on this computer.
    echo Install it from https://nodejs.org  ^(free LTS installer^), then run this again.
    echo.
    pause
    exit /b 1
  )
)

"%NODE%" tv\install-tv.js %*
echo.
pause
