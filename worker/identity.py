"""IP-Adapter FaceID: tenere lo STESSO volto da una generazione all'altra.

Una LoRA cattura lo stile e l'aria di un volto, ma non lo BLOCCA: a ogni scena il modello ne ridisegna uno "simile
ma non lui". FaceID chiude il buco: insightface ricava l'impronta del volto (512 numeri) da una o piu' foto di
riferimento del personaggio, e l'IP-Adapter la IMPONE alla generazione SDXL. Cosi' il personaggio resta lo stesso in
venti scene diverse. insightface ideax lo installa gia' (serve al labiale), quindi qui non si aggiunge un peso nuovo.

Regola di casa: se qualcosa non c'e' o non riesce, NON si rompe la generazione — si salta FaceID e lo si dice a voce
alta (una LoRA da sola e' meglio di uno schermo nero). Non e' un ripiego muto: urla sempre il motivo.

NON PROVATO su GPU vera (qui non c'e'): l'API FaceID di diffusers e' delicata (forma dei tensori, LoRA di
accompagnamento). Chi lo collauda sul PC dello studio scriva qui com'e' andato.
"""
from __future__ import annotations

import io
import os
from typing import Callable, Optional

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))

# I pesi FaceID per SDXL. load_ip_adapter di diffusers li scarica da Hugging Face; il "base" porta con se' una LoRA di
# accompagnamento che va caricata insieme, o la somiglianza resta debole.
FACEID_REPO = "h94/IP-Adapter-FaceID"
FACEID_BIN = "ip-adapter-faceid_sdxl.bin"
FACEID_LORA = "ip-adapter-faceid_sdxl_lora.safetensors"
FACEID_LORA_ADAPTER = "faceid_lora"

_app = None  # insightface FaceAnalysis, una volta sola
_provato_install = False


def _assicura_insightface() -> bool:
    """Rende disponibile insightface NELL'AMBIENTE DEL WORKER, una volta sola. Best-effort: non solleva mai.

    FaceID gira nel worker principale, non nel motore del labiale, quindi insightface va installato qui. Si riusa
    l'installatore che c'e' gia' (copia il pacchetto senza compilare, worker/engines/install_insightface.py) piu'
    onnxruntime e le dipendenze Python. Se non riesce, si genera con la sola LoRA.
    """
    global _provato_install
    try:
        import insightface  # noqa: F401
        return True
    except Exception:  # noqa: BLE001
        pass
    if _provato_install:
        return False
    _provato_install = True
    try:
        import subprocess
        try:
            import onnxruntime  # noqa: F401
        except Exception:  # noqa: BLE001
            print("[ideax] FaceID: installo onnxruntime…", flush=True)
            subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "onnxruntime-gpu"], check=False)
            try:
                import onnxruntime  # noqa: F401
            except Exception:  # noqa: BLE001
                subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "onnxruntime"], check=False)
        subprocess.run([sys.executable, "-m", "pip", "install", "--disable-pip-version-check", "onnx", "scikit-image"], check=False)
        installer = os.path.join(HERE, "engines", "install_insightface.py")
        if os.path.exists(installer):
            print("[ideax] FaceID: installo insightface (la prima volta)…", flush=True)
            subprocess.run([sys.executable, installer], check=False)
        import importlib
        importlib.invalidate_caches()
        import insightface  # noqa: F401
        return True
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] FaceID: insightface non installabile ({err}); genero con la sola LoRA. "
              "Installa il motore Gemello video per averlo stabile.", flush=True)
        return False


def _insightface(gpu: bool):
    """FaceAnalysis di insightface, caricato pigramente e tenuto. None se insightface non c'e'."""
    global _app
    if _app is not None:
        return _app
    if not _assicura_insightface():
        return None
    try:
        from insightface.app import FaceAnalysis
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] FaceID: insightface non disponibile ({err}); genero senza bloccare il volto", flush=True)
        return None
    try:
        providers = (["CUDAExecutionProvider", "CPUExecutionProvider"] if gpu else ["CPUExecutionProvider"])
        app = FaceAnalysis(name="buffalo_l", providers=providers)
        app.prepare(ctx_id=0 if gpu else -1, det_size=(640, 640))
        _app = app
        return app
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] FaceID: non riesco ad avviare insightface ({err}); genero senza bloccare il volto", flush=True)
        return None


