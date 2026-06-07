@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed or not in PATH.
  echo Please install Node.js first, then double-click this file again.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not installed or not in PATH.
  echo Please install Node.js with npm first, then double-click this file again.
  pause
  exit /b 1
)

if not exist "server\node_modules\express" (
  echo Installing backend dependencies. This is only needed the first time...
  pushd server
  call npm install
  if errorlevel 1 (
    echo.
    echo Dependency installation failed.
    pause
    exit /b 1
  )
  popd
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if errorlevel 1 (
  start "homepage-backend" /min cmd /c "pushd ""%~dp0server"" && node server.js"
  timeout /t 2 /nobreak >nul
)

start "" "%~dp0index.html"
exit /b 0
