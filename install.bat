@echo off
REM Installazione di ideax su Windows con GPU NVIDIA.
REM Serve: Python 3.10-3.12 e Node.js 18+ installati.
cd /d %~dp0
where node >nul 2>nul || (echo Installa Node.js da https://nodejs.org & pause & exit /b 1)
where python >nul 2>nul || (echo Installa Python da https://python.org & pause & exit /b 1)
if not exist .venv python -m venv .venv
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install torch --index-url https://download.pytorch.org/whl/cu124
pip install -r worker\requirements.txt
echo.
echo Fatto. Avvia ideax con start.bat
pause
