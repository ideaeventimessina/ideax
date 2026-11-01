// Gestore dei motori: voce, musica, lip-sync… Ogni motore ha il suo ambiente Python separato
// (le librerie dei vari modelli sono incompatibili tra loro), si installa con un clic,
// si accende quando serve e si spegne da solo quando non lavora, per liberare la scheda video.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, APP_ROOT, DATA_DIR, MODELS_DIR, getSettings } from './store.js';
import { detectGpu } from './runtime.js';
import { snapshot, intoCache } from './hfdownload.js';

const IS_WIN = process.platform === 'win32';
const ENGINES_DIR = path.join(ROOT, 'runtime', 'engines');
const UV_DIR = path.join(ROOT, 'runtime', 'uv');
const IDLE_MS = 10 * 60 * 1000;
// La musica carica ~10 GB di modelli: la teniamo accesa più a lungo (se serve la GPU per immagini/video si spegne comunque)
const IDLE_MS_BY_ID = { music: 30 * 60 * 1000 };

// PyTorch 2.6 (richiesto da Chatterbox) esiste per CUDA 11.8, 12.4 e 12.6
function torchIndex(gpu) {
  if (gpu.vendor !== 'nvidia') return 'https://download.pytorch.org/whl/cpu';
  const major = Number(String(gpu.driver).split('.')[0]) || 0;
  if (major >= 560) return 'https://download.pytorch.org/whl/cu126';
  if (major >= 550) return 'https://download.pytorch.org/whl/cu124';
  return 'https://download.pytorch.org/whl/cu118';
}

