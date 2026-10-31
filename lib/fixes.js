// Riparazioni automatiche dei modelli: quando un file scaricato non basta da solo, ideax prende il resto.
// Stable Video Diffusion in file singolo: il motore immagini lo usa nella versione "cartella diffusers".
// Con il token di Hugging Face (Impostazioni) ideax la scarica da solo, in mezza precisione (circa 4,5 GB).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR, getSettings, saveOverride } from './store.js';
import { scanModels } from './scanner.js';

const SVD_REPO = 'stabilityai/stable-video-diffusion-img2vid-xt-1-1';
const HF = process.env.IDEAX_HF_BASE || 'https://huggingface.co'; // indirizzo sostituibile solo per le prove
export const SVD_DIR = path.join(MODELS_DIR, 'checkpoints', 'stable-video-diffusion-xt-1-1');

export const fixes = { svd: { status: 'idle', file: null, done: 0, total: 0, error: null } };

const hfHeaders = () => {
  const t = getSettings().hfToken;
  return { 'User-Agent': 'ideax', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
};

function gatedError(status, repo) {
  if (status === 401) return new Error('Token di Hugging Face mancante o non valido: controllalo in Impostazioni → Hugging Face.');
  if (status === 403) return new Error(`Devi accettare la licenza del modello: apri huggingface.co/${repo}, premi "Agree and access repository" con il tuo account, poi riprova.`);
  return new Error(`Hugging Face ha risposto ${status}`);
}

// Quali file servono: le configurazioni e, per ogni parte del modello, i pesi a mezza precisione (fp16) se ci sono
function pickFiles(siblings) {
  const names = siblings.map((s) => s.rfilename);
  const files = names.filter((n) => n.endsWith('.json') && n.includes('/') || n === 'model_index.json');
  const dirs = [...new Set(names.filter((n) => n.includes('/') && n.endsWith('.safetensors')).map((n) => n.split('/')[0]))];
  for (const d of dirs) {
    const inDir = names.filter((n) => n.startsWith(`${d}/`) && n.endsWith('.safetensors'));
    const fp16 = inDir.filter((n) => n.includes('.fp16.'));
    files.push(...(fp16.length ? fp16 : inDir));
  }
  return files;
}

export function svdReady() {
  return fs.existsSync(path.join(SVD_DIR, 'model_index.json')) && fs.existsSync(path.join(SVD_DIR, 'unet'));
}
if (svdReady()) fixes.svd.status = 'done';

export async function fixSvd() {
  const st = fixes.svd;
  if (st.status === 'running') return st;
  if (svdReady()) { disableSingleFileSvd(); return Object.assign(st, { status: 'done' }); }
  if (!getSettings().hfToken) throw new Error('Serve il token di Hugging Face: aggiungilo in Impostazioni → Hugging Face.');
  Object.assign(st, { status: 'running', file: 'elenco dei file', done: 0, total: 0, error: null });
  (async () => {
    const tmp = `${SVD_DIR}.part`;
    try {
      const info = await fetch(`${HF}/api/models/${SVD_REPO}`, { headers: hfHeaders() });
      if (!info.ok) throw gatedError(info.status, SVD_REPO);
      const files = pickFiles((await info.json()).siblings || []);
      if (!files.some((f) => f.startsWith('unet/'))) throw new Error('Nel repository non trovo i pesi del modello');
      fs.mkdirSync(tmp, { recursive: true });
      for (const f of files) {
        st.file = f;
        // I pesi fp16 si salvano con il nome normale: il motore li carica senza opzioni particolari
        const dest = path.join(tmp, f.replace('.fp16.', '.'));
        if (fs.existsSync(dest)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        const res = await fetch(`${HF}/${SVD_REPO}/resolve/main/${f}`, { headers: hfHeaders() });
        if (!res.ok) throw gatedError(res.status, SVD_REPO);
        const size = Number(res.headers.get('content-length')) || 0;
        st.total += size;
        let got = 0;
        const counted = Readable.fromWeb(res.body);
        counted.on('data', (c) => { got += c.length; st.done += c.length; });
        await pipeline(counted, fs.createWriteStream(`${dest}.tmp`));
        fs.renameSync(`${dest}.tmp`, dest);
      }
      fs.rmSync(SVD_DIR, { recursive: true, force: true });
      fs.renameSync(tmp, SVD_DIR);
      disableSingleFileSvd();
      Object.assign(st, { status: 'done', file: null });
    } catch (err) {
      Object.assign(st, { status: 'error', error: err.message, file: null });
    }
  })();
  return st;
}

// Il file singolo resta sul disco ma si spegne: al suo posto lavora la cartella appena scaricata
function disableSingleFileSvd() {
  const all = scanModels();
  for (const m of all) if (m.fix === 'svd' && m.enabled) saveOverride(m.id, { enabled: false });
  const folder = all.find((m) => m.path === SVD_DIR);
  if (folder) saveOverride(folder.id, { name: 'Stable Video Diffusion XT 1.1', description: 'Da una foto a un video di 3–4 secondi (25 fotogrammi).' });
}

// All'avvio: se c'è un SVD in file singolo e il token, la riparazione parte da sola
export function autoFix() {
  try {
    if (getSettings().hfToken && !svdReady() && scanModels().some((m) => m.fix === 'svd')) fixSvd().catch(() => {});
  } catch {}
}
