# Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M
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

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageOps

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


def _load(data: bytes) -> Image.Image:
    src = Image.open(io.BytesIO(data))
    if src.mode in ("RGBA", "LA", "P"):
        src = src.convert("RGBA")
        bg = Image.new("RGBA", src.size, (255, 255, 255, 255))
        src = Image.alpha_composite(bg, src)
    return src.convert("RGB")


def _layout(box_size, width_mm, height_mm):
    """Misure in mm della forma (proporzioni conservate) e risoluzione di lavoro: fino a 6 px/mm, max 1600 px."""
    cw, ch = box_size
    mm_per_src = min(width_mm / cw, height_mm / ch)
    w_mm, h_mm = cw * mm_per_src, ch * mm_per_src
    ppm = max(2.0, min(6.0, 1600 / max(w_mm, h_mm)))
    size = (max(8, round(w_mm * ppm)), max(8, round(h_mm * ppm)))
    return w_mm, h_mm, ppm, size


def _background(rgb: Image.Image, limit: int, margin: int = 24) -> tuple[int, int, int]:
    """Soglia per canale fra fondo e disegno, presa dal bordo dell'immagine: il modello di immagini non sempre fa
    il fondo bianco puro (spesso è un grigio o un crema sfumato, 215-230) e una soglia fissa lo prenderebbe tutto
    come parte del pezzo. Se il bordo è scuro (il soggetto tocca il bordo) resta la soglia fissa."""
    w, h = rgb.size
    s = max(2, round(min(w, h) * 0.02))
    strips = [rgb.crop((0, 0, w, s)), rgb.crop((0, h - s, w, h)), rgb.crop((0, 0, s, h)), rgb.crop((w - s, 0, w, h))]
    levels = []
    for c in range(3):
        values = sorted(v for strip in strips for v in strip.getchannel(c).getdata())
        levels.append(values[len(values) // 2])
    if min(levels) < 128:
        return (limit, limit, limit)
    return tuple(min(limit, v - margin) for v in levels)


def _binary(img: Image.Image) -> Image.Image:
    return img.point(lambda v: 255 if v >= 128 else 0)


def _cleanup_cut(mask: Image.Image, ppm: float, min_mm: float, gap_mm: float) -> Image.Image:
    """Per il taglio: chiude i varchi più stretti di gap_mm, toglie le parti più sottili di min_mm, arrotonda i bordi.
    La forma è bianca (255) su nero: erosione = MinFilter, dilatazione = MaxFilter."""
    rc = max(1, round(gap_mm * ppm / 2))
    ro = max(1, round(min_mm * ppm / 2))
    pad = rc + ro + 2
    w, h = mask.size
    mask = ImageOps.expand(mask, border=pad, fill=0)
    mask = _morph(_morph(mask, ImageFilter.MaxFilter, rc), ImageFilter.MinFilter, rc)
    mask = _morph(_morph(mask, ImageFilter.MinFilter, ro), ImageFilter.MaxFilter, ro)
    mask = mask.crop((pad, pad, pad + w, pad + h))
    return _binary(mask.filter(ImageFilter.GaussianBlur(ppm * 0.35)))


def _fill_holes(mask: Image.Image) -> Image.Image:
    """Riempie i buchi interni: la sagoma da tagliare è un pezzo unico (i dettagli interni si incidono)."""
    padded = ImageOps.expand(mask, border=1, fill=0)
    ImageDraw.floodfill(padded, (0, 0), 128)
    filled = padded.point(lambda v: 0 if v == 128 else 255)
    return filled.crop((1, 1, 1 + mask.size[0], 1 + mask.size[1]))


def _trace(mask: Image.Image, ppm: float, speckle: int) -> list[str]:
    """Contorni della forma bianca, in mm. I tracciati troppo lunghi si semplificano (IDEAlab: max 200.000 caratteri)."""
    vt = _vtracer()
    border = 4
    img = ImageOps.expand(ImageOps.invert(mask), border=border, fill=255).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, "PNG")
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
            return parts
    raise ValueError("Il disegno è troppo fitto per il laser anche semplificato: chiedi un soggetto più semplice.")


def _svg(w_mm: float, h_mm: float, layers: list[tuple[str, str]]) -> str:
    body = "".join(f'<path d="{d}" fill="{color}" fill-rule="evenodd"/>' for d, color in layers if d)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_fmt(w_mm)} {_fmt(h_mm)}" '
            f'width="{_fmt(w_mm)}mm" height="{_fmt(h_mm)}mm">{body}</svg>')


