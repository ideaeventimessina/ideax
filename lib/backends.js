/* Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M */
// Esecuzione dei lavori sui motori locali:
// - worker: il worker Python di ideax (diffusers) che carica i file scaricati da Civitai/Hugging Face
// - comfyui: un ComfyUI già installato, con un workflow esportato in formato API
// - a1111: Automatic1111 / Forge / SD.Next avviati con --api
// - custom: qualsiasi altro server HTTP sul tuo PC
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { OUTPUT_DIR, getSettings } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Una GPU fa un lavoro alla volta: i lavori verso lo stesso motore vanno in fila.
const queues = new Map();
const pending = new Map();
function enqueue(key, fn) {
  pending.set(key, (pending.get(key) || 0) + 1);
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn).finally(() => pending.set(key, pending.get(key) - 1));
  queues.set(key, next);
  return next;
}

// fetch di Node rinuncia se le intestazioni non arrivano entro 5 minuti (headersTimeout di undici), e non si
// può allungare senza dipendenze. Il worker risponde solo a lavoro finito: un'immagine Flux su una scheda lenta
// ci mette di più. Verso i motori in http si usa node:http, che aspetta quanto serve (o il signal di chi chiama).
function longRequest(url, { method = 'GET', headers = {}, body, signal } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, signal, headers: body == null ? headers : { ...headers, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => text });
      });
    });
    req.on('error', (err) => reject(signal?.aborted ? signal.reason : Object.assign(new Error('fetch failed'), { cause: err })));
    if (body != null) req.write(body);
    req.end();
  });
}

export async function httpJson(url, options = {}) {
  let res;
  try {
    const long = new URL(url).protocol === 'http:' && (options.body == null || typeof options.body === 'string');
    res = await (long ? longRequest(url, options) : fetch(url, options));
  } catch (err) {
    throw new Error(`Non riesco a contattare ${new URL(url).host}: è avviato? (${err.cause?.code || err.message})`);
  }
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  if (!res.ok) {
    const detail = body?.detail || body?.error || body;
    throw new Error(`HTTP ${res.status} da ${new URL(url).host}: ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600)}`);
  }
  return body;
}

function fillTemplate(template, vars) {
  if (typeof template === 'string') {
    const whole = template.match(/^\{\{(\w+)\}\}$/);
    if (whole) return vars[whole[1]] ?? null;
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
  }
  if (Array.isArray(template)) return template.map((t) => fillTemplate(t, vars));
  if (template && typeof template === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(template)) {
      const filled = fillTemplate(v, vars);
      if (filled !== null && filled !== undefined) out[k] = filled;
    }
    return out;
  }
  return template;
}

const firstOf = (job, kind) => job.attachments.find((a) => a.type?.startsWith(kind + '/'));

function dataUrlToBuffer(dataUrl) {
  const comma = dataUrl.indexOf(',');
  return { type: dataUrl.slice(5, dataUrl.indexOf(';')), buf: Buffer.from(dataUrl.slice(comma + 1), 'base64') };
}

// ---------- Worker ideax ----------

