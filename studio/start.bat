@echo off
rem AI Studio launcher (Windows). Keep this file ASCII-only: cmd.exe can mis-read UTF-8 text in .bat files.
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [AI Studio] Node.js 20+ is required. Download: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo [AI Studio] Installing packages, please wait...
  call npm install
  if errorlevel 1 (
    echo [AI Studio] npm install failed. See the messages above.
    pause
    exit /b 1
  )
)
start "" http://127.0.0.1:8790
call npm start
echo.
echo [AI Studio] The server has stopped. See the messages above if this was unexpected.
pause
