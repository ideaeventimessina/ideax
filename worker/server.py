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
import subprocess
import sys
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
    flux_variant: Optional[str] = None  # dev | schnell
    fp8: Optional[str] = None  # e4m3fn | e5m2: pesi FP8 da tenere compressi in memoria


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
    temperature: float = 0.2
    max_tokens: int = 1024


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


def use_offload(arch: str = "") -> bool:
    info = device_info()
    if info["device"] != "cuda":
        return False
    if OFFLOAD == "on":
        return True
    if OFFLOAD == "off":
        return False
    # Flux (transformer + encoder T5) e i modelli video superano i 16 GB: le parti non in uso vanno in RAM
    needed = 24 if arch in ("flux", "diffusers") else 16
    return (info["vram_gb"] or 0) < needed


def place(pipe):
    if use_offload(_loaded.get("arch") or ""):
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(device_info()["device"])
    return pipe


# ---------------------------------------------------------------- caricamento modelli

_loaded: dict[str, Any] = {"key": None, "pipe": None, "derived": {}, "arch": None, "variant": None}
HERE = os.path.dirname(os.path.abspath(__file__))


def free_memory():
    _loaded.update(key=None, pipe=None, derived={}, arch=None, variant=None)
    gc.collect()
    if not DEMO and torch().cuda.is_available():
        torch().cuda.empty_cache()


def flux_variant(spec: ModelSpec) -> str:
    """dev o schnell: dev ha l'ingresso "guidance" (guidance_in)."""
    if spec.flux_variant in ("dev", "schnell"):
        return spec.flux_variant
    if spec.path.lower().endswith(".gguf"):
        try:
            from gguf import GGUFReader

            names = (t.name for t in GGUFReader(spec.path).tensors)
            return "dev" if any("guidance_in" in n for n in names) else "schnell"
        except Exception as err:  # noqa: BLE001
            print(f"[ideax] non riesco a leggere il GGUF ({err}): suppongo Flux dev", flush=True)
    return "dev" if "schnell" not in os.path.basename(spec.path).lower() else "schnell"


def load_flux(spec: ModelSpec, dtype):
    """Flux da un singolo file (Civitai): il transformer dal file, il resto (VAE, encoder di testo) dal modello base.
    - la configurazione del transformer è inclusa in ideax: niente download dal repository protetto di FLUX.1-dev
    - dal modello base si scaricano solo i componenti che servono (circa 10 GB, una volta sola)
    - i pesi FP8 restano FP8 in memoria (circa 12 GB invece di 24) e si convertono strato per strato durante il calcolo
    """
    import diffusers as d
    import transformers as tf

    variant = flux_variant(spec)
    _loaded["variant"] = variant
    kwargs: dict[str, Any] = {"config": os.path.join(HERE, "flux", variant), "torch_dtype": dtype}
    if spec.path.lower().endswith(".gguf"):
        kwargs["quantization_config"] = d.GGUFQuantizationConfig(compute_dtype=dtype)
    print(f"[ideax] Flux {variant}: carico il transformer", flush=True)
    transformer = d.FluxTransformer2DModel.from_single_file(spec.path, **kwargs)
    if spec.fp8 and "quantization_config" not in kwargs and hasattr(transformer, "enable_layerwise_casting"):
        storage = torch().float8_e5m2 if spec.fp8 == "e5m2" else torch().float8_e4m3fn
        transformer.enable_layerwise_casting(storage_dtype=storage, compute_dtype=dtype)

    PROGRESS["phase"] = "Preparo VAE ed encoder di testo (la prima volta li scarico, circa 10 GB)"
    print(f"[ideax] componenti da {FLUX_BASE}", flush=True)
    sub = lambda cls, folder: cls.from_pretrained(FLUX_BASE, subfolder=folder, **({"torch_dtype": dtype} if folder not in ("tokenizer", "tokenizer_2", "scheduler") else {}))  # noqa: E731
    pipe = d.FluxPipeline(
        scheduler=sub(d.FlowMatchEulerDiscreteScheduler, "scheduler"),
        vae=sub(d.AutoencoderKL, "vae"),
        text_encoder=sub(tf.CLIPTextModel, "text_encoder"),
        tokenizer=sub(tf.CLIPTokenizer, "tokenizer"),
        text_encoder_2=sub(tf.T5EncoderModel, "text_encoder_2"),
        tokenizer_2=sub(tf.T5TokenizerFast, "tokenizer_2"),
        transformer=transformer,
    )
    if variant == "dev":
        # Lo scheduler del modello base (schnell) va adattato a dev
        pipe.scheduler = d.FlowMatchEulerDiscreteScheduler.from_config(
            pipe.scheduler.config, shift=3.0, use_dynamic_shifting=True,
            base_shift=0.5, max_shift=1.15, base_image_seq_len=256, max_image_seq_len=4096,
        )
    return pipe