def vectorize(data: bytes, width_mm: float, height_mm: float, mode: str = "taglio",
              min_mm: float = 3.0, gap_mm: float = 2.0, threshold: int = 128) -> dict:
    gray = _load(data).convert("L")
    mask = gray.point(lambda v: 255 if v < threshold else 0)
    box = mask.getbbox()
    if not box:
        raise ValueError("L'immagine è vuota: nessuna forma scura su fondo chiaro.")
    mask = mask.crop(box)
    w_mm, h_mm, ppm, size = _layout(mask.size, width_mm, height_mm)
    mask = _binary(mask.resize(size, Image.LANCZOS))
    if mode == "taglio":
        mask = _cleanup_cut(mask, ppm, min_mm, gap_mm)
        speckle = max(4, round(min_mm * ppm))
    else:
        speckle = max(2, round(0.6 * ppm))
    parts = _trace(mask, ppm, speckle)
    if not parts:
        raise ValueError("Dopo la pulizia non resta nessuna forma: prova con un disegno più pieno o misure più grandi.")
    d_all = " ".join(parts)
    return {"d": d_all, "w": round(w_mm, 2), "h": round(h_mm, 2), "paths": len(parts), "mode": mode,
            "svg": _svg(w_mm, h_mm, [(d_all, "#000" if mode == "taglio" else "#316bba")])}


def decorate(data: bytes, width_mm: float, height_mm: float, min_mm: float = 3.0, gap_mm: float = 2.0,
             line_mm: float = 0.4, margin_mm: float = 2.5, background: int = 232, line_threshold: int = 110) -> dict:
    """Da un'illustrazione su fondo bianco a un pezzo vero: il contorno esterno si taglia, i tratti scuri
    dentro il pezzo si incidono. Le misure di entrambi i livelli sono nello stesso riquadro w×h (mm)."""
    rgb = _load(data)
    # Tutto ciò che è nettamente più scuro del fondo fa parte del pezzo
    thr = _background(rgb, background)
    fg = Image.merge("RGB", [ch.point(lambda v, t=t: 255 if v < t else 0) for ch, t in zip(rgb.split(), thr)])
    fg = fg.convert("L").point(lambda v: 255 if v > 0 else 0)
    fg = ImageChops.lighter(fg, rgb.convert("L").point(lambda v: 255 if v < min(thr) else 0))
    fg = fg.filter(ImageFilter.MedianFilter(5))
    box = fg.getbbox()
    if not box:
        raise ValueError("Il disegno è vuoto: niente su fondo bianco.")
    fg = fg.crop(box)
    gray = rgb.convert("L").crop(box)
    w_mm, h_mm, ppm, size = _layout(fg.size, max(10, width_mm - 4), max(10, height_mm - 4))
    # Un po' di aria intorno: la pulizia e l'arrotondamento non devono schiacciare i bordi contro la cornice
    air = max(2, round(2 * ppm))
    fg = ImageOps.expand(_binary(fg.resize(size, Image.LANCZOS)), border=air, fill=0)
    gray = ImageOps.expand(gray.resize(size, Image.LANCZOS), border=air, fill=255)
    size = fg.size
    w_mm, h_mm = size[0] / ppm, size[1] / ppm
    sil = _fill_holes(fg)
    sil = _fill_holes(_cleanup_cut(sil, ppm, min_mm, gap_mm))
    cut = _trace(sil, ppm, max(4, round(min_mm * ppm)))
    if not cut:
        raise ValueError("Dopo la pulizia per il taglio non resta nessuna forma: chiedi un soggetto più pieno o misure più grandi.")
    # I tratti scuri, solo dentro il pezzo e lontano dal bordo: il bordo lo fa già il taglio
    lines = _binary(gray.point(lambda v: 255 if v < line_threshold else 0))
    rm = max(1, round(margin_mm * ppm))
    # il bordo dell'immagine conta come fuori dal pezzo, altrimenti l'erosione non lo tocca
    inner = _morph(ImageOps.expand(sil, border=rm + 1, fill=0), ImageFilter.MinFilter, rm).crop((rm + 1, rm + 1, rm + 1 + size[0], rm + 1 + size[1]))
    lines = ImageChops.multiply(lines, inner)
    ro = max(1, round(line_mm * ppm / 2))
    lines = _morph(_morph(lines, ImageFilter.MinFilter, ro), ImageFilter.MaxFilter, ro)
    engrave = _trace(lines, ppm, max(3, round(1.5 * ppm))) if lines.getbbox() else []
    d_cut, d_eng = " ".join(cut), " ".join(engrave)
    return {
        "w": round(w_mm, 2), "h": round(h_mm, 2),
        "livelli": [
            {"nome": "Sagoma", "operazione": "taglio", "d": d_cut},
            *([{"nome": "Dettagli incisi", "operazione": "incisione", "d": d_eng, "pieno": True}] if d_eng else []),
        ],
        # anteprima nel legno: il pezzo color pioppo, le incisioni bruciate
        "svg": _svg(w_mm, h_mm, [(d_cut, "#d8b483"), (d_eng, "#6b4a2b")]),
    }
