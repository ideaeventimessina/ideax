"""
ideax worker: esegue sul tuo PC i modelli scaricati (Civitai, Hugging Face) con diffusers,
e il "cervello" .gguf con llama.cpp. Nessuna API esterna.

Avvio:  python worker/server.py        (porta 7861)
Variabili utili:
  IDEAX_WORKER_PORT   porta (default 7861)
  IDEAX_OFFLOAD       auto | on | off  — sposta parti del modello in RAM per GPU con poca VRAM
  IDEAX_FLUX_BASE     modello base per i checkpoint Flux che contengono solo il transformer
  IDEAX_LLM_GPU_LAYERS  strati del LLM sulla GPU (-1 = tutti, 0 = solo CPU)
  IDEAX_DEMO=1        modalità prova: niente GPU, genera immagini finte (serve per testare l'interfaccia)
"""
from __future__ import annotations

import base64
import gc
import inspect
import io
import os
import tempfile
import threading
import time
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image, ImageDraw
from pydantic import BaseModel, Field

DEMO = os.environ.get("IDEAX_DEMO") == "1"
OFFLOAD = os.environ.get("IDEAX_OFFLOAD", "auto")
FLUX_BASE = os.environ.get("IDEAX_FLUX_BASE", "black-forest-labs/FLUX.1-schnell")
LLM_GPU_LAYERS = int(os.environ.get("IDEAX_LLM_GPU_LAYERS", "-1"))

app = FastAPI(title="ideax worker")
gen_lock = threading.Lock()

# Avanzamento del lavoro in corso, letto da ideax per mostrare "19 di 30 passi"
PROGRESS: dict[str, Any] = {"step": 0, "total": 0, "phase": None, "cancel": False}


class Cancelled(Exception):
    pass
llm_lock = threading.Lock()

# Impostazioni di partenza per famiglia di modello (sovrascrivibili con "params")
ARCH_DEFAULTS = {
    "sd15": {"num_inference_steps": 25, "guidance_scale": 7.0, "width": 512, "height": 512},
    "sd2": {"num_inference_steps": 25, "guidance_scale": 7.0, "width": 768, "height": 768},
    "sdxl": {"num_inference_steps": 30, "guidance_scale": 6.0, "width": 1024, "height": 1024},
    "sd3": {"num_inference_steps": 28, "guidance_scale": 7.0, "width": 1024, "height": 1024},
    "flux": {"num_inference_steps": 20, "guidance_scale": 3.5, "width": 1024, "height": 1024},
}
ANIMATION_DEFAULTS = {"num_frames": 16, "width": 512, "height": 512, "num_inference_steps": 25, "guidance_scale": 7.5}


class ModelSpec(BaseModel):
    path: str
    format: str = "single"  # single | diffusers
    arch: str = "unknown"
    pipeline_class: Optional[str] = None
    transformer_only: bool = False


class Lora(BaseModel):
    path: str
    weight: float = 0.8


class RunRequest(BaseModel):
    model: ModelSpec
    task: str
    prompt: str = ""
    negative_prompt: str = ""
    image: Optional[str] = None
    video: Optional[str] = None
    loras: list[Lora] = []
    motion: Optional[str] = None
    params: dict[str, Any] = {}


class LlmRequest(BaseModel):
    model_path: str
    messages: list[dict[str, str]]
    schema_: Optional[dict] = Field(None, alias="schema")


# ---------------------------------------------------------------- dispositivo

_torch = None


def torch():
    global _torch
    if _torch is None:
        import torch as t
        _torch = t
    return _torch


def device_info():
    if DEMO:
        return {"device": "demo", "gpu": None, "vram_gb": None}
    t = torch()
    if t.cuda.is_available():
        props = t.cuda.get_device_properties(0)
        return {"device": "cuda", "gpu": props.name, "vram_gb": round(props.total_memory / 1024**3, 1)}
    if getattr(t.backends, "mps", None) and t.backends.mps.is_available():
        return {"device": "mps", "gpu": "Apple Silicon", "vram_gb": None}
    return {"device": "cpu", "gpu": None, "vram_gb": None}


