"""Volti perfetti: il secondo passaggio sui visi (come ADetailer).

Nelle immagini con persone lontane o a figura intera il viso occupa pochi pixel e il modello lo disegna male.
Qui si trova ogni viso (YuNet di OpenCV, piccolo e veloce), lo si ritaglia con un po' di margine, lo si
ridisegna alla risoluzione piena del modello con un img2img leggero (stesso modello, stesse LoRA: il gemello
resta lui) e lo si rimette al suo posto con i bordi sfumati, così non si vede la cucitura.
"""
from __future__ import annotations

import os
import subprocess
import sys
import urllib.request
from typing import Callable

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
YUNET = os.path.join(HERE, "models", "face_detection_yunet_2023mar.onnx")
YUNET_URLS = [
    "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
    "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
]

FACE_PROMPT = "detailed realistic face, natural skin texture with pores, sharp symmetrical eyes, natural expression, photographic"
FACE_NEGATIVE = "deformed face, distorted face, asymmetric eyes, extra eyes, blurry face, plastic skin, cartoon, bad anatomy, disfigured"


def _cv2():
    try:
        import cv2
    except ImportError:
        print("[ideax] installo OpenCV per sistemare i volti", flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "opencv-python-headless"], check=True)
        import cv2
    return cv2


def _model() -> str:
    if not os.path.exists(YUNET):
        os.makedirs(os.path.dirname(YUNET), exist_ok=True)
        print("[ideax] scarico il rilevatore di volti", flush=True)
        last = None
        for url in YUNET_URLS:
            try:
                urllib.request.urlretrieve(url, YUNET + ".part")
                if os.path.getsize(YUNET + ".part") > 100_000:  # non un puntatore Git LFS o una pagina di errore
                    os.replace(YUNET + ".part", YUNET)
                    break
            except Exception as err:  # noqa: BLE001
                last = err
        else:
            raise RuntimeError(f"non riesco a scaricare il rilevatore di volti ({last})")
    return YUNET


def detect(img: Image.Image, min_score: float = 0.6) -> list[tuple[int, int, int, int]]:
    """Riquadri (x, y, larghezza, altezza) dei volti, dal più grande al più piccolo."""
    cv2 = _cv2()
    import numpy as np

    bgr = cv2.cvtColor(np.asarray(img.convert("RGB")), cv2.COLOR_RGB2BGR)
    h, w = bgr.shape[:2]
    det = cv2.FaceDetectorYN.create(_model(), "", (w, h), score_threshold=min_score, nms_threshold=0.3, top_k=50)
    det.setInputSize((w, h))
    _, faces = det.detect(bgr)
    if faces is None:
        return []
    boxes = [(int(f[0]), int(f[1]), int(f[2]), int(f[3])) for f in faces if f[2] >= 12 and f[3] >= 12]
    return sorted(boxes, key=lambda b: -b[2] * b[3])


def _feather_mask(size: tuple[int, int]) -> Image.Image:
    w, h = size
    mask = Image.new("L", size, 0)
    pad_x, pad_y = int(w * 0.12), int(h * 0.12)
    ImageDraw.Draw(mask).ellipse((pad_x, pad_y, w - pad_x, h - pad_y), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(max(4, min(w, h) // 14)))


def fix_faces(img: Image.Image, redraw: Callable[[Image.Image], Image.Image], side: int = 1024,
              max_faces: int = 6, progress: Callable[[str], None] | None = None) -> tuple[Image.Image, int]:
    """redraw(ritaglio quadrato side×side) → ritaglio ridisegnato. Restituisce l'immagine e quanti volti ha sistemato."""
    boxes = detect(img)[:max_faces]
    out = img.convert("RGB").copy()
    W, H = out.size
    fixed = 0
    for i, (x, y, w, h) in enumerate(boxes):
        # Riquadro quadrato attorno al viso con margine (capelli, mento, un po' di collo)
        s = int(max(w, h) * 2.0)
        if s >= side * 0.9:
            continue  # viso già grande: è stato disegnato con abbastanza dettaglio
        cx, cy = x + w / 2, y + h / 2 - h * 0.05
        x0, y0 = int(max(0, min(W - s, cx - s / 2))), int(max(0, min(H - s, cy - s / 2)))
        s = min(s, W, H)
        crop = out.crop((x0, y0, x0 + s, y0 + s))
        if progress:
            progress(f"Rifinisco i volti ({i + 1}/{len(boxes)})")
        big = redraw(crop.resize((side, side), Image.LANCZOS))
        back = big.convert("RGB").resize((s, s), Image.LANCZOS)
        out.paste(back, (x0, y0), _feather_mask((s, s)))
        fixed += 1
    return out, fixed
