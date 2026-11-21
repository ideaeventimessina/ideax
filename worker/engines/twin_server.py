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
parser.add_argument("--model", default="black-forest-labs/FLUX.1-dev", help="cartella locale di FLUX.1-dev (scaricata da ideax)")
args = parser.parse_args()
APP = Path(args.app)
WORK = Path(args.work)

app = FastAPI()
state: dict = {"status": "idle", "step": 0, "total": 0, "phase": None, "log": [], "output": None, "error": None, "name": None}
proc: Optional[subprocess.Popen] = None
training_lock = threading.Lock()
STEP = re.compile(r"(\d+)/(\d+) \[")
FASE_ADDESTRO = "Addestro il gemello"

# Cane da guardia: su una scheda da 16 GB FLUX può non entrare già nel CARICAMENTO (prima di addestrare) o strisciare
# in addestramento scaricando su disco; in tutt'e due i casi la barra resta ferma per ore senza un errore, perché lo
# stato avanza solo quando ai-toolkit stampa qualcosa — se si impianta, nessuno parla. Si ferma da soli se:
#   - PREPARAZIONE (passo 0): nessuna riga di log per troppo tempo. Qui niente è lungo per natura — il download vero di
#     FLUX lo fa ideax PRIMA, in un'altra fase; questo è solo caricamento dal disco, pochi minuti. Un silenzio lungo =
#     bloccato nel caricare il modello (quasi sempre memoria). Questo è il buco della prima versione: copriva solo...
#   - ADDESTRAMENTO: ...i passi, cronicamente lenti (stima oltre il tetto o oltre il secondi-a-passo), o congelati.
# Così, invece di dodici ore a 10% o un passo 0 eterno, si ferma in minuti dicendo COSA fare.
PASSO_LENTO_S = 120      # oltre 2 minuti a passo (sano < 10 s) è patologico
MIN_PASSI = 5            # servono alcuni passi prima di stimare, per saltare il riscaldamento
STIMA_CAP_H = 10         # se a questo ritmo non finisce entro 10 ore è di fatto morto; sotto resta una corsa lenta ma viva
SILENZIO_S = 1200        # 20 minuti senza avanzare di un passo (in addestramento) = bloccato
CARICAMENTO_FERMO_S = 600  # 10 minuti senza NESSUNA riga di log in preparazione = bloccato nel caricare il modello
VEGLIA_S = 30            # ogni quanto il cane da guardia controlla


def _ferma_bloccato(motivo: str) -> None:
    """Ferma un addestramento impiantato con un messaggio che dice cosa fare, non una barra che mente."""
    global proc
    if state["status"] != "running":
        return
    state.update(status="error", error=motivo, phase=None)
    p = proc
    if p:
        try:
            p.kill()
        except Exception:  # noqa: BLE001
            pass


def _cane_da_guardia(started: float) -> None:
    visto = 0           # ultimo passo visto avanzare
    visto_a = time.time()
    while state["status"] == "running" and state.get("started") == started:
        time.sleep(VEGLIA_S)
        if state.get("started") != started:
            return
        if state["status"] != "running":
            return
        now = time.time()
        if not state.get("train_started"):
            # PREPARAZIONE (passo 0): il modello si carica. Non ci sono fasi lunghe qui (il download di FLUX è altrove),
            # quindi un lungo silenzio nei log = bloccato nel caricare, quasi sempre per memoria sulla 16 GB.
            if state.get("log_at") and now - state["log_at"] > CARICAMENTO_FERMO_S:
                mins = int((now - state["log_at"]) / 60)
                _ferma_bloccato(
                    f"Bloccato nel preparare il modello da {mins} minuti, fermo al passo 0 senza un segnale: su una "
                    "scheda da 16 GB FLUX può non entrare già nel caricamento, prima ancora di addestrare. L'ho "
                    "annullato. Per il tuo gemello conviene SDXL: è molto più leggero e ci sta anche con i monitor "
                    "accesi. Se vuoi restare su FLUX, tieni un solo monitor attivo durante l'addestramento.")
                return
            continue
        # ADDESTRAMENTO vero partito: si guardano i passi.
        passo = state.get("step") or 0
        if passo > visto:
            visto, visto_a = passo, now
        if visto >= 1 and now - visto_a > SILENZIO_S:
            mins = int((now - visto_a) / 60)
            _ferma_bloccato(
                f"Addestramento fermo da {mins} minuti senza avanzare di un passo (al passo {passo}): quasi "
                "certamente la scheda è a corto di memoria con FLUX. L'ho annullato. Per un personaggio inventato "
                "usa SDXL (più leggero, già supportato); in ogni caso libera la GPU spostando il monitor sulla "
                "scheda integrata.")
            return
        if passo >= MIN_PASSI:
            sps = (now - state["train_started"]) / passo
            ore = sps * (state.get("total") or passo) / 3600
            if sps > PASSO_LENTO_S or ore > STIMA_CAP_H:
                _ferma_bloccato(
                    f"Troppo lento per questa scheda: ~{sps:.0f} secondi a passo, stimate {ore:.0f} ore per finire "
                    "(un addestramento sano fa un passo in pochi secondi). FLUX a 16 GB scarica su disco e non "
                    "finirà mai: l'ho annullato. Usa SDXL per un personaggio inventato (più leggero, già "
                    "supportato), e sposta il monitor sulla scheda integrata così la GPU è tutta per il calcolo.")
                return