def load_base(spec: ModelSpec):
    if _loaded["key"] == spec.path:
        return _loaded["pipe"]
    free_memory()
    # Con meno di 24 GB il cervello e un modello grafico insieme non ci stanno: il cervello si ricarica alla prossima chat
    if not DEMO and _llm.get("model") is not None and (device_info()["vram_gb"] or 0) < 24:
        free_llm()
    import diffusers as d

    dtype = dtype_for(spec.arch)
    PROGRESS["phase"] = "Carico il modello in memoria"
    print(f"[ideax] carico {spec.path} ({spec.arch})", flush=True)
    _loaded["arch"] = spec.arch
    if spec.arch == "flux" and spec.format != "diffusers":
        # Flux da file singolo, completo o solo transformer, FP8 o GGUF: stessa strada
        pipe = load_flux(spec, dtype)
    elif spec.format == "diffusers":
        pipe = d.DiffusionPipeline.from_pretrained(spec.path, torch_dtype=dtype)
    elif spec.arch in ("sd15", "sd2"):
        pipe = d.StableDiffusionPipeline.from_single_file(spec.path, torch_dtype=dtype)
    elif spec.arch == "sdxl":
        pipe = d.StableDiffusionXLPipeline.from_single_file(spec.path, torch_dtype=dtype)
    elif spec.arch == "sd3":
        pipe = d.StableDiffusion3Pipeline.from_single_file(spec.path, torch_dtype=dtype)
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
    is_svd = type(base).__name__ == "StableVideoDiffusionPipeline"
    if is_svd:
        # 25 fotogrammi; la decodifica a gruppi di 4 tiene la memoria della scheda sotto i 16 GB
        params.update(num_frames=25, decode_chunk_size=4, motion_bucket_id=127, noise_aug_strength=0.02, num_inference_steps=25, fps=7)
    if req.model.arch == "flux" and _loaded.get("variant") == "schnell":
        params.update(num_inference_steps=4, guidance_scale=0.0)
    if req.task == "animation" and req.motion:
        params.update(ANIMATION_DEFAULTS)
    params.update(req.params)
    fps = int(params.pop("fps", 8))
    seed = params.pop("seed", None)
    face_fix = str(params.pop("face_fix", True)).lower() not in ("false", "0", "no")
    skin_fix = str(params.pop("skin_fix", True)).lower() not in ("false", "0", "no")
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
        if is_svd:
            # SVD lavora a 1024×576: si segue l'orientamento della foto (verticale per i reel)
            w, h = img.size
            kwargs["width"], kwargs["height"] = (1024, 576) if w > h * 1.15 else (576, 1024) if h > w * 1.15 else (768, 768)
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
            # Secondo passaggio sui volti, con le stesse LoRA ancora caricate (il gemello resta riconoscibile)
            if req.task in ("image_generate", "image_edit") and getattr(result, "frames", None) is None and not is_svd:
                # Prima la pelle (ingrandimento + dettagli fini), poi i volti sull'immagine già ingrandita
                if skin_fix:
                    result.images = [refine_skin(img, base, req, params, seed) for img in result.images]
                if face_fix:
                    result.images = [refine_faces(img, base, req, params, seed) for img in result.images]
    finally:
        if adapters:
            pipe.unload_lora_weights()
    return encode_result(result, req.task, fps)


def _img2img(base):
    key = ("img2img",)
    if key not in _loaded["derived"]:
        import diffusers as d

        _loaded["derived"][key] = d.AutoPipelineForImage2Image.from_pipe(base)
    return _loaded["derived"][key]


SKIN_PROMPT = "natural skin texture, visible pores, fine details, realistic lighting, sharp focus, photographic, film photo"
SKIN_NEGATIVE = "plastic skin, airbrushed, smooth skin, waxy, cgi, 3d render, cartoon, blurry, oversaturated, deformed"


