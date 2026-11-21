"""Illustrated reel cards, quiet original accompaniment, and static-frame encoding."""
import math
import subprocess
import tempfile
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw


def righe(testo, draw, font, width):
    lines, line = [], ""
    for word in testo.split():
        prova = (line + " " + word).strip()
        if line and draw.textlength(prova, font=font) > width:
            lines.append(line)
            line = word
        else:
            line = prova
    return lines + ([line] if line else [])


def icona(draw, nome):
    cream, mint, navy = "#f7eed9", "#95e1c8", "#162a39"
    coords = (302, 280)

    def scala(box):
        return tuple(coords[i % 2] + round(v * 1.85) for i, v in enumerate(box))

    def rett(box, fill=cream, radius=12):
        draw.rounded_rectangle(scala(box), radius=radius * 2, fill=fill)

    def cerchio(box, fill=cream):
        draw.ellipse(scala(box), fill=fill)

    def tratto(points, fill=navy, width=8):
        draw.line([scala(p) for p in points], fill=fill, width=width * 2, joint="curve")

    def poligono(points, fill=cream):
        draw.polygon([scala(p) for p in points], fill=fill)

    if nome == "ascolto":
        cerchio((70, 48, 179, 154))
        draw.arc(scala((88, 64, 157, 138)), 180, 515, fill=navy, width=16)
        tratto([(128, 123), (118, 139), (110, 154), (91, 154)], mint)
        for x in (184, 201, 218):
            rett((x, 86, x + 6, 135), mint, 3)
    elif nome == "dialogo":
        rett((38, 65, 157, 136))
        poligono([(76, 127), (62, 155), (102, 127)])
        rett((110, 111, 217, 174), mint)
        poligono([(166, 166), (202, 191), (194, 166)], mint)
        for x in (60, 84, 108):
            cerchio((x, 96, x + 9, 105), navy)
    elif nome in ("preparazione", "riepilogo"):
        rett((70, 43, 187, 188))
        rett((101, 35, 157, 61), mint)
        for y in (88, 120, 152):
            tratto([(86, y), (95, y + 8), (107, y - 7)], navy, 4)
            rett((122, y - 3, 169, y + 4), mint, 3)
    elif nome == "tempo":
        cerchio((56, 43, 201, 187))
        cerchio((71, 58, 186, 172), mint)
        tratto([(129, 77), (129, 115), (153, 132)])
    elif nome == "limite":
        rett((61, 64, 199, 163), cream)
        for x in (84, 114, 144, 174):
            tratto([(x, 72), (x, 154)], mint, 4)
        tratto([(55, 113), (207, 113)], navy)
    elif nome == "alternativa":
        for points in ([(58, 162), (106, 162), (197, 70)], [(102, 161), (150, 169), (197, 169)]):
            tratto(points, cream, 12)
        poligono([(174, 66), (209, 62), (207, 96)], cream)
        poligono([(181, 153), (216, 169), (181, 184)], mint)
    elif nome in ("fiducia", "accordo"):
        poligono([(129, 44), (195, 70), (185, 142), (129, 184), (73, 142), (63, 70)], cream)
        tratto([(96, 115), (120, 140), (165, 96)], "#24866e", 10)
    else:
        poligono([(128, 41), (210, 181), (47, 181)], cream)
        rett((120, 89, 136, 137), navy, 6)
        cerchio((120, 149, 136, 165), navy)