class TrainRequest(BaseModel):
    name: str
    trigger: str
    images: list[str]
    steps: int = 1600
    rank: int = 16
    lr: float = 1e-4
    low_vram: bool = True
    arch: str = "flux"   # "flux" (gemello/predefinito) o "sdxl" (personaggi per i modelli espliciti SDXL)
    base: str = ""       # per SDXL: la cartella/file del checkpoint SDXL su cui addestrare (es. Pony Realism)


def config_for(req: TrainRequest, dataset: Path, out: Path) -> dict:
    sdxl = req.arch == "sdxl"
    # SDXL: arch="sdxl" OBBLIGATORIO. Senza, ai-toolkit (config_modules.py) non trova nessun flag e cade sul default
    # arch="sd1" (Stable Diffusion 1.5): carica un checkpoint SDXL come se fosse SD1.5, qualcosa resta None e si
    # schianta a 0/1600 con "argument of type 'NoneType' is not iterable". Con arch="sdxl" il caricatore accetta sia
    # la cartella diffusers (from_pretrained) sia il file singolo. Niente quantizzazione FLUX, scheduler ddpm,
    # base = il checkpoint SDXL su cui addestrare (es. Pony Realism), così la LoRA è SDXL e si combina coi modelli
    # espliciti. FLUX: come prima (gemello).
    model = ({"name_or_path": req.base, "arch": "sdxl", "quantize": False, "low_vram": req.low_vram}
             if sdxl else {"name_or_path": args.model, "is_flux": True, "quantize": True, "low_vram": req.low_vram})
    scheduler = "ddpm" if sdxl else "flowmatch"
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
                    "shuffle_tokens": False, "cache_latents_to_disk": True,
                    # Su Windows il dataset con latenti già in cache non
                    # beneficia dell'avvio di altri interpreti PyTorch.
                    **({"num_workers": 0} if os.name == "nt" else {}),
                    "resolution": [768, 1024] if sdxl else [512, 768, 1024],
                }],
                "train": {
                    "batch_size": 1, "steps": req.steps, "gradient_accumulation_steps": 1, "train_unet": True,
                    "train_text_encoder": False, "gradient_checkpointing": True, "noise_scheduler": scheduler,
                    # Le didascalie di Gemello sono fisse. SDXL può riusare gli
                    # embedding e liberare la GPU dai due encoder durante i passi.
                    **({"cache_text_embeddings": True} if sdxl else {}),
                    "optimizer": "adamw8bit", "lr": req.lr, "ema_config": {"use_ema": True, "ema_decay": 0.99},
                    "dtype": "bf16", "disable_sampling": True, "skip_first_sample": True,
                },
                "model": model,
                "sample": {"sampler": scheduler, "sample_every": 100000, "width": 1024, "height": 1024,
                           "prompts": [f"photo of {req.trigger}"], "neg": "", "seed": 42,
                           "guidance_scale": 7 if sdxl else 4, "sample_steps": 25 if sdxl else 20},
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
    state["log_at"] = time.time()   # il cane da guardia usa questo per capire se la preparazione è bloccata