def refine_skin(img, base, req: RunRequest, params: dict, seed):
    """Rifinitura della pelle ("hires fix"): ingrandisce l'immagine e la ripassa con un img2img leggero, così il modello
    disegna pori, peli sottili e tessuti alla risoluzione più alta; poi una grana fotografica leggerissima toglie
    l'effetto plastica. La composizione resta la stessa. Se qualcosa va storto si tiene l'immagine com'era."""
    try:
        import numpy as np

        t = torch()
        i2i = _img2img(base)
        arch = req.model.arch
        scale = 2.0 if arch == "sd15" else 1.5
        w, h = img.size
        limit = 2048 if arch != "sd15" else 1280
        scale = min(scale, limit / max(w, h))
        if scale > 1.05:
            w, h = int(w * scale) // 64 * 64, int(h * scale) // 64 * 64
            big = img.convert("RGB").resize((w, h), Image.LANCZOS)
        else:
            big = img.convert("RGB")
        schnell = arch == "flux" and _loaded.get("variant") == "schnell"
        steps = 8 if schnell else max(int(params.get("num_inference_steps", 30)), 24)
        if hasattr(i2i, "vae") and hasattr(i2i.vae, "enable_tiling"):
            i2i.vae.enable_tiling()  # decodifica a pezzi: l'immagine grande sta nei 16 GB
        PROGRESS.update(phase="Rifinisco la pelle e i dettagli")
        kw = {
            "prompt": f"{req.prompt}, {SKIN_PROMPT}"[:900], "image": big, "strength": 0.45 if schnell else 0.3,
            "num_inference_steps": steps, "width": big.width, "height": big.height,
            "negative_prompt": ", ".join(x for x in (SKIN_NEGATIVE, req.negative_prompt) if x),
        }
        if "guidance_scale" in params:
            kw["guidance_scale"] = params["guidance_scale"]
        if seed is not None:
            kw["generator"] = t.Generator("cpu").manual_seed(int(seed))
        sig = inspect.signature(i2i.__call__).parameters
        out = i2i(**{k: v for k, v in kw.items() if k in sig}).images[0].convert("RGB")
        # Grana fotografica leggerissima (solo luminosità): niente superfici troppo lisce
        arr = np.asarray(out).astype(np.float32)
        rng = np.random.default_rng(int(seed) if seed is not None else None)
        arr += rng.normal(0, 2.2, arr.shape[:2])[..., None]
        print(f"[ideax] pelle rifinita a {out.width}×{out.height}", flush=True)
        return Image.fromarray(np.clip(arr, 0, 255).astype("uint8"))
    except Cancelled:
        raise
    except Exception as err:  # noqa: BLE001
        if "out of memory" in str(err).lower():
            free_cuda = torch().cuda.empty_cache if torch().cuda.is_available() else None
            if free_cuda:
                free_cuda()
        print(f"[ideax] rifinitura della pelle saltata: {err}", flush=True)
        return img


def refine_faces(img, base, req: RunRequest, params: dict, seed):
    """Ridisegna ad alta risoluzione i volti piccoli (worker/faces.py). Se qualcosa va storto si tiene l'immagine com'era."""
    try:
        import diffusers as d

        if HERE not in sys.path:
            sys.path.insert(0, HERE)
        from faces import FACE_NEGATIVE, FACE_PROMPT, fix_faces

        t = torch()
        i2i = _img2img(base)
        side = 512 if req.model.arch == "sd15" else 768 if req.model.arch == "sd2" else 1024
        schnell = req.model.arch == "flux" and _loaded.get("variant") == "schnell"
        steps = 8 if schnell else max(int(params.get("num_inference_steps", 30)), 24)
        sig = inspect.signature(i2i.__call__).parameters

        def redraw(crop):
            kw = {
                "prompt": f"{FACE_PROMPT}, {req.prompt}"[:900], "image": crop, "strength": 0.38 if not schnell else 0.5,
                "num_inference_steps": steps, "width": side, "height": side,
                "negative_prompt": ", ".join(x for x in (FACE_NEGATIVE, req.negative_prompt) if x),
            }
            if "guidance_scale" in params:
                kw["guidance_scale"] = params["guidance_scale"]
            if seed is not None:
                kw["generator"] = t.Generator("cpu").manual_seed(int(seed))
            kw = {k: v for k, v in kw.items() if k in sig}
            return i2i(**kw).images[0]

        out, n = fix_faces(img, redraw, side=side, progress=lambda ph: PROGRESS.update(phase=ph))
        if n:
            print(f"[ideax] volti rifiniti: {n}", flush=True)
        return out
    except Cancelled:
        raise
    except Exception as err:  # noqa: BLE001
        print(f"[ideax] rifinitura dei volti saltata: {err}", flush=True)
        return img


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
# La chat porta con sé memoria e conversazione: serve un contesto ampio
LLM_CTX = int(os.environ.get("IDEAX_LLM_CTX", "16384"))


