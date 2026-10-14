@echo off
title TrainTrack - Training Management System
echo.
echo  ==========================================
echo   TrainTrack - Employee Training System
echo  ==========================================
echo.
echo  Starting server...
cd /d "%~dp0"
echo  Open your browser to: http://localhost:3000
echo  Login: admin / admin123
echo.
echo  Press Ctrl+C to stop the server.
echo.
node server.js
pause
