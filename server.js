// ideax: gateway locale per modelli AI di immagini, video e animazioni.
// Interfaccia web + API unica per tutte le applicazioni. Nessuna API a pagamento: tutto gira sul tuo PC.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import * as store from './lib/store.js';
import { scanModels, readSafetensorsHeader, readGgufArchitecture, classifyKeys, ARCH_LABELS, KIND_LABELS } from './lib/scanner.js';
import { route, buildCatalog, PROMPT_STYLES, styleFor, heuristicTask } from './lib/router.js';
import { resolveBrain } from './lib/brain.js';
import { runModel, cancelOnWorker, inGpuQueue } from './lib/backends.js';
import * as engines from './lib/engines.js';
import * as voices from './lib/voices.js';
import * as voicelib from './lib/voicelib.js';
import * as music from './lib/music.js';
import { runReel } from './lib/reels.js';
import * as catena from './lib/catena.js';
import * as personaggio from './lib/personaggio.js';
import * as trascrizione from './lib/transcribe.js';
import * as visione from './lib/vision.js';
import * as personaggi from './lib/personaggi.js';
import * as webdemo from './lib/webdemo.js';
import { fallbackTitle } from './lib/router.js';
import * as runtime from './lib/runtime.js';
import * as updater from './lib/updater.js';
import * as apikeys from './lib/apikeys.js';
import { deliver } from './lib/webhooks.js';
import { Readable } from 'node:stream';
import * as agent from './lib/agent.js';
import * as memory from './lib/memory.js';
import * as chats from './lib/chats.js';
import * as teachers from './lib/teachers.js';
import * as github from './lib/github.js';
import * as systems from './lib/systems.js';
import * as laser from './lib/laser.js';
import * as llama from './lib/llamaserver.js';
import * as twin from './lib/twin.js';
import * as fixes from './lib/fixes.js';
import * as brains from './lib/brains.js';
import { blockedReason, adultGuard } from './lib/safety.js';
import * as regia from './lib/regia.js';
import { brainPair } from './lib/brain.js';

process.title = 'ideax';

// Senza finestra del terminale (eseguibile Windows): i messaggi vanno nel registro data/ideax.log
if (store.IS_SEA) {
  const logFile = path.join(store.DATA_DIR, 'ideax.log');
  try {
    fs.mkdirSync(store.DATA_DIR, { recursive: true });
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 5e6) fs.renameSync(logFile, `${logFile}.1`);
  } catch {}
  const write = (level) => (...args) => {
    try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`); } catch {}
  };
  console.log = write('INFO');
  console.warn = write('WARN');
  console.error = write('ERRORE');
}
// L'ultima volta che una pagina di ideax si è fatta sentire: all'avvio si apre il browser solo se nessuna pagina è già aperta
let lastPing = 0;
const startup = store.getSettings();
const PORT = Number(process.env.PORT) || 7800;
const HOST = process.env.HOST || (startup.network.lan ? '0.0.0.0' : '127.0.0.1');
// Token unico delle versioni precedenti: resta valido accanto alle chiavi API
const LEGACY_TOKEN = process.env.IDEAX_TOKEN || (startup.network.lan ? startup.network.token : '');
const MAX_JSON = 300 * 1024 * 1024;
const jobs = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_JSON) { reject(new Error('Richiesta troppo grande')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('JSON non valido')); }
    });
    req.on('error', reject);
  });
}

// Corpo della richiesta: JSON oppure multipart/form-data (file veri, come li inviano quasi tutti i sistemi)
async function readBody(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('multipart/form-data')) return readJson(req);
  const form = await new Request('http://ideax.local/', { method: 'POST', headers: { 'content-type': type }, body: Readable.toWeb(req), duplex: 'half' }).formData();
  const body = { attachments: [] };
  for (const [key, value] of form.entries()) {
    if (typeof value === 'object' && value !== null && 'arrayBuffer' in value) {
      const buf = Buffer.from(await value.arrayBuffer());
      const ftype = value.type || 'application/octet-stream';
      body.attachments.push({ name: value.name, type: ftype, dataUrl: `data:${ftype};base64,${buf.toString('base64')}` });
    } else if (['params', 'metadata'].includes(key)) {
      try { body[key] = JSON.parse(value); } catch { throw new Error(`Il campo ${key} deve essere JSON`); }
    } else if (['wait', 'inline'].includes(key)) {
      body[key] = !['false', '0', 'no'].includes(String(value).toLowerCase());
    } else body[key] = value;
  }
  return body;
}

function serveFile(res, root, rel) {
  const full = path.join(root, path.normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(root) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end('Non trovato'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(full).pipe(res);
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);

// ---------- Caricamento modelli (drag & drop) ----------

const SUBFOLDER = { checkpoint: 'checkpoints', lora: 'loras', motion: 'motion', vae: 'vae', llm: 'llm' };

function safeName(name) {
  return path.basename(String(name || '')).replace(/[^\w.\- ()[\]]+/g, '_');
}

function uploadModel(req, res, name) {
  const file = safeName(name);
  if (!/\.(safetensors|ckpt|pt|pth|gguf)$/i.test(file)) {
    req.resume();
    return send(res, 400, { error: 'Formati accettati: .safetensors, .gguf, .ckpt, .pt' });
  }
  const tmp = path.join(store.MODELS_DIR, `.${file}.${crypto.randomUUID().slice(0, 6)}.part`);
  const out = fs.createWriteStream(tmp);
  req.pipe(out);
  req.on('aborted', () => { out.destroy(); fs.rm(tmp, { force: true }, () => {}); });
  out.on('error', (err) => { fs.rm(tmp, { force: true }, () => {}); send(res, 500, { error: err.message }); });
  out.on('finish', () => {
    try {
      let kind = 'checkpoint';
      if (/\.gguf$/i.test(file)) kind = ['flux', 'sd3', 'sdxl', 'sd1', 'wan', 'hyvid', 'ltxv'].includes(readGgufArchitecture(tmp)) ? 'checkpoint' : 'llm';
      else if (/\.safetensors$/i.test(file)) kind = classifyKeys(...Object.values(readSafetensorsHeader(tmp))).kind;
      const dir = path.join(store.MODELS_DIR, SUBFOLDER[kind]);
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, file);
      fs.renameSync(tmp, dest);
      send(res, 200, scanModels().find((m) => m.path === dest) || { file });
    } catch (err) {
      fs.rm(tmp, { force: true }, () => {});
      send(res, 400, { error: `File non riconosciuto: ${err.message}` });
    }
  });
}

// ---------- Lavori ----------

async function normalizeAttachments(list = []) {
  const out = [];
  for (const a of list) {
    if (a?.dataUrl) out.push({ name: a.name || 'file', type: a.type || a.dataUrl.slice(5, a.dataUrl.indexOf(';')), dataUrl: a.dataUrl });
    else if (a?.url) {
      const r = await fetch(a.url);
      if (!r.ok) throw new Error(`Impossibile scaricare l'allegato ${a.url}`);
      const type = (r.headers.get('content-type') || a.type || '').split(';')[0];
      out.push({ name: a.name || a.url.split('/').pop(), type, dataUrl: `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}` });
    } else if (a?.base64 && a?.type) out.push({ name: a.name || 'file', type: a.type, dataUrl: `data:${a.type};base64,${a.base64}` });
  }
  return out;
}

async function createJob(body, ctx = {}) {
  if (body.kind === 'speech') {
    if (!body.prompt?.trim()) throw new Error('Scrivi il testo da leggere');
    if (body.prompt.length > 20000) throw new Error('Testo troppo lungo: massimo 20.000 caratteri per richiesta');
  }
  if (!body.prompt?.trim()) throw new Error('Scrivi un prompt');
  const blocked = blockedReason(`${body.prompt} ${body.reel?.style || ''}`);
  if (blocked) throw new Error(blocked);
  if (body.task && !(body.task in store.TASKS)) throw new Error(`Compito sconosciuto: ${body.task}`);
  const callback = body.callback_url || body.callbackUrl || null;
  if (callback && !/^https?:\/\/.+/i.test(callback)) throw new Error('callback_url deve essere un indirizzo http(s)');
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    prompt: body.prompt.trim(),
    attachments: await normalizeAttachments(body.attachments),
    forceModelId: body.model || body.modelId || null,
    forceTask: body.task || null,
    params: body.params && typeof body.params === 'object' ? body.params : {},
    kind: body.kind || 'media',
    speech: body.speech,
    music: body.music,
    reel: body.reel,
    talk: body.talk,
    catena: body.catena,
    personaggio: body.personaggio,
    demo: body.demo,
    client: ctx.client || 'ideax',
    origin: ctx.origin || '',
    callbackUrl: callback,
    metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : undefined,
    status: 'queued',
    log: [],
    results: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  job.done = processJob(job);
  return job;
}

