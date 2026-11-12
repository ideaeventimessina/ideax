// PERSONAGGI INVENTATI: un volto che NON esiste, tenuto sempre uguale con una LoRA sua. Diventa un "brand" ricorrente
// (OnlyFans, sito per adulti, testimonial di fantasia) senza nessuna persona reale, quindi senza consenso e, trattandosi
// di finzione, senza il limite sulle persone reali. Vale sempre e solo il limite sui minori.
//
// Come nasce (tutto sul PC, riusando motori che ideax ha già):
//   1. una faccia di partenza, generata da una descrizione (immagine da testo);
//   2. un dataset: la STESSA faccia in tante pose/abiti/luci, creata con Qwen-Image-Edit (tiene il volto);
//   3. una LoRA addestrata su quel dataset (stesso motore del gemello), che blocca il personaggio per sempre;
//   4. da lì basta nominarlo e torna identico, in immagini e video.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, MODELS_DIR, OUTPUT_DIR } from './store.js';
import * as engines from './engines.js';
import { scanModels } from './scanner.js';
import { buildCatalog } from './router.js';
import { saveOverride } from './store.js';
import { freeGpu } from './twin.js';

const DIR = path.join(DATA_DIR, 'personaggi');
const FILE = path.join(DIR, 'personaggi.json');
fs.mkdirSync(DIR, { recursive: true });

let host = { createJob: null };
export function configure(fns) { host = { ...host, ...fns }; }

export const training = { id: null, status: 'idle', step: 0, total: 0, phase: null, error: null, log: [] };

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { lista: [] }; } }
function save(d) { fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); }
function update(id, patch) { const d = load(); const t = d.lista.find((x) => x.id === id); if (t) { Object.assign(t, patch); save(d); } return t; }
const slug = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'personaggio';

export function list() { return load().lista; }

// Le pose del dataset: stesso volto, scene diverse. Prima era quasi tutto "mezzo busto" uguale, e la LoRA
// imparava solo quella inquadratura. Adesso: MAGGIORANZA a figura intera, con pose/angoli/ambienti diversi;
// qualche mezza figura; POCHI primi piani — che però restano, perché senza abbastanza pixel di viso la faccia
// non si fissa. Qwen-Image-Edit tiene lo stesso volto in ogni scena, quindi la varietà qui non costa fedeltà.
export function istruzioniDataset(descrizione, nsfw) {
  const chi = String(descrizione || 'a person').trim();

  // Figura intera: la maggioranza. Pose, angoli, ambienti e luci tutti diversi.
  const figuraIntera = [
    'full body shot, standing relaxed, weight on one leg, looking at camera, modern apartment, soft window light',
    'full body, walking outdoors on a city street, candid, natural daylight',
    'full body, sitting on a sofa, legs crossed, warm indoor light',
    'full body, leaning against a wall, three-quarter angle, golden hour',
    'full body on a beach, dynamic pose arms up, bright sunlight',
    'full body, sitting at a cafe table, side angle, ambient light',
    'full body in a park, playful mid-stride pose, backlight',
    'full body standing by a large window, elegant pose, evening light',
    'full length from a low angle, confident stance hand on hip, studio light',
    'full body from behind, looking over the shoulder, soft light',
    'full body, crouching pose, urban background, overcast light',
  ];
  // Mezza figura / piano americano: qualcuno.
  const mezzaFigura = [
    'medium shot, upper body, casual outfit, natural light, candid',
    'cowboy shot from the knees up, hand on hip, city background',
    'medium shot sitting, leaning forward toward camera, soft bokeh',
  ];
  // Primi piani e dettagli: pochi, ma servono a fissare il viso.
  const primiPiani = [
    'close-up portrait, soft studio light, looking at camera, sharp focus',
    'headshot, natural daylight, plain background, subtle smile',
    'face detail, three-quarter view, side light, catchlights in the eyes',
  ];

  let scene;
  if (nsfw) {
    // Pose esplicite "attinenti", anch'esse in prevalenza a figura intera e variate.
    // Si tengono comunque alcuni primi piani del viso: senza, il personaggio non resta riconoscibile.
    const esplicite = [
      'full body nude, standing, natural confident pose, bedroom soft light',
      'full body topless in lingerie bottoms, lying on a bed, relaxed pose',
      'full body nude, lying on her side on a bed, soft morning light',
      'full body nude, kneeling on a bed, arching back, warm light',
      'full body nude, sitting on the edge of a bed, legs apart, intimate light',
      'full body in open lingerie, standing against a window, backlight',
      'full body nude seen from behind, looking over the shoulder, soft light',
      'medium shot topless, hands in hair, boudoir light',
      'close-up sensual portrait, parted lips, intimate light',
    ];
    scene = [
      ...figuraIntera.slice(0, 6),
      ...mezzaFigura.slice(0, 2),
      ...primiPiani.slice(0, 2),
      ...esplicite,
    ];
  } else {
    scene = [...figuraIntera, ...mezzaFigura, ...primiPiani];
  }

  return scene.map((scena) => `same exact person, ${chi}, ${scena}, photorealistic, consistent facial features, sharp focus, detailed`);
}

