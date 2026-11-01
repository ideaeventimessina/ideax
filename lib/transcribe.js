// Trascrizione: Whisper large-v3-turbo (OpenAI, MIT) sul worker, con la scheda video.
// Il modello (circa 1,6 GB) lo scarica ideax la prima volta, nella sua cartella dei motori.
import fs from 'node:fs';
import path from 'node:path';
import { getSettings } from './store.js';
import { enginesDir } from './engines.js';
import { snapshot } from './hfdownload.js';

const REPO = 'openai/whisper-large-v3-turbo';
export const MODEL_DIR = path.join(enginesDir, 'whisper-large-v3-turbo');
const READY = path.join(MODEL_DIR, 'pronto.json');
export const job = { status: fs.existsSync(READY) ? 'ready' : 'missing', step: null, done: 0, total: 0, error: null };
let downloading = null;

export function ensureModel() {
  if (fs.existsSync(READY)) return Promise.resolve(MODEL_DIR);
  downloading ??= (async () => {
    Object.assign(job, { status: 'downloading', step: 'Scarico Whisper large-v3-turbo (circa 1,6 GB, una volta sola)', error: null });
    try {
      await snapshot(REPO, MODEL_DIR, ['*.json', 'model.safetensors', '*.txt'], { onProgress: (p) => Object.assign(job, { done: p.done, total: p.total }) });
      fs.writeFileSync(READY, JSON.stringify({ repo: REPO, date: new Date().toISOString() }));
      Object.assign(job, { status: 'ready', step: null });
      return MODEL_DIR;
    } catch (err) {
      Object.assign(job, { status: 'error', step: null, error: err.message });
      throw err;
    } finally {
      downloading = null;
    }
  })();
  return downloading;
}

// audio: data URL o base64. Restituisce { testo, pezzi: [{inizio, fine, testo}], secondi }
export async function transcribe(audio, { lingua, tempi = true } = {}) {
  const model = await ensureModel();
  const res = await fetch(`${getSettings().workerUrl}/trascrivi`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio, model, language: lingua || null, timestamps: tempi }),
    signal: AbortSignal.timeout(30 * 60_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.detail || `Trascrizione non riuscita (HTTP ${res.status})`);
  return { testo: d.text, pezzi: d.chunks, secondi: d.seconds, impiegati: d.elapsed };
}
