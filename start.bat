@echo off
cd /d %~dp0
start "ideax worker" cmd /k ".venv\Scripts\python.exe worker\server.py"
start "ideax" cmd /k "node server.js"
timeout /t 3 >nul
start http://localhost:7800