async function runWorker(model, task, job, log) {
  const url = getSettings().workerUrl;
  const body = {
    model: {
      path: model.path,
      format: model.format,
      arch: model.arch,
      pipeline_class: model.pipelineClass || null,
      transformer_only: !!model.flags?.transformerOnly,
      flux_variant: model.flags?.fluxVariant || null,
      fp8: model.flags?.fp8 || null,
    },
    task,
    prompt: job.routedPrompt,
    negative_prompt: job.negativePrompt || '',
    image: firstOf(job, 'image')?.dataUrl || null,
    video: firstOf(job, 'video')?.dataUrl || null,
    loras: job.loras.map((l) => ({ path: l.path, weight: Number(l.loraWeight) || 0.8 })),
    motion: task === 'animation' && model.motion ? model.motion.path : null,
    params: { ...model.params, ...job.params },
  };
  log(`Invio al worker: ${model.name}${job.loras.length ? ` + LoRA ${job.loras.map((l) => l.name).join(', ')}` : ''}`);
  // Mentre il worker lavora, leggiamo i passi completati per mostrare l'avanzamento
  const timer = setInterval(async () => {
    try {
      const p = await (await fetch(`${url}/progress`, { signal: AbortSignal.timeout(2000) })).json();
      if (p.total) job.progress = { step: p.step, total: p.total, phase: p.phase };
      else if (p.phase) job.progress = { ...(job.progress || {}), phase: p.phase };
    } catch { /* il worker è occupato: riproviamo al giro dopo */ }
  }, 1000);
  let out;
  try {
    out = await httpJson(`${url}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    clearInterval(timer);
  }
  log(`Worker: fatto in ${out.seconds?.toFixed?.(1) ?? '?'} s su ${out.device || '?'}`);
  return out.outputs.map((o) => `data:${o.type};base64,${o.data}`);
}

// ---------- ComfyUI ----------

async function comfyUpload(base, attachment) {
  const { type, buf } = dataUrlToBuffer(attachment.dataUrl);
  const form = new FormData();
  form.append('image', new Blob([buf], { type }), attachment.name || `ideax-${Date.now()}.png`);
  form.append('overwrite', 'true');
  const res = await httpJson(`${base}/upload/image`, { method: 'POST', body: form });
  return res.subfolder ? `${res.subfolder}/${res.name}` : res.name;
}

async function runComfy(server, task, job, log) {
  if (!server.template) throw new Error('Per ComfyUI incolla nel server il workflow esportato con "Save (API Format)".');
  const base = server.endpoint;
  const image = firstOf(job, 'image');
  const video = firstOf(job, 'video');
  const vars = {
    prompt: job.routedPrompt,
    original_prompt: job.prompt,
    negative_prompt: job.negativePrompt || '',
    seed: Math.floor(Math.random() * 2 ** 32),
    image: image ? await comfyUpload(base, image) : null,
    video: video ? await comfyUpload(base, video) : null,
    ...job.params,
  };
  const workflow = fillTemplate(server.template, vars);
  return comfyExecute(base, workflow, job, log);
}

async function comfyExecute(base, workflow, job, log) {
  const { prompt_id: id } = await httpJson(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: 'ideax' }),
  });
  log(`ComfyUI: lavoro ${id} in coda`);
  for (;;) {
    await sleep(1500);
    const hist = await httpJson(`${base}/history/${id}`);
    const entry = hist[id];
    if (!entry) continue;
    if (entry.status?.status_str === 'error') {
      const msg = (entry.status.messages || []).find((m) => m[0] === 'execution_error')?.[1];
      throw new Error(`ComfyUI: ${msg ? `${msg.node_type || ''} ${msg.exception_message || ''}`.trim() : 'errore nel flusso'}`);
    }
    if (job.cancelled) { await fetch(`${base}/interrupt`, { method: 'POST' }).catch(() => {}); throw new Error('Annullato'); }
    if (!entry.status?.completed && !Object.keys(entry.outputs || {}).length) continue;
    const files = Object.values(entry.outputs || {}).flatMap((o) => [...(o.images || []), ...(o.gifs || []), ...(o.videos || [])]);
    return files
      .filter((f) => f.type !== 'temp')
      .map((f) => `${base}/view?${new URLSearchParams({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' })}`);
  }
}

// ---------- Automatic1111 / Forge / SD.Next ----------

async function runA1111(server, task, job, log) {
  const image = firstOf(job, 'image');
  const extra = server.template ? fillTemplate(server.template, { prompt: job.routedPrompt, negative_prompt: job.negativePrompt || '' }) : {};
  const body = { prompt: job.routedPrompt, negative_prompt: job.negativePrompt || '', ...extra, ...job.params };
  let endpoint = 'txt2img';
  if (task === 'image_edit') {
    if (!image) throw new Error('Per modificare un\'immagine allegala al prompt.');
    endpoint = 'img2img';
    body.init_images = [image.dataUrl.slice(image.dataUrl.indexOf(',') + 1)];
    body.denoising_strength ??= 0.6;
  }
  log(`Invio a ${server.name} (${endpoint})`);
  const out = await httpJson(`${server.endpoint}/sdapi/v1/${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...server.headers },
    body: JSON.stringify(body),
  });
  return (out.images || []).map((b64) => `data:image/png;base64,${b64}`);
}

// ---------- Endpoint personalizzato ----------

async function runCustom(server, task, job, log) {
  const vars = {
    prompt: job.routedPrompt,
    original_prompt: job.prompt,
    negative_prompt: job.negativePrompt || '',
    task,
    image: firstOf(job, 'image')?.dataUrl ?? null,
    video: firstOf(job, 'video')?.dataUrl ?? null,
    images: job.attachments.filter((a) => a.type?.startsWith('image/')).map((a) => a.dataUrl),
  };
  const input = { ...fillTemplate(server.template || { prompt: '{{prompt}}', task: '{{task}}', image: '{{image}}', video: '{{video}}' }, vars), ...job.params };
  log(`Invio a ${server.endpoint}`);
  const res = await fetch(server.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...server.headers },
    body: JSON.stringify(input),
  }).catch((err) => { throw new Error(`Non riesco a contattare ${server.endpoint}: ${err.cause?.code || err.message}`); });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (/^(image|video)\//.test(type)) {
    return [`data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`];
  }
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return extractMedia(parsed);
}

// ---------- Risultati ----------

const MEDIA_EXT = /\.(png|jpe?g|webp|gif|mp4|webm|mov)(\?|$)/i;

export function extractMedia(output) {
  const found = [];
  const visit = (v, key) => {
    if (typeof v === 'string') {
      if (/^data:(image|video)\//.test(v)) found.push(v);
      else if (/^https?:\/\//.test(v)) found.push(v);
      else if (['b64_json', 'base64', 'image', 'images'].includes(key) && v.length > 100) found.push(`data:image/png;base64,${v}`);
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, k);
  };
  visit(output);
  const media = found.filter((u) => u.startsWith('data:') || MEDIA_EXT.test(u) || u.includes('/view?'));
  return [...new Set(media)];
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

async function save(src, base) {
  let buf, type;
  if (src.startsWith('data:')) ({ type, buf } = dataUrlToBuffer(src));
  else {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Download fallito (${res.status})`);
    type = (res.headers.get('content-type') || '').split(';')[0];
    buf = Buffer.from(await res.arrayBuffer());
    if (!EXT[type]) {
      const ext = (src.match(MEDIA_EXT)?.[1] || src.match(/filename=[^&]*\.(\w+)/)?.[1] || '').toLowerCase();
      type = Object.keys(EXT).find((t) => EXT[t] === (ext === 'jpeg' ? 'jpg' : ext)) || type;
    }
  }
  const name = `${base}.${EXT[type] || 'bin'}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, name), buf);
  return { url: `/outputs/${name}`, type: type || 'application/octet-stream' };
}

// ---------- MOSS-Image su ComfyUI (motore di ideax) ----------
// Il flusso si costruisce qui: modello int8, encoder Qwen3.5-9B, VAE di FLUX.2, le LoRA scelte e 30 passi a guida 3.
async function runMoss(model, task, job, log) {
  if (task !== 'image_generate') throw new Error('MOSS-Image per ora crea immagini da testo.');
  const engines = await import('./engines.js');
  await fetch(`${getSettings().workerUrl}/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  engines.stop('music');
  (await import('./llamaserver.js')).stop();
  log('Accendo ComfyUI con MOSS-Image (la prima volta carica i modelli: qualche minuto)…');
  const base = await engines.ensureRunning('comfyui');
  const modelsDir = path.join(engines.appDirOf('comfyui'), 'models');
  // ComfyUI cerca ogni tipo di file nella sua cartella (vae/, text_encoders/…): se un pacchetto l'ha messo altrove, lo spostiamo
  const rel = (sub, name) => {
    const target = path.join(modelsDir, sub, name);
    if (!fs.existsSync(target)) {
      const found = engines.findFile(modelsDir, name);
      if (!found) throw new Error(`Manca il file ${name}: reinstalla il motore MOSS-Image`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(found, target);
    }
    return name;
  };
  const p = job.params || {};
  let width = Number(p.width) || 1024;
  let height = Number(p.height) || 1024;
  if (p.aspect) {
    const [a, b] = String(p.aspect).split(':').map(Number);
    const area = 1024 * 1024;
    width = Math.round(Math.sqrt(area * a / b) / 16) * 16;
    height = Math.round(Math.sqrt(area * b / a) / 16) * 16;
  }
  const loraRoot = path.join((await import('./store.js')).MODELS_DIR, 'loras');
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: rel('diffusion_models', 'moss_image_sft_int8_convrot_attn.safetensors'), weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: rel('text_encoders', 'qwen3.5_9b_int8_convrot.safetensors'), type: 'moss_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: rel('vae', 'flux2-vae.safetensors') } },
  };
  let modelRef = ['1', 0];
  for (const [i, l] of (job.loras || []).entries()) {
    if (!l.path.startsWith(loraRoot)) { log(`LoRA ${l.name} fuori dalla cartella loras di ideax: saltata`); continue; }
    const id = String(20 + i);
    wf[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: path.relative(loraRoot, l.path).split(path.sep).join('/'), strength_model: Number(l.weight ?? l.loraWeight ?? 1) } };
    modelRef = [id, 0];
    log(`Con la LoRA ${l.name}`);
  }
  Object.assign(wf, {
    4: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.routedPrompt } },
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.negativePrompt || '' } },
    6: { class_type: 'EmptyFlux2LatentImage', inputs: { width, height, batch_size: Math.min(4, Number(p.num_images_per_prompt) || 1) } },
    7: { class_type: 'KSampler', inputs: { model: modelRef, positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: p.seed != null ? Number(p.seed) : Math.floor(Math.random() * 2 ** 32), steps: Number(p.num_inference_steps) || 30, cfg: Number(p.guidance_scale) || 3, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    8: { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    9: { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'ideax' } },
  });
  const skin = !['false', '0', 'no'].includes(String(p.skin_fix ?? true).toLowerCase());
  if (skin) {
    // Pelle e dettagli: si ingrandisce 1,5 volte e MOSS (con le stesse LoRA) ripassa l'immagine con un tocco leggero
    Object.assign(wf, {
      10: { class_type: 'ImageScaleBy', inputs: { image: ['8', 0], upscale_method: 'lanczos', scale_by: 1.5 } },
      11: { class_type: 'VAEEncode', inputs: { pixels: ['10', 0], vae: ['3', 0] } },
      12: { class_type: 'KSampler', inputs: { ...wf[7].inputs, latent_image: ['11', 0], denoise: 0.3 } },
      13: { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['3', 0] } },
    });
    wf[9].inputs.images = ['13', 0];
    log('Con la rifinitura della pelle (ingrandimento 1,5×)');
  }
  let sources;
  try {
    sources = await comfyExecute(base, wf, job, log);
  } catch (err) {
    if (!skin || job.cancelled || !/memory|memoria|OOM|allocat/i.test(err.message)) throw err;
    log('Memoria della scheda video al limite: rifaccio senza ingrandimento');
    for (const k of [10, 11, 12, 13]) delete wf[k];
    wf[9].inputs.images = ['8', 0];
    sources = await comfyExecute(base, wf, job, log);
  }
  return refineFacesOnWorker(sources, job, log);
}

