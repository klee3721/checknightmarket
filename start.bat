@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai thu vien lan dau...
  call npm install
  if errorlevel 1 (
    echo Cai thu vien that bai.
    pause
    exit /b 1
  )
)
start "Night Market Checker Server" /D "%~dp0" cmd /k npm start
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:3210"