async function waitJob(job) { await job.done; if (job.status !== 'done') throw new Error(job.error || 'non riuscito'); return job.results || []; }
const fileOf = (url) => path.join(OUTPUT_DIR, path.basename(url));
const toAtt = (r) => ({ name: path.basename(r.url), type: r.type, dataUrl: `data:${r.type};base64,${fs.readFileSync(fileOf(r.url)).toString('base64')}` });

// Crea un personaggio: genera la faccia, il dataset, addestra la LoRA, lo registra. Parte in background come il gemello.
// Trova un modello esplicito SDXL installato (es. Pony Realism): serve come base su cui addestrare la LoRA del
// personaggio e per generarne il volto, così la LoRA è SDXL e si combina con quei modelli.
function baseSdxl() {
  return buildCatalog().generators.find((g) => g.arch === 'sdxl' && g.backend === 'worker' && g.capabilities?.includes('image_generate') && g.path) || null;
}

export async function createPersonaggio({ nome, descrizione, nsfw = false, scatti = 16, sdxl = false, anchorUrl = null }) {
  const clean = String(nome || '').trim().slice(0, 40);
  if (!clean) throw new Error('Dai un nome al personaggio');
  // Se parti da un volto GIÀ generato (anchorUrl), la descrizione è facoltativa: la faccia è quella scelta.
  const anchorFile = anchorUrl ? path.join(OUTPUT_DIR, path.basename(anchorUrl)) : null;
  if (anchorFile && !fs.existsSync(anchorFile)) throw new Error('La foto di partenza non si trova più: rigenerala.');
  if (!anchorFile && !String(descrizione || '').trim()) throw new Error('Descrivi il personaggio (età adulta, aspetto, stile): il volto è inventato');
  if (!engines.isInstalled('twin')) throw new Error('Serve il motore Gemello foto (addestra la LoRA): installalo nella pagina Modelli');
  if (!engines.isInstalled('qwenedit')) throw new Error('Serve il motore Fotomontaggio Qwen (tiene il volto uguale nel dataset): installalo nella pagina Modelli');
  if (training.status === 'running') throw new Error('Sto già preparando un personaggio: aspetta che finisca');
  // Per i contenuti espliciti la LoRA va addestrata su SDXL (per combinarsi con Pony Realism ecc.): serve un modello SDXL installato.
  const base = sdxl ? baseSdxl() : null;
  if (sdxl && !base) throw new Error('Per un personaggio per contenuti espliciti scarica prima un modello esplicito SDXL (Modelli → Modelli per adulti).');
  const id = crypto.randomUUID().slice(0, 8);
  const key = `${slug(clean)}_${id.slice(0, 4)}`;
  const token = `${slug(clean).replace(/_/g, '')}chr`;
  const p = { id, nome: clean, key, token, descrizione: String(descrizione || 'the person in the photo').trim(), nsfw: !!nsfw, finto: true, sdxl: !!sdxl, baseId: base?.id || null, basePath: base?.path || null, anchorFile, status: 'training', createdAt: Date.now() };
  const d = load(); d.lista.unshift(p); save(d);
  prepara(p, Math.max(10, Math.min(24, Number(scatti) || 16))).catch(() => {});
  return p;
}