def dtype_for(arch: str):
    t = torch()
    dev = device_info()["device"]
    if dev == "cpu":
        return t.float32
    if dev == "cuda" and arch in ("flux", "sd3", "diffusers") and t.cuda.is_bf16_supported():
        return t.bfloat16
    return t.float16


def use_offload() -> bool:
    info = device_info()
    if info["device"] != "cuda":
        return False
    if OFFLOAD == "on":
        return True
    if OFFLOAD == "off":
        return False
    return (info["vram_gb"] or 0) < 16


def place(pipe):
    if use_offload():
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(device_info()["device"])
    return pipe


# ---------------------------------------------------------------- caricamento modelli

_loaded: dict[str, Any] = {"key": None, "pipe": None, "derived": {}}


def free_memory():
    _loaded.update(key=None, pipe=None, derived={})
    gc.collect()
    if not DEMO and torch().cuda.is_available():
        torch().cuda.empty_cache()


def load_base(spec: ModelSpec):
    if _loaded["key"] == spec.path:
        return _loaded["pipe"]
    free_memory()
    import diffusers as d

    dtype = dtype_for(spec.arch)
    PROGRESS["phase"] = "Carico il modello in memoria"
    print(f"[ideax] carico {spec.path} ({spec.arch})", flush=True)
    if spec.format == "gguf" and spec.arch == "flux":
        # Flux compresso (GGUF, molto diffuso su Civitai): serve il pacchetto "gguf"
        transformer = d.FluxTransformer2DModel.from_single_file(
            spec.path, quantization_config=d.GGUFQuantizationConfig(compute_dtype=dtype), torch_dtype=dtype
        )
        pipe = d.FluxPipeline.from_pretrained(FLUX_BASE, transformer=transformer, torch_dtype=dtype)
    elif spec.format == "diffusers":
        pipe = d.DiffusionPipeline.from_pretrained(spec.path, torch_dtype=dtype)
    elif spec.arch in ("sd15", "sd2"):
        pipe = d.StableDiffusionPipeline.from_single_file(spec.path, torch_dtype=dtype)
    elif spec.arch == "sdxl":
        pipe = d.StableDiffusionXLPipeline.from_single_file(spec.path, torch_dtype=dtype)
    elif spec.arch == "sd3":
        pipe = d.StableDiffusion3Pipeline.from_single_file(spec.path, torch_dtype=dtype)
    elif spec.arch == "flux":
        if spec.transformer_only:
            transformer = d.FluxTransformer2DModel.from_single_file(spec.path, torch_dtype=dtype)
            pipe = d.FluxPipeline.from_pretrained(FLUX_BASE, transformer=transformer, torch_dtype=dtype)
        else:
            pipe = d.FluxPipeline.from_single_file(spec.path, torch_dtype=dtype)
    else:
        raise HTTPException(400, "Architettura del modello sconosciuta: indicala nella pagina Modelli.")
    _loaded.update(key=spec.path, pipe=pipe, derived={})
    return pipe


def accepts(pipe, name: str) -> bool:
    return name in inspect.signature(pipe.__call__).parameters


def runner_for(req: RunRequest, base):
    """Sceglie la pipeline da chiamare: la base, una variante img2img o AnimateDiff con il modulo di movimento."""
    import diffusers as d

    if req.task == "animation" and req.motion and req.model.format == "single":
        key = ("anim", req.motion)
        if key not in _loaded["derived"]:
            adapter = d.MotionAdapter.from_single_file(req.motion, torch_dtype=dtype_for(req.model.arch))
            pipe = d.AnimateDiffPipeline.from_pipe(base, motion_adapter=adapter)
            pipe.scheduler = d.DDIMScheduler.from_config(
                pipe.scheduler.config, beta_schedule="linear", clip_sample=False, timestep_spacing="linspace", steps_offset=1
            )
            _loaded["derived"][key] = pipe
        return _loaded["derived"][key]
    if req.task == "image_edit" and req.image and not accepts(base, "image"):
        key = ("img2img",)
        if key not in _loaded["derived"]:
            _loaded["derived"][key] = d.AutoPipelineForImage2Image.from_pipe(base)
        return _loaded["derived"][key]
    return base


