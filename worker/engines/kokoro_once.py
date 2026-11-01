"""Libreria voci di ideax: legge un testo con una voce sintetica di Kokoro-82M (Apache-2.0) e salva un WAV.
Il WAV diventa il campione da cui Chatterbox clona la voce del personaggio.

uso: python kokoro_once.py MODELLO VOCI VOCE LINGUA FILE_TESTO USCITA.wav
VOCE può essere una miscela: "af_bella:0.6,af_sarah:0.4"
"""
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

model, voices, voice, lang, text_file, out = sys.argv[1:7]
k = Kokoro(model, voices)
if ":" in voice:
    parts = [p.split(":") for p in voice.split(",")]
    total = sum(float(w) for _, w in parts) or 1.0
    style = sum(k.get_voice_style(n) * (float(w) / total) for n, w in parts)
else:
    style = voice
text = open(text_file, encoding="utf-8").read()
samples, sr = k.create(text, voice=style, speed=1.0, lang=lang)
sf.write(out, np.asarray(samples, dtype=np.float32), sr)
print(f"ok {len(samples) / sr:.1f}s")