// Volti (e grana fotografica) per le immagini fatte da un altro motore: li ridisegna il worker con il miglior
// modello realistico installato. Se non c'è un modello adatto, o qualcosa va storto, si tengono le immagini come sono.
async function refineFacesOnWorker(sources, job, log) {
  const p = job.params || {};
  if (['false', '0', 'no'].includes(String(p.face_fix ?? true).toLowerCase())) return sources;
  const { buildCatalog } = await import('./router.js');
  const pick = buildCatalog().all
    .filter((m) => m.backend === 'worker' && m.enabled !== false && m.kind === 'checkpoint' && ['sdxl', 'flux', 'sd15'].includes(m.arch) && m.capabilities?.includes('image_generate'))
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || ({ sdxl: 2, flux: 1, sd15: 0 }[b.arch] - { sdxl: 2, flux: 1, sd15: 0 }[a.arch]))[0];
  if (!pick) { log('Rifinitura dei volti saltata: serve un modello SDXL, Flux o SD 1.5 nella pagina Modelli'); return sources; }
  // Prima si scaricano le immagini da ComfyUI, poi lo si spegne per lasciare la scheda video al worker
  const images = [];
  for (const src of sources) {
    if (src.startsWith('data:')) { images.push(src); continue; }
    const r = await fetch(src);
    const type = (r.headers.get('content-type') || 'image/png').split(';')[0];
    images.push(`data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`);
  }
  (await import('./engines.js')).stop('comfyui');
  log(`Rifinisco i volti con ${pick.name}`);
  const out = [];
  for (const image of images) {
    try {
      const r = await httpJson(`${getSettings().workerUrl}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15 * 60_000),
        body: JSON.stringify({
          model: { path: pick.path, format: pick.format, arch: pick.arch, pipeline_class: pick.pipelineClass || null, transformer_only: !!pick.flags?.transformerOnly, flux_variant: pick.flags?.fluxVariant || null, fp8: pick.flags?.fp8 || null },
          task: 'image_generate', prompt: job.routedPrompt, negative_prompt: job.negativePrompt || '', image, params: { ...(p.seed != null ? { seed: Number(p.seed) } : {}) },
        }),
      });
      const o = r.outputs?.[0];
      out.push(o ? `data:${o.type};base64,${o.data}` : image);
    } catch (err) {
      log(`Rifinitura dei volti non riuscita (${err.message}): tengo l'immagine com'è`);
      out.push(image);
    }
  }
  return out;
}

// I file di un motore aggiuntivo di ComfyUI (Wan, Qwen, Kontext): nome per chiave, e un errore chiaro se ne manca uno
function comfyFiles(engines, id, modelsDir) {
  const e = engines.CATALOG[id];
  const out = {};
  for (const [key, [sub, name]] of Object.entries(e.files)) {
    if (!fs.existsSync(path.join(modelsDir, sub, name))) throw new Error(`Manca ${name}: reinstalla "${e.name}" dalla pagina Modelli`);
    out[key] = name;
  }
  return out;
}

// Prima di un lavoro su ComfyUI: si libera la scheda video dagli altri motori e si accende ComfyUI
async function comfyPrepare(log, what) {
  const engines = await import('./engines.js');
  await fetch(`${getSettings().workerUrl}/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  engines.stop('music');
  (await import('./llamaserver.js')).stop();
  log(`Accendo ComfyUI con ${what} (la prima volta carica i modelli: qualche minuto)…`);
  const base = await engines.ensureRunning('comfyui');
  return { engines, base, modelsDir: path.join(engines.appDirOf('comfyui'), 'models') };
}

const imagesOf = (job) => job.attachments.filter((a) => a.type?.startsWith('image/'));

// ---------- Fotomontaggio: Qwen-Image-Edit-2509 su ComfyUI ----------
// Flusso ufficiale di ComfyUI per il 2509: foto ridimensionata a ~1 megapixel, TextEncodeQwenImageEditPlus con
// fino a 3 immagini (1 = la persona, 2-3 = stile o elementi), ModelSamplingAuraFlow 3 + CFGNorm, e con la LoRA
// Lightning 8 passi a guida 1 (senza: 20 passi a guida 2,5).
async function runQwenEdit(model, task, job, log) {
  const imgs = imagesOf(job).slice(0, 3);
  if (!imgs.length) throw new Error('Per il fotomontaggio allega la foto da trasformare');
  const { engines, base, modelsDir } = await comfyPrepare(log, 'Qwen-Image-Edit');
  const f = comfyFiles(engines, 'qwenedit', modelsDir);
  const p = job.params || {};
  const lightning = !['false', '0', 'no'].includes(String(p.lightning ?? true).toLowerCase());
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: f.model, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: f.te, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: f.vae } },
  };
  let modelRef = ['1', 0];
  if (lightning) { wf[4] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: f.lightning, strength_model: 1 } }; modelRef = ['4', 0]; }
  wf[5] = { class_type: 'ModelSamplingAuraFlow', inputs: { model: modelRef, shift: 3 } };
  wf[6] = { class_type: 'CFGNorm', inputs: { model: ['5', 0], strength: 1 } };
  const enc = { clip: ['2', 0], vae: ['3', 0] };
  for (const [i, img] of imgs.entries()) {
    const load = String(10 + i), scale = String(20 + i);
    wf[load] = { class_type: 'LoadImage', inputs: { image: await comfyUpload(base, img) } };
    wf[scale] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: [load, 0], upscale_method: 'lanczos', megapixels: Number(p.megapixels) || 1, resolution_steps: 1 } };
    enc[`image${i + 1}`] = [scale, 0];
  }
  Object.assign(wf, {
    30: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { ...enc, prompt: job.routedPrompt } },
    31: { class_type: 'TextEncodeQwenImageEditPlus', inputs: { ...enc, prompt: job.negativePrompt || '' } },
    32: { class_type: 'VAEEncode', inputs: { pixels: ['20', 0], vae: ['3', 0] } },
    33: { class_type: 'KSampler', inputs: { model: ['6', 0], positive: ['30', 0], negative: ['31', 0], latent_image: ['32', 0], seed: p.seed != null ? Number(p.seed) : Math.floor(Math.random() * 2 ** 32), steps: Number(p.num_inference_steps) || (lightning ? 8 : 20), cfg: Number(p.guidance_scale) || (lightning ? 1 : 2.5), sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    34: { class_type: 'VAEDecode', inputs: { samples: ['33', 0], vae: ['3', 0] } },
    35: { class_type: 'SaveImage', inputs: { images: ['34', 0], filename_prefix: 'ideax/qwenedit' } },
  });
  log(`Fotomontaggio con ${imgs.length} immagin${imgs.length > 1 ? 'i' : 'e'}${lightning ? ', 8 passi' : ''}`);
  return comfyExecute(base, wf, job, log);
}

