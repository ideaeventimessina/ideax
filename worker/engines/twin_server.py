"""Gemello foto: addestra una LoRA del tuo viso su FLUX.1-dev con ai-toolkit (ostris), sul tuo PC.

ideax manda le foto (15-30, viso ben visibile, luci e sfondi diversi), il server prepara il dataset e la
configurazione per una scheda da 16 GB (modello quantizzato a 8 bit, poca memoria) e lancia l'addestramento
di ai-toolkit in un processo separato. Il risultato è un file .safetensors che ideax mette tra le LoRA.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
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
parser.add_argument("--port", type=int, default=7873)
parser.add_argument("--app", required=True, help="cartella di ai-toolkit")
parser.add_argument("--work", required=True, help="cartella dei dati di addestramento")
args = parser.parse_args()
APP = Path(args.app)
WORK = Path(args.work)

app = FastAPI()
state: dict = {"status": "idle", "step": 0, "total": 0, "phase": None, "log": [], "output": None, "error": None, "name": None}
proc: Optional[subprocess.Popen] = None
STEP = re.compile(r"(\d+)/(\d+) \[")


class TrainRequest(BaseModel):
    name: str
    trigger: str
    images: list[str]
    steps: int = 1600
    rank: int = 16
    lr: float = 1e-4
    low_vram: bool = True


def config_for(req: TrainRequest, dataset: Path, out: Path) -> dict:
    return {
        "job": "extension",
        "config": {
            "name": req.name,
            "process": [{
                "type": "sd_trainer",
                "training_folder": str(out),
                "device": "cuda:0",
                "trigger_word": req.trigger,
                "network": {"type": "lora", "linear": req.rank, "linear_alpha": req.rank},
                "save": {"dtype": "float16", "save_every": 400, "max_step_saves_to_keep": 2, "push_to_hub": False},
                "datasets": [{
                    "folder_path": str(dataset), "caption_ext": "txt", "caption_dropout_rate": 0.05,
                    "shuffle_tokens": False, "cache_latents_to_disk": True, "resolution": [512, 768, 1024],
                }],
                "train": {
                    "batch_size": 1, "steps": req.steps, "gradient_accumulation_steps": 1, "train_unet": True,
                    "train_text_encoder": False, "gradient_checkpointing": True, "noise_scheduler": "flowmatch",
                    "optimizer": "adamw8bit", "lr": req.lr, "ema_config": {"use_ema": True, "ema_decay": 0.99},
                    "dtype": "bf16", "disable_sampling": True, "skip_first_sample": True,
                },
                # 16 GB: trasformatore quantizzato a 8 bit e quantizzazione a pezzi (più lenta, ma ci sta)
                "model": {"name_or_path": "black-forest-labs/FLUX.1-dev", "is_flux": True, "quantize": True, "low_vram": req.low_vram},
                "sample": {"sampler": "flowmatch", "sample_every": 100000, "width": 1024, "height": 1024,
                           "prompts": [f"photo of {req.trigger}"], "neg": "", "seed": 42, "guidance_scale": 4, "sample_steps": 20},
            }],
        },
        "meta": {"name": req.name, "version": "1.0"},
    }


def log(line: str) -> None:
    line = line.rstrip()
    if not line:
        return
    state["log"].append(line[-300:])
    del state["log"][:-60]


def run(req: TrainRequest, cfg_path: Path, out: Path) -> None:
    global proc
    try:
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"}
        proc = subprocess.Popen([sys.executable, "run.py", str(cfg_path)], cwd=APP, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
        state["phase"] = "Preparo il modello (la prima volta scarica FLUX.1-dev, circa 30 GB)"
        buf = ""
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in "\r\n":
                if buf:
                    m = STEP.search(buf)
                    if m and int(m.group(2)) == req.steps:
                        state.update(step=int(m.group(1)), total=int(m.group(2)), phase="Addestro il gemello")
                    elif "cach" in buf.lower() and "latent" in buf.lower():
                        state["phase"] = "Preparo le foto"
                    log(buf)
                buf = ""
            else:
                buf += ch
        code = proc.wait()
        if state["status"] == "cancelled":
            return
        final = out / req.name / f"{req.name}.safetensors"
        if code != 0 or not final.exists():
            tail = " · ".join(state["log"][-3:])
            raise RuntimeError(f"addestramento terminato con codice {code}: {tail}")
        state.update(status="done", output=str(final), phase=None, step=req.steps)
    except Exception as err:  # noqa: BLE001
        if state["status"] != "cancelled":
            state.update(status="error", error=str(err), phase=None)
    finally:
        proc = None


@app.get("/health")
def health():
    return {"ok": True, "status": state["status"]}


@app.post("/train")
def train(req: TrainRequest):
    if state["status"] == "running":
        raise HTTPException(409, "Sto già addestrando un gemello")
    if len(req.images) < 8:
        raise HTTPException(400, "Servono almeno 8 foto (meglio 15-30)")
    if not re.fullmatch(r"[a-z0-9_]{2,40}", req.name):
        raise HTTPException(400, "Nome non valido")
    base = WORK / req.name
    dataset = base / "foto"
    out = base / "output"
    shutil.rmtree(dataset, ignore_errors=True)
    dataset.mkdir(parents=True)
    for i, src in enumerate(req.images):
        ext = Path(src).suffix.lower() or ".jpg"
        shutil.copyfile(src, dataset / f"{i:03d}{ext}")
        (dataset / f"{i:03d}.txt").write_text(f"photo of [trigger]", encoding="utf-8")
    cfg_path = base / "config.yaml"
    # Il JSON è YAML valido: niente dipendenze in più
    cfg_path.write_text(json.dumps(config_for(req, dataset, out), indent=2), encoding="utf-8")
    state.update(status="running", step=0, total=req.steps, phase="Avvio", log=[], output=None, error=None, name=req.name, started=time.time())
    threading.Thread(target=run, args=(req, cfg_path, out), daemon=True).start()
    return {"ok": True}


@app.get("/progress")
def progress():
    return {k: state.get(k) for k in ("status", "step", "total", "phase", "output", "error", "name", "started")} | {"log": state["log"][-8:]}


@app.post("/cancel")
def cancel():
    if proc and state["status"] == "running":
        state["status"] = "cancelled"
        proc.kill()
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
