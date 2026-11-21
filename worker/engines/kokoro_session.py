"""Keep one CPU Kokoro model loaded and return a WAV for each requested segment."""
import base64
import io
import json
import re
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

speaker = Kokoro(*sys.argv[1:3])
emphasis = re.compile(r"\b(?:NON|MAI|SEMPRE|ORA|ANCORA|ATTENZIONE|IMPORTANTE|SUBITO)\b")
print(json.dumps({"ready": True}), flush=True)
for line in sys.stdin:
    key = None
    try:
        req = json.loads(line)
        key = req["id"]
        text = req["text"]
        if req["language"] == "it":
            text = emphasis.sub(lambda match: match[0].lower(), text)
        samples, rate = speaker.create(text, voice=req["voice"], speed=req["speed"], lang=req["language"])
        samples = np.asarray(samples, dtype=np.float32)
        samples = np.pad(samples, (0, round(req["pause"] * rate / 1000)))
        wav = io.BytesIO()
        sf.write(wav, samples, rate, format="WAV")
        result = {"id": key, "audio": base64.b64encode(wav.getvalue()).decode("ascii")}
    except Exception as error:
        result = {"id": key, "error": str(error)}
    print(json.dumps(result), flush=True)