// ---------- Immagini con testo: Qwen-Image su ComfyUI ----------
// Flusso ufficiale: ModelSamplingAuraFlow 3,1, EmptySD3LatentImage ~1,3 megapixel, Lightning 8 passi a guida 1
// (senza: 25 passi a guida 2,5). Il prompt va scritto con il testo tra virgolette, esattamente come deve apparire.
async function runQwenImage(model, task, job, log) {
  const { engines, base, modelsDir } = await comfyPrepare(log, 'Qwen-Image');
  const f = comfyFiles(engines, 'qwenimage', modelsDir);
  const p = job.params || {};
  const lightning = !['false', '0', 'no'].includes(String(p.lightning ?? true).toLowerCase());
  const aspect = String(p.aspect || '1:1');
  const SIZES = { '1:1': [1328, 1328], '16:9': [1664, 928], '9:16': [928, 1664], '4:3': [1472, 1104], '3:4': [1104, 1472], '3:2': [1584, 1056], '2:3': [1056, 1584], '4:5': [1088, 1360] };
  const [width, height] = SIZES[aspect] || SIZES['1:1'];
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: f.model, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: f.te, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: f.vae } },
  };
  let modelRef = ['1', 0];
  if (lightning) { wf[4] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: f.lightning, strength_model: 1 } }; modelRef = ['4', 0]; }
  Object.assign(wf, {
    5: { class_type: 'ModelSamplingAuraFlow', inputs: { model: modelRef, shift: 3.1 } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.routedPrompt } },
    7: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.negativePrompt || '' } },
    8: { class_type: 'EmptySD3LatentImage', inputs: { width, height, batch_size: Math.min(4, Number(p.num_images_per_prompt) || 1) } },
    9: { class_type: 'KSampler', inputs: { model: ['5', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0], seed: p.seed != null ? Number(p.seed) : Math.floor(Math.random() * 2 ** 32), steps: Number(p.num_inference_steps) || (lightning ? 8 : 25), cfg: Number(p.guidance_scale) || (lightning ? 1 : 2.5), sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    10: { class_type: 'VAEDecode', inputs: { samples: ['9', 0], vae: ['3', 0] } },
    11: { class_type: 'SaveImage', inputs: { images: ['10', 0], filename_prefix: 'ideax/qwenimage' } },
  });
  log(`Immagine con testo ${width}×${height}${lightning ? ', 8 passi' : ''}`);
  return comfyExecute(base, wf, job, log);
}

