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
    if (entry.status?.status_str === 'error') throw new Error('ComfyUI ha segnalato un errore nel workflow');
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

const RUNNERS = { worker: runWorker, comfyui: runComfy, a1111: runA1111, custom: runCustom };

export async function cancelOnWorker() {
  await fetch(`${getSettings().workerUrl}/cancel`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

export async function runModel(model, task, job, log) {
  const runner = RUNNERS[model.backend];
  if (!runner) throw new Error(`Motore sconosciuto: ${model.backend}`);
  const key = model.backend === 'worker' ? getSettings().workerUrl : model.endpoint;
  if (pending.get(key) > 0) {
    job.waiting = true;
    log('In fila: la GPU sta finendo un altro lavoro…');
  }
  const sources = await enqueue(key, () => {
    job.waiting = false;
    if (job.cancelled) throw new Error('Annullato');
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
