// Il tuo gemello AI.
// - Foto: da 15–30 tue foto ai-toolkit addestra una LoRA del tuo viso su FLUX.1-dev (motore "twin").
//   Finito l'addestramento la LoRA entra tra i modelli: "una foto di me al mare" la usa da sola.
// - Video: un tuo video vero (viso frontale) + la tua voce clonata → LatentSync rifà le labbra (motore "lipsync").
// Per entrambi serve il consenso: il viso deve essere tuo o di chi ti ha dato il permesso.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, MODELS_DIR, OUTPUT_DIR, getSettings, saveOverride } from './store.js';
import { scanModels } from './scanner.js';
import { buildCatalog } from './router.js';
import * as engines from './engines.js';
import * as voices from './voices.js';
import * as llama from './llamaserver.js';

const DIR = path.join(DATA_DIR, 'gemello');
const PHOTO_DIR = path.join(DIR, 'foto');
const VIDEO_DIR = path.join(DIR, 'video');
const META = path.join(DIR, 'gemelli.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(META, 'utf8'));
  } catch {
    return { photo: [], video: [] };
  }
}
function save(data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(META, JSON.stringify(data, null, 2));
}

export function list() {
  const d = load();
  return { photo: d.photo.map((t) => ({ ...t, progress: training.id === t.id ? { ...training } : null })), video: d.video };
}

const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 24) || 'gemello';

function decode(a) {
  const type = a.type || a.dataUrl.slice(5, a.dataUrl.indexOf(';'));
  return { type, buffer: Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(',') + 1), 'base64') };
}