// ---------- Ingrandimento 4×: 4x-UltraSharp su ComfyUI ----------
async function runUpscale(model, task, job, log) {
  const img = imagesOf(job)[0];
  if (!img) throw new Error('Per ingrandire allega l\'immagine');
  const { engines, base, modelsDir } = await comfyPrepare(log, 'l\'ingrandimento 4×');
  const f = comfyFiles(engines, 'upscale', modelsDir);
  const wf = {
    1: { class_type: 'LoadImage', inputs: { image: await comfyUpload(base, img) } },
    2: { class_type: 'UpscaleModelLoader', inputs: { model_name: f.model } },
    3: { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['2', 0], image: ['1', 0] } },
    4: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'ideax/upscale' } },
  };
  log('Ingrandisco 4 volte');
  return comfyExecute(base, wf, job, log);
}

// ---------- Fotomontaggio fedele: FLUX.1 Kontext dev su ComfyUI ----------
// Flusso ufficiale: FluxKontextImageScale → VAEEncode → ReferenceLatent sul testo, FluxGuidance 2,5, 20 passi euler.
async function runKontext(model, task, job, log) {
  const img = imagesOf(job)[0];
  if (!img) throw new Error('Per il fotomontaggio allega la foto da trasformare');
  const { engines, base, modelsDir } = await comfyPrepare(log, 'FLUX.1 Kontext');
  const f = comfyFiles(engines, 'kontext', modelsDir);
  const p = job.params || {};
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: f.model, weight_dtype: 'default' } },
    2: { class_type: 'DualCLIPLoader', inputs: { clip_name1: f.clip, clip_name2: f.t5, type: 'flux', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: f.vae } },
    10: { class_type: 'LoadImage', inputs: { image: await comfyUpload(base, img) } },
    11: { class_type: 'FluxKontextImageScale', inputs: { image: ['10', 0] } },
    12: { class_type: 'VAEEncode', inputs: { pixels: ['11', 0], vae: ['3', 0] } },
    13: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.routedPrompt } },
    14: { class_type: 'ReferenceLatent', inputs: { conditioning: ['13', 0], latent: ['12', 0] } },
    15: { class_type: 'FluxGuidance', inputs: { conditioning: ['14', 0], guidance: Number(p.guidance_scale) || 2.5 } },
    16: { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['13', 0] } },
    17: { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['15', 0], negative: ['16', 0], latent_image: ['12', 0], seed: p.seed != null ? Number(p.seed) : Math.floor(Math.random() * 2 ** 32), steps: Number(p.num_inference_steps) || 20, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    18: { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['3', 0] } },
    19: { class_type: 'SaveImage', inputs: { images: ['18', 0], filename_prefix: 'ideax/kontext' } },
  };
  log('Fotomontaggio fedele con FLUX.1 Kontext, 20 passi');
  return comfyExecute(base, wf, job, log);
}

