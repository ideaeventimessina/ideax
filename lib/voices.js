// Voci clonate: per ognuna il campione audio preparato (WAV 24 kHz) e il consenso registrato.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';
import * as engines from './engines.js';

const DIR = path.join(DATA_DIR, 'voices');
fs.mkdirSync(DIR, { recursive: true });

export const MIN_SECONDS = 5;

function readMeta(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DIR, id, 'meta.json'), 'utf8'));
  } catch {
    return null;
  }
}

export function listVoices() {
  return fs.readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => readMeta(d.name))
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

// Per id o per nome (senza distinguere maiuscole), così i sistemi collegati possono scrivere "voice": "Marco"
export function findVoice(ref) {
  if (!ref) return listVoices()[0] || null;
  const r = String(ref).toLowerCase();
  return listVoices().find((v) => v.id === ref || v.name.toLowerCase() === r) || null;
}

export const samplePath = (id) => path.join(DIR, id, 'sample.wav');

export async function createVoice({ name, language = 'it', consent, consentBy, file, synthetic, gender, description }) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Dai un nome alla voce');
  // Le voci sintetiche della libreria (Kokoro) non appartengono a nessuna persona: niente consenso da raccogliere
  if (!consent && !synthetic) {
    throw new Error('Serve il consenso: la voce deve essere tua o di una persona che ti ha dato il permesso di clonarla.');
  }
  if (!file?.buffer?.length) throw new Error('Manca il campione audio');
  if (listVoices().some((v) => v.name.toLowerCase() === clean.toLowerCase())) throw new Error(`Esiste già una voce chiamata "${clean}"`);
  if (!engines.isInstalled('voice')) {
    const err = new Error('Il motore voce non è installato: installalo dalla pagina Voce.');
    err.status = 409;
    throw err;
  }
  const id = crypto.randomUUID().slice(0, 8);
  const dir = path.join(DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const ext = (path.extname(file.name || '') || '.audio').slice(0, 8);
  const original = path.join(dir, `original${ext}`);
  fs.writeFileSync(original, file.buffer);
  try {
    const { seconds } = await engines.call('voice', '/prepare', { input: original, output: samplePath(id) }, { timeout: 120_000 });
    if (seconds < MIN_SECONDS) {
      throw new Error(`Il campione dura ${seconds} secondi: ne servono almeno ${MIN_SECONDS} di voce (meglio 15–30), senza musica né rumori.`);
    }
    const meta = {
      id, name: clean, language, seconds, createdAt: Date.now(),
      ...(synthetic
        ? { origin: synthetic, gender: gender || null, description: description || '' }
        : { consent: { given: true, by: consentBy || 'utente di ideax', at: new Date().toISOString() }, ...(gender ? { gender } : {}) }),
    };
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

export function deleteVoice(id) {
  const v = readMeta(id);
  if (!v) return false;
  fs.rmSync(path.join(DIR, id), { recursive: true, force: true });
  return true;
}

export function updateVoice(id, patch) {
  const v = readMeta(id);
  if (!v) throw new Error('Voce non trovata');
  const next = { ...v };
  if (patch.name) next.name = String(patch.name).trim().slice(0, 60);
  if (patch.language) next.language = patch.language;
  if (patch.defaults && typeof patch.defaults === 'object') next.defaults = patch.defaults;
  fs.writeFileSync(path.join(DIR, id, 'meta.json'), JSON.stringify(next, null, 2));
  return next;
}
