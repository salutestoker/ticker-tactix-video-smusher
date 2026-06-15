@echo off
setlocal

cd /d "%~dp0"

echo Starting Ticker Tactix Video Smusher...

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is not installed. Install Node.js from https://nodejs.org/ and run this file again.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo Installing app dependencies. This only needs to happen the first time.
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

echo.
echo The browser should open automatically. Keep this window open while using the app.
call npm start

echo.
pause
