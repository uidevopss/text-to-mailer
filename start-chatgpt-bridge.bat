@echo off
setlocal
cd /d "%~dp0"
echo.
echo ================================================
echo Text-to-Mailer Ai Bridge V18 - Microsoft Edge
echo ================================================
echo.
if not exist node_modules (
  echo Installing dependencies for first run...
  npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Make sure Node.js 18+ is installed.
    pause
    exit /b 1
  )
)
echo.
echo Starting bridge at http://127.0.0.1:3210/
echo Health check: http://127.0.0.1:3210/health
echo.
node server.js
pause
