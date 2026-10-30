"""
Motore voce di ideax: clone vocale e lettura di testi con Chatterbox Multilingual (Resemble AI, licenza MIT).
Gira nel suo ambiente Python (Python 3.11 + PyTorch 2.6), avviato e spento da ideax.
IDEAX_DEMO=1: niente modello, genera un tono di prova (per provare l'interfaccia senza GPU).
"""
from __future__ import annotations

import argparse
import base64
import io
import os
import re
import subprocess
import tempfile
import threading
import time
from typing import Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

DEMO = os.environ.get("IDEAX_DEMO") == "1"
SR = 24000
app = FastAPI(title="ideax voce")
lock = threading.Lock()
state: dict = {"model": None, "device": None}
PROGRESS: dict = {"step": 0, "total": 0, "phase": None, "cancel": False}

LANGUAGES = ["ar", "da", "de", "el", "en", "es", "fi", "fr", "he", "hi", "it", "ja", "ko", "ms", "nl", "no", "pl", "pt", "ru", "sv", "sw", "tr", "zh"]


class Cancelled(Exception):
    pass


def ffmpeg() -> str:
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


def load_model():
    if state["model"] is not None or DEMO:
        return state["model"]
    import torch
    from chatterbox.mtl_tts import ChatterboxMultilingualTTS

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[voce] carico Chatterbox Multilingual su {device}", flush=True)
    state["model"] = ChatterboxMultilingualTTS.from_pretrained(device=device)
    state["device"] = device
    return state["model"]


@app.get("/health")
def health():
    return {"ok": True, "demo": DEMO, "loaded": state["model"] is not None, "device": state["device"]}


@app.post("/warmup")
def warmup():
    """Scarica i pesi (la prima volta, circa 3 GB) e carica il modello."""
    with lock:
        load_model()
    return {"ok": True}


@app.post("/unload")
def unload():
    with lock:
        state["model"] = None
        try:
            import torch

            torch.cuda.empty_cache()
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True}


@app.get("/progress")
def progress():
    return {k: PROGRESS[k] for k in ("step", "total", "phase")}


@app.post("/cancel")
def cancel():
    if PROGRESS["phase"]:
        PROGRESS["cancel"] = True
    return {"ok": True}


# ---------- Preparazione del campione di voce ----------

class PrepareRequest(BaseModel):
    input: str
    output: str


@app.post("/prepare")
def prepare(req: PrepareRequest):
    """Converte il campione (mp3, m4a, webm del microfono…) in WAV mono 24 kHz, toglie il silenzio iniziale
    e normalizza il volume. Restituisce la durata: servono almeno 8–10 secondi di voce pulita."""
    cmd = [ffmpeg(), "-y", "-i", req.input, "-ac", "1", "-ar", str(SR),
           "-af", "silenceremove=start_periods=1:start_threshold=-45dB,loudnorm=I=-18:TP=-2", req.output]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(req.output):
        raise HTTPException(400, f"Non riesco a leggere il file audio: {proc.stderr[-400:]}")
    import soundfile as sf

    info = sf.info(req.output)
    return {"seconds": round(info.frames / info.samplerate, 1)}


# ---------- Lettura ----------

class SpeakRequest(BaseModel):
    text: str
    language: str = "it"
    reference: Optional[str] = None  # WAV del campione di voce
    exaggeration: float = 0.5  # espressività: 0.25 piatta, 0.5 naturale, 0.8+ teatrale
    cfg_weight: float = 0.5  # aderenza al campione e ritmo: più basso = più lento e calmo
    temperature: float = 0.8
    seed: Optional[int] = None
    format: str = "mp3"  # mp3 | wav
    pause_ms: int = 180  # pausa tra le frasi


def split_text(text: str, limit: int = 260) -> list[str]:
    """Il modello rende meglio su frasi brevi: dividiamo per frasi, poi per virgole se una frase è troppo lunga."""
    text = re.sub(r"\s+", " ", text).strip()
    sentences = re.split(r"(?<=[.!?…;:])\s+", text)
    chunks: list[str] = []
    for s in sentences:
        while len(s) > limit:
            cut = s.rfind(",", 0, limit)
            cut = cut if cut > limit // 3 else s.rfind(" ", 0, limit)
            chunks.append(s[: cut + 1].strip())
            s = s[cut + 1:].strip()
        if s:
            chunks.append(s)
    # Unisce frasi molto corte alla successiva
    merged: list[str] = []
    for c in chunks:
        if merged and len(merged[-1]) < 40 and len(merged[-1]) + len(c) < limit:
            merged[-1] += " " + c
        else:
            merged.append(c)
    return merged


def encode(samples, fmt: str) -> tuple[str, str]:
    import numpy as np
    import soundfile as sf

    buf = io.BytesIO()
    sf.write(buf, np.asarray(samples, dtype="float32"), SR, format="WAV")
    wav = buf.getvalue()
    if fmt == "wav":
        return "audio/wav", base64.b64encode(wav).decode()
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "a.wav"), os.path.join(d, "a.mp3")
        open(src, "wb").write(wav)
        subprocess.run([ffmpeg(), "-y", "-i", src, "-codec:a", "libmp3lame", "-b:a", "192k", dst], capture_output=True, check=True)
        return "audio/mpeg", base64.b64encode(open(dst, "rb").read()).decode()


@app.post("/speak")
def speak(req: SpeakRequest):
    import numpy as np

    if req.language not in LANGUAGES:
        raise HTTPException(400, f"Lingua non supportata: {req.language}")
    chunks = split_text(req.text)
    if not chunks:
        raise HTTPException(400, "Testo vuoto")
    start = time.time()
    with lock:
        PROGRESS.update(step=0, total=len(chunks), phase="Leggo", cancel=False)
        try:
            pieces = []
            pause = np.zeros(int(SR * req.pause_ms / 1000), dtype="float32")
            if DEMO:
                for i, c in enumerate(chunks):
                    t = np.linspace(0, max(0.4, len(c) * 0.06), int(SR * max(0.4, len(c) * 0.06)), endpoint=False)
                    pieces += [0.15 * np.sin(2 * np.pi * (220 + 40 * i) * t).astype("float32"), pause]
                    PROGRESS["step"] = i + 1
                    time.sleep(0.05)
                    if PROGRESS["cancel"]:
                        raise Cancelled()
            else:
                import torch

                model = load_model()
                if req.seed is not None:
                    torch.manual_seed(int(req.seed))
                for i, c in enumerate(chunks):
                    wav = model.generate(
                        c, language_id=req.language, audio_prompt_path=req.reference,
                        exaggeration=req.exaggeration, cfg_weight=req.cfg_weight, temperature=req.temperature,
                    )
                    pieces += [wav.squeeze(0).detach().cpu().numpy().astype("float32"), pause]
                    PROGRESS["step"] = i + 1
                    if PROGRESS["cancel"]:
                        raise Cancelled()
            audio = np.concatenate(pieces[:-1]) if pieces else np.zeros(1, dtype="float32")
            mime, data = encode(audio, req.format)
        except Cancelled:
            raise HTTPException(409, "Annullato")
        finally:
            PROGRESS.update(step=0, total=0, phase=None, cancel=False)
    return {"type": mime, "data": data, "seconds": round(len(audio) / SR, 2), "elapsed": round(time.time() - start, 1), "chunks": len(chunks)}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=7871)
    args = ap.parse_args()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")