// ---------- Wan 2.2 TI2V-5B su ComfyUI (motore video di ideax) ----------
// Flusso ufficiale di ComfyUI per il 5B: modello + encoder umT5 + VAE di Wan 2.2, ModelSamplingSD3 (shift 8),
// latente Wan22ImageToVideoLatent (con la foto di partenza, se c'è), 20 passi uni_pc a guida 5, video a 24 fps.
async function runWan(model, task, job, log) {
  const { engines, base, modelsDir } = await comfyPrepare(log, 'Wan 2.2');
  const files = comfyFiles(engines, 'wan', modelsDir);
  const p = job.params || {};
  const aspect = String(p.aspect || '16:9');
  // Veloce (bozza): circa metà dei pixel e meno passi. Le misure restano multipli di 32, come vuole Wan
  const veloce = ['true', '1', 'si', 'sì'].includes(String(p.veloce ?? '').toLowerCase());
  const [width, height] = veloce
    ? (aspect === '9:16' ? [544, 960] : aspect === '1:1' ? [704, 704] : aspect === '4:5' ? [576, 704] : [960, 544])
    : (aspect === '9:16' ? [704, 1280] : aspect === '1:1' ? [960, 960] : aspect === '4:5' ? [768, 960] : [1280, 704]);
  const seconds = Math.min(5, Math.max(1, Number(p.seconds || p.secondi || p.duration) || 5));
  const length = Math.round(seconds * 24 / 4) * 4 + 1; // Wan vuole 4n+1 fotogrammi
  const image = firstOf(job, 'image');
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: files.model, weight_dtype: 'default' } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: files.te, type: 'wan', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: files.vae } },
    4: { class_type: 'ModelSamplingSD3', inputs: { model: ['1', 0], shift: 8 } },  // il modello passa prima dalle LoRA (sotto)
    5: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.routedPrompt } },
    6: { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: job.negativePrompt || 'blurry, low quality, static, still image, distorted faces, deformed hands, extra fingers, watermark, text, subtitles, flicker, jitter, overexposed' } },
    7: { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['3', 0], width, height, length, batch_size: 1 } },
    8: { class_type: 'KSampler', inputs: { model: ['4', 0], positive: ['5', 0], negative: ['6', 0], latent_image: ['7', 0], seed: p.seed != null ? Number(p.seed) : Math.floor(Math.random() * 2 ** 32), steps: Number(p.num_inference_steps) || (veloce ? 12 : 20), cfg: Number(p.guidance_scale) || 5, sampler_name: 'uni_pc', scheduler: 'simple', denoise: 1 } },
    9: { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } },
    11: { class_type: 'CreateVideo', inputs: { images: ['9', 0], fps: 24 } },
    12: { class_type: 'SaveVideo', inputs: { video: ['11', 0], filename_prefix: 'ideax/wan', format: 'mp4', codec: 'h264' } },
  };
  // LoRA per Wan (stile, movimenti, contenuti): stessa cartella loras di ideax, come per MOSS
  const loraRoot = path.join((await import('./store.js')).MODELS_DIR, 'loras');
  let modelRef = ['1', 0];
  for (const [i, l] of (job.loras || []).entries()) {
    if (!l.path.startsWith(loraRoot)) { log(`LoRA ${l.name} fuori dalla cartella loras di ideax: saltata`); continue; }
    const id = String(40 + i);
    wf[id] = { class_type: 'LoraLoaderModelOnly', inputs: { model: modelRef, lora_name: path.relative(loraRoot, l.path).split(path.sep).join('/'), strength_model: Number(l.weight ?? l.loraWeight ?? 1) } };
    modelRef = [id, 0];
    log(`Con la LoRA ${l.name}`);
  }
  wf[4].inputs.model = modelRef;
  if (image) {
    wf[10] = { class_type: 'LoadImage', inputs: { image: await comfyUpload(base, image) } };
    wf[7].inputs.start_image = ['10', 0];
    log(`Animo la foto di partenza: ${width}×${height}, ${seconds} s${veloce ? ' (veloce)' : ''}`);
  } else {
    log(`Video da testo: ${width}×${height}, ${seconds} s${veloce ? ' (veloce)' : ''}`);
  }
  return comfyExecute(base, wf, job, log);
}

