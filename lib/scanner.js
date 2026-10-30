// Trova i modelli nelle cartelle e capisce cosa sono leggendo solo l'intestazione dei file
// (.safetensors ha un header JSON con i nomi dei tensori e i metadati: niente GPU, niente Python).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { MODELS_DIR, getSettings, getOverrides } from './store.js';

export const ARCH_LABELS = {
  sd15: 'Stable Diffusion 1.5',
  sd2: 'Stable Diffusion 2.x',
  sdxl: 'SDXL / Pony / Illustrious',
  sd3: 'Stable Diffusion 3',
  flux: 'Flux',
  diffusers: 'Cartella diffusers',
  llm: 'LLM (GGUF)',
  unknown: 'Da indicare',
};

export const KIND_LABELS = {
  checkpoint: 'Modello',
  lora: 'LoRA',
  motion: 'Modulo di movimento (AnimateDiff)',
  vae: 'VAE',
  llm: 'Cervello (LLM)',
};

const MODEL_EXT = new Set(['.safetensors', '.ckpt', '.pt', '.pth', '.gguf']);
const MAX_HEADER = 100 * 1024 * 1024;
const cache = new Map(); // percorso → { key, info }

function idFor(file) {
  return crypto.createHash('sha1').update(file).digest('hex').slice(0, 12);
}

export function readSafetensorsHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const lenBuf = Buffer.alloc(8);
    fs.readSync(fd, lenBuf, 0, 8, 0);
    const len = Number(lenBuf.readBigUInt64LE());
    if (!len || len > MAX_HEADER) throw new Error('header non valido');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 8);
    const header = JSON.parse(buf.toString('utf8'));
    const meta = header.__metadata__ || {};
    delete header.__metadata__;
    return { keys: Object.keys(header), meta };
  } finally {
    fs.closeSync(fd);
  }
}

function archFromText(text = '') {
  const t = text.toLowerCase();
  if (/flux/.test(t)) return 'flux';
  if (/xl|pony|illustrious|noob/.test(t)) return 'sdxl';
  if (/stable-diffusion-3|sd3/.test(t)) return 'sd3';
  if (/v2|sd2|2\.1|2\.0/.test(t)) return 'sd2';
  if (/v1|sd1|1\.5|sd_v1/.test(t)) return 'sd15';
  return null;
}

// Riconosce tipo e architettura dai nomi dei tensori.
export function classifyKeys(keys, meta = {}) {
  const has = (re) => keys.some((k) => re.test(k));
  const spec = meta['modelspec.architecture'] || '';

  if (has(/lora_(up|down)|\.lora_[AB]\.|lora_unet_|lora_te\d?_|\.lora\.(up|down)|lokr_|hada_/) || /\/lora/.test(spec)) {
    let arch = archFromText(spec) || archFromText(meta.ss_base_model_version);
    if (!arch) {
      if (has(/double_blocks|single_blocks|single_transformer_blocks|transformer_blocks\.\d+\.attn\.add_q_proj/)) arch = 'flux';
      else if (has(/lora_te2_|text_encoder_2|add_k_proj/)) arch = 'sdxl';
      else if (has(/input_blocks_[78]_1_transformer_blocks_[2-9]|down_blocks_2_attentions_\d_transformer_blocks_[2-9]/)) arch = 'sdxl';
      else arch = 'sd15';
    }
    return { kind: 'lora', arch };
  }
  if (has(/motion_modules\./)) {
    return { kind: 'motion', arch: archFromText(spec) === 'sdxl' ? 'sdxl' : 'sd15' };
  }

  const specArch = archFromText(spec);
  let arch = null;
  if (has(/(^|\.)double_blocks\.|(^|\.)single_blocks\.|single_transformer_blocks\./)) arch = 'flux';
  else if (has(/joint_blocks\./)) arch = 'sd3';
  else if (has(/^conditioner\.embedders\.1\.|^conditioner\.embedders\.0\.model\./)) arch = 'sdxl';
  else if (has(/^cond_stage_model\.model\./)) arch = 'sd2';
  else if (has(/^cond_stage_model\.transformer\.|^model\.diffusion_model\.input_blocks/)) arch = 'sd15';
  arch = arch || specArch;

  if (!arch && has(/^(first_stage_model\.)?(encoder|decoder)\./) && !has(/diffusion_model/)) {
    return { kind: 'vae', arch: 'unknown' };
  }
  const flags = {};
  // Molti checkpoint Flux su Civitai contengono solo il "transformer": il resto (VAE, encoder di testo) arriva dal modello base.
  if (arch === 'flux' && !has(/text_encoders?\.|conditioner\.|^vae\.|first_stage_model\./)) flags.transformerOnly = true;
  return { kind: 'checkpoint', arch: arch || 'unknown', flags };
}