# ---------------------------------------------------------------- input / output

def decode_data_url(data_url: str) -> bytes:
    return base64.b64decode(data_url.split(",", 1)[1])


def fit(img: Image.Image, target: int) -> Image.Image:
    img = img.convert("RGB")
    scale = target / max(img.size)
    w, h = (int(img.width * scale) // 64 * 64 or 64, int(img.height * scale) // 64 * 64 or 64)
    return img.resize((w, h), Image.LANCZOS)


def load_video_frames(data_url: str, max_frames: int = 49) -> list[Image.Image]:
    import imageio.v3 as iio

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        f.write(decode_data_url(data_url))
        name = f.name
    try:
        frames = [Image.fromarray(fr) for i, fr in enumerate(iio.imiter(name)) if i < max_frames]
    finally:
        os.unlink(name)
    return frames


def to_pil(frame) -> Image.Image:
    if isinstance(frame, Image.Image):
        return frame
    import numpy as np

    arr = np.asarray(frame)
    if arr.dtype != np.uint8:
        arr = (np.clip(arr, 0, 1) * 255).round().astype("uint8")
    if arr.ndim == 3 and arr.shape[0] in (1, 3) and arr.shape[-1] not in (1, 3):
        arr = arr.transpose(1, 2, 0)
    return Image.fromarray(arr)


def encode_png(img: Image.Image) -> dict:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {"type": "image/png", "data": base64.b64encode(buf.getvalue()).decode()}


def encode_gif(frames: list[Image.Image], fps: int) -> dict:
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=int(1000 / fps), loop=0)
    return {"type": "image/gif", "data": base64.b64encode(buf.getvalue()).decode()}


def encode_mp4(frames: list[Image.Image], fps: int) -> dict:
    import imageio.v2 as imageio
    import numpy as np

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        name = f.name
    try:
        writer = imageio.get_writer(name, fps=fps, codec="libx264", quality=8, macro_block_size=8)
        for fr in frames:
            writer.append_data(np.asarray(fr.convert("RGB")))
        writer.close()
        with open(name, "rb") as fh:
            data = fh.read()
    finally:
        os.unlink(name)
    return {"type": "video/mp4", "data": base64.b64encode(data).decode()}


def encode_result(result, task: str, fps: int) -> list[dict]:
    frames = getattr(result, "frames", None)
    if frames is None:
        return [encode_png(to_pil(img)) for img in result.images]
    if isinstance(frames, list):
        clips = frames if frames and isinstance(frames[0], (list, tuple)) else [frames]
    else:
        import numpy as np

        arr = np.asarray(frames)
        clips = arr if arr.ndim == 5 else [arr]
    out = []
    for clip in clips:
        seq = [to_pil(f) for f in clip]
        out.append(encode_mp4(seq, fps))
        if task == "animation":
            out.append(encode_gif(seq, fps))
    return out


# ---------------------------------------------------------------- generazione

