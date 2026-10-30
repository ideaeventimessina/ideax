"""Gemello video: LatentSync (ByteDance, Apache 2.0) muove le labbra di un tuo video vero sulla voce nuova.

Tu registri una volta un video di base (viso frontale, 10-60 secondi); per ogni testo ideax genera la voce
con il tuo clone e questo server rifà le labbra del video su quell'audio. Se l'audio è più lungo,
LatentSync ripete il video avanti e indietro.
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=7874)
parser.add_argument("--app", required=True, help="cartella di LatentSync")
parser.add_argument("--config", default="configs/unet/stage2.yaml")
args = parser.parse_args()
APP = Path(args.app)

app = FastAPI()
lock = threading.Lock()
state: dict = {"step": 0, "total": 0, "phase": None, "log": []}
proc: Optional[subprocess.Popen] = None
cancelled = False
STEP = re.compile(r"(\d+)/(\d+) \[")


class LipsyncRequest(BaseModel):
    video: str
    audio: str
    out: str
    steps: int = 20
    guidance: float = 1.5
    seed: int = 1247


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/lipsync")
def lipsync(req: LipsyncRequest):
    global proc, cancelled
    for p in (req.video, req.audio):
        if not Path(p).is_file():
            raise HTTPException(400, f"File non trovato: {p}")
    if not lock.acquire(blocking=False):
        raise HTTPException(409, "Sto già lavorando a un altro video")
    try:
        cancelled = False
        state.update(step=0, total=0, phase="Carico il modello", log=[])
        started = time.time()
        cmd = [sys.executable, "-m", "scripts.inference",
               "--unet_config_path", args.config, "--inference_ckpt_path", "checkpoints/latentsync_unet.pt",
               "--inference_steps", str(req.steps), "--guidance_scale", str(req.guidance), "--enable_deepcache",
               "--seed", str(req.seed), "--video_path", req.video, "--audio_path", req.audio, "--video_out_path", req.out]
        proc = subprocess.Popen(cmd, cwd=APP, env={**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"},
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
        buf = ""
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in "\r\n":
                if buf:
                    m = STEP.search(buf)
                    if m:
                        state.update(step=int(m.group(1)), total=int(m.group(2)), phase="Muovo le labbra")
                    elif "affine" in buf.lower() or "face" in buf.lower():
                        state["phase"] = "Trovo il viso nel video"
                    state["log"].append(buf[-300:])
                    del state["log"][:-40]
                buf = ""
            else:
                buf += ch
        code = proc.wait()
        if cancelled:
            raise HTTPException(499, "Annullato")
        if code != 0 or not Path(req.out).is_file():
            raise HTTPException(500, f"LatentSync non è riuscito (codice {code}): {' · '.join(state['log'][-3:])}")
        return {"out": req.out, "elapsed": round(time.time() - started, 1)}
    finally:
        proc = None
        state["phase"] = None
        lock.release()


@app.get("/progress")
def progress():
    return {k: state[k] for k in ("step", "total", "phase")}


@app.post("/cancel")
def cancel():
    global cancelled
    if proc:
        cancelled = True
        proc.kill()
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
