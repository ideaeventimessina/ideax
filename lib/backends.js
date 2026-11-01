// Esecuzione dei lavori sui motori locali:
// - worker: il worker Python di ideax (diffusers) che carica i file scaricati da Civitai/Hugging Face
// - comfyui: un ComfyUI già installato, con un workflow esportato in formato API
// - a1111: Automatic1111 / Forge / SD.Next avviati con --api
// - custom: qualsiasi altro server HTTP sul tuo PC
import fs from 'node:fs';
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

async function httpJson(url, options = {}) {
  let res;
  try {
    res = await fetch(url, options);
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

const RUNNERS = { worker: runWorker, comfyui: runComfy, a1111: runA1111, custom: runCustom, moss: runMoss };

export async function cancelOnWorker() {
  await fetch(`${getSettings().workerUrl}/cancel`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

// Tutto ciò che usa la scheda video di questo PC (worker immagini e motori come la voce) passa da un'unica fila
export const GPU_QUEUE = 'gpu-locale';

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
  const key = model.backend === 'worker' || model.backend === 'moss' ? GPU_QUEUE : model.endpoint;
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
