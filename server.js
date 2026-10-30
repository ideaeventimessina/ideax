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
import { route, buildCatalog, PROMPT_STYLES, styleFor } from './lib/router.js';
import { resolveBrain } from './lib/brain.js';
import { runModel, cancelOnWorker } from './lib/backends.js';
import * as runtime from './lib/runtime.js';

process.title = 'ideax';
const startup = store.getSettings();
const PORT = Number(process.env.PORT) || 7800;
const HOST = process.env.HOST || (startup.network.lan ? '0.0.0.0' : '127.0.0.1');
const TOKEN = process.env.IDEAX_TOKEN || (startup.network.lan ? startup.network.token : '');
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

async function createJob(body) {
  if (!body.prompt?.trim()) throw new Error('Scrivi un prompt');
  if (body.task && !(body.task in store.TASKS)) throw new Error(`Compito sconosciuto: ${body.task}`);
  const job = {
    id: crypto.randomUUID().slice(0, 8),
    prompt: body.prompt.trim(),
    attachments: await normalizeAttachments(body.attachments),
    forceModelId: body.model || body.modelId || null,
    forceTask: body.task || null,
    params: body.params && typeof body.params === 'object' ? body.params : {},
    status: 'queued',
    log: [],
    results: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  job.done = processJob(job);
  return job;
}

async function processJob(job) {
  const log = (msg) => job.log.push({ t: Date.now(), msg });
  try {
    job.status = 'routing';
    log('Analizzo il prompt…');
    const d = await route(job.prompt, job.attachments, { forceModelId: job.forceModelId, forceTask: job.forceTask });
    if (job.cancelled) throw new Error('Annullato');
    // Parametri dello stile (es. clip_skip per Pony) < parametri del modello < parametri della richiesta
    job.params = { ...(d.styleParams || {}), ...(d.model.params || {}), ...job.params };
    Object.assign(job, {
      task: d.task, modelId: d.model.id, modelName: d.model.name, routedPrompt: d.prompt,
      negativePrompt: d.negativePrompt, loras: d.loras, reason: d.reason, brain: d.brain, title: d.title,
    });
    log(`Compito: ${store.TASKS[d.task]} → ${d.model.name}`);
    if (d.reason) log(d.reason);
    job.status = 'running';
    job.results = await runModel(d.model, d.task, job, log);
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
      });
    }
    job.attachments = job.attachments.map(({ name, type }) => ({ name, type }));
  }
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

// ---------- HTTP ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const origin = `http://${req.headers.host}`;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (TOKEN && !isLoopback(req) && (p.startsWith('/api/') || p.startsWith('/v1/'))) {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(res, 401, { error: 'Token mancante o errato' });
  }

  try {
    // ----- API pubblica per le applicazioni -----
    if (p === '/v1/models' && req.method === 'GET') {
      return send(res, 200, { models: modelsPayload().generators, tasks: store.TASKS });
    }
    if (p === '/v1/generate' && req.method === 'POST') {
      const body = await readJson(req);
      const job = await createJob(body);
      if (body.wait === false) return send(res, 202, { id: job.id, status: job.status });
      await job.done;
      return send(res, job.status === 'done' ? 200 : 500, publicJob(job, origin));
    }
    if (/^\/(v1|api)\/jobs\/[\w-]+\/cancel$/.test(p) && req.method === 'POST') {
      const job = jobs.get(p.split('/')[3]);
      if (!job) return send(res, 404, { error: 'Lavoro non trovato' });
      if (!['done', 'error', 'cancelled'].includes(job.status)) {
        job.cancelled = true;
        if (job.status === 'running' && !job.waiting && job.backend === 'worker') await cancelOnWorker();
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
      const job = await createJob({ prompt: body.prompt, task: 'image_generate', model: isAuto ? null : body.model, params });
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
      const allowed = ['name', 'description', 'priority', 'enabled', 'triggerWords', 'loraWeight', 'loraAlways', 'arch', 'kind', 'capabilities', 'params', 'promptStyle', 'negativePrompt'];
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
    if (p === '/api/settings' && req.method === 'GET') return send(res, 200, store.getSettings());
    if (p === '/api/settings' && req.method === 'POST') return send(res, 200, store.saveSettings(await readJson(req)));
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
        platform: process.platform, llm: runtime.llmSetup,
      });
    }
    if (p === '/api/setup' && req.method === 'POST') return send(res, 200, await runtime.startSetup());
    if (p === '/api/setup/llm' && req.method === 'POST') return send(res, 200, await runtime.installLlmSupport());
    if (p === '/api/network' && req.method === 'GET') {
      const addrs = Object.values(os.networkInterfaces()).flat().filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
      return send(res, 200, { host: HOST, port: PORT, lan: HOST === '0.0.0.0', addresses: addrs, tokenActive: !!TOKEN });
    }
    if (p === '/api/generate' && req.method === 'POST') {
      const job = await createJob(await readJson(req));
      return send(res, 202, { id: job.id });
    }
    if (p.startsWith('/api/jobs/') && req.method === 'GET') {
      const job = jobs.get(p.split('/').pop());
      return job ? send(res, 200, publicJob(job)) : send(res, 404, { error: 'Lavoro non trovato' });
    }
    if (p === '/api/history' && req.method === 'GET') return send(res, 200, store.listHistory());

    if (p.startsWith('/outputs/')) return serveFile(res, store.OUTPUT_DIR, p.slice('/outputs/'.length));
    if (p.startsWith('/api/') || p.startsWith('/v1/')) return send(res, 404, { error: 'Percorso sconosciuto' });
    return serveFile(res, path.join(store.ROOT, 'public'), p === '/' ? 'index.html' : p.slice(1));
  } catch (err) {
    return send(res, 400, { error: err.message });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const localUrl = `http://localhost:${PORT}`;
const shouldOpen = store.IS_SEA || process.env.IDEAX_OPEN === '1';

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
  console.log('  ideax è attivo');
  console.log(`  Apri: ${localUrl}`);
  if (HOST === '0.0.0.0') {
    for (const a of Object.values(os.networkInterfaces()).flat().filter((x) => x?.family === 'IPv4' && !x.internal)) {
      console.log(`  Dalla rete: http://${a.address}:${PORT}${TOKEN ? '  (con token)' : ''}`);
    }
    if (!TOKEN) console.log('  Attenzione: accesso dalla rete senza token.');
  }
  console.log(`  Modelli: ${store.MODELS_DIR}`);
  if (store.IS_SEA) console.log('\n  Lascia aperta questa finestra: chiudendola ideax si ferma.');
  console.log('');
  runtime.startWorker();
  if (shouldOpen) openBrowser(localUrl);
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => { runtime.stopWorker(); process.exit(0); });
}
process.on('exit', () => runtime.stopWorker());
