#!/usr/bin/env bash
# Installazione di ideax su Linux (GPU NVIDIA) o macOS (Apple Silicon).
set -e
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Installa Node.js 18+ da https://nodejs.org"; exit 1; }
command -v python3 >/dev/null || { echo "Installa Python 3.10+"; exit 1; }
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
if [ "$(uname)" = "Darwin" ]; then
  pip install torch
else
  pip install torch --index-url https://download.pytorch.org/whl/cu124
fi
pip install -r worker/requirements.txt
echo "Fatto. Avvia ideax con ./start.sh"