// Libera la scheda video: l'addestramento e il lip-sync la vogliono tutta
export async function freeGpu(except) {
  await fetch(`${getSettings().workerUrl}/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (const id of ['music', 'voice', 'twin', 'lipsync', 'comfyui']) if (id !== except) engines.stop(id);
  llama.stop();
}

// ---------- Gemello foto ----------

export const training = { id: null, status: 'idle', step: 0, total: 0, phase: null, error: null, log: [] };

export async function createPhotoTwin({ name, photos = [], consent }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Scrivi il nome della persona (es. il tuo nome)');
  if (!consent) throw new Error('Serve il consenso: il viso deve essere il tuo o di una persona che ti ha dato il permesso.');
  const images = photos.filter((p) => /^image\/(jpeg|png|webp)/.test(p.type || p.dataUrl?.slice(5, 20) || ''));
  if (images.length < 8) throw new Error(`Servono almeno 8 foto (meglio 15–30): ne hai caricate ${images.length}.`);
  if (!engines.isInstalled('twin')) throw new Error('Il motore Gemello foto non è installato: installalo qui sopra.');
  if (training.status === 'running') throw new Error('Sto già addestrando un gemello: aspetta che finisca.');
  const id = crypto.randomUUID().slice(0, 8);
  const key = `${slug(clean)}_${id.slice(0, 4)}`;
  const dir = path.join(PHOTO_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const files = images.slice(0, 40).map((p, i) => {
    const { type, buffer } = decode(p);
    const file = path.join(dir, `${String(i).padStart(3, '0')}.${type.split('/')[1].replace('jpeg', 'jpg')}`);
    fs.writeFileSync(file, buffer);
    return file;
  });
  // Parola rara che il modello impara a collegare al tuo viso
  const token = `${slug(clean).replace(/_/g, '')}ohwx`;
  const twin = { id, name: clean, key, token, photos: files.length, status: 'training', consent: { by: clean, at: new Date().toISOString() }, createdAt: Date.now() };
  const data = load();
  data.photo.unshift(twin);
  save(data);
  train(twin, files);
  return twin;
}

function update(id, patch) {
  const data = load();
  const t = data.photo.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  save(data);
  return t;
}

async function train(twin, files) {
  Object.assign(training, { id: twin.id, status: 'running', step: 0, total: 0, phase: 'Accendo il motore', error: null, log: [] });
  try {
    await freeGpu('twin');
    const base = await engines.ensureRunning('twin');
    const post = async (p, body) => {
      const r = await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `Motore gemello: HTTP ${r.status}`);
      return data;
    };
    await post('/train', { name: twin.key, trigger: twin.token, images: files });
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      engines.touch('twin');
      const p = await post('/progress');
      Object.assign(training, { step: p.step, total: p.total, phase: p.phase, log: p.log || [] });
      if (p.status === 'error') throw new Error(p.error || 'addestramento non riuscito');
      if (p.status === 'cancelled') throw new Error('Annullato');
      if (p.status === 'done') {
        const dest = path.join(MODELS_DIR, 'loras', `gemello-${twin.key}.safetensors`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(p.output, dest);
        const model = scanModels().find((m) => m.path === dest);
        if (model) {
          saveOverride(model.id, {
            name: `Gemello · ${twin.name}`,
            description: `Il viso di ${twin.name}, addestrato su ${twin.photos} foto.`,
            triggerWords: [twin.name.toLowerCase(), 'di me', 'me stesso', 'me stessa', 'mio gemello', 'il gemello', 'gemello', 'photo of me', 'picture of me'].join(', '),
            promptToken: twin.token,
            loraWeight: 1,
          });
        }
        update(twin.id, { status: 'ready', lora: dest, modelId: model?.id, readyAt: Date.now() });
        Object.assign(training, { status: 'done', phase: null });
        break;
      }
    }
  } catch (err) {
    update(twin.id, { status: 'error', error: err.message });
    Object.assign(training, { status: 'error', error: err.message, phase: null });
  } finally {
    engines.stop('twin');
  }
}

export async function cancelTraining() {
  if (training.status !== 'running') return;
  await fetch(`http://127.0.0.1:${engines.CATALOG.twin.port}/cancel`, { method: 'POST' }).catch(() => {});
}

export function deletePhotoTwin(id) {
  const data = load();
  const t = data.photo.find((x) => x.id === id);
  if (!t) return false;
  if (training.id === id && training.status === 'running') throw new Error('Prima annulla l\'addestramento');
  fs.rmSync(path.join(PHOTO_DIR, id), { recursive: true, force: true });
  if (t.lora) fs.rmSync(t.lora, { force: true });
  data.photo = data.photo.filter((x) => x.id !== id);
  save(data);
  return true;
}

// Se il prompt parla del gemello: la sua LoRA e un modello Flux su cui usarla
export function twinForPrompt(prompt) {
  const catalog = buildCatalog();
  const p = ` ${String(prompt).toLowerCase()} `;
  const lora = catalog.loras.find((l) => l.promptToken && String(l.triggerWords || '').split(',').map((w) => w.trim()).filter(Boolean)
    .some((w) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(p)));
  if (!lora) return null;
  const flux = catalog.generators.find((g) => g.arch === lora.arch && g.capabilities?.includes('image_generate'));
  return { lora, modelId: flux?.id || null };
}

// ---------- Gemello video ----------

export async function createVideoTwin({ name, video, consent, voice }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Dai un nome al video di base');
  if (!consent) throw new Error('Serve il consenso: nel video devi esserci tu o una persona che ti ha dato il permesso.');
  if (!video?.dataUrl || !/^video\//.test(video.type || '')) throw new Error('Carica un video (mp4, mov) di 10–60 secondi con il viso ben visibile');
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(VIDEO_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const { buffer } = decode(video);
  const ext = (path.extname(video.name || '') || '.mp4').toLowerCase().slice(0, 6);
  fs.writeFileSync(path.join(dir, `base${ext}`), buffer);
  const twin = { id, name: clean, file: `base${ext}`, voice: voices.findVoice(voice)?.id || null, consent: { by: clean, at: new Date().toISOString() }, createdAt: Date.now() };
  const data = load();
  data.video.unshift(twin);
  save(data);
  return twin;
}

export function deleteVideoTwin(id) {
  const data = load();
  if (!data.video.some((x) => x.id === id)) return false;
  fs.rmSync(path.join(VIDEO_DIR, id), { recursive: true, force: true });
  data.video = data.video.filter((x) => x.id !== id);
  save(data);
  return true;
}

export const videoPath = (t) => path.join(VIDEO_DIR, t.id, t.file);

export function findVideoTwin(ref) {
  const all = load().video;
  if (!ref) return all[0] || null;
  const r = String(ref).toLowerCase();
  return all.find((t) => t.id === ref || t.name.toLowerCase() === r) || null;
}

// Un lavoro "parla": voce clonata → lip-sync sul video di base. job.talk = { twin, voice, language }
export async function runTalk(job, log) {
  const t = findVideoTwin(job.talk?.twin);
  if (!t) throw new Error('Non c\'è ancora un video di base: caricalo nella pagina Gemello.');
  const voice = voices.findVoice(job.talk?.voice || t.voice);
  if (!voice) throw new Error('Serve una voce clonata: creala nella pagina Voce.');
  if (!engines.isInstalled('voice')) throw new Error('Il motore voce non è installato.');
  if (!engines.isInstalled('lipsync')) throw new Error('Il motore Gemello video non è installato: installalo nella pagina Gemello.');
  Object.assign(job, { task: 'talk', modelName: `Gemello video · ${t.name}`, title: job.title || job.prompt.slice(0, 60), routedPrompt: job.prompt, brain: 'motore voce + LatentSync', reason: `Voce "${voice.name}" sul video "${t.name}".` });
  job.status = 'running';
  job.startedAt = Date.now();
  await freeGpu('voice');
  log(`Leggo il testo con la voce "${voice.name}"…`);
  job.progress = { phase: 'Leggo il testo' };
  job.backend = 'voice';
  const speech = await engines.call('voice', '/speak', {
    text: job.prompt, language: job.talk?.language || voice.language || 'it', reference: voices.samplePath(voice.id), format: 'wav', ...(voice.defaults || {}),
  });
  if (job.cancelled) throw new Error('Annullato');
  const audio = path.join(OUTPUT_DIR, `${job.id}-voce.wav`);
  fs.writeFileSync(audio, Buffer.from(speech.data, 'base64'));
  engines.stop('voice');
  log('Muovo le labbra del video sulla voce…');
  job.backend = 'lipsync';
  const out = path.join(OUTPUT_DIR, `${job.id}-gemello.mp4`);
  await engines.call('lipsync', '/lipsync', { video: videoPath(t), audio, out }, {
    timeout: 60 * 60 * 1000,
    onProgress: (p) => { job.progress = p.total ? { step: p.step, total: p.total, phase: p.phase || 'Muovo le labbra' } : { phase: p.phase || 'Carico il modello' }; },
  });
  job.results = [{ url: `/outputs/${path.basename(out)}`, type: 'video/mp4', seconds: speech.seconds }];
  job.status = 'done';
  log('Completato.');
}