def run(req: TrainRequest, cfg_path: Path, out: Path) -> None:
    global proc
    try:
        if state["status"] == "cancelled":
            return
        env = {**os.environ, "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1"}
        proc = subprocess.Popen([sys.executable, "run.py", str(cfg_path)], cwd=APP, env=env,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1)
        if state["status"] == "cancelled":
            proc.kill()
        # ideax passa --model come CARTELLA già scaricata (una volta sola, all'installazione del motore): lì il modello
        # si CARICA dal disco, non si scarica. La scritta diceva "scarica" sempre, anche a modello già presente: falso.
        # Si scarica davvero solo se la cartella non c'è (es. avvio standalone con un repo di Hugging Face).
        if req.arch == "sdxl":
            state["phase"] = "Preparo il modello SDXL su cui addestrare"
        elif os.path.isdir(args.model):
            state["phase"] = "Preparo il modello (lo carico in memoria, non riscarica)"
        else:
            state["phase"] = "Scarico il modello (solo la prima volta, circa 30 GB)"
        buf = ""
        while True:
            ch = proc.stdout.read(1)
            if not ch:
                break
            if ch in "\r\n":
                if buf:
                    m = STEP.search(buf)
                    if m and int(m.group(2)) == req.steps:
                        if not state.get("train_started"):
                            state["train_started"] = time.time()   # arma il cane da guardia: da qui i passi vanno veloci
                        state.update(step=int(m.group(1)), total=int(m.group(2)), phase=FASE_ADDESTRO)
                    elif "cach" in buf.lower() and "latent" in buf.lower():
                        state["phase"] = "Preparo le foto"
                    log(buf)
                buf = ""
            else:
                buf += ch
        code = proc.wait()
        if state["status"] in ("cancelled", "error"):
            return   # annullato a mano, o fermato dal cane da guardia: il suo messaggio non si sovrascrive
        final = out / req.name / f"{req.name}.safetensors"
        if code != 0 or not final.exists():
            tail = " · ".join(state["log"][-5:])
            raise RuntimeError(f"addestramento terminato con codice {code}: {tail}")
        state.update(status="done", output=str(final), phase=None, step=req.steps)
    except Exception as err:  # noqa: BLE001
        if state["status"] != "cancelled":
            state.update(status="error", error=str(err), phase=None)
    finally:
        proc = None
        training_lock.release()


@app.get("/health")
def health():
    return {"ok": True, "status": state["status"]}


@app.post("/train")
def train(req: TrainRequest):
    if len(req.images) < 8:
        raise HTTPException(400, "Servono almeno 8 foto (meglio 15-30)")
    if not re.fullmatch(r"[a-z0-9_]{2,40}", req.name):
        raise HTTPException(400, "Nome non valido")
    if not training_lock.acquire(blocking=False):
        raise HTTPException(409, "Sto già addestrando un gemello")
    started = time.time()
    state.update(status="running", step=0, total=req.steps, phase="Avvio", log=[], output=None, error=None,
                 name=req.name, started=started, train_started=None, log_at=started)
    try:
        base = WORK / req.name
        dataset = base / "foto"
        out = base / "output"
        shutil.rmtree(dataset, ignore_errors=True)
        dataset.mkdir(parents=True)
        for i, src in enumerate(req.images):
            ext = Path(src).suffix.lower() or ".jpg"
            shutil.copyfile(src, dataset / f"{i:03d}{ext}")
            (dataset / f"{i:03d}.txt").write_text("photo of [trigger]", encoding="utf-8")
        cfg_path = base / "config.yaml"
        # Il JSON è YAML valido: niente dipendenze in più
        cfg_path.write_text(json.dumps(config_for(req, dataset, out), indent=2), encoding="utf-8")
        threading.Thread(target=run, args=(req, cfg_path, out), daemon=True).start()
    except Exception as err:
        state.update(status="error", error=str(err), phase=None)
        training_lock.release()
        raise
    threading.Thread(target=_cane_da_guardia, args=(started,), daemon=True).start()
    return {"ok": True}


@app.get("/progress")
def progress():
    return {k: state.get(k) for k in ("status", "step", "total", "phase", "output", "error", "name", "started")} | {"log": state["log"][-8:]}


@app.post("/cancel")
def cancel():
    if state["status"] == "running":
        state.update(status="cancelled", phase=None)
        current = proc
        if current:
            current.kill()
    return {"ok": True}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
