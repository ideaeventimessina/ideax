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
import re
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
                        if i == 0 and p.azione in ("vai", "login"):
                            raise HTTPException(502, "Impossibile aprire la pagina iniziale della demo.") from err
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


# ---------------------------------------------------------------- Browser pilotato passo-passo (/br/*)
# L'operatore di ideax guida un browser vero, un passo alla volta. L'API sync di Playwright è legata al thread
# che la crea, mentre FastAPI serve le richieste su thread diversi: perciò il browser vive su UN thread dedicato
# e gli endpoint gli passano i comandi via coda e aspettano la risposta. Una sessione per "sessione" (il run).
import threading  # noqa: E402
import queue  # noqa: E402

_BR: dict = {"q": queue.Queue(), "thread": None}


def _br_stato(page) -> dict:
    try:
        titolo = page.title()
    except Exception:  # noqa: BLE001
        titolo = ""
    try:
        cliccabili = page.eval_on_selector_all(
            "a,button,[role=button],input[type=submit],input[type=button]",
            "els => els.slice(0,40).map(e => (e.innerText||e.value||e.getAttribute('aria-label')||'').trim()).filter(Boolean)")
    except Exception:  # noqa: BLE001
        cliccabili = []
    try:
        testo = page.inner_text("body")
    except Exception:  # noqa: BLE001
        testo = ""
    # Uno screenshot della pagina visibile: il cervello che "vede" (VL) decide guardando, come farebbe una persona.
    try:
        schermata = base64.b64encode(page.screenshot(type="jpeg", quality=55, full_page=False)).decode()
    except Exception:  # noqa: BLE001
        schermata = None
    return {"url": page.url, "titolo": titolo, "cliccabili": cliccabili[:40], "testo": testo[:6000], "schermata": schermata}


def _br_loop():
    from playwright.sync_api import sync_playwright
    pw = sync_playwright().start()
    sessioni: dict = {}

    def apri(ses):
        exe = os.environ.get("IDEAX_CHROMIUM") or None
        browser = pw.chromium.launch(executable_path=exe, args=["--no-sandbox"])
        context = browser.new_context()
        sessioni[ses] = {"browser": browser, "page": context.new_page()}
        return sessioni[ses]

    while True:
        azione, a, resp = _BR["q"].get()
        ses = a.get("sessione") or "default"
        try:
            if azione == "chiudi":
                s = sessioni.pop(ses, None)
                if s:
                    try:
                        s["browser"].close()
                    except Exception:  # noqa: BLE001
                        pass
                resp.put(("ok", {"chiuso": True}))
                continue
            s = sessioni.get(ses) or apri(ses)
            page = s["page"]
            if azione == "vai":
                page.goto(a["url"], wait_until="domcontentloaded", timeout=30000)
                page.wait_for_timeout(600)
                resp.put(("ok", _br_stato(page)))
            elif azione == "clicca":
                if a.get("selettore"):
                    page.click(a["selettore"], timeout=6000)
                else:
                    page.get_by_text(a.get("testo") or "", exact=False).first.click(timeout=6000)
                page.wait_for_timeout(600)
                resp.put(("ok", _br_stato(page)))
            elif azione == "compila":
                if a.get("selettore"):
                    page.fill(a["selettore"], a.get("valore") or "", timeout=6000)
                else:
                    page.get_by_label(a.get("testo") or "").first.fill(a.get("valore") or "", timeout=6000)
                resp.put(("ok", {"ok": True}))
            elif azione == "estrai":
                dato = page.inner_text(a["selettore"], timeout=6000) if a.get("selettore") else page.inner_text("body")
                resp.put(("ok", {"dato": dato[:8000]}))
            else:
                resp.put(("err", f"azione sconosciuta: {azione}"))
        except Exception as e:  # noqa: BLE001 — l'errore torna all'operatore, che riprova o si ferma
            resp.put(("err", str(e)[:300]))


def _br_call(azione: str, a: dict, timeout: float = 120.0):
    if _BR["thread"] is None or not _BR["thread"].is_alive():
        _BR["thread"] = threading.Thread(target=_br_loop, daemon=True)
        _BR["thread"].start()
    resp: queue.Queue = queue.Queue()
    _BR["q"].put((azione, a, resp))
    try:
        stato, dato = resp.get(timeout=timeout)
    except queue.Empty:
        raise HTTPException(504, "il browser non ha risposto in tempo")
    if stato == "err":
        raise HTTPException(500, dato)
    return dato


class BrReq(BaseModel):
    sessione: str = "default"
    url: Optional[str] = None
    selettore: Optional[str] = None
    testo: Optional[str] = None
    valore: Optional[str] = None


@app.post("/br/vai")
def br_vai(r: BrReq):
    if not _chromium_ok():
        raise HTTPException(503, "Chromium non è installato: chiama prima /warmup.")
    if not r.url:
        raise HTTPException(400, "manca l'indirizzo (url)")
    return _br_call("vai", {"sessione": r.sessione, "url": r.url})