// Lettura di un testo con una voce clonata, sul motore voce locale
async function runSpeech(job, log) {
  const sp = job.speech || {};
  const voice = voices.findVoice(sp.voice);
  if (!voice) throw new Error(sp.voice ? `Voce non trovata: ${sp.voice}` : 'Non c\'è ancora nessuna voce: creala nella pagina Voce.');
  if (!engines.isInstalled('voice')) throw new Error('Il motore voce non è installato: installalo dalla pagina Voce.');
  Object.assign(job, {
    task: 'speech', modelName: `Voce · ${voice.name}`, title: fallbackTitle(job.prompt), routedPrompt: job.prompt,
    brain: 'motore voce', reason: `Letto con la voce "${voice.name}" (${sp.language || voice.language}).`,
  });
  job.status = 'running';
  log(`Leggo con la voce "${voice.name}"…`);
  const out = await inGpuQueue(job, log, () => {
    job.backend = 'voice';
    return engines.call('voice', '/speak', {
      text: job.prompt,
      language: sp.language || voice.language || 'it',
      reference: voices.samplePath(voice.id),
      format: sp.format === 'wav' ? 'wav' : 'mp3',
      ...(voice.defaults || {}),
      ...Object.fromEntries(['exaggeration', 'cfg_weight', 'temperature', 'seed', 'pause_ms'].filter((k) => sp[k] != null).map((k) => [k, Number(sp[k])])),
    }, { onProgress: (p) => { if (p.total) job.progress = { step: p.step, total: p.total, phase: 'Leggo' }; } });
  });
  const ext = out.type === 'audio/wav' ? 'wav' : 'mp3';
  const name = `${job.id}-voce-${crypto.randomUUID().slice(0, 4)}.${ext}`;
  fs.writeFileSync(path.join(store.OUTPUT_DIR, name), Buffer.from(out.data, 'base64'));
  job.results = [{ url: `/outputs/${name}`, type: out.type, seconds: out.seconds }];
  job.status = 'done';
  log(`Completato: ${out.seconds} secondi di audio in ${out.elapsed} s.`);
}