export const CATALOG = {
  voice: {
    id: 'voice',
    name: 'Voce',
    model: 'Chatterbox Multilingual · Resemble AI',
    license: 'MIT, uso commerciale consentito',
    description: 'Clona una voce da 10–30 secondi di audio e legge qualsiasi testo con quella voce, in 23 lingue, italiano compreso.',
    sizeGb: 7,
    port: 7871,
    python: '3.11',
    script: 'worker/engines/voice_server.py',
    packages: (gpu) => [
      { label: 'PyTorch per la scheda video', args: ['torch==2.6.0', 'torchaudio==2.6.0', '--index-url', torchIndex(gpu)] },
      // Le dipendenze di Chatterbox una per una, senza pkuseg (solo cinese, su Windows va compilato e fallisce)
      // e senza gradio (interfaccia web che non ci serve): il codice di Chatterbox le tratta come facoltative.
      {
        label: 'Librerie audio',
        args: [
          'numpy>=1.24,<1.26', 'librosa==0.11.0', 's3tokenizer', 'transformers==4.46.3', 'diffusers==0.29.0',
          'resemble-perth==1.0.1', 'conformer==0.3.2', 'safetensors==0.5.3', 'pykakasi==2.3.0', 'einops',
          // resemble-perth (filigrana audio) usa yaml e pkg_resources senza dichiararli tra le dipendenze
          'pyyaml', 'setuptools<81',
          'fastapi', 'uvicorn', 'soundfile', 'imageio-ffmpeg',
          // Solo pacchetti già pronti: niente compilazioni, che su Windows senza strumenti di sviluppo falliscono
          '--only-binary', ':all:',
        ],
      },
      { label: 'Chatterbox', args: ['chatterbox-tts==0.1.4', '--no-deps'] },
    ],
    available: true,
  },
  // ACE-Step 1.5: si installa il progetto ufficiale (versione fissa) con il suo lockfile, poi si usa il suo server REST
  music: {
    id: 'music',
    name: 'Musica',
    model: 'ACE-Step 1.5',
    license: 'MIT, uso commerciale consentito',
    description: 'Basi, sottofondi e jingle della durata che serve (da 10 secondi a 10 minuti), anche canzoni con testo in italiano.',
    sizeGb: 18,
    port: 7872,
    python: '3.11',
    type: 'project',
    source: {
      ref: 'ca1e85fe9430179831e6bc6be790c332190a3866',
      url: 'https://github.com/ace-step/ACE-Step-1.5/archive/ca1e85fe9430179831e6bc6be790c332190a3866.zip',
    },
    // I modelli stanno fuori dalla cartella del programma: reinstallando non si riscaricano.
    // Il server di ACE-Step li cerca in <ACESTEP_PROJECT_ROOT>/checkpoints (ignora ACESTEP_CHECKPOINTS_DIR),
    // quindi la "radice del progetto" è una cartella stabile e i modelli stanno nella sua sottocartella checkpoints.
    dataRoot: () => path.join(ENGINES_DIR, 'music-data'),
    checkpoints: () => path.join(ENGINES_DIR, 'music-data', 'checkpoints'),
    postInstall: (id) => ({ label: 'Scarico i modelli musicali (circa 10 GB)', args: ['-m', 'acestep.model_downloader', '--dir', CATALOG[id].checkpoints()] }),
    startArgs: (e) => ['-m', 'acestep.api_server', '--host', '127.0.0.1', '--port', String(e.port)],
    env: (e) => ({
      ACESTEP_PROJECT_ROOT: e.dataRoot(),
      ACESTEP_CHECKPOINTS_DIR: e.checkpoints(),
      ACESTEP_TMPDIR: path.join(engineDir(e.id), 'tmp'),
      ACESTEP_INIT_LLM: 'auto',
    }),
    available: true,
  },
  // Gemello foto: ai-toolkit (ostris) a versione fissa, addestra una LoRA del tuo viso su FLUX.1-dev.
  // Il motore si accende solo per addestrare; poi la LoRA si usa con il motore immagini, come le altre.
  twin: {
    id: 'twin',
    name: 'Gemello foto',
    model: 'ai-toolkit · LoRA del tuo viso su FLUX.1-dev',
    license: 'ai-toolkit MIT · FLUX.1-dev licenza non commerciale BFL (le immagini generate sono tue)',
    description: 'Da 15–30 tue foto impara il tuo viso: poi ti crea in qualsiasi scena, stile o vestito. Addestramento una volta sola, circa 1–2 ore.',
    sizeGb: 45,
    port: 7873,
    python: '3.12',
    type: 'repo',
    driverMin: 580,
    source: {
      ref: '126ac4d3b8a09b5403ee2f5ee6f59d88453b478c',
      url: 'https://github.com/ostris/ai-toolkit/archive/126ac4d3b8a09b5403ee2f5ee6f59d88453b478c.zip',
    },
    torch: ['torch==2.13.0', 'torchvision==0.28.0', 'torchaudio==2.11.0', '--index-url', 'https://download.pytorch.org/whl/cu130'],
    requirements: 'requirements.txt',
    extra: ['fastapi', 'uvicorn'],
    needsHf: 'black-forest-labs/FLUX.1-dev',
    // FLUX.1-dev lo scarica ideax in una cartella normale (la cache Python di Hugging Face su Windows può fallire)
    download: [{
      label: 'Scarico FLUX.1-dev per l\'addestramento (circa 34 GB)',
      repo: 'black-forest-labs/FLUX.1-dev',
      dest: () => path.join(ENGINES_DIR, 'twin-models', 'FLUX.1-dev'),
      patterns: ['model_index.json', '*/*.json', '*/*.txt', '*/*.model', 'transformer/*.safetensors', 'text_encoder/*.safetensors', 'text_encoder_2/*.safetensors', 'vae/*.safetensors'],
    }],
    server: 'worker/engines/twin_server.py',
    serverArgs: (e) => ['--app', path.join(engineDir(e.id), 'app'), '--work', path.join(ENGINES_DIR, 'twin-data'), '--model', e.download[0].dest()],
    env: () => ({ HF_HOME: path.join(ENGINES_DIR, 'hf') }),
    available: true,
  },
  // ComfyUI a versione fissa: fa girare i modelli che il motore immagini non conosce, a partire da MOSS-Image.
  // Moss si scarica già preparato per ComfyUI (int8, adatto a 16 GB). Le LoRA arrivano dalla cartella dei modelli di ideax.
  comfyui: {
    id: 'comfyui',
    name: 'MOSS-Image',
    model: 'ComfyUI · MOSS-Image (OpenMOSS)',
    license: 'ComfyUI GPL-3.0 · MOSS-Image: vedi la licenza su huggingface.co/OpenMOSS-Team',
    description: 'Modello di immagini di nuova generazione: segue il prompt alla lettera, anche lungo e dettagliato. Usa le LoRA fatte per Moss (es. Mystic XXX).',
    sizeGb: 30,
    port: 7875,
    python: '3.12',
    type: 'repo',
    driverMin: 580,
    healthPath: '/system_stats',
    source: {
      ref: '6d352802d8f8b9133f664a1757d6c6d26390c335',
      url: 'https://github.com/comfyanonymous/ComfyUI/archive/6d352802d8f8b9133f664a1757d6c6d26390c335.zip',
    },
    torch: ['torch==2.13.0', 'torchvision==0.28.0', 'torchaudio==2.11.0', '--index-url', 'https://download.pytorch.org/whl/cu130'],
    requirements: 'requirements.txt',
    download: [
      {
        label: 'Scarico MOSS-Image (modello ed encoder del testo, circa 20 GB)',
        repo: 'Comfy-Org/MOSS-Image',
        dest: 'models',
        patterns: ['diffusion_models/moss_image_sft_int8_convrot_attn.safetensors', 'text_encoders/qwen3.5_9b_int8_convrot.safetensors', '*flux2-vae.safetensors'],
      },
      // Il VAE di FLUX.2 è un file condiviso: se non era nel pacchetto di Moss, si prende da quello di FLUX.2
      { label: 'Scarico il VAE di FLUX.2', repo: 'Comfy-Org/flux2-dev', dest: 'models', patterns: ['*flux2-vae.safetensors'], skipIf: (appDir) => !!findFile(path.join(appDir, 'models'), 'flux2-vae.safetensors') },
    ],
    startArgs: (e) => {
      const appDir = path.join(engineDir(e.id), 'app');
      // Le LoRA di ideax si vedono anche in ComfyUI, senza copiarle
      const yaml = path.join(appDir, 'ideax-cartelle.yaml');
      fs.writeFileSync(yaml, `ideax:\n  base_path: ${JSON.stringify(MODELS_DIR)}\n  loras: loras\n`);
      return [path.join(appDir, 'main.py'), '--listen', '127.0.0.1', '--port', String(e.port), '--disable-auto-launch', '--extra-model-paths-config', yaml];
    },
    available: true,
  },
  // Video da testo o da foto: Wan 2.2 TI2V-5B (Alibaba, Apache 2.0) sul ComfyUI già installato per MOSS-Image.
  // È un'aggiunta: scarica solo i modelli nella cartella di ComfyUI, niente nuovo ambiente Python.
  wan: {
    id: 'wan',
    name: 'Video Wan 2.2',
    model: 'Wan 2.2 TI2V-5B · Alibaba (su ComfyUI)',
    license: 'Apache 2.0, uso commerciale consentito',
    description: 'Video veri da testo o da una foto: 720p, 24 fotogrammi al secondo, fino a 5 secondi a clip, con movimento naturale. Serve ComfyUI (si installa con MOSS-Image).',
    sizeGb: 18,
    type: 'addon',
    parent: 'comfyui',
    download: [
      {
        label: 'Scarico Wan 2.2 (modello, encoder del testo e VAE, circa 18 GB)',
        repo: 'Comfy-Org/Wan_2.2_ComfyUI_Repackaged',
        dest: 'models',
        patterns: [
          'split_files/diffusion_models/wan2.2_ti2v_5B_fp16.safetensors',
          'split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors',
          'split_files/vae/wan2.2_vae.safetensors',
        ],
      },
    ],
    files: { model: ['diffusion_models', 'wan2.2_ti2v_5B_fp16.safetensors'], te: ['text_encoders', 'umt5_xxl_fp8_e4m3fn_scaled.safetensors'], vae: ['vae', 'wan2.2_vae.safetensors'] },
    available: true,
  },
  // Fotomontaggio: Qwen-Image-Edit-2509 (Alibaba, Apache 2.0) con Lightning a 8 passi, sul ComfyUI di MOSS-Image.
  // La foto vera resta la base (il volto si tiene), il prompt dice cosa cambiare; accetta fino a 3 immagini (foto + stile).
  qwenedit: {
    id: 'qwenedit',
    name: 'Fotomontaggio Qwen',
    model: 'Qwen-Image-Edit-2509 + Lightning 8 passi (su ComfyUI)',
    license: 'Apache 2.0, uso commerciale consentito',
    description: 'Trasforma una foto vera tenendo il volto: temi, costumi, scenari, caricature con un foglio di stile. Fino a 3 immagini insieme. Serve ComfyUI (si installa con MOSS-Image).',
    sizeGb: 30,
    type: 'addon',
    parent: 'comfyui',
    download: [
      { label: 'Scarico Qwen-Image-Edit-2509 (circa 20 GB)', repo: 'Comfy-Org/Qwen-Image-Edit_ComfyUI', dest: 'models', patterns: ['split_files/diffusion_models/qwen_image_edit_2509_fp8_e4m3fn.safetensors'] },
      { label: 'Scarico encoder del testo e VAE di Qwen-Image (circa 9 GB)', repo: 'Comfy-Org/Qwen-Image_ComfyUI', dest: 'models', patterns: ['split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', 'split_files/vae/qwen_image_vae.safetensors'] },
      { label: 'Scarico l\'acceleratore Lightning (8 passi)', repo: 'lightx2v/Qwen-Image-Lightning', dest: 'models/loras', patterns: ['*Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors'] },
    ],
    files: {
      model: ['diffusion_models', 'qwen_image_edit_2509_fp8_e4m3fn.safetensors'],
      te: ['text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'],
      vae: ['vae', 'qwen_image_vae.safetensors'],
      lightning: ['loras', 'Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors'],
    },
    available: true,
  },
  // Fotomontaggio fedele: FLUX.1 Kontext dev (Black Forest Labs, licenza NON commerciale: uso privato) sul ComfyUI.
  kontext: {
    id: 'kontext',
    name: 'Fotomontaggio Kontext',
    model: 'FLUX.1 Kontext dev (su ComfyUI)',
    license: 'FLUX.1 dev: licenza non commerciale (uso privato)',
    description: 'Modifiche fedelissime al volto e alla foto di partenza: cambia vestiti, sfondo, luce, dettagli. Trasforma meno di Qwen ma sbaglia meno la faccia.',
    sizeGb: 18,
    type: 'addon',
    parent: 'comfyui',
    download: [
      { label: 'Scarico FLUX.1 Kontext dev (circa 12 GB)', repo: 'Comfy-Org/flux1-kontext-dev_ComfyUI', dest: 'models', patterns: ['split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors'] },
      { label: 'Scarico gli encoder del testo di FLUX (circa 5 GB)', repo: 'comfyanonymous/flux_text_encoders', dest: 'models/text_encoders', patterns: ['clip_l.safetensors', 't5xxl_fp8_e4m3fn_scaled.safetensors'] },
      { label: 'Scarico il VAE di FLUX', repo: 'Comfy-Org/Lumina_Image_2.0_Repackaged', dest: 'models', patterns: ['split_files/vae/ae.safetensors'] },
    ],
    files: {
      model: ['diffusion_models', 'flux1-dev-kontext_fp8_scaled.safetensors'],
      clip: ['text_encoders', 'clip_l.safetensors'],
      t5: ['text_encoders', 't5xxl_fp8_e4m3fn_scaled.safetensors'],
      vae: ['vae', 'ae.safetensors'],
    },
    available: true,
  },
  // Immagini con testi perfetti: Qwen-Image (Alibaba, Apache 2.0) con Lightning 8 passi. Usa lo stesso encoder e lo
  // stesso VAE del fotomontaggio Qwen: se c'è già, scarica solo il modello.
  qwenimage: {
    id: 'qwenimage',
    name: 'Immagini con testo (Qwen-Image)',
    model: 'Qwen-Image + Lightning 8 passi (su ComfyUI)',
    license: 'Apache 2.0, uso commerciale consentito',
    description: 'Il migliore per immagini con scritte: inviti, locandine, copertine, menu, cornici, loghi con testo. Scrive in italiano senza errori. Serve ComfyUI (si installa con MOSS-Image).',
    sizeGb: 22,
    type: 'addon',
    parent: 'comfyui',
    download: [
      { label: 'Scarico Qwen-Image (circa 20 GB)', repo: 'Comfy-Org/Qwen-Image_ComfyUI', dest: 'models', patterns: ['split_files/diffusion_models/qwen_image_fp8_e4m3fn.safetensors', 'split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors', 'split_files/vae/qwen_image_vae.safetensors'] },
      { label: 'Scarico l\'acceleratore Lightning (8 passi)', repo: 'lightx2v/Qwen-Image-Lightning', dest: 'models/loras', patterns: ['Qwen-Image-Lightning-8steps-V1.1.safetensors'] },
    ],
    files: {
      model: ['diffusion_models', 'qwen_image_fp8_e4m3fn.safetensors'],
      te: ['text_encoders', 'qwen_2.5_vl_7b_fp8_scaled.safetensors'],
      vae: ['vae', 'qwen_image_vae.safetensors'],
      lightning: ['loras', 'Qwen-Image-Lightning-8steps-V1.1.safetensors'],
    },
    available: true,
  },
  // Ingrandimento 4× per la stampa: 4x-UltraSharp (ESRGAN, 67 MB) su ComfyUI
  upscale: {
    id: 'upscale',
    name: 'Ingrandimento 4×',
    model: '4x-UltraSharp (ESRGAN, su ComfyUI)',
    license: 'CC BY-NC-SA 4.0 (uso privato)',
    description: 'Ingrandisce 4 volte un\'immagine aggiungendo dettaglio vero: per stampe, album e manifesti. Pochi secondi.',
    sizeGb: 0.1,
    type: 'addon',
    parent: 'comfyui',
    download: [{ label: 'Scarico 4x-UltraSharp', repo: 'lokCX/4x-Ultrasharp', dest: 'models/upscale_models', patterns: ['4x-UltraSharp.pth'] }],
    files: { model: ['upscale_models', '4x-UltraSharp.pth'] },
    available: true,
  },
  // Regista web: ideax guida un browser vero sulle tue pagine (con i tuoi accessi) e registra lo schermo. Serve per
  // i video dimostrativi dei tuoi software. Scarica Chromium (circa 150 MB) la prima volta.
  webdemo: {
    id: 'webdemo',
    name: 'Regista web',
    model: 'Playwright + Chromium',
    license: 'Apache 2.0 (Playwright) · Chromium BSD',
    description: 'Apre un browser, naviga le tue pagine, fa login dove gli dai gli accessi e registra lo schermo: video dimostrativi dei tuoi siti e gestionali. Gli accessi restano sul PC.',
    sizeGb: 0.5,
    port: 7877,
    python: '3.11',
    script: 'worker/engines/webdemo_server.py',
    packages: () => [{ label: 'Browser e registrazione', args: ['playwright==1.48.0', 'fastapi', 'uvicorn', 'imageio-ffmpeg', '--only-binary', ':all:'] }],
    available: true,
  },
  // Gemello video: LatentSync 1.5 (ByteDance, Apache 2.0). Rifà le labbra di un tuo video vero sulla voce nuova.
  lipsync: {
    id: 'lipsync',
    name: 'Gemello video',
    model: 'LatentSync 1.5 · ByteDance',
    license: 'Apache 2.0, uso commerciale consentito',
    description: 'Registri una volta un video di te che parli; poi ogni testo diventa un video tuo, con la tua voce clonata e le labbra a tempo.',
    sizeGb: 12,
    port: 7874,
    python: '3.10',
    type: 'repo',
    driverMin: 525,
    source: {
      ref: 'a229c3948406bc2cf6eaf4873e662e70c6a04746',
      url: 'https://github.com/bytedance/LatentSync/archive/a229c3948406bc2cf6eaf4873e662e70c6a04746.zip',
    },
    torch: ['torch==2.5.1', 'torchvision==0.20.1', '--index-url', 'https://download.pytorch.org/whl/cu121'],
    requirements: 'requirements.txt',
    // insightface va compilato su Windows: lo installiamo a parte, solo la parte in Python. gradio non serve.
    dropRequirements: /^(torch|torchvision|insightface|gradio)\b/,
    extra: ['onnx', 'scikit-image', 'easydict', 'fastapi', 'uvicorn'],
    preInstall: [{ label: 'Rilevatore di volti (insightface)', script: 'worker/engines/install_insightface.py' }],
    download: [
      { label: 'Scarico LatentSync 1.5 (circa 5 GB)', repo: 'ByteDance/LatentSync-1.5', dest: 'checkpoints', patterns: ['latentsync_unet.pt', 'whisper/tiny.pt'] },
      // LatentSync chiede il VAE per nome a Hugging Face: lo mettiamo noi nella cache, e il motore lavora offline
      { label: 'Scarico il VAE di Stable Diffusion', repo: 'stabilityai/sd-vae-ft-mse', cache: true, patterns: ['config.json', 'diffusion_pytorch_model.safetensors'] },
    ],
    postInstall: () => ({
      label: 'Preparo il rilevatore di volti',
      args: ['-c', 'from insightface.app import FaceAnalysis; FaceAnalysis(allowed_modules=["detection","landmark_2d_106"], root="checkpoints/auxiliary", providers=["CPUExecutionProvider"])'],
    }),
    needsFfmpeg: true,
    server: 'worker/engines/lipsync_server.py',
    serverArgs: (e) => ['--app', path.join(engineDir(e.id), 'app')],
    env: () => ({ HF_HOME: path.join(ENGINES_DIR, 'hf'), HF_HUB_OFFLINE: '1' }),
    available: true,
  },
};