def _decode(dati: str) -> Optional[Image.Image]:
    """Una foto di riferimento da data-URL o base64 nudo."""
    try:
        import base64
        if "," in dati and dati.strip().startswith("data:"):
            dati = dati.split(",", 1)[1]
        return Image.open(io.BytesIO(base64.b64decode(dati))).convert("RGB")
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] FaceID: foto di riferimento illeggibile ({err})", flush=True)
        return None


def impronta(riferimenti: list[str], gpu: bool):
    """Da una o piu' foto di riferimento → il tensore d'identita' (2, N, 512) pronto per CFG, oppure None.

    (2, N, 512): la riga 0 e' il "negativo" a zero, la riga 1 e' l'impronta vera; diffusers vuole tutt'e due per la
    classifier-free guidance. Si media il volto PIU' GRANDE di ogni foto (il soggetto, non i volti sullo sfondo).
    """
    import numpy as np
    import torch

    app = _insightface(gpu)
    if app is None:
        return None
    try:
        import cv2
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] FaceID: manca OpenCV ({err}); genero senza bloccare il volto", flush=True)
        return None

    embeds = []
    for dato in riferimenti or []:
        img = _decode(dato)
        if img is None:
            continue
        bgr = cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
        volti = app.get(bgr)
        if not volti:
            continue
        volto = max(volti, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))  # il piu' grande
        embeds.append(torch.from_numpy(volto.normed_embedding).unsqueeze(0))  # (1, 512)
    if not embeds:
        print("[ideax] FaceID: nessun volto riconoscibile nelle foto di riferimento; genero senza bloccare il volto", flush=True)
        return None
    ref = torch.stack(embeds, dim=0)            # (N, 1, 512)
    ref = ref.mean(dim=0, keepdim=True)         # (1, 1, 512): media delle foto = identita' piu' stabile
    neg = torch.zeros_like(ref)
    return torch.cat([neg, ref], dim=0)          # (2, 1, 512)


def applica(pipe, riferimenti: list[str], scala: float, device, dtype) -> tuple[Optional[object], Callable[[], None]]:
    """Carica FaceID sulla pipe e torna (embeds_da_passare_a_pipe, pulizia()).

    embeds va messo in pipe(ip_adapter_image_embeds=[embeds]); pulizia() va chiamata nel finally, sempre. Se FaceID non
    si puo' applicare, torna (None, no-op): la generazione prosegue con la sola LoRA.
    """
    def niente():
        return None

    gpu = str(getattr(device, "type", device)) == "cuda"
    embeds = impronta(riferimenti, gpu)
    if embeds is None:
        return None, niente
    if not hasattr(pipe, "load_ip_adapter"):
        print("[ideax] FaceID: questa pipeline non supporta IP-Adapter; genero con la sola LoRA", flush=True)
        return None, niente
    try:
        pipe.load_ip_adapter(FACEID_REPO, subfolder=None, weight_name=FACEID_BIN, image_encoder_folder=None)
        # La LoRA di accompagnamento del FaceID (senza, la somiglianza resta molle). Si aggiunge agli adapter gia' attivi.
        try:
            pipe.load_lora_weights(FACEID_REPO, weight_name=FACEID_LORA, adapter_name=FACEID_LORA_ADAPTER)
        except Exception as err:  # noqa: BLE001
            print(f"[ideax] FaceID: LoRA di accompagnamento non caricata ({err}); somiglianza piu' debole", flush=True)
        pipe.set_ip_adapter_scale(float(scala))
        embeds = embeds.to(device=device, dtype=dtype)

        def pulizia():
            try:
                pipe.unload_ip_adapter()
            except Exception:  # noqa: BLE001
                pass
        return embeds, pulizia
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] FaceID: non applicato ({err}); genero con la sola LoRA", flush=True)
        return None, niente
