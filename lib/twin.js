// Il tuo gemello AI.
// - Foto: da 15–30 tue foto ai-toolkit addestra una LoRA del tuo viso su FLUX.1-dev (motore "twin").
//   Finito l'addestramento la LoRA entra tra i modelli: "una foto di me al mare" la usa da sola.
// - Video: un tuo video vero (viso frontale) + la tua voce clonata → LatentSync rifà le labbra (motore "lipsync").
// Per entrambi serve il consenso: il viso deve essere tuo o di chi ti ha dato il permesso.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, MODELS_DIR, OUTPUT_DIR, saveOverride } from './store.js';
import { scanModels } from './scanner.js';
import { buildCatalog } from './router.js';
import * as engines from './engines.js';
import * as voices from './voices.js';
import { durataWav, voceNativa, parla as parlaKokoro } from './voicelib.js';
import * as runtime from './runtime.js';

// Quale motore per il gemello foto. FLUX dà la somiglianza migliore MA in addestramento il suo picco di caricamento
// sfora i 16 GB: su una scheda così si pianta già prima di addestrare (visto davvero, due volte). Quindi: FLUX solo su
// schede grandi (~20 GB+), SDXL sulle altre — più leggero, si addestra comodo sui 16 GB anche coi monitor accesi, e la
// somiglianza con tante foto è ottima. Si può forzare con IDEAX_TWIN_ARCH=flux|sdxl.
const SDXL_REALISTICO = /realvis|juggernaut|realism|realistic|photon|photoreal|epicreal|cyberrealistic|nightvision|zavy|dreamshaper/i;
// Basi da NON usare per un viso reale: esplicite/stilizzate. Oltre all'estetica sbagliata, gli SDXL espliciti stile
// John6666 (big-lust, pony…) su alcune macchine escono RUMORE (arch non riconosciuta → il fix del VAE fp16 non scatta,
// vedi lib/scanner.js). Un gemello su una di queste basi dà la neve colorata qualunque sia l'addestramento.
const SDXL_DA_EVITARE = /lust|pony|hentai|\banime|cartoon|toon|niji|comic|\b2d\b|nsfw|xxx|uncensor|\bporn|explicit|bigasp/i;
function baseSdxlGemello() {
  const sdxl = buildCatalog().generators.filter((g) => g.arch === 'sdxl' && g.backend === 'worker' && g.capabilities?.includes('image_generate') && g.path);
  // File singolo prima: le cartelle diffusers SDXL sono proprio quelle col bug del rumore (meta-device / VAE fp16).
  const singoli = sdxl.filter((g) => g.format && g.format !== 'diffusers');
  const pool = singoli.length ? singoli : sdxl;
  const txt = (g) => `${g.name} ${g.id} ${g.file || ''} ${g.path || ''}`;
  const puliti = pool.filter((g) => !SDXL_DA_EVITARE.test(txt(g))); // un viso reale non si addestra su una base esplicita
  return puliti.find((g) => SDXL_REALISTICO.test(txt(g)))  // un realistico, se c'è: il viso resta vero
      || puliti[0]                                          // altrimenti un qualunque SDXL pulito (non esplicito)
      || null;                                              // nessuna base pulita: si avvisa, NON si ripiega su un esplicito
}
async function scegliMotore() {
  const forced = (process.env.IDEAX_TWIN_ARCH || '').toLowerCase();
  if (forced === 'flux') return { arch: 'flux', engine: 'FLUX', base: null };
  const gpu = await runtime.detectGpu().catch(() => ({ vendor: 'none' }));
  const vram = gpu.vendor === 'nvidia' ? (gpu.vramGb || 0) : 99; // non-NVIDIA/Mac: lascio decidere a valle, come prima
  if (forced !== 'sdxl' && vram >= 20) return { arch: 'flux', engine: 'FLUX', base: null };
  const b = baseSdxlGemello();
  if (b) return { arch: 'sdxl', engine: 'SDXL', base: b };
  // Scheda piccola e nessuna base SDXL: FLUX non entra e SDXL non ha su cosa addestrare. Lo dice chiaro, non si pianta.
  return { arch: 'flux', engine: 'FLUX', base: null, avviso: 'piccola-senza-sdxl' };
}

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

