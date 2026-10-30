#!/usr/bin/env bash
# Avvia ideax (Linux/macOS). ideax avvia da solo il worker Python se trova .venv (creato da install.sh).
cd "$(dirname "$0")"
IDEAX_OPEN=1 exec node server.js