def free_llm():
    with llm_lock:
        if _llm.get("model") is not None:
            _llm.update(path=None, model=None)
            gc.collect()
            if not DEMO and torch().cuda.is_available():
                torch().cuda.empty_cache()


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
            _llm.update(path=req.model_path, model=Llama(model_path=req.model_path, n_ctx=LLM_CTX, n_gpu_layers=LLM_GPU_LAYERS, verbose=False))
        fmt = {"type": "json_object", "schema": req.schema_} if req.schema_ else {"type": "json_object"}
        out = _llm["model"].create_chat_completion(messages=req.messages, response_format=fmt, temperature=req.temperature, max_tokens=min(req.max_tokens, 4096))
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


# ---------------------------------------------------------------- vettorizzazione per il laser

class VectorizeRequest(BaseModel):
    image: str  # PNG/JPG in base64 (anche data URL)
    width_mm: float
    height_mm: float
    mode: str = "taglio"  # taglio | incisione
    min_mm: float = 3.0
    gap_mm: float = 2.0
    threshold: int = 128


class DecorateRequest(BaseModel):
    image: str
    width_mm: float
    height_mm: float
    min_mm: float = 3.0
    gap_mm: float = 2.0


@app.post("/decorate")
def decorate_endpoint(req: DecorateRequest):
    """Illustrazione su fondo bianco → pezzo vero: contorno da tagliare + dettagli da incidere, in mm."""
    import sys

    if HERE not in sys.path:
        sys.path.insert(0, HERE)
    from vectorize import decorate

    raw = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
    try:
        return decorate(base64.b64decode(raw), req.width_mm, req.height_mm, req.min_mm, req.gap_mm)
    except ValueError as err:
        raise HTTPException(400, str(err))


@app.post("/vectorize")
def vectorize_endpoint(req: VectorizeRequest):
    import sys

    if HERE not in sys.path:  # il Python "embeddable" di Windows non aggiunge la cartella dello script
        sys.path.insert(0, HERE)
    from vectorize import vectorize

    raw = req.image.split(",", 1)[1] if req.image.startswith("data:") else req.image
    try:
        return vectorize(base64.b64decode(raw), req.width_mm, req.height_mm, req.mode, req.min_mm, req.gap_mm, req.threshold)
    except ValueError as err:
        raise HTTPException(400, str(err))


# ---------------------------------------------------------------- montaggio dei reel

compose_lock = threading.Lock()
COMPOSE: dict[str, Any] = {"frame": 0, "frames": 0}

FONT_CANDIDATES = [
    "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
]


class ComposeScene(BaseModel):
    image: str
    start: float
    duration: float


class ComposeCaption(BaseModel):
    text: str
    start: float
    end: float


class ComposeRequest(BaseModel):
    scenes: list[ComposeScene]
    captions: list[ComposeCaption] = []
    voice: Optional[str] = None
    music: Optional[str] = None
    output: str
    width: int = 1080
    height: int = 1920
    fps: int = 30
    music_volume: float = 0.18
    caption_position: float = 0.70  # altezza del centro dei sottotitoli, da 0 (alto) a 1 (basso)


def load_font(size: int):
    from PIL import ImageFont

    for f in FONT_CANDIDATES:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    try:
        return ImageFont.load_default(size=size)  # Pillow 10.1+: carattere scalabile incluso
    except TypeError:
        return ImageFont.load_default()