// ---------- Wan 2.2 14B su ComfyUI: due esperti (alto/basso rumore) + Lightning 4 passi (sperimentale) ----------
async function runWan14b(model, task, job, log) {
  const image = firstOf(job, 'image');
  if (!image) throw new Error('Wan 14B parte da una foto: allega l\'immagine di partenza (ideax la crea prima se chiedi un video).');
  const { engines, base, modelsDir } = await comfyPrepare(log, 'Wan 2.2 14B (pesante: può metterci)');
  const f = comfyFiles(engines, 'wan14b', modelsDir);
  const p = job.params || {};
  const aspect = String(p.aspect || '16:9');
  const [width, height] = aspect === '9:16' ? [704, 1280] : aspect === '1:1' ? [768, 768] : [1280, 704];
  const seconds = Math.min(5, Math.max(1, Number(p.seconds || p.secondi || p.duration) || 4));
  const length = Math.round(seconds * 16 / 4) * 4 + 1; // Wan vuole 4n+1
  const path_ = (await import('node:path')).default;
  const loraRoot = path_.join((await import('./store.js')).MODELS_DIR, 'loras');
  // La LoRA Lightning (nei file di sistema) + eventuali LoRA dell'utente, applicate a entrambi gli esperti
  const fs2 = (await import('node:fs')).default;
  const lorasDir = path_.join(modelsDir, 'loras');
  const lightning = (fs2.existsSync(lorasDir) ? fs2.readdirSync(lorasDir, { recursive: true }).map(String).find((x) => /lightning/i.test(x) && /wan/i.test(x) && x.endsWith('.safetensors')) : null);
  const lightningPath = lightning ? path_.join(lorasDir, lightning) : null;
  const wf = {
    1: { class_type: 'UNETLoader', inputs: { unet_name: f.high, weight_dtype: 'default' } },
    2: { class_type: 'UNETLoader', inputs: { unet_name: f.low, weight_dtype: 'default' } },
    3: { class_type: 'CLIPLoader', inputs: { clip_name: f.te, type: 'wan', device: 'default' } },
    4: { class_type: 'VAELoader', inputs: { vae_name: f.vae } },
    5: { class_type: 'LoadImage', inputs: { image: await comfyUpload(base, image) } },
  };
  const applicaLore = (ref, startId) => {
    let r = ref; let id = startId;
    for (const l of (job.loras || [])) {
      if (!l.path.startsWith(loraRoot)) continue;
      wf[String(id)] = { class_type: 'LoraLoaderModelOnly', inputs: { model: r, lora_name: path_.relative(loraRoot, l.path).split(path_.sep).join('/'), strength_model: Number(l.weight ?? l.loraWeight ?? 1) } };
      r = [String(id), 0]; id++;
    }
    return r;
  };
  let high = applicaLore(['1', 0], 60);
  let low = applicaLore(['2', 0], 70);
  wf[10] = { class_type: 'ModelSamplingSD3', inputs: { model: high, shift: 8 } };
  wf[11] = { class_type: 'ModelSamplingSD3', inputs: { model: low, shift: 8 } };
  wf[12] = { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: job.routedPrompt } };
  wf[13] = { class_type: 'CLIPTextEncode', inputs: { clip: ['3', 0], text: job.negativePrompt || 'blurry, low quality, static, distorted, watermark, text' } };
  wf[14] = { class_type: 'Wan22ImageToVideoLatent', inputs: { vae: ['4', 0], width, height, length, batch_size: 1, start_image: ['5', 0] } };
  const steps = Number(p.num_inference_steps) || (lightning ? 4 : 20);
  const mid = Math.max(1, Math.round(steps / 2));
  const cfg = Number(p.guidance_scale) || (lightning ? 1 : 5);
  // esperto alto rumore: prima metà dei passi, lascia il rumore per il secondo
  wf[15] = { class_type: 'KSamplerAdvanced', inputs: { model: ['10', 0], add_noise: 'enable', noise_seed: p.seed != null ? Number(p.seed) : Math.floor(Math.random() * 2 ** 32), steps, cfg, sampler_name: 'euler', scheduler: 'simple', positive: ['12', 0], negative: ['13', 0], latent_image: ['14', 0], start_at_step: 0, end_at_step: mid, return_with_leftover_noise: 'enable' } };
  // esperto basso rumore: seconda metà
  wf[16] = { class_type: 'KSamplerAdvanced', inputs: { model: ['11', 0], add_noise: 'disable', noise_seed: 0, steps, cfg, sampler_name: 'euler', scheduler: 'simple', positive: ['12', 0], negative: ['13', 0], latent_image: ['15', 0], start_at_step: mid, end_at_step: steps, return_with_leftover_noise: 'disable' } };
  wf[17] = { class_type: 'VAEDecode', inputs: { samples: ['16', 0], vae: ['4', 0] } };
  wf[18] = { class_type: 'CreateVideo', inputs: { images: ['17', 0], fps: 16 } };
  wf[19] = { class_type: 'SaveVideo', inputs: { video: ['18', 0], filename_prefix: 'ideax/wan14b', format: 'mp4', codec: 'h264' } };
  if (lightningPath) { wf[50] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['10', 0], lora_name: lightning.split(path_.sep).join('/'), strength_model: 1 } }; wf[15].inputs.model = ['50', 0]; wf[51] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['11', 0], lora_name: lightning.split(path_.sep).join('/'), strength_model: 1 } }; wf[16].inputs.model = ['51', 0]; }
  log(`Wan 14B: ${width}×${height}, ${seconds}s, due esperti${lightning ? ', 4 passi' : ''}`);
  return comfyExecute(base, wf, job, log);
}