def run_real(req: RunRequest) -> list[dict]:
    t = torch()
    base = load_base(req.model)
    pipe = runner_for(req, base)
    place(pipe)

    params = dict(ARCH_DEFAULTS.get(req.model.arch, {}))
    if req.task == "animation" and req.motion:
        params.update(ANIMATION_DEFAULTS)
    params.update(req.params)
    fps = int(params.pop("fps", 8))
    seed = params.pop("seed", None)
    aspect = params.pop("aspect", None)
    if aspect and "width" in params and "height" in params:
        # Stessa quantità di pixel del formato nativo, con le proporzioni richieste (multipli di 64)
        a, b = (float(x) for x in str(aspect).split(":"))
        area = params["width"] * params["height"]
        params["width"] = max(64, round((area * a / b) ** 0.5 / 64) * 64)
        params["height"] = max(64, round((area * b / a) ** 0.5 / 64) * 64)

    kwargs: dict[str, Any] = {"prompt": req.prompt, **params}
    if req.negative_prompt:
        kwargs["negative_prompt"] = req.negative_prompt
    if seed is not None:
        kwargs["generator"] = t.Generator("cpu").manual_seed(int(seed))
    if req.image:
        img = Image.open(io.BytesIO(decode_data_url(req.image)))
        img = fit(img, max(params.get("width", 1024), params.get("height", 1024)))
        kwargs["image"] = img
        kwargs.pop("width", None)
        kwargs.pop("height", None)
        if req.task == "image_edit":
            kwargs.setdefault("strength", 0.6)
    if req.video:
        kwargs["video"] = load_video_frames(req.video)

    sig = inspect.signature(pipe.__call__).parameters
    PROGRESS.update(step=0, total=int(kwargs.get("num_inference_steps") or 0), phase="Genero")
    if "callback_on_step_end" in sig:
        def on_step(_pipe, i, _t, cb_kwargs):
            PROGRESS["step"] = i + 1
            if PROGRESS["cancel"]:
                raise Cancelled()
            return cb_kwargs

        kwargs["callback_on_step_end"] = on_step

    # Passa solo i parametri che la pipeline accetta (ogni modello ne ha di diversi)
    if not any(p.kind == p.VAR_KEYWORD for p in sig.values()):
        dropped = [k for k in kwargs if k not in sig]
        kwargs = {k: v for k, v in kwargs.items() if k in sig}
        if dropped:
            print(f"[ideax] parametri ignorati da questo modello: {dropped}", flush=True)

    adapters = []
    if req.loras and hasattr(pipe, "load_lora_weights"):
        for i, lora in enumerate(req.loras):
            name = f"lora{i}"
            pipe.load_lora_weights(lora.path, adapter_name=name)
            adapters.append((name, lora.weight))
        pipe.set_adapters([a for a, _ in adapters], adapter_weights=[w for _, w in adapters])
    try:
        with t.inference_mode():
            result = pipe(**kwargs)
    finally:
        if adapters:
            pipe.unload_lora_weights()
    return encode_result(result, req.task, fps)


def run_demo(req: RunRequest) -> list[dict]:
    """Immagini finte per provare l'interfaccia senza GPU."""
    colors = [(124, 108, 255), (62, 207, 142), (255, 159, 67), (255, 107, 107)]

    def frame(i: int, n: int) -> Image.Image:
        img = Image.new("RGB", (512, 512), colors[i % len(colors)] if n == 1 else colors[0])
        d = ImageDraw.Draw(img)
        if n > 1:
            x = int(40 + 400 * i / max(n - 1, 1))
            d.ellipse((x, 220, x + 72, 292), fill=(255, 255, 255))
        d.text((16, 16), f"DEMO {req.task}\n{os.path.basename(req.model.path)}\n{req.prompt[:200]}", fill=(255, 255, 255))
        return img

    steps = int(req.params.get("num_inference_steps", 12))
    PROGRESS.update(step=0, total=steps, phase="Genero")
    for i in range(steps):
        time.sleep(float(os.environ.get("IDEAX_DEMO_STEP", "0.05")))
        PROGRESS["step"] = i + 1
        if PROGRESS["cancel"]:
            raise Cancelled()
    if req.task in ("animation", "image_to_video", "video_generate", "video_edit"):
        frames = [frame(i, 12) for i in range(12)]
        out = [encode_mp4(frames, 8)]
        if req.task == "animation":
            out.append(encode_gif(frames, 8))
        return out
    return [encode_png(frame(0, 1))]


@app.post("/run")
def run(req: RunRequest):
    start = time.time()
    with gen_lock:
        PROGRESS.update(step=0, total=0, phase="Preparo", cancel=False)
        try:
            outputs = run_demo(req) if DEMO else run_real(req)
        except HTTPException:
            raise
        except Cancelled:
            raise HTTPException(409, "Annullato")
        except Exception as err:  # errori di caricamento/VRAM → messaggio leggibile
            if not DEMO and "out of memory" in str(err).lower():
                free_memory()
                raise HTTPException(500, "Memoria della GPU esaurita: prova una risoluzione più bassa o meno frame.")
            raise HTTPException(500, f"{type(err).__name__}: {err}")
        finally:
            PROGRESS.update(step=0, total=0, phase=None, cancel=False)
            # Restituisce al sistema la memoria della GPU non più usata (il modello resta caricato)
            if not DEMO and torch().cuda.is_available():
                torch().cuda.empty_cache()
    return {"outputs": outputs, "seconds": time.time() - start, "device": device_info()["device"]}