// Legge "general.architecture" dall'intestazione di un file GGUF: distingue un LLM da un modello di immagini compresso.
export function readGgufArchitecture(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.toString('latin1', 0, 4) !== 'GGUF') return null;
    let off = 8; // magic + versione
    const u64 = () => { const v = Number(buf.readBigUInt64LE(off)); off += 8; return v; };
    const str = () => { const len = u64(); const v = buf.toString('utf8', off, off + len); off += len; return v; };
    const SIZES = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
    const skip = (type) => {
      if (type === 8) str();
      else if (type === 9) {
        const inner = buf.readUInt32LE(off); off += 4;
        const count = u64();
        for (let i = 0; i < count; i++) skip(inner);
      } else off += SIZES[type] ?? Infinity;
    };
    u64(); // numero di tensori
    const kvCount = u64();
    for (let i = 0; i < kvCount && off < n - 16; i++) {
      const key = str();
      const type = buf.readUInt32LE(off); off += 4;
      if (key === 'general.architecture' && type === 8) return str();
      skip(type);
    }
    return null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const IMAGE_GGUF = { flux: 'flux', sd3: 'sd3', sdxl: 'sdxl', sd1: 'sd15', wan: null, hyvid: null, ltxv: null, aura: null, lumina2: null, hidream: null, qwen_image: null };

const DIFFUSERS_CAPS = [
  [/Kontext|InstructPix2Pix|ImageEdit|Img2Img|Inpaint/i, ['image_edit']],
  [/StableVideoDiffusion/i, ['image_to_video', 'animation']],
  [/AnimateDiffVideoToVideo|VideoToVideo/i, ['video_edit']],
  [/AnimateDiff/i, ['animation']],
  [/ImageToVideo|I2V/i, ['image_to_video', 'animation']],
  [/CogVideoX|LTX|Wan|HunyuanVideo|Mochi|TextToVideo|Allegro|Latte/i, ['video_generate', 'animation']],
  [/Pipeline/i, ['image_generate', 'image_edit']],
];

export function capabilitiesFor(info) {
  if (info.kind !== 'checkpoint') return [];
  if (info.format === 'diffusers') {
    for (const [re, caps] of DIFFUSERS_CAPS) if (re.test(info.pipelineClass || '')) return caps;
    return ['image_generate'];
  }
  if (info.arch === 'unknown') return [];
  return ['image_generate', 'image_edit'];
}

function inspectFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.gguf') {
    const ggufArch = readGgufArchitecture(file);
    if (ggufArch && ggufArch in IMAGE_GGUF) {
      const arch = IMAGE_GGUF[ggufArch];
      // Il worker sa usare i Flux compressi in GGUF; gli altri (es. Wan) vanno usati tramite ComfyUI
      return arch === 'flux'
        ? { kind: 'checkpoint', arch: 'flux', format: 'gguf', flags: { transformerOnly: true } }
        : { kind: 'checkpoint', arch: 'unknown', format: 'gguf', note: `Modello ${ggufArch} in formato GGUF: usalo tramite ComfyUI collegato a ideax.` };
    }
    return { kind: 'llm', arch: 'llm', format: 'gguf' };
  }
  if (ext === '.safetensors') {
    try {
      const { keys, meta } = readSafetensorsHeader(file);
      const c = classifyKeys(keys, meta);
      const trigger = meta['modelspec.trigger_phrase'] || '';
      return { ...c, format: 'single', metaName: meta['modelspec.title'] || meta.ss_output_name || '', trigger };
    } catch (err) {
      return { kind: 'checkpoint', arch: 'unknown', format: 'single', error: `File illeggibile: ${err.message}` };
    }
  }
  // .ckpt/.pt sono archivi pickle: non si possono leggere in sicurezza senza Python, si indica l'architettura a mano
  return { kind: 'checkpoint', arch: 'unknown', format: 'single', note: 'Formato .ckpt: indica tu l\'architettura (meglio convertirlo in .safetensors).' };
}

function inspectDiffusersDir(dir) {
  try {
    const idx = JSON.parse(fs.readFileSync(path.join(dir, 'model_index.json'), 'utf8'));
    return { kind: 'checkpoint', arch: 'diffusers', format: 'diffusers', pipelineClass: idx._class_name || '' };
  } catch {
    return null;
  }
}

function walk(dir, depth, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.name === 'model_index.json')) {
    out.push({ file: dir, isDir: true });
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < 4) walk(full, depth + 1, out);
    else if (e.isFile() && MODEL_EXT.has(path.extname(e.name).toLowerCase())) out.push({ file: full, isDir: false });
  }
}

export function modelDirs() {
  return [MODELS_DIR, ...getSettings().extraModelDirs];
}

export function scanModels() {
  const found = [];
  for (const dir of modelDirs()) walk(dir, 0, found);
  const overrides = getOverrides();
  const result = [];
  for (const { file, isDir } of found) {
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    const key = `${stat.size}:${stat.mtimeMs}`;
    let info = cache.get(file)?.key === key ? cache.get(file).info : null;
    if (!info) {
      info = isDir ? inspectDiffusersDir(file) : inspectFile(file);
      if (!info) continue;
      cache.set(file, { key, info });
    }
    const id = idFor(file);
    const o = overrides[id] || {};
    const base = path.basename(file).replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, '');
    const merged = { ...info, ...(o.arch ? { arch: o.arch } : {}), ...(o.kind ? { kind: o.kind } : {}) };
    result.push({
      id,
      source: 'local',
      path: file,
      file: path.basename(file),
      size: isDir ? null : stat.size,
      ...merged,
      name: o.name || info.metaName || base,
      description: o.description || '',
      priority: Number(o.priority) || 0,
      enabled: o.enabled !== false,
      triggerWords: o.triggerWords ?? info.trigger ?? '',
      loraWeight: o.loraWeight ?? 0.8,
      loraAlways: !!o.loraAlways,
      params: o.params || {},
      capabilities: o.capabilities?.length ? o.capabilities : capabilitiesFor(merged),
    });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