@app.post("/br/clicca")
def br_clicca(r: BrReq):
    return _br_call("clicca", {"sessione": r.sessione, "selettore": r.selettore, "testo": r.testo})


@app.post("/br/compila")
def br_compila(r: BrReq):
    return _br_call("compila", {"sessione": r.sessione, "selettore": r.selettore, "testo": r.testo, "valore": r.valore or ""})


@app.post("/br/estrai")
def br_estrai(r: BrReq):
    return _br_call("estrai", {"sessione": r.sessione, "selettore": r.selettore})


@app.post("/br/chiudi")
def br_chiudi(r: BrReq):
    return _br_call("chiudi", {"sessione": r.sessione}, timeout=20.0)


class CollaudoGioco(BaseModel):
    url: str


@app.post("/br/collauda-guida")
def collauda_guida(r: CollaudoGioco):
    """Collaudo senza sessioni, credenziali o accesso alla rete esterna."""
    if not re.fullmatch(r"http://127\.0\.0\.1:[1-9]\d{0,4}/[a-f0-9]{32}/", r.url):
        raise HTTPException(400, "Anteprima locale non valida.")
    if not _chromium_ok():
        raise HTTPException(503, "Prepara Chromium dal motore Regista web.")
    from playwright.sync_api import sync_playwright

    errors = []
    phase = "Apertura pagina"
    with sync_playwright() as pw:
        browser = pw.chromium.launch(executable_path=os.environ.get("IDEAX_CHROMIUM") or None)
        try:
            context = browser.new_context(service_workers="block", accept_downloads=False,
                                          viewport={"width": 1050, "height": 720})
            context.route("**/*", lambda route: route.continue_()
                          if route.request.url in (r.url, r.url + "azione") else route.abort())
            page = context.new_page()
            page.set_default_timeout(2500)
            page.on("pageerror", lambda err: errors.append((getattr(err, "stack", None) or str(err))[:350]))
            page.goto(r.url, timeout=5000)
            page.locator("#world").wait_for()
            initial = page.locator("#world").screenshot(animations="disabled")
            phase = "Click #start: atteso POST relativo a 'azione' con {azione:'avvia'}"
            with page.expect_response(lambda response: response.url == r.url + "azione") as started:
                page.locator("#start").click()
            if started.value.status != 200 or started.value.json() != {"x": 0, "z": 0, "score": 0}:
                raise AssertionError("Avvio: API attesa x=0 z=0 score=0")
            page.locator("#score").wait_for()
            phase = "Tasto ArrowRight: atteso POST relativo a 'azione' con {azione:'destra'}"
            with page.expect_response(lambda response: response.url == r.url + "azione") as advanced:
                page.keyboard.press("ArrowRight")
            if advanced.value.status != 200 or advanced.value.json() != {"x": 1, "z": 0, "score": 1}:
                raise AssertionError("Freccia destra: API attesa x=1 z=0 score=1")
            page.wait_for_function("document.querySelector('#score')?.textContent.trim() === '1'")
            changed = page.locator("#world").screenshot(animations="disabled")
            if initial == changed:
                raise AssertionError("Il canvas resta identico durante la guida.")
            def press(key):
                with page.expect_response(lambda response: response.url == r.url + "azione") as response:
                    page.keyboard.press(key)
                if response.value.status != 200:
                    raise AssertionError(f"{key}: HTTP {response.value.status}")
                state = response.value.json()
                page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
                return state

            phase = "Percorso completo: ogni freccia deve produrre un POST"
            last = None
            for key, count in [("ArrowRight", 3), ("ArrowUp", 3), ("ArrowLeft", 8),
                               ("ArrowUp", 1), ("ArrowLeft", 1), ("ArrowDown", 8),
                               ("ArrowRight", 9), ("ArrowDown", 1)]:
                for _ in range(count):
                    last = press(key)
            if last != {"x": 4, "z": 5, "score": 5}:
                raise AssertionError(f"Percorso completo: atteso il quinto checkpoint, ricevuto {last}")
            page.wait_for_function("document.querySelector('#score')?.textContent.trim() === '5'")
            phase = "Traguardo: attendono #vittoria visibile e riavvio"
            page.locator("#vittoria").wait_for()
            with page.expect_response(lambda response: response.url == r.url + "azione") as reset:
                page.locator("#start").click()
            if reset.value.json() != {"x": 0, "z": 0, "score": 0}:
                raise AssertionError("Il riavvio dopo la vittoria deve azzerare la partita.")
            if errors:
                raise AssertionError(errors[0])
            return {"ok": True, "casi": 6, "preview": base64.b64encode(changed).decode("ascii")}
        except Exception as exc:
            return {"ok": False, "errore": (phase + ": " + (errors[0] if errors else str(exc)))[:500]}
        finally:
            browser.close()


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=args.port)
