# Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M
"""Regista web: ideax guida un browser vero sulle tue pagine (con i tuoi accessi), fa quello che il copione dice e
REGISTRA lo schermo del browser. Il video torna a ideax, che lo monta in un reel con voce.

Niente di nascosto: naviga, fa login dove gli dai le credenziali, clicca, scrive, scorre, evidenzia e mette
sottotitoli. Le credenziali le riceve da ideax (restano sul PC) e non finiscono nel video né nei log.
"""
from __future__ import annotations

import argparse
import base64
import os
import subprocess
import sys
import tempfile
import time
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

parser = argparse.ArgumentParser()
parser.add_argument("--port", type=int, default=7877)
args = parser.parse_args()

app = FastAPI()
PROGRESS: dict = {"status": "idle", "phase": None, "step": 0, "total": 0, "log": []}


def _chromium_ok() -> bool:
    try:
        from playwright.sync_api import sync_playwright
        # Un browser già presente (es. in un ambiente dove è preinstallato): si usa quello
        if os.environ.get("IDEAX_CHROMIUM") and os.path.exists(os.environ["IDEAX_CHROMIUM"]):
            return True
        with sync_playwright() as p:
            path = p.chromium.executable_path
            return bool(path) and os.path.exists(path)
    except Exception:
        return False


@app.get("/health")
def health():
    return {"ok": True, "status": PROGRESS["status"]}


@app.post("/warmup")
def warmup():
    """Scarica Chromium la prima volta (circa 150 MB)."""
    if not _chromium_ok():
        PROGRESS.update(status="setup", phase="Scarico il browser (una volta sola)")
        subprocess.run([sys.executable, "-m", "playwright", "install", "chromium", "ffmpeg"], check=True)
    PROGRESS.update(status="idle", phase=None)
    return {"ok": True}


class Passo(BaseModel):
    azione: str  # vai | login | click | scrivi | scorri | evidenzia | aspetta | commento
    url: Optional[str] = None
    selettore: Optional[str] = None
    testo: Optional[str] = None
    campi: Optional[list[dict]] = None
    invia: Optional[str] = None
    ms: Optional[int] = None
    a: Optional[str] = None


class RegistraRequest(BaseModel):
    passi: list[Passo]
    larghezza: int = 1280
    altezza: int = 720
    secondi_max: int = 180


CAPTION_JS = """(txt) => {
  let el = document.getElementById('__ideax_caption');
  if (!el) {
    el = document.createElement('div'); el.id = '__ideax_caption';
    el.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;padding:18px 24px;background:linear-gradient(transparent,rgba(0,0,0,.82));color:#fff;font:600 28px/1.3 system-ui,Arial;text-align:center;text-shadow:0 2px 6px rgba(0,0,0,.9);pointer-events:none';
    document.documentElement.appendChild(el);
  }
  el.textContent = txt || '';
}"""
HILITE_JS = """(sel) => {
  const n = document.querySelector(sel); if (!n) return false;
  n.scrollIntoView({block:'center',behavior:'smooth'});
  const o = document.createElement('div'); const r = n.getBoundingClientRect();
  o.style.cssText = `position:fixed;z-index:2147483646;left:${r.left-6}px;top:${r.top-6}px;width:${r.width+12}px;height:${r.height+12}px;border:3px solid #7c5cff;border-radius:10px;box-shadow:0 0 0 4000px rgba(0,0,0,.35);pointer-events:none;transition:opacity .4s`;
  document.documentElement.appendChild(o); setTimeout(()=>{o.style.opacity='0';setTimeout(()=>o.remove(),500)},1600); return true;
}"""


def _log(msg: str):
    PROGRESS["log"].append(msg[:200])
    del PROGRESS["log"][:-40]