// Musica con il motore ACE-Step. Prima libera la scheda video: la musica ne usa tanta.
async function runMusic(job, log) {
  if (!engines.isInstalled('music')) throw new Error('Il motore musica non è installato: installalo dalla pagina Musica.');
  const m = job.music || {};
  Object.assign(job, {
    task: 'music', modelName: 'Musica · ACE-Step 1.5', title: m.title || fallbackTitle(job.prompt), routedPrompt: job.prompt,
    brain: 'motore musica',
    reason: `${m.instrumental === false ? (m.lyrics ? 'Canzone con il tuo testo' : 'Canzone con testo scritto dal motore') : 'Brano strumentale'} di ${m.duration || 30} secondi.`,
  });
  job.status = 'running';
  const out = await inGpuQueue(job, log, async () => {
    job.backend = 'music';
    await fetch(`${store.getSettings().workerUrl}/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
    engines.stop('voice');
    llama.stop();
    log('Accendo il motore musica (la prima volta carica i modelli: può servire qualche minuto)…');
    return music.generate({ ...m, prompt: job.prompt }, {
      isCancelled: () => job.cancelled,
      onProgress: (p) => { job.progress = { phase: p.phase, elapsed: p.elapsed, coldStart: p.coldStart, detail: p.detail }; },
    });
  });
  const ext = out.type === 'audio/wav' ? 'wav' : 'mp3';
  const name = `${job.id}-musica-${crypto.randomUUID().slice(0, 4)}.${ext}`;
  fs.writeFileSync(path.join(store.OUTPUT_DIR, name), out.buffer);
  job.results = [{ url: `/outputs/${name}`, type: out.type, seconds: out.seconds, metas: out.metas }];
  job.status = 'done';
  log(`Completato: ${out.seconds} secondi di musica in ${out.elapsed} s.`);
}

// Dallo Studio: "fammi una base lo-fi di 30 secondi" → musica, se il motore è installato
const MUSIC_WORDS = /\b(musica|musicale|base|basi|sottofondo|canzone|brano|jingle|beat|colonna sonora|melodia|traccia audio|strumentale|song|soundtrack)\b/i;
const NOT_MUSIC = /\b(foto|immagine|copertina|logo|disegno|illustrazione|ritratto|video|poster|locandina)\b/i;
export function musicFromPrompt(prompt) {
  if (!MUSIC_WORDS.test(prompt) || NOT_MUSIC.test(prompt)) return null;
  const sec = prompt.match(/(\d+)\s*(s\b|sec|secondi|seconds)/i);
  const min = prompt.match(/(\d+(?:[.,]\d+)?)\s*(min|minuti|minuto|minutes)/i);
  const duration = sec ? Number(sec[1]) : min ? Math.round(parseFloat(min[1].replace(',', '.')) * 60) : 30;
  const song = /\b(canzone|cantat\w*|con (il )?testo|con voce|song)\b/i.test(prompt) && !/\bstrumental\w*/i.test(prompt);
  return { duration, instrumental: !song };
}

async function processJob(job) {
  const log = (msg) => job.log.push({ t: Date.now(), msg });
  try {
    if (job.kind === 'speech') {
      await runSpeech(job, log);
      return;
    }
    if (job.kind === 'music') {
      await runMusic(job, log);
      return;
    }
    if (job.kind === 'reel') {
      await runReel(job, log);
      return;
    }
    if (job.kind === 'talk') {
      await twin.runTalk(job, log);
      return;
    }
    if (job.kind === 'demo') {
      job.results = await webdemo.runDemo(job, log);
      job.status = 'done'; log('Completato.');
      return;
    }
    if (job.kind === 'personaggio') {
      job.results = await personaggio.runPersonaggio(job, log);
      job.status = 'done';
      log('Completato.');
      return;
    }
    if (job.kind === 'catena') {
      job.results = await catena.runCatena(job, log);
      job.status = 'done';
      log('Completato.');
      return;
    }
    // "una foto di me al mare": il gemello si usa con il suo modello (Flux), se la richiesta non ne sceglie un altro
    if (!job.forceModelId && !job.attachments.length) {
      const car = personaggi.personaggioForPrompt(job.prompt);
      if (car?.modelId) { job.forceModelId = car.modelId; log(`Uso il personaggio "${car.personaggio.nome}"`); }
    }
    if (!job.forceModelId && !job.attachments.length) {
      const tw = twin.twinForPrompt(job.prompt);
      if (tw?.modelId) {
        // Per un video il gemello serve alla foto di partenza, non al motore video
        if (/video|animation/.test(job.forceTask || '') || heuristicTask(job.prompt, []) !== 'image_generate') job.twinModelId = tw.modelId;
        else job.forceModelId = tw.modelId;
        log(`Uso il gemello "${tw.lora.name}"`);
      }
    }
    job.status = 'routing';
    log('Analizzo il prompt…');
    const d = await route(job.prompt, job.attachments, { forceModelId: job.forceModelId, forceTask: job.forceTask });
    if (job.cancelled) throw new Error('Annullato');
    // Parametri dello stile (es. clip_skip per Pony) < parametri del modello < parametri della richiesta
    job.params = { ...(d.styleParams || {}), ...(d.model.params || {}), ...job.params };
    // Chi chiama può aggiungere cose da evitare (es. le decorazioni laser): si sommano a quelle dello stile
    if (job.params.negative_prompt) {
      d.negativePrompt = [d.negativePrompt, job.params.negative_prompt].filter(Boolean).join(', ');
      delete job.params.negative_prompt;
    }
    Object.assign(job, {
      task: d.task, modelId: d.model.id, modelName: d.model.name, routedPrompt: d.prompt,
      negativePrompt: d.negativePrompt, loras: d.loras, reason: d.reason, brain: d.brain, title: d.title,
    });
    // Il prompt riscritto dal cervello passa dagli stessi limiti di quello scritto dall'utente
    const blockedRouted = blockedReason(job.routedPrompt);
    if (blockedRouted) throw new Error(blockedRouted);
    { const g = adultGuard(job.routedPrompt, job.negativePrompt); job.routedPrompt = g.prompt; job.negativePrompt = g.negative; }
    // La parola imparata da una LoRA (il viso del gemello) deve stare nel prompt, altrimenti la LoRA non "riconosce" la richiesta
    for (const l of d.loras || []) {
      if (l.promptToken && !job.routedPrompt.includes(l.promptToken)) job.routedPrompt = `${l.promptToken}, ${job.routedPrompt}`;
    }
    log(`Compito: ${store.TASKS[d.task]} → ${d.model.name}`);
    if (d.reason) log(d.reason);
    // Un modello che anima solo una foto (es. Stable Video Diffusion) senza foto di partenza:
    // prima si crea l'immagine dal testo, poi la si anima
    // Wan 2.2: per volti perfetti (e per il gemello) si parte da una foto rifinita, salvo da_foto: false
    const svdOnly = !d.model.capabilities?.includes('video_generate') && (d.model.arch === 'svd' || /StableVideoDiffusion/i.test(d.model.pipelineClass || ''));
    const wanStill = d.model.backend === 'wan' && !['false', '0', 'no'].includes(String(job.params.da_foto ?? true).toLowerCase());
    const needsStill = /video|animation/.test(d.task) && (svdOnly || wanStill)
      && !job.attachments.some((a) => a.type?.startsWith('image/'));
    if (needsStill) {
      log(svdOnly ? 'Il motore video parte da una foto: prima creo l\'immagine dal testo' : 'Prima creo la foto di partenza (rifinita: pelle e volti), poi la animo con Wan 2.2');
      const di = await route(job.prompt, [], { forceTask: 'image_generate', forceModelId: job.twinModelId || null });
      const blockedStill = blockedReason(di.prompt);
      if (blockedStill) throw new Error(blockedStill);
      const still = { ...job, attachments: [], loras: di.loras || [], routedPrompt: di.prompt, negativePrompt: di.negativePrompt,
        params: { ...(di.styleParams || {}), ...(di.model.params || {}), aspect: job.params.aspect || (/reel|verticale|storia|stories|9:16|tiktok/i.test(job.prompt) ? '9:16' : '16:9') } };
      const [img] = await runModel(di.model, 'image_generate', still, log);
      if (job.cancelled) throw new Error('Annullato');
      if (!img) throw new Error('Non sono riuscito a creare la foto di partenza del video');
      const buf = fs.readFileSync(path.join(store.OUTPUT_DIR, path.basename(img.url)));
      job.attachments = [{ name: path.basename(img.url), type: img.type, dataUrl: `data:${img.type};base64,${buf.toString('base64')}` }];
      job.still = img;
      job.params.aspect = still.params.aspect; // il video ha lo stesso formato della foto
      log(`Foto di partenza pronta (${di.model.name}), ora la animo`);
    }
    job.status = 'running';
    job.results = await runModel(d.model, d.task, job, log);
    if (job.still) job.results = [...job.results, job.still];
    job.status = 'done';
    log('Completato.');
  } catch (err) {
    job.status = job.cancelled ? 'cancelled' : 'error';
    job.error = job.cancelled ? 'Annullato' : err.message;
    log(job.cancelled ? 'Lavoro annullato.' : `Errore: ${err.message}`);
  } finally {
    job.finishedAt = Date.now();
    if (job.status !== 'cancelled') {
      store.addHistory({
        id: job.id, title: job.title, prompt: job.prompt, task: job.task, modelName: job.modelName,
        routedPrompt: job.routedPrompt, negativePrompt: job.negativePrompt, loras: (job.loras || []).map((l) => l.name),
        reason: job.reason, brain: job.brain, status: job.status, error: job.error, results: job.results,
        createdAt: job.createdAt, seconds: job.startedAt ? Math.round((job.finishedAt - job.startedAt) / 1000) : null,
        client: job.client, metadata: job.metadata,
        ...(job.catenaInfo ? { catena: job.catenaInfo } : {}),
        ...(job.reelPlan ? { reel: { caption: job.reelPlan.caption, hashtags: job.reelPlan.hashtags, scenes: job.reelPlan.scenes.map(({ text }) => text) } } : {}),
      });
    }
    job.attachments = job.attachments.map(({ name, type }) => ({ name, type }));
    if (job.callbackUrl) {
      const event = { done: 'job.completed', cancelled: 'job.cancelled' }[job.status] || 'job.failed';
      job.webhook = {};
      deliver(job.callbackUrl, event, publicJob(job, job.origin), job.webhook)
        .then((r) => job.log.push({ t: Date.now(), msg: r.status === 'delivered' ? `Webhook consegnato a ${job.callbackUrl}` : `Webhook non consegnato dopo ${r.attempts} tentativi` }));
    }
  }
}

// Con "inline" i file viaggiano dentro la risposta, in base64: utile ai sistemi che non possono fare una seconda richiesta
function withData(results) {
  return results.map((r) => {
    try {
      return { ...r, data: fs.readFileSync(path.join(store.OUTPUT_DIR, path.basename(r.url))).toString('base64') };
    } catch {
      return r;
    }
  });
}

function publicCreation(h, origin) {
  return {
    id: h.id, title: h.title, prompt: h.prompt, task: h.task, type: h.task === 'reel' ? 'reel' : h.task === 'talk' ? 'video' : ['speech', 'music'].includes(h.task) ? 'audio' : h.task === 'animation' ? 'animation' : /video|catena/.test(h.task || '') ? 'video' : 'image',
    model: h.modelName, routedPrompt: h.routedPrompt, negativePrompt: h.negativePrompt, loras: h.loras || [], status: h.status,
    error: h.error, client: h.client, metadata: h.metadata, createdAt: h.createdAt, seconds: h.seconds, reel: h.reel,
    results: (h.results || []).map((r) => ({ ...r, url: origin + r.url })),
  };
}

function publicJob(job, origin = '') {
  return {
    id: job.id,
    status: job.status,
    waiting: !!job.waiting,
    progress: job.progress || null,
    title: job.title,
    prompt: job.prompt,
    task: job.task,
    model: job.modelName,
    routedPrompt: job.routedPrompt,
    negativePrompt: job.negativePrompt,
    loras: (job.loras || []).map((l) => l.name),
    reason: job.reason,
    brain: job.brain,
    error: job.error,
    client: job.client,
    metadata: job.metadata,
    webhook: job.webhook,
    ...(job.catenaInfo ? { catena: job.catenaInfo } : {}),
    ...(job.reelPlan ? { reel: { title: job.reelPlan.title, caption: job.reelPlan.caption, hashtags: job.reelPlan.hashtags, scenes: job.reelPlan.scenes.map(({ text, visual }) => ({ text, visual })), music: job.reelPlan.music } } : {}),
    results: job.results.map((r) => ({ ...r, url: origin + r.url })),
    log: job.log,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    seconds: job.startedAt && job.finishedAt ? Math.round((job.finishedAt - job.startedAt) / 1000) : null,
  };
}

function modelsPayload() {
  const catalog = buildCatalog();
  return {
    local: catalog.all.map((m) => (m.kind === 'checkpoint' ? { ...m, styleAuto: styleFor({ ...m, backend: 'worker', promptStyle: 'auto' }) } : m)),
    servers: store.listServers(),
    generators: catalog.generators.map(({ id, name, capabilities, arch, description, priority }) => ({ id, name, capabilities, arch, description, priority })),
    brain: resolveBrain(catalog.all).label,
    dirs: [store.MODELS_DIR, ...store.getSettings().extraModelDirs],
  };
}

agent.configure({ createJob, musicFromPrompt, getJob: (id) => jobs.get(id) || store.getHistory(id) });

// Chat chiesta da un sistema online: una conversazione per sistema (e per utente, se lo indica)
async function chatForSystem(d, sys) {
  const key = `${sys.name}:${d.utente || ''}`;
  let chat = chats.getChat(d.chat_id) || chats.listChats().map((c) => chats.getChat(c.id)).find((c) => c.externalKey === key);
  if (!chat) {
    chat = chats.createChat({ client: sys.name, title: d.titolo || `${sys.name}${d.utente ? ` · ${d.utente}` : ''}` });
    chat.externalKey = key;
    chats.saveChat(chat);
  }
  const msg = await agent.send(chat, { text: d.messaggio || d.message, ctx: { client: sys.name } });
  const out = { chat_id: chat.id, risposta: msg.content, lavori: msg.jobs || [], ricordati: msg.remembered || [] };
  // Chi chiede da lontano (es. Jarvis) vuole anche i file: si aspetta che le creazioni finiscano e si rimandano
  if (d.attendi_media && msg.jobs?.length) {
    out.file = [];
    out.errori = [];
    let bytes = 0;
    for (const id of msg.jobs) {
      const job = jobs.get(id);
      if (!job) continue;
      await Promise.race([job.done, new Promise((r) => setTimeout(r, 40 * 60_000))]);
      if (job.status !== 'done') { out.errori.push(`${job.title || 'creazione'}: ${job.error || 'non finita in tempo'}`); continue; }
      for (const r of job.results) {
        const file = path.join(store.OUTPUT_DIR, path.basename(r.url));
        const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        if (!size || bytes + size > 45e6) { out.errori.push(`${path.basename(r.url)}: troppo grande per il ponte, è in ideax`); continue; }
        bytes += size;
        out.file.push({ tipo: r.type, nome: path.basename(r.url), base64: fs.readFileSync(file).toString('base64') });
      }
    }
  }
  return out;
}
systems.configure({ createJob, chat: chatForSystem });
catena.configure({ createJob });
personaggio.configure({ createJob });
personaggi.configure({ createJob });
webdemo.configure({ createJob });

function publicSettings() {
  const s = store.getSettings();
  return { ...s, github: { allowWrite: s.github.allowWrite, hasToken: !!s.github.token }, teachers: teachers.listTeachers(), systems: systems.listSystems() };
}

function chatPayload(chat) {
  return { ...chat, busy: agent.isBusy(chat.id) };
}

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const origin = `http://${req.headers.host}`;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // Autenticazione: da questo PC non serve; dagli altri dispositivi serve una chiave API.
  // Una chiave sbagliata viene rifiutata sempre, così gli errori di configurazione si notano subito.
  const PUBLIC = ['/v1/health', '/v1/openapi.json'];
  const protectedPath = /^\/(api|v1|outputs)\//.test(p) && !PUBLIC.includes(p);
  const key = apikeys.keyFromRequest(req, url);
  let client = null;
  if (key) {
    client = apikeys.verifyKey(key) || (LEGACY_TOKEN && key === LEGACY_TOKEN ? { id: 'token', name: 'Token di rete' } : null);
    if (!client && protectedPath) return send(res, 401, { error: 'Chiave API non valida o revocata' });
  }
  if (protectedPath && !client && !isLoopback(req)) {
    return send(res, 401, { error: 'Serve una chiave API: intestazione "Authorization: Bearer <chiave>" (si crea in ideax → Collega app)' });
  }
  const ctx = { client: client?.name || (p.startsWith('/v1/') ? 'App su questo PC' : 'ideax'), origin };

  try {
    // ----- API pubblica per le applicazioni -----
    if (p === '/v1/models' && req.method === 'GET') {
      return send(res, 200, { models: modelsPayload().generators, tasks: store.TASKS });
    }
    if (p === '/v1/generate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.task && !body.attachments?.length && engines.isInstalled('music')) {
        const m = musicFromPrompt(body.prompt || '');
        if (m) Object.assign(body, { kind: 'music', music: { ...m, ...(body.params || {}) } });
      }
      const job = await createJob(body, ctx);
      // Con un webhook la risposta è immediata (a meno che si chieda esplicitamente di aspettare)
      if (body.wait === false || (job.callbackUrl && body.wait !== true)) {
        return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
      }
      await job.done;
      const out = publicJob(job, origin);
      if (body.inline) out.results = withData(out.results);
      return send(res, job.status === 'done' ? 200 : 500, out);
    }
    // ----- Voce -----
    // Trascrizione (Whisper) e vista (cervello VL): { audio } → { testo, pezzi }, { immagini: [dataUrl], domanda, schema? }
    if (p === '/v1/trascrivi' && req.method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await trascrizione.transcribe(b.audio, { lingua: b.lingua, tempi: b.tempi !== false }));
    }
    if (p === '/v1/vista' && req.method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, await visione.look(b.immagini || (b.immagine ? [b.immagine] : []), b.domanda, { schema: b.schema || null }));
    }
    if (p === '/v1/personaggio' && req.method === 'POST') {
      const b = await readJson(req);
      const job = await createJob({ prompt: b.testo, kind: 'personaggio', personaggio: { descrizione: b.descrizione, voce: b.voce, lingua: b.lingua, formato: b.formato }, attachments: b.foto ? [{ name: 'foto', dataUrl: b.foto }] : [] }, ctx);
      return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
    }
    if (p === '/api/accessi' && req.method === 'GET') return send(res, 200, { accessi: webdemo.listAccessi() });
    if (p === '/api/accessi' && req.method === 'POST') return send(res, 200, webdemo.saveAccesso(await readJson(req)));
    if (/^\/api\/accessi\/[\w-]+$/.test(p) && req.method === 'DELETE') { webdemo.deleteAccesso(p.split('/').pop()); return send(res, 200, { ok: true }); }
    if (p === '/v1/demo' && req.method === 'POST') {
      const b = await readJson(req);
      const job = await createJob({ prompt: b.obiettivo || 'demo', kind: 'demo', demo: b }, ctx);
      return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
    }
    if (p === '/api/personaggi' && req.method === 'GET') return send(res, 200, { personaggi: personaggi.list(), training: personaggi.training });
    if (p === '/api/personaggi' && req.method === 'POST') { const b = await readJson(req); return send(res, 200, await personaggi.createPersonaggio(b)); }
    if (p === '/api/personaggi/cancel' && req.method === 'POST') { await personaggi.cancel(); return send(res, 200, { ok: true }); }
    if (/^\/api\/personaggi\/[\w-]+$/.test(p) && req.method === 'DELETE') return send(res, 200, { ok: personaggi.del(p.split('/').pop()) });
    if (p === '/api/catena/montatore' && req.method === 'GET') return send(res, 200, await catena.montatoreStato());
    if (p === '/v1/catena' && req.method === 'POST') {
      const b = await readJson(req);
      const job = await createJob({ prompt: b.prompt || b.idea, kind: 'catena', catena: { clip: b.clip, formato: b.formato, stile: b.stile, musica_provenienza: b.musica_provenienza, monta: b.monta, scene: b.scene, musica_file: b.musica_file, veloce: !!b.veloce } }, ctx);
      return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
    }
    if (p === '/api/voicelib' && req.method === 'GET') return send(res, 200, voicelib.list());
    if (p === '/api/voicelib' && req.method === 'POST') {
      const b = await readJson(req);
      // Va avanti da solo (la pagina legge lo stato); gli errori immediati (nome già usato, motore mancante) si dicono subito
      const lavoro = voicelib.add(b);
      const subito = await Promise.race([lavoro.then(() => null, (e) => e), new Promise((r) => setTimeout(() => r(null), 300))]);
      lavoro.catch(() => {});
      if (subito) return send(res, 400, { error: subito.message });
      return send(res, 202, { ok: true });
    }
    if (p === '/v1/voices' && req.method === 'GET') {
      return send(res, 200, { voices: voices.listVoices().map((v) => ({ ...v, sample_url: `${origin}/v1/voices/${v.id}/sample` })), engine: engines.isInstalled('voice') ? 'installed' : 'missing' });
    }
    if (p === '/v1/voices' && req.method === 'POST') {
      const body = await readBody(req);
      const a = body.attachments?.[0];
      const file = a && { name: a.name, buffer: Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(',') + 1), 'base64') };
      try {
        const v = await voices.createVoice({
          name: body.name, language: body.language || 'it',
          consent: [true, 'true', '1', 'yes', 'si', 'sì'].includes(body.consent), consentBy: body.consent_by || client?.name, file,
        });
        return send(res, 201, v);
      } catch (err) {
        return send(res, err.status || 400, { error: err.message });
      }
    }
    if (/^\/v1\/voices\/[\w-]+\/sample$/.test(p) && req.method === 'GET') {
      const file = voices.samplePath(p.split('/')[3]);
      if (!fs.existsSync(file)) return send(res, 404, { error: 'Voce non trovata' });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return fs.createReadStream(file).pipe(res);
    }
    if (/^\/v1\/voices\/[\w-]+$/.test(p) && req.method === 'PATCH') {
      return send(res, 200, voices.updateVoice(p.split('/').pop(), await readJson(req)));
    }
    if (/^\/v1\/voices\/[\w-]+$/.test(p) && req.method === 'DELETE') {
      return voices.deleteVoice(p.split('/').pop()) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Voce non trovata' });
    }
    if (p === '/v1/speech' && req.method === 'POST') {
      const body = await readBody(req);
      const { text, voice, language, format, exaggeration, cfg_weight, temperature, seed, pause_ms } = body;
      const job = await createJob({
        ...body, prompt: text || body.prompt, kind: 'speech',
        speech: { voice, language, format, exaggeration, cfg_weight, temperature, seed, pause_ms },
      }, ctx);
      if (body.wait === false || (job.callbackUrl && body.wait !== true)) {
        return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
      }
      await job.done;
      const out = publicJob(job, origin);
      if (body.inline) out.results = withData(out.results);
      return send(res, job.status === 'done' ? 200 : 500, out);
    }
    if (p === '/v1/reels' && req.method === 'POST') {
      const body = await readBody(req);
      const { plan, script, voice, duration, style, music: mus, captions, model, language, seed, musicVolume } = body;
      if (!body.prompt && !plan && !script) return send(res, 400, { error: 'Serve "prompt" (l\'argomento), "script" (il testo) oppure "plan" (scene già pronte)' });
      const job = await createJob({
        ...body,
        prompt: body.prompt || plan?.title || (plan?.scenes?.[0]?.text) || String(script).slice(0, 200),
        kind: 'reel',
        reel: { plan, script, voice, duration, style, music: mus, captions, model, language, seed, musicVolume },
      }, ctx);
      // Un reel richiede minuti: risposta immediata, salvo wait=true
      if (body.wait !== true) return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
      await job.done;
      return send(res, job.status === 'done' ? 200 : 500, publicJob(job, origin));
    }
    if (p === '/v1/music' && req.method === 'POST') {
      const body = await readBody(req);
      const { prompt, lyrics, duration, instrumental, language, bpm, key, seed, format, quality, title } = body;
      const job = await createJob({
        ...body, prompt: prompt || body.description, kind: 'music',
        music: { lyrics, duration, instrumental, language, bpm, key, seed, format, quality, title },
      }, ctx);
      if (body.wait === false || (job.callbackUrl && body.wait !== true)) {
        return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
      }
      await job.done;
      const out = publicJob(job, origin);
      if (body.inline) out.results = withData(out.results);
      return send(res, job.status === 'done' ? 200 : 500, out);
    }
    // Compatibile OpenAI TTS: client.audio.speech.create(model=…, voice="Marco", input=…)
    if (p === '/v1/audio/speech' && req.method === 'POST') {
      const body = await readJson(req);
      const fmt = body.response_format === 'wav' ? 'wav' : 'mp3';
      const job = await createJob({ prompt: body.input, kind: 'speech', speech: { voice: body.voice, format: fmt } }, ctx);
      await job.done;
      if (job.status !== 'done') return send(res, 500, { error: { message: job.error } });
      res.writeHead(200, { 'Content-Type': job.results[0].type });
      return fs.createReadStream(path.join(store.OUTPUT_DIR, path.basename(job.results[0].url))).pipe(res);
    }

    // ----- Cervello: chat, memoria, maestri -----
    if (p === '/v1/chat' && req.method === 'POST') {
      const body = await readBody(req);
      let chat = chats.getChat(body.chat_id);
      if (!chat) chat = chats.createChat({ client: ctx.client, title: body.title || '' });
      const msg = await agent.send(chat, { text: body.message || body.prompt, attachments: body.attachments, ctx });
      return send(res, 200, {
        chat_id: chat.id, reply: msg.content, steps: msg.steps || [], remembered: msg.remembered || [],
        jobs: (msg.jobs || []).map((id) => ({ id, status_url: `${origin}/v1/jobs/${id}` })),
      });
    }
    // Compatibile OpenAI: qualsiasi app che parla con "chat/completions" può usare ideax come cervello (con la sua memoria)
    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const body = await readJson(req);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const last = [...msgs].reverse().find((m) => m.role === 'user');
      if (!last) return send(res, 400, { error: { message: 'Serve almeno un messaggio "user"' } });
      const text = Array.isArray(last.content) ? last.content.map((c) => c.text || '').join('\n') : String(last.content || '');
      const key = String(body.user || body.chat_id || '');
      let chat = key ? chats.listChats().map((c) => chats.getChat(c.id)).find((c) => c.externalKey === key) : null;
      if (!chat) {
        chat = chats.createChat({ client: ctx.client, title: '' });
        chat.externalKey = key || undefined;
        // La conversazione precedente arriva dall'app che chiama
        for (const m of msgs.slice(0, msgs.lastIndexOf(last))) {
          if (['user', 'assistant'].includes(m.role)) chat.messages.push({ id: crypto.randomUUID().slice(0, 8), ts: Date.now(), role: m.role, content: String(m.content || '') });
        }
        chats.saveChat(chat);
      }
      const msg = await agent.send(chat, { text, ctx });
      return send(res, 200, {
        id: `chatcmpl-${msg.id}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: 'ideax',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: msg.content } }],
        ideax: { chat_id: chat.id, jobs: msg.jobs || [], remembered: msg.remembered || [] },
      });
    }
    if (/^\/(v1|api)\/chats$/.test(p) && req.method === 'GET') return send(res, 200, chats.listChats());
    if (/^\/(v1|api)\/chats$/.test(p) && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, chats.createChat({ client: ctx.client, title: body.title || '', mode: body.mode === 'intervista' ? 'intervista' : '' }));
    }
    if (/^\/(v1|api)\/chats\/[\w-]+$/.test(p) && req.method === 'GET') {
      const chat = chats.getChat(p.split('/').pop());
      return chat ? send(res, 200, chatPayload(chat)) : send(res, 404, { error: 'Chat non trovata' });
    }
    if (/^\/(v1|api)\/chats\/[\w-]+$/.test(p) && req.method === 'PATCH') {
      const chat = chats.getChat(p.split('/').pop());
      if (!chat) return send(res, 404, { error: 'Chat non trovata' });
      const body = await readJson(req);
      if (body.title != null) chat.title = String(body.title).slice(0, 120);
      if (body.mode != null) chat.mode = body.mode === 'intervista' ? 'intervista' : '';
      return send(res, 200, chats.saveChat(chat));
    }
    if (/^\/(v1|api)\/chats\/[\w-]+$/.test(p) && req.method === 'DELETE') {
      return chats.deleteChat(p.split('/').pop()) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Chat non trovata' });
    }
    // Dall'interfaccia: il messaggio parte e la pagina segue i passi leggendo la chat
    if (/^\/api\/chats\/[\w-]+\/messages$/.test(p) && req.method === 'POST') {
      const chat = chats.getChat(p.split('/')[3]);
      if (!chat) return send(res, 404, { error: 'Chat non trovata' });
      const body = await readJson(req);
      agent.send(chat, { text: body.message, attachments: body.attachments, ctx });
      return send(res, 202, chatPayload(chat));
    }
    if (/^\/(v1|api)\/memory$/.test(p) && req.method === 'GET') {
      return send(res, 200, { facts: memory.listFacts(), categories: memory.CATEGORIES, ...memory.stats() });
    }
    if (/^\/(v1|api)\/memory$/.test(p) && req.method === 'POST') {
      const body = await readJson(req);
      const list = Array.isArray(body.facts) ? body.facts : [body];
      const saved = list.map((f) => memory.remember(typeof f === 'string' ? f : f.text, { category: f.category, source: body.source || ctx.client })).filter(Boolean);
      return send(res, 200, { saved });
    }
    if (/^\/(v1|api)\/memory$/.test(p) && req.method === 'DELETE') { memory.forgetAll(); return send(res, 200, { ok: true }); }
    if (/^\/(v1|api)\/memory\/[\w-]+$/.test(p) && req.method === 'PATCH') {
      const f = memory.updateFact(p.split('/').pop(), await readJson(req));
      return f ? send(res, 200, f) : send(res, 404, { error: 'Ricordo non trovato' });
    }
    if (/^\/(v1|api)\/memory\/[\w-]+$/.test(p) && req.method === 'DELETE') {
      return memory.forget(p.split('/').pop()) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Ricordo non trovato' });
    }
    // Insegnare in blocco: un testo (appunti, profilo, esportazione di un altro assistente) diventa ricordi
    if (/^\/(v1|api)\/memory\/import$/.test(p) && req.method === 'POST') {
      const body = await readBody(req);
      let text = String(body.text || '');
      for (const a of body.attachments || []) text += `\n\n${Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(',') + 1), 'base64').toString('utf8')}`;
      if (!text.trim()) return send(res, 400, { error: 'Incolla un testo o allega un file .txt / .md' });
      const saved = await agent.extractFacts(text.slice(0, 200000), body.source || 'importato');
      return send(res, 200, { saved, total: memory.stats().total });
    }
    // ----- Regia: progetti, business, missioni -----
    if (p === '/api/regia' && req.method === 'GET') return send(res, 200, regia.state());
    if (p === '/api/regia/study' && req.method === 'POST') return send(res, 200, regia.studyProjects());
    if (/^\/api\/regia\/projects\/[\w-]+$/.test(p) && req.method === 'PATCH') return send(res, 200, regia.updateProject(p.split('/').pop(), await readJson(req)));
    if (/^\/api\/regia\/projects\/[\w-]+\/piano$/.test(p) && req.method === 'POST') return send(res, 200, regia.pianoGuadagno(p.split('/')[4], (await readJson(req)).focus || ''));
    if (p === '/api/regia/ideas' && req.method === 'POST') return send(res, 200, regia.proposeBusiness((await readJson(req)).focus || ''));
    if (/^\/api\/regia\/ideas\/[\w-]+$/.test(p) && req.method === 'DELETE') { regia.deleteIdea(p.split('/').pop()); return send(res, 200, { ok: true }); }
    if (/^\/api\/regia\/ideas\/[\w-]+\/mission$/.test(p) && req.method === 'POST') return send(res, 200, regia.startMission(p.split('/')[4]));
    if (/^\/api\/regia\/missions\/[\w-]+\/steps\/[\w-]+$/.test(p) && req.method === 'PATCH') {
      const [, , , , mid, , sid] = p.split('/');
      return send(res, 200, regia.updateStep(mid, sid, await readJson(req)));
    }
    if (/^\/api\/regia\/missions\/[\w-]+$/.test(p) && req.method === 'DELETE') { regia.deleteMission(p.split('/').pop()); return send(res, 200, { ok: true }); }
    // ----- Gemello -----
    if (/^\/(api|v1)\/twin$/.test(p) && req.method === 'GET') return send(res, 200, { ...twin.list(), engines: engines.listEngines().filter((e) => ['twin', 'lipsync'].includes(e.id)) });
    if (/^\/(api|v1)\/twin\/photo$/.test(p) && req.method === 'POST') {
      const body = await readBody(req);
      const consent = [true, 'true', '1', 'si', 'sì', 'yes'].includes(body.consent);
      return send(res, 202, await twin.createPhotoTwin({ name: body.name, photos: body.photos || body.attachments, consent }));
    }
    if (/^\/(api|v1)\/twin\/photo\/cancel$/.test(p) && req.method === 'POST') { await twin.cancelTraining(); return send(res, 200, { ok: true }); }
    if (/^\/(api|v1)\/twin\/photo\/[\w-]+$/.test(p) && req.method === 'DELETE') return send(res, 200, { ok: twin.deletePhotoTwin(p.split('/').pop()) });
    if (/^\/(api|v1)\/twin\/video$/.test(p) && req.method === 'POST') {
      const body = await readBody(req);
      const consent = [true, 'true', '1', 'si', 'sì', 'yes'].includes(body.consent);
      return send(res, 201, await twin.createVideoTwin({ name: body.name, video: body.video || body.attachments?.[0], consent, voice: body.voice }));
    }
    if (/^\/(api|v1)\/twin\/video\/[\w-]+$/.test(p) && req.method === 'DELETE') return send(res, 200, { ok: twin.deleteVideoTwin(p.split('/').pop()) });
    if (/^\/(api|v1)\/twin\/video\/[\w-]+\/file$/.test(p) && req.method === 'GET') {
      const t = twin.findVideoTwin(p.split('/')[4]);
      if (!t) return send(res, 404, { error: 'Video non trovato' });
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      return fs.createReadStream(twin.videoPath(t)).pipe(res);
    }
    // Il gemello che parla: testo → voce clonata → video con le labbra a tempo
    if (/^\/(api|v1)\/twin\/talk$/.test(p) && req.method === 'POST') {
      const body = await readBody(req);
      const job = await createJob({ ...body, prompt: body.text || body.prompt, kind: 'talk', talk: { twin: body.twin, voice: body.voice, language: body.language } }, ctx);
      if (body.wait !== true) return send(res, 202, { id: job.id, status: job.status, status_url: `${origin}/v1/jobs/${job.id}` });
      await job.done;
      return send(res, job.status === 'done' ? 200 : 500, publicJob(job, origin));
    }
    // ----- Sistemi collegati (ideax va a prendere il lavoro) -----
    if (p === '/api/systems' && req.method === 'GET') return send(res, 200, { systems: systems.listSystems(), capabilities: systems.capabilities() });
    if (p === '/api/systems' && req.method === 'POST') return send(res, 200, systems.saveSystem(await readJson(req)));
    if (p === '/api/systems/ponte' && req.method === 'POST') return send(res, 200, systems.createBridge(await readJson(req)));
    if (/^\/api\/systems\/[\w-]+\/chiave$/.test(p) && req.method === 'GET') return send(res, 200, systems.systemKey(p.split('/')[3]));
    if (/^\/api\/systems\/[\w-]+$/.test(p) && req.method === 'DELETE') { systems.deleteSystem(p.split('/').pop()); return send(res, 200, { ok: true }); }
    if (/^\/api\/systems\/[\w-]+\/test$/.test(p) && req.method === 'POST') return send(res, 200, await systems.test(p.split('/')[3]));
    // Decorazioni laser anche dall'API locale
    if (p === '/v1/laser/decoration' && req.method === 'POST') return send(res, 200, await laser.decoration(await readJson(req), { createJob, ctx }));
    if (p === '/v1/laser/vectorize' && req.method === 'POST') {
      const body = await readBody(req);
      const img = body.immagine || body.image || body.attachments?.[0]?.dataUrl;
      return send(res, 200, await laser.vectorize({ ...body, immagine: img }));
    }
    if (p === '/api/teachers' && req.method === 'GET') return send(res, 200, teachers.listTeachers());
    if (p === '/api/teachers' && req.method === 'POST') return send(res, 200, teachers.saveTeacher(await readJson(req)));
    if (/^\/api\/teachers\/[\w-]+$/.test(p) && req.method === 'DELETE') { teachers.deleteTeacher(p.split('/').pop()); return send(res, 200, { ok: true }); }
    if (/^\/api\/teachers\/[\w-]+\/test$/.test(p) && req.method === 'POST') {
      const t = teachers.findTeacher(p.split('/')[3]);
      if (!t) return send(res, 404, { error: 'Maestro non trovato' });
      const reply = await teachers.ask(t, 'Ciao! Sono ideax. Rispondi con una frase per confermare che mi senti.', { timeout: 60_000 });
      return send(res, 200, { reply: reply.slice(0, 500) });
    }
    if (p === '/api/learn' && req.method === 'GET') return send(res, 200, agent.learning);
    if (p === '/api/learn' && req.method === 'POST') {
      const body = await readJson(req);
      return send(res, 200, agent.learnFromTeacher(body.teacher, body.questions || []));
    }
    if (p === '/api/github' && req.method === 'GET') {
      const gs = store.getSettings().github;
      let user = null;
      let error = null;
      if (gs.token) user = await github.whoami().catch((err) => { error = err.message; return null; });
      return send(res, 200, { hasToken: !!gs.token, allowWrite: gs.allowWrite, user, error, downloaded: github.listDownloaded() });
    }
    if (p === '/api/github' && req.method === 'POST') {
      const body = await readJson(req);
      const patch = {};
      if (body.token != null) patch.token = String(body.token).trim();
      if (body.allowWrite != null) patch.allowWrite = !!body.allowWrite;
      store.saveSettings({ github: patch });
      return send(res, 200, { ok: true });
    }
    // ----- Motori -----
    if (p === '/api/engines' && req.method === 'GET') return send(res, 200, engines.listEngines());
    if (/^\/api\/engines\/\w+\/install$/.test(p) && req.method === 'POST') return send(res, 200, await engines.install(p.split('/')[3]));
    if (/^\/api\/engines\/\w+\/stop$/.test(p) && req.method === 'POST') { engines.stop(p.split('/')[3]); return send(res, 200, { ok: true }); }
    if (/^\/api\/engines\/\w+$/.test(p) && req.method === 'DELETE') { engines.uninstall(p.split('/')[3]); return send(res, 200, { ok: true }); }

    if (p === '/v1/health' && req.method === 'GET') {
      const w = await runtime.workerResponds();
      const active = [...jobs.values()].filter((j) => !['done', 'error', 'cancelled'].includes(j.status));
      return send(res, 200, {
        status: w ? 'ok' : 'degraded', version: store.VERSION, worker: w ? 'online' : 'offline',
        queue: { active: active.length, waiting: active.filter((j) => j.waiting).length },
        models: buildCatalog().generators.length,
      });
    }
    if (p === '/v1/openapi.json' && req.method === 'GET') {
      const spec = JSON.parse(fs.readFileSync(path.join(store.APP_ROOT, 'public', 'openapi.json'), 'utf8'));
      spec.info.version = store.VERSION;
      spec.servers = [{ url: origin, description: 'Questo ideax' }];
      return send(res, 200, spec);
    }
    if (p === '/v1/creations' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const offset = Number(url.searchParams.get('offset')) || 0;
      const type = url.searchParams.get('type');
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const all = store.listHistory().map((h) => publicCreation(h, origin)).filter((c) => c.status === 'done'
        && (!type || c.type === type) && (!q || `${c.title} ${c.prompt}`.toLowerCase().includes(q)));
      return send(res, 200, { total: all.length, limit, offset, items: all.slice(offset, offset + limit) });
    }
    if (/^\/(v1\/creations|api\/history)\/[\w-]+$/.test(p) && req.method === 'GET') {
      const h = store.getHistory(p.split('/').pop());
      if (!h) return send(res, 404, { error: 'Creazione non trovata' });
      const c = publicCreation(h, origin);
      if (url.searchParams.get('inline') === 'true') c.results = withData(c.results);
      return send(res, 200, c);
    }
    if (/^\/(v1\/creations|api\/history)\/[\w-]+$/.test(p) && req.method === 'DELETE') {
      return store.deleteHistory(p.split('/').pop()) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'Creazione non trovata' });
    }
    if (/^\/(v1|api)\/jobs\/[\w-]+\/cancel$/.test(p) && req.method === 'POST') {
      const job = jobs.get(p.split('/')[3]);
      if (!job) return send(res, 404, { error: 'Lavoro non trovato' });
      if (!['done', 'error', 'cancelled'].includes(job.status)) {
        job.cancelled = true;
        if (job.status === 'running' && !job.waiting && job.backend === 'worker') await cancelOnWorker();
        if (job.status === 'running' && !job.waiting && job.backend === 'voice') await engines.cancel('voice');
        if (job.status === 'running' && job.backend === 'lipsync') await engines.cancel('lipsync');
        // Musica: il lavoro si interrompe al prossimo controllo dello stato (job.cancelled)
      }
      return send(res, 200, { ok: true });
    }
    if (p.startsWith('/v1/jobs/') && req.method === 'GET') {
      const job = jobs.get(p.split('/').pop());
      return job ? send(res, 200, publicJob(job, origin)) : send(res, 404, { error: 'Lavoro non trovato' });
    }
    // Compatibile con le librerie OpenAI: basta cambiare base_url in http://<pc>:7800/v1
    if (p === '/v1/images/generations' && req.method === 'POST') {
      const body = await readJson(req);
      const params = {};
      if (body.size && /^\d+x\d+$/.test(body.size)) [params.width, params.height] = body.size.split('x').map(Number);
      if (body.n) params.num_images_per_prompt = body.n;
      const isAuto = !body.model || /^(auto|ideax|dall-e|gpt-image)/.test(body.model);
      const job = await createJob({ prompt: body.prompt, task: 'image_generate', model: isAuto ? null : body.model, params }, ctx);
      await job.done;
      if (job.status !== 'done') return send(res, 500, { error: { message: job.error } });
      const data = job.results.map((r) => body.response_format === 'b64_json'
        ? { b64_json: fs.readFileSync(path.join(store.OUTPUT_DIR, path.basename(r.url))).toString('base64'), revised_prompt: job.routedPrompt }
        : { url: origin + r.url, revised_prompt: job.routedPrompt });
      return send(res, 200, { created: Math.floor(job.createdAt / 1000), data });
    }

    // ----- API dell'interfaccia -----
    if (p === '/api/models' && req.method === 'GET') return send(res, 200, modelsPayload());
    if (p.startsWith('/api/models/') && req.method === 'PATCH') {
      const id = p.split('/').pop();
      const patch = await readJson(req);
      const allowed = ['name', 'description', 'priority', 'enabled', 'triggerWords', 'loraWeight', 'loraAlways', 'arch', 'kind', 'capabilities', 'params', 'promptStyle', 'negativePrompt', 'promptToken'];
      return send(res, 200, store.saveOverride(id, Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)))));
    }
    if (p.startsWith('/api/models/') && req.method === 'DELETE') {
      const m = scanModels().find((x) => x.id === p.split('/').pop());
      if (!m) return send(res, 404, { error: 'Modello non trovato' });
      // Si cancellano solo i file dentro la cartella models di ideax; quelli delle altre cartelle si scollegano e basta
      if (m.path.startsWith(store.MODELS_DIR + path.sep)) fs.rmSync(m.path, { recursive: true, force: true });
      else store.saveOverride(m.id, { enabled: false });
      return send(res, 200, { ok: true });
    }
    // ----- Cervelli: principale veloce + riserva grande -----
    if (p === '/api/brains' && req.method === 'GET') {
      const all = scanModels();
      const pair = brainPair(all);
      const slim = (m) => m && { id: m.id, name: m.name, size: m.size, file: m.file };
      return send(res, 200, {
        primary: slim(pair.primary), reserve: slim(pair.reserve), mode: store.getSettings().brain.mode,
        llms: all.filter((m) => m.kind === 'llm' && m.enabled).map(slim),
        recommended: brains.RECOMMENDED, job: brains.job, engine: { ...llama.llm, log: undefined, installed: llama.isInstalled() },
      });
    }
    if (p === '/api/brains/select' && req.method === 'POST') {
      const b = await readJson(req);
      const patch = {};
      if (b.gguf != null) patch.gguf = String(b.gguf);
      if (b.reserve != null) patch.reserve = String(b.reserve);
      if (store.getSettings().brain.mode === 'rules') patch.mode = 'auto';
      store.saveSettings({ brain: patch });
      llama.stop();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/brains/lighten' && req.method === 'POST') {
      const b = await readJson(req);
      return send(res, 200, brains.lighten(b.id, b.type || 'Q4_K_M'));
    }
    if (p === '/api/brains/download' && req.method === 'POST') return send(res, 200, brains.download((await readJson(req)).key));
    if (p === '/api/hf/gate' && req.method === 'POST') return send(res, 200, await (await import('./lib/hfcheck.js')).gateInfo((await readJson(req)).repo));
    if (p === '/api/hf/request' && req.method === 'POST') {
      const b = await readJson(req);
      if (b.consent !== true) return send(res, 400, { error: 'Serve la tua conferma di accettare la licenza' });
      const r = await (await import('./lib/hfcheck.js')).requestAccess(b.repo, b.values || {});
      // Se Hugging Face vuole il clic dal sito, apriamo la pagina giusta nel browser di questo PC
      if (!r.ok && isLoopback(req)) openBrowser(r.url);
      if (r.ok) fixes.autoFix();
      return send(res, 200, r);
    }
    if (p === '/api/hf/check' && req.method === 'POST') return send(res, 200, await (await import('./lib/hfcheck.js')).check());
    if (p === '/api/fixes' && req.method === 'GET') return send(res, 200, fixes.fixes);
    if (p === '/api/fixes/svd' && req.method === 'POST') return send(res, 200, await fixes.fixSvd());
    if (p === '/api/upload' && req.method === 'PUT') return uploadModel(req, res, url.searchParams.get('name'));
    if (p === '/api/meta' && req.method === 'GET') {
      const styles = Object.fromEntries(Object.entries(PROMPT_STYLES).map(([k, v]) => [k, v.label]));
      return send(res, 200, { tasks: store.TASKS, archs: ARCH_LABELS, kinds: KIND_LABELS, serverTypes: store.SERVER_TYPES, styles });
    }
    if (p === '/api/servers' && req.method === 'POST') return send(res, 200, store.saveServer(await readJson(req)));
    if (p.startsWith('/api/servers/') && req.method === 'DELETE') {
      store.deleteServer(p.split('/').pop());
      return send(res, 200, { ok: true });
    }
    if (p === '/api/ping') { lastPing = Date.now(); return send(res, 200, { ok: true, version: store.VERSION }); }
    // Esci da ideax (dal pulsante della barra laterale: non c'è più la finestra del terminale da chiudere)
    if (p === '/api/quit' && req.method === 'POST') {
      if (!isLoopback(req)) return send(res, 403, { error: 'Si può chiudere ideax solo da questo PC' });
      send(res, 200, { ok: true });
      setTimeout(() => process.exit(0), 400);
      return;
    }
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, publicSettings());
    if (p === '/api/settings' && req.method === 'POST') {
      // Token GitHub e maestri hanno le loro pagine: qui non si toccano
      const { github: _g, teachers: _t, systems: _s, ...patch } = await readJson(req);
      store.saveSettings(patch);
      if (patch.hfToken) fixes.autoFix();
      return send(res, 200, publicSettings());
    }
    if (p === '/api/worker' && req.method === 'GET') {
      const proc = { process: runtime.worker.state, installed: runtime.isInstalled(), log: runtime.worker.tail.slice(-40) };
      try {
        const r = await fetch(`${store.getSettings().workerUrl}/health`, { signal: AbortSignal.timeout(2500) });
        const health = await r.json();
        const loaded = health.loaded ? scanModels().find((m) => m.path === health.loaded) : null;
        return send(res, 200, { online: r.ok, ...health, loadedName: loaded?.name || (health.loaded ? path.basename(health.loaded) : null), ...proc });
      } catch {
        return send(res, 200, { online: false, ...proc });
      }
    }
    if (p === '/api/worker/restart' && req.method === 'POST') {
      await runtime.restartWorker();
      return send(res, 200, { ok: true });
    }
    if (p === '/api/setup' && req.method === 'GET') {
      if (!runtime.setup.gpu) runtime.setup.gpu = await runtime.detectGpu();
      return send(res, 200, {
        ...runtime.setup, log: runtime.setup.log.slice(-60), installed: runtime.isInstalled(),
        variant: runtime.setup.variant || runtime.torchVariant(runtime.setup.gpu),
        platform: process.platform, llm: { ...llama.llm, log: llama.llm.log.slice(-20), installed: llama.isInstalled() },
      });
    }
    if (p === '/api/setup' && req.method === 'POST') return send(res, 200, await runtime.startSetup());
    if (p === '/api/setup/llm' && req.method === 'POST') {
      llama.install().catch(() => {});
      return send(res, 200, llama.llm);
    }
    if (p === '/api/about' && req.method === 'GET') {
      return send(res, 200, { version: store.VERSION, installed: store.INSTALLED, home: store.ROOT, appRoot: store.APP_ROOT, platform: process.platform });
    }
    if (p === '/api/update' && req.method === 'GET') return send(res, 200, updater.update);
    if (p === '/api/update/check' && req.method === 'POST') return send(res, 200, await updater.checkForUpdate());
    if (p === '/api/update/install' && req.method === 'POST') {
      const blocker = updater.installBlocker();
      if (blocker) return send(res, 400, { error: blocker });
      updater.installUpdate();
      return send(res, 200, updater.update);
    }
    if (p === '/api/open-folder' && req.method === 'POST') {
      const { which } = await readJson(req);
      const dir = { home: store.ROOT, models: store.MODELS_DIR, outputs: store.OUTPUT_DIR }[which] || store.ROOT;
      const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      exec(`${cmd} "${dir}"`, { windowsHide: true }, () => {});
      return send(res, 200, { ok: true, dir });
    }
    if (p === '/api/network' && req.method === 'GET') {
      const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
      return send(res, 200, { host: HOST, port: PORT, lan: HOST === '0.0.0.0', addresses: addrs, keys: apikeys.listKeys().length, legacyToken: !!LEGACY_TOKEN });
    }
    if (p === '/api/keys' && req.method === 'GET') return send(res, 200, apikeys.listKeys());
    if (p === '/api/keys' && req.method === 'POST') return send(res, 200, apikeys.createKey((await readJson(req)).name));
    if (p.startsWith('/api/keys/') && req.method === 'DELETE') {
      apikeys.revokeKey(p.split('/').pop());
      return send(res, 200, { ok: true });
    }
    if (p === '/api/webhook' && req.method === 'GET') return send(res, 200, { secret: apikeys.webhookSecret() });
    if (p === '/api/webhook/rotate' && req.method === 'POST') return send(res, 200, { secret: apikeys.rotateWebhookSecret() });
    if (p === '/api/webhook/test' && req.method === 'POST') {
      const { url: target } = await readJson(req);
      if (!/^https?:\/\//i.test(target || '')) return send(res, 400, { error: 'Indirizzo non valido' });
      const r = await deliver(target, 'ping', { message: 'Prova del webhook di ideax', version: store.VERSION }, {});
      return send(res, 200, r);
    }
    if (p === '/api/generate' && req.method === 'POST') {
      const body = await readJson(req);
      // "fammi un reel su…" dallo Studio
      if (!body.task && !body.attachments?.length && /\b(reel|reels|tiktok|short|shorts)\b/i.test(body.prompt || '')) {
        const sec = (body.prompt || '').match(/(\d+)\s*(s\b|sec|secondi)/i);
        Object.assign(body, { kind: 'reel', reel: { duration: sec ? Number(sec[1]) : 30 } });
      }
      if (!body.kind && (!body.task || body.task === 'music') && !body.attachments?.length && engines.isInstalled('music')) {
        const m = body.task === 'music' ? (musicFromPrompt(body.prompt || '') || { duration: 30, instrumental: true }) : musicFromPrompt(body.prompt || '');
        if (m) Object.assign(body, { kind: 'music', music: m, task: undefined });
      }
      const job = await createJob(body, ctx);
      return send(res, 202, { id: job.id });
    }
    if (p.startsWith('/api/jobs/') && req.method === 'GET') {
      const job = jobs.get(p.split('/').pop());
      return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'Lavoro non trovato' });
    }
    if (p === '/api/history' && req.method === 'GET') return send(res, 200, store.listHistory());

    if (p.startsWith('/outputs/')) return serveFile(res, store.OUTPUT_DIR, p.slice('/outputs/'.length));
    if (p.startsWith('/api/') || p.startsWith('/v1/')) return send(res, 404, { error: 'Percorso sconosciuto' });
    return serveFile(res, path.join(store.APP_ROOT, 'public'), p === '/' ? 'index.html' : p.slice(1));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, { windowsHide: true }, () => {});
}

const localUrl = `http://localhost:${PORT}`;
const shouldOpen = (store.IS_SEA || process.env.IDEAX_OPEN === '1') && process.env.IDEAX_NO_OPEN !== '1';

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // ideax è già aperto: mostriamo la finestra esistente
    console.log(`ideax è già in esecuzione su ${localUrl}`);
    if (shouldOpen) openBrowser(localUrl);
    setTimeout(() => process.exit(0), 1500);
  } else {
    console.error(err);
    process.exit(1);
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log(`  ideax ${store.VERSION} è attivo`);
  console.log(`  Apri: ${localUrl}`);
  if (HOST === '0.0.0.0') {
    for (const a of Object.values(os.networkInterfaces()).flat().filter((x) => x?.family === 'IPv4' && !x.internal)) {
      console.log(`  Dalla rete: http://${a.address}:${PORT}  (con chiave API)`);
    }
  }
  console.log(`  I tuoi dati: ${store.ROOT}`);
  console.log('');
  runtime.startWorker();
  updater.scheduleChecks();
  systems.startAll();
  fixes.autoFix();
  // Se una pagina di ideax è già aperta (es. dopo un aggiornamento) si ricollega da sola: niente schede doppie
  if (shouldOpen) setTimeout(() => { if (Date.now() - lastPing > 6000) openBrowser(localUrl); }, 5000);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { runtime.stopWorker(); process.exit(0); });
}
process.on('exit', () => { runtime.stopWorker(); engines.stopAll(); llama.stop(); apikeys.flushKeys(); });