// Libera la scheda video: l'addestramento e il lip-sync la vogliono tutta.
// Con due schede il worker delle immagini sta su un'ALTRA scheda: non lo spegniamo, così si continua a generare
// mentre questo lavoro gira (lo decide engines.freeForEngine). Gli altri motori pesanti, che condividono la scheda
// con questo, si fermano sempre.
export async function freeGpu(except) {
  await engines.freeForEngine(except);
}

// ---------- Gemello foto ----------

export const training = { id: null, status: 'idle', step: 0, total: 0, phase: null, error: null, log: [], engine: null, engineBase: null };
let cancelRequested = false;

// FaceID: fino a `max` foto di riferimento di una cartella, come data-URL base64. insightface ne media il volto.
const EXT_FOTO = /\.(jpe?g|png|webp)$/i;
export function facceDa(dir, max = 3) {
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => EXT_FOTO.test(f)).sort().slice(0, max); } catch { return []; }
  return files.map((f) => {
    try {
      const ext = path.extname(f).slice(1).toLowerCase().replace('jpg', 'jpeg');
      return `data:image/${ext};base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}`;
    } catch { return null; }
  }).filter(Boolean);
}

// Se fra le LoRA attive c'è un gemello pronto, torna le sue foto di riferimento per FaceID. real:true = VISO REALE,
// così chi chiama spegne FaceID sui contenuti espliciti (regola di Andrea). null se nessuna LoRA è un gemello.
export function riferimentoVolto(loras = []) {
  const data = load();
  for (const l of loras) {
    const g = data.photo.find((t) => t.status === 'ready' && t.lora && (t.lora === l.path || (l.id && t.modelId === l.id)));
    if (g) { const faces = facceDa(path.join(PHOTO_DIR, g.id)); if (faces.length) return { faces, real: true, nome: g.name }; }
  }
  return null;
}