def scheda(titolo, serie, simbolo, badge, index, count, font):
    w, h = 1080, 1920
    img = Image.new("RGB", (w, h), "#162a39")
    draw = ImageDraw.Draw(img)
    cream, mint, muted = "#f7eed9", "#95e1c8", "#b4cdc9"
    for y in range(20, 1860, 65):
        for x in range(20 + (y % 2) * 25, 1060, 65):
            draw.ellipse((x, y, x + 3, y + 3), fill="#284151")
    draw.rounded_rectangle((62, 100, 1018, 1815), 56, fill="#1c3444", outline="#3b5865", width=3)
    for row, line in enumerate(righe(serie.upper(), draw, font(27), 875)[:2]):
        draw.text((103, 163 + row * 38), line, fill=muted, font=font(27))
    for k in range(count):
        x = 104 + k * (872 / count)
        draw.rounded_rectangle((x, 260, x + 872 / count - 10, 269), 4, fill=mint if k <= index else "#496470")
    draw.ellipse((280, 302, 800, 822), fill="#294959", outline="#547b79", width=3)
    draw.ellipse((314, 336, 766, 788), outline="#365961", width=2)
    icona(draw, simbolo)
    draw.text((106, 912), badge.upper(), fill=mint, font=font(33))
    size = 92
    lines = righe(titolo, draw, font(size), 860)
    while len(lines) > 3 and size > 48:
        size -= 8
        lines = righe(titolo, draw, font(size), 860)
    for i, line in enumerate(lines[:4]):
        draw.text((102, 985 + i * round(size * 1.18)), line, fill=cream, font=font(size))
    return img


def accompagnamento(path, seconds):
    rate = 24000
    samples = np.zeros(round(seconds * rate), dtype=np.float32)
    accordi = [(130.81, 164.81, 196), (110, 130.81, 164.81), (87.31, 130.81, 174.61), (98, 146.83, 196)]
    for i, start in enumerate(np.arange(0, seconds, 0.8)):
        offset = round(start * rate)
        length = min(round(rate * 2.1), len(samples) - offset)
        if length <= 0:
            break
        t = np.arange(length) / rate
        chord = accordi[(i // 4) % len(accordi)]
        freq = chord[i % 3] * (2 if i % 4 else 1)
        envelope = np.minimum(t * 24, 1) * np.exp(-t * 1.9) * np.minimum((t[-1] - t) * 12, 1)
        samples[offset:offset + length] += 0.22 * envelope * (np.sin(2 * np.pi * freq * t) + 0.2 * np.sin(4 * np.pi * freq * t))
    with wave.open(str(path), 'wb') as out:
        out.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        out.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())


def codifica_statica(req, frames, overlays, silent, ff, cover):
    from bisect import bisect_right

    fps = req.fps
    with tempfile.TemporaryDirectory(prefix="ideax-schede-") as tmp:
        root = Path(tmp)
        starts = [math.ceil(s.start * fps - 1e-8) for s in req.scenes]
        cuts = {0, frames, *starts}
        for caption, _, _ in overlays:
            cuts.update((math.ceil(caption.start * fps - 1e-8), math.ceil(caption.end * fps - 1e-8)))
        cuts = sorted(c for c in cuts if 0 <= c <= frames)
        bases = []
        for s in req.scenes:
            with Image.open(s.image) as img:
                bases.append(cover(img, req.width, req.height))
        entries = ["ffconcat version 1.0"]
        for i, (start, end) in enumerate(zip(cuts, cuts[1:])):
            frame = bases[max(0, bisect_right(starts, start) - 1)].copy()
            t = start / fps + 1e-9
            for c, ov, offset in overlays:
                if c.start <= t < c.end:
                    frame.paste(ov, offset, ov)
                    break
            name = f"frame-{i:03d}.jpg"
            frame.save(root / name, quality=95, subsampling=0)
            entries.extend([f"file '{name}'", f"option framerate {fps}", f"duration {(end-start)/fps:.9f}"])
        entries.extend([f"file '{name}'", f"option framerate {fps}"])
        manifest = root / "frames.ffconcat"
        manifest.write_text("\n".join(entries) + "\n", encoding="ascii")
        subprocess.run([ff, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(manifest),
                        "-vf", f"fps={fps}", "-frames:v", str(frames), "-c:v", "libx264", "-preset", "veryfast",
                        "-crf", "19", "-pix_fmt", "yuv420p", silent], check=True, capture_output=True)