async function prepara(p, scatti) {
  Object.assign(training, { id: p.id, status: 'running', step: 0, total: scatti + 1, phase: 'Creo la faccia di partenza', error: null, log: [] });
  const dir = path.join(DIR, p.id, 'foto');
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 1. la faccia di partenza: quella che hai scelto (anchorFile) oppure generata dalla descrizione
    let anchorPath, anchorAtt;
    if (p.anchorFile && fs.existsSync(p.anchorFile)) {
      Object.assign(training, { phase: 'Uso il volto che hai scelto', step: 1 });
      anchorPath = p.anchorFile;
      const type = p.anchorFile.endsWith('.jpg') || p.anchorFile.endsWith('.jpeg') ? 'image/jpeg' : p.anchorFile.endsWith('.webp') ? 'image/webp' : 'image/png';
      anchorAtt = { name: path.basename(p.anchorFile), type, dataUrl: `data:${type};base64,${fs.readFileSync(p.anchorFile).toString('base64')}` };
    } else {
      const anchorJob = await host.createJob({ prompt: `photorealistic portrait of ${p.descrizione}, adult, 25 to 35 years old, facing camera, neutral background, sharp focus, consistent facial features`, task: 'image_generate', ...(p.baseId ? { model: p.baseId } : {}), params: { aspect: '1:1', face_fix: true } }, { client: 'personaggio' });
      const anchor = (await waitJob(anchorJob)).find((r) => r.type?.startsWith('image/'));
      if (!anchor) throw new Error('Non sono riuscito a creare la faccia di partenza');
      anchorPath = fileOf(anchor.url);
      anchorAtt = toAtt(anchor);
    }
    const files = [];

    // 2. il dataset: la stessa faccia in tante scene (Qwen-Image-Edit sulla faccia di partenza)
    const scene = istruzioniDataset(p.descrizione, p.nsfw).slice(0, scatti);
    for (const [i, istr] of scene.entries()) {
      if (training.status === 'cancelled') throw new Error('Annullato');
      training.phase = `Creo il personaggio in pose diverse (${i + 1}/${scene.length})`;
      training.step = i + 1;
      try {
        const j = await host.createJob({ prompt: istr, task: 'image_edit', model: 'engine-qwenedit', params: { face_fix: false, skin_fix: false }, attachments: [anchorAtt] }, { client: 'personaggio' });
        const img = (await waitJob(j)).find((r) => r.type?.startsWith('image/'));
        if (img) {
          const dest = path.join(dir, `${String(files.length).padStart(3, '0')}.png`);
          fs.copyFileSync(fileOf(img.url), dest);
          fs.writeFileSync(dest.replace(/\.png$/, '.txt'), `photo of ${p.token}`);
          files.push(dest);
        }
      } catch { /* una scena saltata non ferma tutto */ }
    }
    // la faccia di partenza entra nel dataset
    { const dest = path.join(dir, `${String(files.length).padStart(3, '0')}.png`); fs.copyFileSync(anchorPath, dest); fs.writeFileSync(dest.replace(/\.png$/, '.txt'), `photo of ${p.token}`); files.push(dest); }
    if (files.length < 8) throw new Error('Sono riuscite meno di 8 immagini del personaggio: riprova (serve il motore immagini e Qwen)');

    // 3. la LoRA (motore del gemello)
    training.phase = 'Addestro la LoRA del personaggio (una volta sola)';
    await freeGpu('twin');
    const base = await engines.ensureRunning('twin');
    const post = async (path_, body) => {
      const r = await fetch(base + path_, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      const data = await r.json().catch(() => ({})); if (!r.ok) throw new Error(data.detail || `Motore: HTTP ${r.status}`); return data;
    };
    await post('/train', { name: p.key, trigger: p.token, images: files, ...(p.sdxl ? { arch: 'sdxl', base: p.basePath } : {}) });
    for (;;) {
      await new Promise((r) => setTimeout(r, 4000));
      engines.touch('twin');
      const pr = await post('/progress');
      Object.assign(training, { step: scatti + Math.round((pr.step / (pr.total || 1)) * 100) / 100, phase: pr.phase || 'Addestro', log: pr.log || [] });
      if (pr.status === 'error') throw new Error(pr.error || 'addestramento non riuscito');
      if (pr.status === 'cancelled') throw new Error('Annullato');
      if (pr.status === 'done') {
        const dest = path.join(MODELS_DIR, 'loras', `personaggio-${p.key}.safetensors`);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(pr.output, dest);
        const model = scanModels().find((m) => m.path === dest);
        if (model) saveOverride(model.id, {
          name: `Personaggio · ${p.nome}`,
          description: `Personaggio inventato "${p.nome}" (volto di fantasia). ${p.descrizione}`.slice(0, 300),
          triggerWords: [p.nome.toLowerCase(), slug(p.nome).replace(/_/g, ' ')].filter(Boolean).join(', '),
          promptToken: p.token, loraWeight: 1,
          // SDXL: così la LoRA si combina coi modelli espliciti SDXL (altrimenti lo scanner potrebbe non indovinare l'architettura)
          ...(p.sdxl ? { arch: 'sdxl', adultLora: !!p.nsfw } : {}),
        });
        update(p.id, { status: 'ready', lora: dest, modelId: model?.id, scatti: files.length, readyAt: Date.now() });
        Object.assign(training, { status: 'done', phase: null });
        break;
      }
    }
  } catch (err) {
    update(p.id, { status: 'error', error: err.message });
    Object.assign(training, { status: 'error', error: err.message, phase: null });
  } finally {
    engines.stop('twin');
  }
}

export async function cancel() {
  if (training.status !== 'running') return;
  training.status = 'cancelled';
  await fetch(`http://127.0.0.1:${engines.CATALOG.twin.port}/cancel`, { method: 'POST' }).catch(() => {});
}

export function del(id) {
  const d = load(); const t = d.lista.find((x) => x.id === id); if (!t) return false;
  if (training.id === id && training.status === 'running') throw new Error('Prima annulla la preparazione');
  fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
  if (t.lora) fs.rmSync(t.lora, { force: true });
  d.lista = d.lista.filter((x) => x.id !== id); save(d);
  return true;
}

// Se il prompt nomina un personaggio: la sua LoRA e un modello su cui usarla. { nsfw } dice se è un personaggio adulto.
export function personaggioForPrompt(prompt) {
  const p = ` ${String(prompt).toLowerCase()} `;
  const car = load().lista.find((x) => x.status === 'ready' && new RegExp(`(^|[^\\p{L}])${x.nome.toLowerCase().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([^\\p{L}]|$)`, 'u').test(p));
  if (!car) return null;
  const catalog = buildCatalog();
  const lora = catalog.loras.find((l) => l.id === car.modelId || l.promptToken === car.token);
  if (!lora) return null;
  const gen = catalog.generators.find((g) => g.arch === lora.arch && g.capabilities?.includes('image_generate'));
  return { personaggio: car, lora, modelId: gen?.id || null, nsfw: car.nsfw };
}