# ---------------------------------------------------------------- cervello (LLM .gguf)

_llm: dict[str, Any] = {"path": None, "model": None}


@app.post("/llm")
def llm(req: LlmRequest):
    if DEMO:
        raise HTTPException(503, "LLM non disponibile in modalità demo")
    try:
        from llama_cpp import Llama
    except ImportError:
        raise HTTPException(503, "Per usare un cervello .gguf installa llama-cpp-python (vedi README).")
    with llm_lock:
        if _llm["path"] != req.model_path:
            _llm.update(path=None, model=None)
            gc.collect()
            _llm.update(path=req.model_path, model=Llama(model_path=req.model_path, n_ctx=8192, n_gpu_layers=LLM_GPU_LAYERS, verbose=False))
        fmt = {"type": "json_object", "schema": req.schema_} if req.schema_ else {"type": "json_object"}
        out = _llm["model"].create_chat_completion(messages=req.messages, response_format=fmt, temperature=0.2, max_tokens=1024)
    return {"content": out["choices"][0]["message"]["content"]}


# ---------------------------------------------------------------- traduttore locale

_tr: dict[str, Any] = {"model": None, "tok": None}
tr_lock = threading.Lock()
TRANSLATOR = os.environ.get("IDEAX_TRANSLATOR", "Helsinki-NLP/opus-mt-it-en")


class TranslateRequest(BaseModel):
    text: str


@app.post("/translate")
def translate(req: TranslateRequest):
    """Traduce il prompt dall'italiano all'inglese con un modello piccolo (circa 300 MB) che gira sul processore:
    i modelli SD/SDXL capiscono solo l'inglese. Si scarica da Hugging Face la prima volta, poi funziona offline."""
    if DEMO:
        return {"text": req.text}
    with tr_lock:
        if _tr["model"] is None:
            from transformers import MarianMTModel, MarianTokenizer

            print(f"[ideax] carico il traduttore {TRANSLATOR}", flush=True)
            _tr["tok"] = MarianTokenizer.from_pretrained(TRANSLATOR)
            _tr["model"] = MarianMTModel.from_pretrained(TRANSLATOR).eval()
        tok, model = _tr["tok"], _tr["model"]
        # Frase per frase: il modello rende meglio su testi brevi
        parts = [p.strip() for p in req.text.replace("\n", ". ").split(".") if p.strip()]
        with torch().inference_mode():
            batch = tok(parts, return_tensors="pt", padding=True, truncation=True, max_length=256)
            out = model.generate(**batch, max_new_tokens=256, num_beams=4)
        text = ". ".join(tok.decode(o, skip_special_tokens=True).rstrip(".") for o in out)
    return {"text": text}


@app.get("/progress")
def progress():
    return {k: PROGRESS[k] for k in ("step", "total", "phase")}


@app.post("/cancel")
def cancel():
    if PROGRESS["phase"]:
        PROGRESS["cancel"] = True
    return {"ok": True}


@app.get("/health")
def health():
    info = device_info()
    if info["device"] == "cuda":
        free, _ = torch().cuda.mem_get_info()
        info["vram_free_gb"] = round(free / 1024**3, 1)
    try:
        import llama_cpp  # noqa: F401
        llm_ok = True
    except ImportError:
        llm_ok = False
    return {**info, "demo": DEMO, "loaded": _loaded["key"], "llm_available": llm_ok, "offload": use_offload()}


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("IDEAX_WORKER_HOST", "127.0.0.1"), port=int(os.environ.get("IDEAX_WORKER_PORT", "7861")))
