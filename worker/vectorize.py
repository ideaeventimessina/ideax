"""Vettorizzatore per il laser: da un'immagine (sagoma nera su fondo bianco) a tracciati SVG in millimetri.

- "taglio": la sagoma si taglia. Si tolgono le parti più sottili di min_mm e si chiudono i varchi più
  stretti di gap_mm, così il pezzo regge e il laser non brucia i dettagli.
- "incisione": il disegno si incide. Si tengono i dettagli, si tolgono solo i puntini.

Usa vtracer (MIT): se manca nel worker si installa da solo la prima volta.
"""
from __future__ import annotations

import io
import re
import subprocess
import sys

from PIL import Image, ImageFilter, ImageOps

MAX_CHARS = 180_000
TOKEN = re.compile(r"[MLHVCSQTAZmlhvcsqtaz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
PATH = re.compile(r"<path\b[^>]*>")
ATTR_D = re.compile(r'\bd="([^"]+)"')
ATTR_T = re.compile(r'transform="translate\(([-\d.]+)[ ,]+([-\d.]+)\)"')


def _vtracer():
    try:
        import vtracer
    except ImportError:
        print("[ideax] installo vtracer per vettorizzare", flush=True)
        subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "vtracer"], check=True)
        import vtracer
    return vtracer


def _morph(img: Image.Image, filt, radius: int) -> Image.Image:
    for _ in range(radius):
        img = img.filter(filt(3))
    return img


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".") if abs(v) > 1e-9 else "0"


def transform_path(d: str, scale: float, ox: float, oy: float) -> str:
    """Scala un tracciato SVG (pixel → mm) e lo sposta: i comandi assoluti si spostano, i relativi si scalano e basta."""
    out: list[str] = []
    cmd = ""
    idx = 0  # posizione del numero dentro il comando (per sapere se è x o y)
    for tok in TOKEN.findall(d):
        if tok.isalpha():
            cmd = tok
            idx = 0
            out.append(tok)
            continue
        v = float(tok)
        absolute = cmd.isupper()
        c = cmd.upper()
        if c == "H":
            v = v * scale + (ox if absolute else 0)
        elif c == "V":
            v = v * scale + (oy if absolute else 0)
        elif c == "A":
            k = idx % 7
            if k in (0, 1):
                v = v * scale
            elif k == 5:
                v = v * scale + (ox if absolute else 0)
            elif k == 6:
                v = v * scale + (oy if absolute else 0)
        else:
            v = v * scale + ((ox if idx % 2 == 0 else oy) if absolute else 0)
        idx += 1
        out.append(_fmt(v))
    return " ".join(out)


def vectorize(data: bytes, width_mm: float, height_mm: float, mode: str = "taglio",
              min_mm: float = 3.0, gap_mm: float = 2.0, threshold: int = 128) -> dict:
    vt = _vtracer()
    src = Image.open(io.BytesIO(data))
    if src.mode in ("RGBA", "LA", "P"):
        src = src.convert("RGBA")
        bg = Image.new("RGBA", src.size, (255, 255, 255, 255))
        src = Image.alpha_composite(bg, src)
    gray = src.convert("L")
    # La forma è bianca (255) su nero: così erosione = MinFilter e dilatazione = MaxFilter
    mask = gray.point(lambda v: 255 if v < threshold else 0)
    box = mask.getbbox()
    if not box:
        raise ValueError("L'immagine è vuota: nessuna forma scura su fondo chiaro.")
    mask = mask.crop(box)
    cw, ch = mask.size
    mm_per_src = min(width_mm / cw, height_mm / ch)
    w_mm, h_mm = cw * mm_per_src, ch * mm_per_src
    # Risoluzione di lavoro: fino a 6 pixel per mm, al massimo 1600 pixel sul lato lungo
    ppm = max(2.0, min(6.0, 1600 / max(w_mm, h_mm)))
    size = (max(8, round(w_mm * ppm)), max(8, round(h_mm * ppm)))
    mask = mask.resize(size, Image.LANCZOS).point(lambda v: 255 if v >= 128 else 0)
    if mode == "taglio":
        rc = max(1, round(gap_mm * ppm / 2))
        ro = max(1, round(min_mm * ppm / 2))
        pad = rc + ro + 2
        mask = ImageOps.expand(mask, border=pad, fill=0)
        mask = _morph(_morph(mask, ImageFilter.MaxFilter, rc), ImageFilter.MinFilter, rc)  # chiude i varchi stretti
        mask = _morph(_morph(mask, ImageFilter.MinFilter, ro), ImageFilter.MaxFilter, ro)  # toglie le parti sottili
        mask = mask.crop((pad, pad, pad + size[0], pad + size[1]))
        # Bordi morbidi: la morfologia lascia gradini, una sfocatura leggera e una nuova soglia li arrotondano
        mask = mask.filter(ImageFilter.GaussianBlur(ppm * 0.35)).point(lambda v: 255 if v >= 128 else 0)
        speckle = max(4, round(min_mm * ppm))
    else:
        speckle = max(2, round(0.6 * ppm))
    border = 4
    img = ImageOps.expand(ImageOps.invert(mask), border=border, fill=255).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG")
    # I tracciati troppo lunghi (disegni molto fitti) si semplificano: IDEAlab accetta fino a 200.000 caratteri
    for attempt in range(4):
        svg = vt.convert_raw_image_to_svg(
            buf.getvalue(), img_format="png", colormode="binary", mode="spline",
            filter_speckle=speckle * (1 + attempt), corner_threshold=60, length_threshold=4.0 + attempt * 2,
            splice_threshold=45, path_precision=3,
        )
        parts = []
        for tag in PATH.findall(svg):
            d = ATTR_D.search(tag)
            if not d:
                continue
            t = ATTR_T.search(tag)
            ox = ((float(t.group(1)) if t else 0) - border) / ppm
            oy = ((float(t.group(2)) if t else 0) - border) / ppm
            parts.append(transform_path(d.group(1), 1 / ppm, ox, oy))
        if sum(len(x) + 1 for x in parts) <= MAX_CHARS:
            break
    else:
        raise ValueError("Il disegno è troppo fitto per il laser anche semplificato: chiedi una sagoma più semplice.")
    if not parts:
        raise ValueError("Dopo la pulizia non resta nessuna forma: prova con un disegno più pieno o misure più grandi.")
    d_all = " ".join(parts)
    preview = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_fmt(w_mm)} {_fmt(h_mm)}" width="{_fmt(w_mm)}mm" height="{_fmt(h_mm)}mm">'
               f'<path d="{d_all}" fill="{"#000" if mode == "taglio" else "#316bba"}" fill-rule="evenodd"/></svg>')
    return {"d": d_all, "w": round(w_mm, 2), "h": round(h_mm, 2), "paths": len(parts), "svg": preview, "mode": mode}