const RUNNERS = { worker: runWorker, comfyui: runComfy, a1111: runA1111, custom: runCustom, moss: runMoss, wan: runWan, qwenedit: runQwenEdit, kontext: runKontext, qwenimage: runQwenImage, upscale: runUpscale, wan14b: runWan14b };

export async function cancelOnWorker() {
  await fetch(`${getSettings().workerUrl}/cancel`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

// Tutto ciò che usa la scheda video di questo PC (worker immagini e motori come la voce) passa da un'unica fila
export const GPU_QUEUE = 'gpu-locale';

// La GPU di questo PC sta già lavorando? Lo chiede la farm: il capofila offre un lavoro agli altri PC SOLO quando la
// sua scheda è occupata (un lavoro singolo su una scheda libera resta qui, come prima).
export function localBusy() {
  return (pending.get(GPU_QUEUE) || 0) > 0;
}

export async function inGpuQueue(job, log, fn) {
  if (pending.get(GPU_QUEUE) > 0) {
    job.waiting = true;
    log('In fila: la GPU sta finendo un altro lavoro…');
  }
  return enqueue(GPU_QUEUE, () => {
    job.waiting = false;
    if (job.cancelled) throw new Error('Annullato');
    job.startedAt = Date.now();
    return fn();
  });
}

export async function runModel(model, task, job, log) {
  const runner = RUNNERS[model.backend];
  if (!runner) throw new Error(`Motore sconosciuto: ${model.backend}`);
  const key = ['worker', 'moss', 'wan', 'qwenedit', 'kontext', 'qwenimage', 'upscale', 'wan14b'].includes(model.backend) ? GPU_QUEUE : model.endpoint;
  if (pending.get(key) > 0) {
    job.waiting = true;
    log('In fila: la GPU sta finendo un altro lavoro…');
  }
  const sources = await enqueue(key, async () => {
    job.waiting = false;
    if (job.cancelled) throw new Error('Annullato');
    if (model.backend === 'worker') {
      // Immagini e video vogliono tutta la scheda video: si spengono musica e cervello (si riaccendono quando servono)
      (await import('./engines.js')).stop('music');
      (await import('./engines.js')).stop('comfyui');
      (await import('./llamaserver.js')).stop();
    }
    job.startedAt = Date.now();
    job.backend = model.backend;
    return runner(model, task, job, log);
  });
  if (!sources.length) throw new Error('Il motore ha risposto ma senza immagini o video.');
  const results = [];
  for (const [i, src] of sources.entries()) {
    results.push(await save(src, `${job.id}-${i + 1}-${crypto.randomUUID().slice(0, 4)}`));
  }
  return results;
}