export async function createPhotoTwin({ name, photos = [], consent }) {
  const clean = String(name || '').trim().slice(0, 40);
  if (!clean) throw new Error('Scrivi il nome della persona (es. il tuo nome)');
  if (!consent) throw new Error('Serve il consenso: il viso deve essere il tuo o di una persona che ti ha dato il permesso.');
  const images = photos.filter((p) => /^image\/(jpeg|png|webp)/.test(p.type || p.dataUrl?.slice(5, 20) || ''));
  if (images.length < 8) throw new Error(`Servono almeno 8 foto (meglio 15–30): ne hai caricate ${images.length}.`);
  const foto = images.slice(0, 40).map(decode);
  const firma = firmaFoto(foto.map((p) => p.buffer));
  const data = load();
  const precedente = data.photo.find((t) => {
    if (t.name.toLowerCase() !== clean.toLowerCase() || t.photos !== foto.length) return false;
    if (t.datasetFingerprint) return t.datasetFingerprint === firma;
    try {
      return firmaFoto(fileDiTraining(t.id).map((f) => fs.readFileSync(f))) === firma;
    } catch { return false; }
  });
  if (precedente?.status === 'ready' && precedente.lora && fs.existsSync(precedente.lora)) {
    return { ...precedente, reused: true };
  }
  if (!engines.isInstalled('twin')) throw new Error('Il motore Gemello foto non è installato: installalo qui sopra.');
  if (training.status === 'running') throw new Error('Sto già addestrando un gemello: aspetta che finisca.');
  if (precedente && precedente.status !== 'ready') {
    const files = fileDiTraining(precedente.id);
    if (files.length === foto.length) {
      update(precedente.id, { status: 'training', error: null, datasetFingerprint: firma });
      avviaAddestramento(precedente, files);
      return { ...precedente, status: 'training', error: null };
    }
  }
  const id = crypto.randomUUID().slice(0, 8);
  const key = `${slug(clean)}_${id.slice(0, 4)}`;
  const dir = path.join(PHOTO_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const files = foto.map(({ type, buffer }, i) => {
    const file = path.join(dir, `${String(i).padStart(3, '0')}.${type.split('/')[1].replace('jpeg', 'jpg')}`);
    fs.writeFileSync(file, buffer);
    return file;
  });
  // Parola rara che il modello impara a collegare al tuo viso
  const token = `${slug(clean).replace(/_/g, '')}ohwx`;
  const twin = { id, name: clean, key, token, photos: files.length, datasetFingerprint: firma, status: 'training', consent: { by: clean, at: new Date().toISOString() }, createdAt: Date.now() };
  data.photo.unshift(twin);
  save(data);
  avviaAddestramento(twin, files);
  return twin;
}

function firmaFoto(buffers) {
  const impronte = buffers.map((buf) => crypto.createHash('sha256').update(buf).digest('hex')).sort();
  return crypto.createHash('sha256').update(impronte.join('')).digest('hex');
}

function fileDiTraining(id) {
  const dir = path.join(PHOTO_DIR, id);
  return fs.readdirSync(dir).filter((f) => /^\d{3}\.(?:jpe?g|png|webp)$/i.test(f)).sort().map((f) => path.join(dir, f));
}

function avviaAddestramento(twin, files) {
  cancelRequested = false;
  Object.assign(training, { id: twin.id, status: 'running', step: 0, total: 0, phase: 'Scelgo il modello', error: null, log: [], engine: null, engineBase: null });
  train(twin, files);
}

function update(id, patch) {
  const data = load();
  const t = data.photo.find((x) => x.id === id);
  if (t) Object.assign(t, patch);
  save(data);
  return t;
}

async function train(twin, files) {
  // Il motore si sceglie dalla scheda: FLUX (somiglianza migliore) solo dove entra (~20 GB+), SDXL sulle altre — così su
  // una 16 GB il gemello si addestra davvero invece di piantarsi. Si vede quale è partito, non lo indovini.
  let engineStarted = false;
  try {
    const mot = await scegliMotore();
    if (cancelRequested) throw new Error('Annullato');
    if (mot.avviso === 'piccola-senza-sdxl') {
      throw new Error('La tua scheda non regge FLUX e non trovo un modello SDXL su cui addestrare il gemello. '
        + 'Scarica un SDXL realistico in Modelli (es. RealVisXL o Juggernaut XL) e riprova.');
    }
    const engine = { engine: mot.engine, engineBase: mot.base?.name || null };
    update(twin.id, engine);
    Object.assign(training, { ...engine, phase: 'Accendo il motore' });
    await freeGpu('twin');
    if (cancelRequested) throw new Error('Annullato');
    const srv = await engines.ensureRunning('twin');
    engineStarted = true;
    const post = async (p, body) => {
      const r = await fetch(srv + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.detail || `Motore gemello: HTTP ${r.status}`);
      return data;
    };
    if (cancelRequested) throw new Error('Annullato');
    await post('/train', { name: twin.key, trigger: twin.token, images: files, ...(mot.arch === 'sdxl' ? { arch: 'sdxl', base: mot.base.path } : {}) });
    if (cancelRequested) await post('/cancel', {});
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
            description: `Il viso di ${twin.name}, addestrato su ${twin.photos} foto${mot.engine === 'SDXL' ? ' (SDXL)' : ''}.`,
            triggerWords: [twin.name.toLowerCase(), 'di me', 'me stesso', 'me stessa', 'mio gemello', 'il gemello', 'gemello', 'photo of me', 'picture of me'].join(', '),
            promptToken: twin.token,
            loraWeight: 1,
            // SDXL: così lo scanner non prova a indovinare l'architettura e la LoRA si combina coi modelli SDXL giusti.
            ...(mot.arch === 'sdxl' ? { arch: 'sdxl' } : {}),
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
    if (engineStarted) engines.stop('twin');
  }
}

export async function cancelTraining() {
  if (training.status !== 'running') return;
  cancelRequested = true;
  await fetch(`http://127.0.0.1:${engines.CATALOG.twin.port}/cancel`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
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
  // Per un gemello SDXL si usa la base PULITA (file-singolo, realistica, non esplicita): baseSdxlGemello evita le
  // cartelle diffusers col bug del rumore e le basi toon/esplicite. Senza, si prendeva il PRIMO SDXL del catalogo,
  // che poteva essere proprio uno "sporco" → viso giusto ma immagine rumorosa o stilizzata. Per Flux resta com'era.
  const motore = lora.arch === 'sdxl'
    ? (baseSdxlGemello() || catalog.generators.find((g) => g.arch === 'sdxl' && g.capabilities?.includes('image_generate')))
    : catalog.generators.find((g) => g.arch === lora.arch && g.capabilities?.includes('image_generate'));
  return { lora, modelId: motore?.id || null };
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
  if (!engines.isInstalled('lipsync')) throw new Error('Il motore Gemello video non è installato: installalo nella pagina Gemello.');
  Object.assign(job, { task: 'talk', modelName: `Gemello video · ${t.name}`, title: job.title || job.prompt.slice(0, 60), routedPrompt: job.prompt, brain: 'motore voce + LatentSync', reason: `Voce "${voice.name}" sul video "${t.name}".` });
  job.status = 'running';
  job.startedAt = Date.now();
  log(`Leggo il testo con la voce "${voice.name}"…`);
  job.progress = { phase: 'Leggo il testo' };
  const lingua = job.talk?.language || voice.language || 'it';
  const nativa = job.talk?.steps === 6 && job.prompt.length <= 1200 ? voceNativa(voice, lingua) : null;
  let wav;
  let seconds;
  if (nativa) {
    try {
      wav = await parlaKokoro(job.prompt, nativa);
      seconds = +durataWav(wav).toFixed(2);
      log('Uso la voce sintetica originale su CPU.');
    } catch { log('Ripiego sul motore di clonazione per la voce.'); }
  }
  if (!wav) {
    if (!engines.isInstalled('voice')) throw new Error('Il motore voce non è installato.');
    await freeGpu('voice');
    job.backend = 'voice';
    const speech = await engines.call('voice', '/speak', {
      text: job.prompt, language: lingua, reference: voices.samplePath(voice.id), format: 'wav', ...(voice.defaults || {}),
    });
    wav = Buffer.from(speech.data, 'base64');
    seconds = speech.seconds;
    engines.stop('voice');
  } else {
    await freeGpu('lipsync');
  }
  if (job.cancelled) throw new Error('Annullato');
  const audio = path.join(OUTPUT_DIR, `${job.id}-voce.wav`);
  fs.writeFileSync(audio, wav);
  log('Muovo le labbra del video sulla voce…');
  job.backend = 'lipsync';
  const out = path.join(OUTPUT_DIR, `${job.id}-gemello.mp4`);
  await engines.call('lipsync', '/lipsync', { video: videoPath(t), audio, out, steps: job.talk?.steps,
    ...(job.talk?.steps === 6 ? { guidance: 1 } : {}) }, {
    timeout: 60 * 60 * 1000,
    onProgress: (p) => { job.progress = p.total ? { step: p.step, total: p.total, phase: p.phase || 'Muovo le labbra' } : { phase: p.phase || 'Carico il modello' }; },
  });
  job.results = [{ url: '/outputs/' + path.basename(out), type: 'video/mp4', ...(seconds != null ? { seconds } : {}) }];
  job.progress = { phase: 'Completato' };
  job.status = 'done';
  log('Completato.');
}
