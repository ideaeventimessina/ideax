#!/usr/bin/env bash
cd "$(dirname "$0")"
.venv/bin/python worker/server.py &
WORKER=$!
trap 'kill $WORKER 2>/dev/null' EXIT
node server.js