def cover(img: Image.Image, w: int, h: int) -> Image.Image:
    """Ridimensiona e ritaglia l'immagine per riempire w×h senza bande nere."""
    img = img.convert("RGB")
    scale = max(w / img.width, h / img.height)
    img = img.resize((max(w, round(img.width * scale)), max(h, round(img.height * scale))), Image.LANCZOS)
    left, top = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def caption_overlay(text: str, w: int, h: int, pos: float) -> Image.Image:
    """Sottotitolo grande, bianco con contorno nero, centrato e su più righe se serve."""
    size = round(w * 0.068)
    font = load_font(size)
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    words, lines, cur = text.split(), [], ""
    for word in words:
        test = f"{cur} {word}".strip()
        if d.textlength(test, font=font) <= w * 0.84 or not cur:
            cur = test
        else:
            lines.append(cur)
            cur = word
    if cur:
        lines.append(cur)
    line_h = round(size * 1.22)
    y = round(h * pos - line_h * len(lines) / 2)
    for line in lines:
        tw = d.textlength(line, font=font)
        d.text(((w - tw) / 2, y), line, font=font, fill=(255, 255, 255, 255),
               stroke_width=max(4, size // 11), stroke_fill=(0, 0, 0, 255))
        y += line_h
    return layer


@app.get("/compose/progress")
def compose_progress():
    return dict(COMPOSE)


@app.post("/compose")
def compose(req: ComposeRequest):
    """Monta il reel: immagini con zoom lento (effetto Ken Burns), sottotitoli, voce e musica sotto la voce."""
    import imageio.v2 as imageio
    import imageio_ffmpeg
    import numpy as np

    W, H, fps = req.width, req.height, req.fps
    total = max(s.start + s.duration for s in req.scenes)
    frames = int(round(total * fps))
    with compose_lock:
        COMPOSE.update(frame=0, frames=frames)
        # Ogni scena: immagine un po' più grande dell'inquadratura, per poter zoomare e spostarsi
        bases = [cover(Image.open(s.image), round(W * 1.12), round(H * 1.12)) for s in req.scenes]
        overlays = [(c, caption_overlay(c.text, W, H, req.caption_position)) for c in req.captions]
        silent = req.output + ".video.mp4"
        writer = imageio.get_writer(silent, fps=fps, codec="libx264", quality=8, macro_block_size=8,
                                    ffmpeg_params=["-pix_fmt", "yuv420p", "-preset", "veryfast"])
        try:
            for i in range(frames):
                t = i / fps
                k = next((j for j, s in enumerate(req.scenes) if s.start <= t < s.start + s.duration), len(req.scenes) - 1)
                s, base = req.scenes[k], bases[k]
                p = min(1.0, max(0.0, (t - s.start) / max(s.duration, 0.01)))
                p = p * p * (3 - 2 * p)  # movimento morbido all'inizio e alla fine
                # Scene alterne: zoom in e zoom out, con un leggero spostamento laterale
                zoom = 1.0 + 0.10 * (p if k % 2 == 0 else 1 - p)
                cw, ch = round(base.width / zoom / 1.0), round(base.height / zoom / 1.0)
                cw, ch = min(cw, base.width), min(ch, base.height)
                pan = (p - 0.5) * (base.width - cw) * (0.6 if k % 3 == 1 else -0.6 if k % 3 == 2 else 0)
                left = max(0, min(base.width - cw, round((base.width - cw) / 2 + pan)))
                top = (base.height - ch) // 2
                frame = base.crop((left, top, left + cw, top + ch)).resize((W, H), Image.BILINEAR)
                for c, ov in overlays:
                    if c.start <= t < c.end:
                        frame.paste(ov, (0, 0), ov)
                        break
                writer.append_data(np.asarray(frame))
                COMPOSE["frame"] = i + 1
        finally:
            writer.close()

        # Audio: voce in primo piano, musica bassa con dissolvenze
        ff = imageio_ffmpeg.get_ffmpeg_exe()
        cmd = [ff, "-y", "-i", silent]
        filters, labels = [], []
        if req.voice:
            cmd += ["-i", req.voice]
            labels.append(f"[{len(labels) + 1}:a]")
        if req.music:
            cmd += ["-stream_loop", "-1", "-i", req.music]
            idx = len(labels) + 1
            fade_out = max(0.0, total - 2.0)
            filters.append(f"[{idx}:a]volume={req.music_volume},afade=t=in:d=1,afade=t=out:st={fade_out:.2f}:d=2[m]")
            labels.append("[m]")
        if labels:
            if len(labels) > 1:
                filters.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=longest:normalize=0[a]")
            else:
                filters.append(f"{labels[0]}anull[a]")
            cmd += ["-filter_complex", ";".join(filters), "-map", "0:v", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
        cmd += ["-c:v", "copy", "-t", f"{total:.2f}", "-movflags", "+faststart", req.output]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        os.remove(silent)
        if proc.returncode != 0:
            raise HTTPException(500, f"Montaggio non riuscito: {proc.stderr[-600:]}")
        # Copertina: il primo fotogramma con il titolo, utile per l'anteprima
        COMPOSE.update(frame=0, frames=0)
    return {"output": req.output, "seconds": round(total, 2), "frames": frames}


@app.post("/unload")
def unload():
    """Libera la memoria della scheda video (ideax lo chiede prima di lavori pesanti come la musica)."""
    with gen_lock:
        free_memory()
    free_llm()
    return {"ok": True}


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
    return {**info, "demo": DEMO, "loaded": _loaded["key"], "llm_available": llm_ok, "offload": use_offload(_loaded.get("arch") or "")}


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("IDEAX_WORKER_HOST", "127.0.0.1"), port=int(os.environ.get("IDEAX_WORKER_PORT", "7861")))