// ---------- Stato ----------

const states = {};
function state(id) {
  if (!states[id]) {
    states[id] = { status: isInstalled(id) ? 'installed' : 'missing', step: null, log: [], error: null, running: false, phase: null };
  }
  return states[id];
}

const engineDir = (id) => path.join(ENGINES_DIR, id);
// IDEAX_ENGINE_PYTHON: solo per lo sviluppo, usa un Python già pronto invece degli ambienti installati
const venvPython = (id) => process.env.IDEAX_ENGINE_PYTHON || path.join(engineDir(id), 'venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
export const isInstalled = (id) => (!!process.env.IDEAX_ENGINE_PYTHON && CATALOG[id]?.available) || fs.existsSync(path.join(engineDir(id), 'installed.json'));

function log(id, line) {
  const s = state(id);
  const text = String(line).replace(/\r/g, '').trim();
  if (!text) return;
  s.log.push(text);
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

export function listEngines() {
  return Object.values(CATALOG).map(({ packages, script, ...e }) => ({ ...e, ...state(e.id), log: state(e.id).log.slice(-40) }));
}

// ---------- uv: crea gli ambienti Python e installa i pacchetti ----------

function uvAsset() {
  if (IS_WIN) return 'uv-x86_64-pc-windows-msvc.zip';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz';
  return 'uv-x86_64-unknown-linux-gnu.tar.gz';
}

function findInPath(cmd) {
  return new Promise((resolve) => execFile(IS_WIN ? 'where' : 'which', [cmd], { windowsHide: true }, (err, out) => resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
}

async function ensureUv(id) {
  const local = path.join(UV_DIR, IS_WIN ? 'uv.exe' : 'uv');
  if (fs.existsSync(local)) return local;
  const system = await findInPath('uv');
  if (system) return system;
  log(id, 'Scarico uv (gestore degli ambienti Python)…');
  fs.mkdirSync(UV_DIR, { recursive: true });
  const archive = path.join(UV_DIR, uvAsset());
  const res = await fetch(`https://github.com/astral-sh/uv/releases/latest/download/${uvAsset()}`);
  if (!res.ok) throw new Error(`Download di uv non riuscito (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));
  await run(id, 'tar', ['-xf', archive, '-C', UV_DIR]);
  fs.rmSync(archive, { force: true });
  // Negli archivi per Linux/macOS uv sta in una sottocartella
  if (!fs.existsSync(local)) {
    for (const d of fs.readdirSync(UV_DIR)) {
      const inner = path.join(UV_DIR, d, 'uv');
      if (fs.existsSync(inner)) fs.renameSync(inner, local);
    }
  }
  if (!fs.existsSync(local)) throw new Error('uv non trovato dopo l\'estrazione');
  return local;
}

function uvEnv() {
  return {
    ...process.env,
    // Python e cache di uv restano nella cartella dei dati di ideax: disinstallando si libera tutto
    UV_PYTHON_INSTALL_DIR: path.join(UV_DIR, 'python'),
    UV_CACHE_DIR: path.join(UV_DIR, 'cache'),
    UV_LINK_MODE: 'copy',
    PYTHONUTF8: '1',
  };
}

function hfEnv() {
  const t = getSettings().hfToken;
  return t ? { HF_TOKEN: t } : {};
}

function run(id, cmd, args, env = process.env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    child.stdout.on('data', (d) => String(d).split('\n').forEach((l) => log(id, l)));
    child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => log(id, l)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(explain(id, `${path.basename(cmd)} è terminato con codice ${code}`)))));
  });
}

// Dall'ultimo pezzo del registro, un messaggio che dice cosa fare (non solo "codice 1")
function explain(id, base) {
  const tail = state(id).log.slice(-40).join('\n');
  if (/GatedRepo|403 Client Error|Access to model .* is restricted|awaiting a review|not in the authorized list/i.test(tail)) {
    const repo = (tail.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)/) || [])[1] || CATALOG[id]?.needsHf || 'il modello';
    return `Hugging Face non dà accesso a ${repo}: apri huggingface.co/${repo}, accetta la licenza ("Agree and access repository") con lo stesso account del token, poi riprova. Impostazioni → Hugging Face → "Verifica" ti dice esattamente cosa manca.`;
  }
  if (/401 Client Error|Invalid user token|invalid credentials/i.test(tail)) return 'Il token di Hugging Face non è valido: controllalo in Impostazioni → Hugging Face.';
  if (/No space left|not enough space|errno 28/i.test(tail)) return 'Spazio su disco finito: libera spazio e riprova (l\'installazione riparte da dove si era fermata).';
  const last = state(id).log.filter((l) => /error|errore|exception|failed/i.test(l)).pop();
  return last ? `${base}: ${last.slice(0, 300)}` : base;
}

// ---------- Installazione ----------

// Le librerie del progetto, ripulite: niente PyTorch (si installa prima, nella versione per la scheda video),
// niente righe tolte dal catalogo, e le dipendenze "git+" diventano archivi zip (git sul PC non serve).
function writeRequirements(e, appDir) {
  const lines = [];
  const read = (file) => {
    for (const raw of fs.readFileSync(path.join(appDir, file), 'utf8').split(/\r?\n/)) {
      const l = raw.trim();
      if (!l || l.startsWith('#') || /^--(extra-)?index-url/.test(l)) continue;
      if (l.startsWith('-r ')) { read(l.slice(3).trim()); continue; }
      if (/^(torch|torchvision|torchaudio)\s*(==|>=|$)/.test(l)) continue;
      if (e.dropRequirements?.test(l)) continue;
      const git = l.match(/^git\+https:\/\/github\.com\/([^/]+)\/([^@]+?)(?:\.git)?@([0-9a-f]{7,40})$/);
      lines.push(git ? `${git[2]} @ https://github.com/${git[1]}/${git[2]}/archive/${git[3]}.zip` : l);
    }
  };
  read(e.requirements);
  const out = path.join(appDir, 'requisiti-ideax.txt');
  fs.writeFileSync(out, lines.join('\n') + '\n');
  return out;
}

export async function install(id) {
  const e = CATALOG[id];
  if (!e) throw new Error(`Motore sconosciuto: ${id}`);
  if (!e.available) throw new Error(`Il motore "${e.name}" arriverà in un prossimo aggiornamento.`);
  const s = state(id);
  if (s.status === 'installing') return s;
  Object.assign(s, { status: 'installing', error: null, log: [], step: 'Preparazione' });
  (async () => {
    try {
      const uv = await ensureUv(id);
      const env = uvEnv();
      const dir = engineDir(id);
      // I motori "repo" riprendono da dove si erano fermati: niente da riscaricare se si riprova
      if (e.type !== 'repo') fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const gpu = await detectGpu();
      log(id, gpu.vendor === 'nvidia' ? `Scheda video: ${gpu.name} (driver ${gpu.driver})` : 'Nessuna scheda NVIDIA: il motore userà il processore (lento).');
      if (e.type === 'project' && gpu.vendor === 'nvidia' && (Number(String(gpu.driver).split('.')[0]) || 0) < 570) {
        log(id, `Attenzione: ${e.model} usa CUDA 12.8 e richiede il driver NVIDIA 570 o più recente (hai ${gpu.driver}). Aggiorna il driver da nvidia.com, altrimenti userà il processore.`);
      }
      const driver = Number(String(gpu.driver).split('.')[0]) || 0;
      if (e.driverMin && gpu.vendor === 'nvidia' && driver < e.driverMin) {
        throw new Error(`${e.model} richiede il driver NVIDIA ${e.driverMin} o più recente (hai ${gpu.driver}). Aggiornalo da nvidia.com/drivers e riprova.`);
      }
      if (e.needsHf && !getSettings().hfToken) {
        throw new Error(`Serve il token di Hugging Face (Impostazioni → Hugging Face) e la licenza accettata su huggingface.co/${e.needsHf}.`);
      }
      if (e.type === 'addon') {
        // Aggiunta a un motore già installato: solo i modelli, nella sua cartella
        if (!isInstalled(e.parent)) throw new Error(`Prima installa "${CATALOG[e.parent].name}": ${e.name} usa il suo ComfyUI.`);
        const modelsDir = path.join(engineDir(e.parent), 'app', 'models');
        for (const d of e.download) {
          s.step = d.label;
          await snapshot(d.repo, path.join(engineDir(e.parent), 'app', d.dest), d.patterns, {
            log: (l) => log(id, l),
            onProgress: (p) => { s.step = `${d.label} · ${(p.done / 1e9).toFixed(1).replace('.', ',')} di ${(p.total / 1e9).toFixed(1).replace('.', ',')} GB`; },
          });
        }
        // Ogni file nella cartella dove ComfyUI lo cerca
        for (const [sub, name] of Object.values(e.files || {})) {
          const target = path.join(modelsDir, sub, name);
          if (fs.existsSync(target)) continue;
          const found = findFile(modelsDir, name);
          if (!found) throw new Error(`Dopo il download manca ${name}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.renameSync(found, target);
        }
      } else if (e.type === 'project') {
        // Progetto completo: codice ufficiale a una versione fissa + le versioni esatte del suo lockfile
        s.step = `Scarico ${e.model}`;
        const zip = path.join(dir, 'source.zip');
        const res = await fetch(e.source.url);
        if (!res.ok) throw new Error(`Download di ${e.model} non riuscito (${res.status})`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
        await run(id, 'tar', ['-xf', zip, '-C', dir]);
        fs.rmSync(zip, { force: true });
        const extracted = fs.readdirSync(dir).find((d) => fs.statSync(path.join(dir, d)).isDirectory() && d !== 'venv');
        fs.renameSync(path.join(dir, extracted), path.join(dir, 'app'));
        s.step = 'Librerie e PyTorch per la scheda video (alcuni GB)';
        await run(id, uv, ['sync', '--frozen', '--python', e.python, '--no-dev'], { ...env, UV_PROJECT_ENVIRONMENT: path.join(dir, 'venv') }, path.join(dir, 'app'));
        const post = e.postInstall(id);
        s.step = post.label;
        fs.mkdirSync(e.checkpoints(), { recursive: true });
        await run(id, venvPython(id), post.args, { ...env, ...e.env(e), ...hfEnv() }, path.join(dir, 'app'));
        s.step = 'Avvio il motore e lo provo';
        await start(id);
      } else if (e.type === 'repo') {
        // Codice ufficiale a versione fissa + le sue librerie (requirements.txt), con PyTorch per la scheda video
        const appDir = path.join(dir, 'app');
        const doneFile = path.join(dir, 'passi-fatti.json');
        const done = (() => { try { return JSON.parse(fs.readFileSync(doneFile, 'utf8')); } catch { return {}; } })();
        // Ogni passo riuscito si segna: riprovando si salta (la versione del codice deve essere la stessa)
        const step = async (key, label, fn) => {
          if (done[key] === e.source.ref) { log(id, `${label}: già fatto`); return; }
          s.step = label;
          await fn();
          done[key] = e.source.ref;
          fs.writeFileSync(doneFile, JSON.stringify(done, null, 2));
        };
        await step('codice', `Scarico ${e.model}`, async () => {
          fs.rmSync(appDir, { recursive: true, force: true });
          const zip = path.join(dir, 'source.zip');
          const res = await fetch(e.source.url);
          if (!res.ok) throw new Error(`Download di ${e.model} non riuscito (${res.status})`);
          await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
          const tmp = path.join(dir, 'estratto');
          fs.rmSync(tmp, { recursive: true, force: true });
          fs.mkdirSync(tmp);
          await run(id, 'tar', ['-xf', zip, '-C', tmp]);
          fs.rmSync(zip, { force: true });
          fs.renameSync(path.join(tmp, fs.readdirSync(tmp)[0]), appDir);
          fs.rmSync(tmp, { recursive: true, force: true });
        });
        await step('python', `Ambiente Python ${e.python}`, () => run(id, uv, ['venv', path.join(dir, 'venv'), '--python', e.python, '--seed', '--clear'], env));
        const pip = (args) => run(id, uv, ['pip', 'install', '--python', venvPython(id), ...args], env, appDir);
        await step('torch', 'PyTorch per la scheda video (alcuni GB)', () => pip(e.torch));
        for (const pre of e.preInstall || []) {
          await step(`pre-${pre.script}`, pre.label, () => run(id, venvPython(id), [path.join(APP_ROOT, pre.script)], { ...env, ...hfEnv() }, appDir));
        }
        await step('librerie', 'Librerie del motore', () => pip(['-r', writeRequirements(e, appDir), ...(e.extra || [])]));
        for (const d of e.download || []) {
          // Download fatto da ideax: riprende da dove si era fermato, mostra quanto manca
          const opts = {
            log: (l) => log(id, l),
            onProgress: (p) => { s.step = `${d.label} · ${(p.done / 1e9).toFixed(1).replace('.', ',')} di ${(p.total / 1e9).toFixed(1).replace('.', ',')} GB`; },
          };
          if (d.skipIf?.(appDir)) { log(id, `${d.label}: non serve`); continue; }
          await step(`download-${d.repo}`, d.label, () => (d.cache
            ? intoCache(d.repo, path.join(ENGINES_DIR, 'hf', 'hub'), d.patterns, opts)
            : snapshot(d.repo, typeof d.dest === 'function' ? d.dest() : path.join(appDir, d.dest), d.patterns, opts)));
        }
        if (e.postInstall) {
          const post = e.postInstall(id);
          await step('modelli', post.label, () => run(id, venvPython(id), post.args, { ...env, ...(e.env ? e.env(e) : {}), ...hfEnv() }, appDir));
        }
        s.step = 'Avvio il motore e lo provo';
        await start(id);
      } else {
        s.step = `Ambiente Python ${e.python}`;
        await run(id, uv, ['venv', path.join(dir, 'venv'), '--python', e.python, '--seed'], env);
        for (const p of e.packages(gpu)) {
          s.step = p.label;
          await run(id, uv, ['pip', 'install', '--python', venvPython(id), ...p.args], env);
        }
        s.step = 'Scarico il modello e lo provo';
        await start(id);
        await call(id, '/warmup', {}, { timeout: 30 * 60 * 1000 });
      }
      fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ date: new Date().toISOString(), gpu }, null, 2));
      Object.assign(s, { status: 'installed', step: null });
      log(id, 'Motore installato e pronto.');
    } catch (err) {
      Object.assign(s, { status: 'error', error: err.message });
      log(id, `Errore: ${err.message}`);
      stop(id);
    }
  })();
  return s;
}

export function uninstall(id) {
  const e = CATALOG[id];
  if (e?.type === 'addon') {
    // I file condivisi con altri motori (es. il VAE di FLUX) restano
    const shared = new Set(Object.values(CATALOG).filter((x) => x.id !== id && x.type === 'addon' && isInstalled(x.id)).flatMap((x) => Object.values(x.files || {}).map(([, n]) => n)));
    for (const [sub, name] of Object.values(e.files || {})) if (!shared.has(name)) fs.rmSync(path.join(engineDir(e.parent), 'app', 'models', sub, name), { force: true });
  }
  stop(id);
  fs.rmSync(engineDir(id), { recursive: true, force: true });
  Object.assign(state(id), { status: 'missing', log: [], error: null });
}

// ---------- Processi ----------

const procs = {};
const idleTimers = {};

function url(id) {
  return `http://127.0.0.1:${CATALOG[id].port}`;
}

async function healthy(id) {
  try {
    return (await fetch(`${url(id)}${CATALOG[id].healthPath || '/health'}`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// Versioni fino alla 1.5.0: i modelli musicali stavano in "music-models", e il server ne aveva scaricata
// una seconda copia in app/checkpoints. Li spostiamo nella cartella giusta (senza riscaricarli) e togliamo il doppione.
function migrateMusicModels() {
  const target = CATALOG.music.checkpoints();
  const old = path.join(ENGINES_DIR, 'music-models');
  const dup = path.join(engineDir('music'), 'app', 'checkpoints');
  try {
    if (!fs.existsSync(target) || !fs.readdirSync(target).length) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) fs.rmdirSync(target);
      if (fs.existsSync(old) && fs.readdirSync(old).length) fs.renameSync(old, target);
      else if (fs.existsSync(dup) && fs.readdirSync(dup).length) fs.renameSync(dup, target);
    }
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      for (const extra of [old, dup]) if (fs.existsSync(extra)) fs.rmSync(extra, { recursive: true, force: true });
    }
  } catch (err) {
    log('music', `Spostamento dei modelli non riuscito: ${err.message}`);
  }
}

// Ultima riga utile del registro di un motore (per mostrare cosa sta facendo)
export function lastLog(id) {
  const lines = state(id).log;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (l && !/^INFO:\s+127\.0\.0\.1/.test(l) && !/GET \/health|POST \/query_result/.test(l)) return l.slice(0, 160);
  }
  return '';
}

// ACE-Step salva gli MP3 chiamando il programma "ffmpeg", che su Windows di solito non c'è:
// ne mettiamo uno nella cartella del motore (da imageio-ffmpeg) e la aggiungiamo al PATH del motore.
const ffmpegDir = (id) => path.join(engineDir(id), 'bin');
async function ensureFfmpeg(id) {
  const target = path.join(ffmpegDir(id), IS_WIN ? 'ffmpeg.exe' : 'ffmpeg');
  if (fs.existsSync(target)) return;
  log(id, 'Preparo ffmpeg per salvare i brani in MP3…');
  const exe = () => new Promise((resolve, reject) => execFile(venvPython(id), ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out).trim()))));
  let src = await exe().catch(() => null);
  if (!src) {
    const uv = await ensureUv(id);
    await run(id, uv, ['pip', 'install', '--python', venvPython(id), 'imageio-ffmpeg'], uvEnv());
    src = await exe();
  }
  fs.mkdirSync(ffmpegDir(id), { recursive: true });
  fs.copyFileSync(src, target);
  if (!IS_WIN) fs.chmodSync(target, 0o755);
}

export async function start(id) {
  if (CATALOG[id]?.type === 'addon') return start(CATALOG[id].parent);
  const e = CATALOG[id];
  const s = state(id);
  if (id === 'music') migrateMusicModels();
  if (await healthy(id)) { s.running = true; return; }
  if (!procs[id]) {
    const py = fs.existsSync(venvPython(id)) ? venvPython(id) : null;
    if (!py) throw new Error(`Il motore "${e.name}" non è installato.`);
    if (id === 'music') await ensureFfmpeg(id).catch((err) => log(id, `ffmpeg non disponibile (${err.message}): i brani saranno in WAV.`));
    if (e.needsFfmpeg) await ensureFfmpeg(id).catch((err) => log(id, `ffmpeg non disponibile: ${err.message}`));
    const out = fs.createWriteStream(path.join(DATA_DIR, `engine-${id}.log`), { flags: 'a' });
    const settings = getSettings();
    const args = e.startArgs ? e.startArgs(e)
      : e.server ? [path.join(APP_ROOT, e.server), '--port', String(e.port), ...(e.serverArgs ? e.serverArgs(e) : [])]
        : [path.join(APP_ROOT, e.script), '--port', String(e.port)];
    if (e.dataRoot) fs.mkdirSync(e.dataRoot(), { recursive: true });
    const child = spawn(py, args, {
      cwd: e.type === 'project' || e.type === 'repo' ? path.join(engineDir(id), 'app') : ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        ...(settings.hfToken ? { HF_TOKEN: settings.hfToken } : {}),
        ...(e.env ? e.env(e) : {}),
        PATH: `${ffmpegDir(id)}${path.delimiter}${process.env.PATH || process.env.Path || ''}`,
      },
    });
    procs[id] = child;
    child.on('error', (err) => { log(id, `Avvio non riuscito: ${err.message}`); delete procs[id]; s.running = false; });
    const onData = (d) => { out.write(d); String(d).split('\n').forEach((l) => log(id, l)); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      delete procs[id];
      s.running = false;
      out.end();
      if (code) log(id, `Il motore si è fermato (codice ${code}).`);
    });
  }
  const deadline = Date.now() + (e.type === 'project' ? 600_000 : 180_000);
  while (Date.now() < deadline) {
    if (await healthy(id)) { s.running = true; return; }
    if (!procs[id]) throw new Error(`Il motore "${e.name}" non è partito: guarda il registro in Impostazioni → Motori.`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Il motore "${e.name}" non risponde.`);
}

export function stop(id) {
  if (CATALOG[id]?.type === 'addon') return;
  procs[id]?.kill();
  delete procs[id];
  if (states[id]) states[id].running = false;
}

export function stopAll() {
  for (const id of Object.keys(procs)) stop(id);
}

// Chiama un motore: lo accende se serve e lo spegne dopo 10 minuti di inattività
export async function call(id, route, body, { timeout = 20 * 60 * 1000, onProgress } = {}) {
  await start(id);
  clearTimeout(idleTimers[id]);
  const s = state(id);
  const timer = onProgress && setInterval(async () => {
    try { onProgress(await (await fetch(`${url(id)}/progress`, { signal: AbortSignal.timeout(2000) })).json()); } catch { /* occupato */ }
  }, 1000);
  try {
    const res = await fetch(`${url(id)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || `Motore ${id}: HTTP ${res.status}`);
    return data;
  } finally {
    clearInterval(timer);
    s.phase = null;
    armIdle(id);
    idleTimers[id].unref?.();
  }
}

// Per i motori con un proprio server REST (es. ACE-Step): accende il motore e dà l'indirizzo
export async function ensureRunning(id) {
  await start(id);
  clearTimeout(idleTimers[id]);
  return url(id);
}

function armIdle(id) {
  const ms = IDLE_MS_BY_ID[id] || IDLE_MS;
  idleTimers[id] = setTimeout(() => { log(id, `Inattivo da ${ms / 60000} minuti: spengo il motore per liberare la scheda video.`); stop(id); }, ms);
}

export function touch(id) {
  clearTimeout(idleTimers[id]);
  armIdle(id);
  idleTimers[id].unref?.();
}

export function cancel(id) {
  return fetch(`${url(id)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

export const enginesDir = ENGINES_DIR;
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-'));

// Cerca un file per nome in una cartella e nelle sottocartelle (es. il VAE di FLUX.2 dentro i modelli di ComfyUI)
export function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const f = findFile(full, name);
      if (f) return f;
    }
  }
  return null;
}

export const appDirOf = (id) => path.join(engineDir(id), 'app');

// Un piccolo ambiente Python a parte (es. la libreria voci con Kokoro, che vuole numpy 2 e non può stare
// nell'ambiente di Chatterbox). Restituisce il python dell'ambiente; i pacchetti si installano una volta.
export async function sideEnv(id, dir, python, packages) {
  const py = path.join(dir, 'venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
  const mark = path.join(dir, 'pacchetti.json');
  const want = JSON.stringify(packages);
  if (fs.existsSync(py) && fs.existsSync(mark) && fs.readFileSync(mark, 'utf8') === want) return py;
  const uv = await ensureUv(id);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(py)) await run(id, uv, ['venv', '--python', python, path.join(dir, 'venv')], uvEnv());
  await run(id, uv, ['pip', 'install', '--python', py, ...packages], uvEnv());
  fs.writeFileSync(mark, want);
  return py;
}
export const engineLog = (id) => state(id).log.slice(-6);