@app.post("/registra")
def registra(req: RegistraRequest):
    if not _chromium_ok():
        warmup()
    from playwright.sync_api import sync_playwright

    PROGRESS.update(status="running", step=0, total=len(req.passi), phase="Apro il browser", log=[])
    start = time.time()
    with tempfile.TemporaryDirectory() as tmp:
        video_dir = os.path.join(tmp, "video")
        with sync_playwright() as pw:
            _exe = os.environ.get("IDEAX_CHROMIUM") or None
            browser = pw.chromium.launch(executable_path=_exe, args=["--no-sandbox"])
            context = browser.new_context(viewport={"width": req.larghezza, "height": req.altezza},
                                          record_video_dir=video_dir, record_video_size={"width": req.larghezza, "height": req.altezza})
            page = context.new_page()
            try:
                for i, p in enumerate(req.passi):
                    if time.time() - start > req.secondi_max:
                        _log("tempo massimo raggiunto, mi fermo")
                        break
                    PROGRESS.update(step=i + 1, phase=f"{p.azione} ({i + 1}/{len(req.passi)})")
                    try:
                        _esegui(page, p)
                    except Exception as err:  # noqa: BLE001 — un passo sbagliato non ferma la registrazione
                        _log(f"passo {i+1} ({p.azione}) saltato: {str(err)[:120]}")
                    page.wait_for_timeout(300)
            finally:
                video = page.video
                context.close()
                browser.close()
            webm = video.path() if video else None
        if not webm or not os.path.exists(webm):
            raise HTTPException(500, "La registrazione non ha prodotto un video.")
        # webm → mp4 (h264) per riprodurlo e montarlo ovunque
        import imageio_ffmpeg
        mp4 = os.path.join(tmp, "demo.mp4")
        ff = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4],
                            capture_output=True, text=True)
        out = mp4 if ff.returncode == 0 and os.path.exists(mp4) else webm
        data = base64.b64encode(open(out, "rb").read()).decode()
        PROGRESS.update(status="idle", phase=None)
        return {"type": "video/mp4" if out.endswith(".mp4") else "video/webm", "base64": data,
                "secondi": round(time.time() - start, 1), "passi": PROGRESS["step"], "log": PROGRESS["log"]}


def _esegui(page, p: Passo):
    az = p.azione
    if az == "vai":
        page.goto(p.url, wait_until="domcontentloaded", timeout=30000)
        page.wait_for_timeout(1200)
    elif az == "login":
        if p.url:
            page.goto(p.url, wait_until="domcontentloaded", timeout=30000)
        for c in (p.campi or []):
            page.fill(c["selettore"], str(c.get("valore", "")), timeout=10000)
        if p.invia:
            page.click(p.invia, timeout=10000)
            page.wait_for_load_state("networkidle", timeout=20000)
    elif az == "click":
        (page.click(p.selettore, timeout=8000) if p.selettore else page.get_by_text(p.testo, exact=False).first.click(timeout=8000))
        page.wait_for_timeout(800)
    elif az == "scrivi":
        page.fill(p.selettore, p.testo or "", timeout=8000)
    elif az == "scorri":
        if p.a == "fondo":
            page.evaluate("() => window.scrollTo({top:document.body.scrollHeight,behavior:'smooth'})")
        elif p.a == "cima":
            page.evaluate("() => window.scrollTo({top:0,behavior:'smooth'})")
        else:
            page.mouse.wheel(0, int(p.a) if p.a else 600)
        page.wait_for_timeout(1200)
    elif az == "evidenzia":
        page.evaluate(HILITE_JS, p.selettore)
        page.wait_for_timeout(1800)
    elif az == "aspetta":
        if p.selettore:
            page.wait_for_selector(p.selettore, timeout=15000)
        else:
            page.wait_for_timeout(p.ms or 1500)
    elif az == "commento":
        page.evaluate(CAPTION_JS, p.testo or "")
        page.wait_for_timeout(p.ms or 2500)
        page.evaluate(CAPTION_JS, "")
    else:
        _log(f"azione sconosciuta: {az}")


@app.get("/progress")
def progress():
    return PROGRESS


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
