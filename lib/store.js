// Persistenza su file JSON: impostazioni, personalizzazioni dei modelli, server esterni e cronologia.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// Due cartelle distinte:
// - APP_ROOT: il programma (ideax.exe, interfaccia, worker). L'installazione e gli aggiornamenti lo sostituiscono.
// - ROOT: i tuoi dati (modelli, creazioni, impostazioni, motore Python). Gli aggiornamenti non lo toccano mai.
/* global __IDEAX_SEA__, __IDEAX_VERSION__ */
export const IS_SEA = typeof __IDEAX_SEA__ !== 'undefined';
export const APP_ROOT = IS_SEA ? path.dirname(process.execPath) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = typeof __IDEAX_VERSION__ !== 'undefined'
  ? __IDEAX_VERSION__
  : JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;

// Installato con ideax-setup.exe: l'installatore lascia questo file accanto al programma
export const INSTALLED = fs.existsSync(path.join(APP_ROOT, 'ideax-installato.txt'));
// Un file in AppData può indicare dove stanno i dati (es. la vecchia cartella portatile)
export const HOME_POINTER = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'ideax', 'home.txt');

function resolveHome() {
  if (process.env.IDEAX_HOME) return process.env.IDEAX_HOME;
  if (!INSTALLED) return APP_ROOT; // versione portatile o dal codice: dati accanto al programma
  try {
    const p = fs.readFileSync(HOME_POINTER, 'utf8').trim();
    if (p && fs.existsSync(p)) return p;
  } catch { /* nessun puntatore */ }
  return path.join(os.homedir(), 'ideax');
}

export const ROOT = resolveHome();
export const DATA_DIR = path.join(ROOT, 'data');
export const MODELS_DIR = path.join(ROOT, 'models');
export const OUTPUT_DIR = path.join(ROOT, 'outputs');
for (const d of [DATA_DIR, MODELS_DIR, OUTPUT_DIR]) fs.mkdirSync(d, { recursive: true });

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, value) {
  const file = path.join(DATA_DIR, name);
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2));
  fs.renameSync(file + '.tmp', file);
}

export const TASKS = {
  image_generate: 'Genera immagine da testo',
  image_edit: 'Modifica immagine',
  image_to_video: 'Da immagine a video',
  video_generate: 'Genera video da testo',
  video_edit: 'Modifica video',
  animation: 'Animazione / GIF',
};

// ---------- Impostazioni ----------

const DEFAULT_SETTINGS = {
  workerUrl: 'http://127.0.0.1:7861',
  manageWorker: true, // ideax avvia e ferma da solo il worker Python
  network: { lan: false, token: '' }, // accesso dagli altri dispositivi (vale dal prossimo avvio)
  update: { repo: 'ideaeventimessina/ideax', auto: true }, // da dove arrivano gli aggiornamenti (GitHub Releases)
  extraModelDirs: [],
  brain: {
    mode: 'auto', // auto | rules | gguf | server
    gguf: '', // id del file .gguf da usare (vuoto = il primo trovato)
    serverUrl: 'http://127.0.0.1:11434/v1', // Ollama, LM Studio, llama.cpp server…
    serverModel: '',
  },
};

export function getSettings() {
  const s = readJson('settings.json', {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    brain: { ...DEFAULT_SETTINGS.brain, ...(s.brain || {}) },
    network: { ...DEFAULT_SETTINGS.network, ...(s.network || {}) },
    update: { ...DEFAULT_SETTINGS.update, ...(s.update || {}) },
  };
}

export function saveSettings(patch) {
  const current = getSettings();
  const next = {
    ...current,
    ...patch,
    brain: { ...current.brain, ...(patch.brain || {}) },
    network: { ...current.network, ...(patch.network || {}) },
    update: { ...current.update, ...(patch.update || {}) },
  };
  next.extraModelDirs = (next.extraModelDirs || []).map((d) => String(d).trim()).filter(Boolean);
  writeJson('settings.json', next);
  return next;
}

// ---------- Personalizzazioni dei modelli trovati su disco ----------
// I file vengono rilevati in automatico; qui si salva solo quello che l'utente cambia
// (nome, descrizione, priorità, parole chiave delle LoRA, architettura corretta a mano…).

export function getOverrides() {
  return readJson('overrides.json', {});
}

export function saveOverride(id, patch) {
  const all = getOverrides();
  all[id] = { ...(all[id] || {}), ...patch };
  writeJson('overrides.json', all);
  return all[id];
}

// ---------- Server locali esterni (ComfyUI, Automatic1111/Forge, endpoint personalizzati) ----------

export const SERVER_TYPES = ['comfyui', 'a1111', 'custom'];

export function listServers() {
  return readJson('servers.json', []);
}

export function saveServer(input) {
  if (!input?.name) throw new Error('Il nome è obbligatorio');
  if (!SERVER_TYPES.includes(input.type)) throw new Error(`Tipo non supportato: ${input.type}`);
  if (!input.endpoint) throw new Error('Serve l\'indirizzo del server');
  const capabilities = (input.capabilities || []).filter((c) => c in TASKS);
  if (!capabilities.length) throw new Error('Seleziona almeno una capacità');
  const parse = (v) => (typeof v === 'string' ? (v.trim() ? JSON.parse(v) : null) : v || null);
  const server = {
    id: input.id || 'srv-' + crypto.randomUUID().slice(0, 8),
    name: String(input.name),
    type: input.type,
    endpoint: String(input.endpoint).replace(/\/$/, ''),
    capabilities,
    description: input.description || '',
    priority: Number(input.priority) || 0,
    enabled: input.enabled !== false,
    template: parse(input.template),
    headers: parse(input.headers) || {},
  };
  const list = listServers();
  const i = list.findIndex((s) => s.id === server.id);
  if (i >= 0) list[i] = server;
  else list.push(server);
  writeJson('servers.json', list);
  return server;
}

export function deleteServer(id) {
  writeJson('servers.json', listServers().filter((s) => s.id !== id));
}

// ---------- Cronologia ----------

export function listHistory() {
  return readJson('history.json', []);
}

export function addHistory(entry) {
  const history = listHistory();
  history.unshift(entry);
  writeJson('history.json', history.slice(0, 300));
}
