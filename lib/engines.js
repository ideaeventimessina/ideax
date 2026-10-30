// Gestore dei motori: voce, musica, lip-sync… Ogni motore ha il suo ambiente Python separato
// (le librerie dei vari modelli sono incompatibili tra loro), si installa con un clic,
// si accende quando serve e si spegne da solo quando non lavora, per liberare la scheda video.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, APP_ROOT, DATA_DIR, getSettings } from './store.js';
import { detectGpu } from './runtime.js';

const IS_WIN = process.platform === 'win32';
const ENGINES_DIR = path.join(ROOT, 'runtime', 'engines');
const UV_DIR = path.join(ROOT, 'runtime', 'uv');
const IDLE_MS = 10 * 60 * 1000;
// La musica carica ~10 GB di modelli: la teniamo accesa più a lungo (se serve la GPU per immagini/video si spegne comunque)
const IDLE_MS_BY_ID = { music: 30 * 60 * 1000 };

// PyTorch 2.6 (richiesto da Chatterbox) esiste per CUDA 11.8, 12.4 e 12.6
function torchIndex(gpu) {
  if (gpu.vendor !== 'nvidia') return 'https://download.pytorch.org/whl/cpu';
  const major = Number(String(gpu.driver).split('.')[0]) || 0;
  if (major >= 560) return 'https://download.pytorch.org/whl/cu126';
  if (major >= 550) return 'https://download.pytorch.org/whl/cu124';
  return 'https://download.pytorch.org/whl/cu118';
}

export const CATALOG = {
  voice: {
    id: 'voice',
    name: 'Voce',
    model: 'Chatterbox Multilingual · Resemble AI',
    license: 'MIT, uso commerciale consentito',
    description: 'Clona una voce da 10–30 secondi di audio e legge qualsiasi testo con quella voce, in 23 lingue, italiano compreso.',
    sizeGb: 7,
    port: 7871,
    python: '3.11',
    script: 'worker/engines/voice_server.py',
    packages: (gpu) => [
      { label: 'PyTorch per la scheda video', args: ['torch==2.6.0', 'torchaudio==2.6.0', '--index-url', torchIndex(gpu)] },
      // Le dipendenze di Chatterbox una per una, senza pkuseg (solo cinese, su Windows va compilato e fallisce)
      // e senza gradio (interfaccia web che non ci serve): il codice di Chatterbox le tratta come facoltative.
      {
        label: 'Librerie audio',
        args: [
          'numpy>=1.24,<1.26', 'librosa==0.11.0', 's3tokenizer', 'transformers==4.46.3', 'diffusers==0.29.0',
          'resemble-perth==1.0.1', 'conformer==0.3.2', 'safetensors==0.5.3', 'pykakasi==2.3.0', 'einops',
          // resemble-perth (filigrana audio) usa yaml e pkg_resources senza dichiararli tra le dipendenze
          'pyyaml', 'setuptools<81',
          'fastapi', 'uvicorn', 'soundfile', 'imageio-ffmpeg',
          // Solo pacchetti già pronti: niente compilazioni, che su Windows senza strumenti di sviluppo falliscono
          '--only-binary', ':all:',
        ],
      },
      { label: 'Chatterbox', args: ['chatterbox-tts==0.1.4', '--no-deps'] },
    ],
    available: true,
  },
  // ACE-Step 1.5: si installa il progetto ufficiale (versione fissa) con il suo lockfile, poi si usa il suo server REST
  music: {
    id: 'music',
    name: 'Musica',
    model: 'ACE-Step 1.5',
    license: 'MIT, uso commerciale consentito',
    description: 'Basi, sottofondi e jingle della durata che serve (da 10 secondi a 10 minuti), anche canzoni con testo in italiano.',
    sizeGb: 18,
    port: 7872,
    python: '3.11',
    type: 'project',
    source: {
      ref: 'ca1e85fe9430179831e6bc6be790c332190a3866',
      url: 'https://github.com/ace-step/ACE-Step-1.5/archive/ca1e85fe9430179831e6bc6be790c332190a3866.zip',
    },
    // I modelli stanno fuori dalla cartella del programma: reinstallando non si riscaricano.
    // Il server di ACE-Step li cerca in <ACESTEP_PROJECT_ROOT>/checkpoints (ignora ACESTEP_CHECKPOINTS_DIR),
    // quindi la "radice del progetto" è una cartella stabile e i modelli stanno nella sua sottocartella checkpoints.
    dataRoot: () => path.join(ENGINES_DIR, 'music-data'),
    checkpoints: () => path.join(ENGINES_DIR, 'music-data', 'checkpoints'),
    postInstall: (id) => ({ label: 'Scarico i modelli musicali (circa 10 GB)', args: ['-m', 'acestep.model_downloader', '--dir', CATALOG[id].checkpoints()] }),
    startArgs: (e) => ['-m', 'acestep.api_server', '--host', '127.0.0.1', '--port', String(e.port)],
    env: (e) => ({
      ACESTEP_PROJECT_ROOT: e.dataRoot(),
      ACESTEP_CHECKPOINTS_DIR: e.checkpoints(),
      ACESTEP_TMPDIR: path.join(engineDir(e.id), 'tmp'),
      ACESTEP_INIT_LLM: 'auto',
    }),
    available: true,
  },
  twin: {
    id: 'twin', name: 'Gemello foto', model: 'Addestramento LoRA sul tuo volto', license: '—',
    description: 'Da circa 20 tue foto, immagini di te in qualsiasi scena.', sizeGb: 12, available: false,
  },
  lipsync: {
    id: 'lipsync', name: 'Gemello video', model: 'LatentSync / MuseTalk', license: '—',
    description: 'Il tuo video di base che parla con la tua voce clonata.', sizeGb: 8, available: false,
  },
};

// ---------- Stato ----------

const states = {};
function state(id) {
  if (!states[id]) {
    states[id] = { status: isInstalled(id) ? 'installed' : 'missing', step: null, log: [], error: null, running: false, phase: null };
  }
  return states[id];
}

const engineDir = (id) => path.join(ENGINES_DIR, id);
// IDEAX_ENGINE_PYTHON: solo per lo sviluppo, usa un Python già pronto invece degli ambienti installati
const venvPython = (id) => process.env.IDEAX_ENGINE_PYTHON || path.join(engineDir(id), 'venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
export const isInstalled = (id) => (!!process.env.IDEAX_ENGINE_PYTHON && CATALOG[id]?.available) || fs.existsSync(path.join(engineDir(id), 'installed.json'));

function log(id, line) {
  const s = state(id);
  const text = String(line).replace(/\r/g, '').trim();
  if (!text) return;
  s.log.push(text);
  if (s.log.length > 300) s.log.splice(0, s.log.length - 300);
}

export function listEngines() {
  return Object.values(CATALOG).map(({ packages, script, ...e }) => ({ ...e, ...state(e.id), log: state(e.id).log.slice(-40) }));
}

// ---------- uv: crea gli ambienti Python e installa i pacchetti ----------

function uvAsset() {
  if (IS_WIN) return 'uv-x86_64-pc-windows-msvc.zip';
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'uv-aarch64-apple-darwin.tar.gz' : 'uv-x86_64-apple-darwin.tar.gz';
  return 'uv-x86_64-unknown-linux-gnu.tar.gz';
}

function findInPath(cmd) {
  return new Promise((resolve) => execFile(IS_WIN ? 'where' : 'which', [cmd], (err, out) => resolve(err ? null : String(out).split(/\r?\n/)[0].trim() || null)));
}

async function ensureUv(id) {
  const local = path.join(UV_DIR, IS_WIN ? 'uv.exe' : 'uv');
  if (fs.existsSync(local)) return local;
  const system = await findInPath('uv');
  if (system) return system;
  log(id, 'Scarico uv (gestore degli ambienti Python)…');
  fs.mkdirSync(UV_DIR, { recursive: true });
  const archive = path.join(UV_DIR, uvAsset());
  const res = await fetch(`https://github.com/astral-sh/uv/releases/latest/download/${uvAsset()}`);
  if (!res.ok) throw new Error(`Download di uv non riuscito (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(archive));
  await run(id, 'tar', ['-xf', archive, '-C', UV_DIR]);
  fs.rmSync(archive, { force: true });
  // Negli archivi per Linux/macOS uv sta in una sottocartella
  if (!fs.existsSync(local)) {
    for (const d of fs.readdirSync(UV_DIR)) {
      const inner = path.join(UV_DIR, d, 'uv');
      if (fs.existsSync(inner)) fs.renameSync(inner, local);
    }
  }
  if (!fs.existsSync(local)) throw new Error('uv non trovato dopo l\'estrazione');
  return local;
}

function uvEnv() {
  return {
    ...process.env,
    // Python e cache di uv restano nella cartella dei dati di ideax: disinstallando si libera tutto
    UV_PYTHON_INSTALL_DIR: path.join(UV_DIR, 'python'),
    UV_CACHE_DIR: path.join(UV_DIR, 'cache'),
    UV_LINK_MODE: 'copy',
    PYTHONUTF8: '1',
  };
}

function hfEnv() {
  const t = getSettings().hfToken;
  return t ? { HF_TOKEN: t } : {};
}

function run(id, cmd, args, env = process.env, cwd = ROOT) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    child.stdout.on('data', (d) => String(d).split('\n').forEach((l) => log(id, l)));
    child.stderr.on('data', (d) => String(d).split('\n').forEach((l) => log(id, l)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} è terminato con codice ${code}`))));
  });
}

// ---------- Installazione ----------

export async function install(id) {
  const e = CATALOG[id];
  if (!e) throw new Error(`Motore sconosciuto: ${id}`);
  if (!e.available) throw new Error(`Il motore "${e.name}" arriverà in un prossimo aggiornamento.`);
  const s = state(id);
  if (s.status === 'installing') return s;
  Object.assign(s, { status: 'installing', error: null, log: [], step: 'Preparazione' });
  (async () => {
    try {
      const uv = await ensureUv(id);
      const env = uvEnv();
      const dir = engineDir(id);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const gpu = await detectGpu();
      log(id, gpu.vendor === 'nvidia' ? `Scheda video: ${gpu.name} (driver ${gpu.driver})` : 'Nessuna scheda NVIDIA: il motore userà il processore (lento).');
      if (e.type === 'project' && gpu.vendor === 'nvidia' && (Number(String(gpu.driver).split('.')[0]) || 0) < 570) {
        log(id, `Attenzione: ${e.model} usa CUDA 12.8 e richiede il driver NVIDIA 570 o più recente (hai ${gpu.driver}). Aggiorna il driver da nvidia.com, altrimenti userà il processore.`);
      }
      if (e.type === 'project') {
        // Progetto completo: codice ufficiale a una versione fissa + le versioni esatte del suo lockfile
        s.step = `Scarico ${e.model}`;
        const zip = path.join(dir, 'source.zip');
        const res = await fetch(e.source.url);
        if (!res.ok) throw new Error(`Download di ${e.model} non riuscito (${res.status})`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zip));
        await run(id, 'tar', ['-xf', zip, '-C', dir]);
        fs.rmSync(zip, { force: true });
        const extracted = fs.readdirSync(dir).find((d) => fs.statSync(path.join(dir, d)).isDirectory() && d !== 'venv');
        fs.renameSync(path.join(dir, extracted), path.join(dir, 'app'));
        s.step = 'Librerie e PyTorch per la scheda video (alcuni GB)';
        await run(id, uv, ['sync', '--frozen', '--python', e.python, '--no-dev'], { ...env, UV_PROJECT_ENVIRONMENT: path.join(dir, 'venv') }, path.join(dir, 'app'));
        const post = e.postInstall(id);
        s.step = post.label;
        fs.mkdirSync(e.checkpoints(), { recursive: true });
        await run(id, venvPython(id), post.args, { ...env, ...e.env(e), ...hfEnv() }, path.join(dir, 'app'));
        s.step = 'Avvio il motore e lo provo';
        await start(id);
      } else {
        s.step = `Ambiente Python ${e.python}`;
        await run(id, uv, ['venv', path.join(dir, 'venv'), '--python', e.python, '--seed'], env);
        for (const p of e.packages(gpu)) {
          s.step = p.label;
          await run(id, uv, ['pip', 'install', '--python', venvPython(id), ...p.args], env);
        }
        s.step = 'Scarico il modello e lo provo';
        await start(id);
        await call(id, '/warmup', {}, { timeout: 30 * 60 * 1000 });
      }
      fs.writeFileSync(path.join(dir, 'installed.json'), JSON.stringify({ date: new Date().toISOString(), gpu }, null, 2));
      Object.assign(s, { status: 'installed', step: null });
      log(id, 'Motore installato e pronto.');
    } catch (err) {
      Object.assign(s, { status: 'error', error: err.message });
      log(id, `Errore: ${err.message}`);
      stop(id);
    }
  })();
  return s;
}

export function uninstall(id) {
  stop(id);
  fs.rmSync(engineDir(id), { recursive: true, force: true });
  Object.assign(state(id), { status: 'missing', log: [], error: null });
}

// ---------- Processi ----------

const procs = {};
const idleTimers = {};

function url(id) {
  return `http://127.0.0.1:${CATALOG[id].port}`;
}

async function healthy(id) {
  try {
    return (await fetch(`${url(id)}/health`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

// Versioni fino alla 1.5.0: i modelli musicali stavano in "music-models", e il server ne aveva scaricata
// una seconda copia in app/checkpoints. Li spostiamo nella cartella giusta (senza riscaricarli) e togliamo il doppione.
function migrateMusicModels() {
  const target = CATALOG.music.checkpoints();
  const old = path.join(ENGINES_DIR, 'music-models');
  const dup = path.join(engineDir('music'), 'app', 'checkpoints');
  try {
    if (!fs.existsSync(target) || !fs.readdirSync(target).length) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) fs.rmdirSync(target);
      if (fs.existsSync(old) && fs.readdirSync(old).length) fs.renameSync(old, target);
      else if (fs.existsSync(dup) && fs.readdirSync(dup).length) fs.renameSync(dup, target);
    }
    if (fs.existsSync(target) && fs.readdirSync(target).length) {
      for (const extra of [old, dup]) if (fs.existsSync(extra)) fs.rmSync(extra, { recursive: true, force: true });
    }
  } catch (err) {
    log('music', `Spostamento dei modelli non riuscito: ${err.message}`);
  }
}

// Ultima riga utile del registro di un motore (per mostrare cosa sta facendo)
export function lastLog(id) {
  const lines = state(id).log;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i].replace(/\x1b\[[0-9;]*m/g, '').trim();
    if (l && !/^INFO:\s+127\.0\.0\.1/.test(l) && !/GET \/health|POST \/query_result/.test(l)) return l.slice(0, 160);
  }
  return '';
}

export async function start(id) {
  const e = CATALOG[id];
  const s = state(id);
  if (id === 'music') migrateMusicModels();
  if (await healthy(id)) { s.running = true; return; }
  if (!procs[id]) {
    const py = fs.existsSync(venvPython(id)) ? venvPython(id) : null;
    if (!py) throw new Error(`Il motore "${e.name}" non è installato.`);
    const out = fs.createWriteStream(path.join(DATA_DIR, `engine-${id}.log`), { flags: 'a' });
    const settings = getSettings();
    const args = e.startArgs ? e.startArgs(e) : [path.join(APP_ROOT, e.script), '--port', String(e.port)];
    if (e.dataRoot) fs.mkdirSync(e.dataRoot(), { recursive: true });
    const child = spawn(py, args, {
      cwd: e.type === 'project' ? path.join(engineDir(id), 'app') : ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1',
        ...(settings.hfToken ? { HF_TOKEN: settings.hfToken } : {}),
        ...(e.env ? e.env(e) : {}),
      },
    });
    procs[id] = child;
    const onData = (d) => { out.write(d); String(d).split('\n').forEach((l) => log(id, l)); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      delete procs[id];
      s.running = false;
      out.end();
      if (code) log(id, `Il motore si è fermato (codice ${code}).`);
    });
  }
  const deadline = Date.now() + (e.type === 'project' ? 600_000 : 180_000);
  while (Date.now() < deadline) {
    if (await healthy(id)) { s.running = true; return; }
    if (!procs[id]) throw new Error(`Il motore "${e.name}" non è partito: guarda il registro in Impostazioni → Motori.`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Il motore "${e.name}" non risponde.`);
}

export function stop(id) {
  procs[id]?.kill();
  delete procs[id];
  if (states[id]) states[id].running = false;
}

export function stopAll() {
  for (const id of Object.keys(procs)) stop(id);
}

// Chiama un motore: lo accende se serve e lo spegne dopo 10 minuti di inattività
export async function call(id, route, body, { timeout = 20 * 60 * 1000, onProgress } = {}) {
  await start(id);
  clearTimeout(idleTimers[id]);
  const s = state(id);
  const timer = onProgress && setInterval(async () => {
    try { onProgress(await (await fetch(`${url(id)}/progress`, { signal: AbortSignal.timeout(2000) })).json()); } catch { /* occupato */ }
  }, 1000);
  try {
    const res = await fetch(`${url(id)}${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || data.error || `Motore ${id}: HTTP ${res.status}`);
    return data;
  } finally {
    clearInterval(timer);
    s.phase = null;
    armIdle(id);
    idleTimers[id].unref?.();
  }
}

// Per i motori con un proprio server REST (es. ACE-Step): accende il motore e dà l'indirizzo
export async function ensureRunning(id) {
  await start(id);
  clearTimeout(idleTimers[id]);
  return url(id);
}

function armIdle(id) {
  const ms = IDLE_MS_BY_ID[id] || IDLE_MS;
  idleTimers[id] = setTimeout(() => { log(id, `Inattivo da ${ms / 60000} minuti: spengo il motore per liberare la scheda video.`); stop(id); }, ms);
}

export function touch(id) {
  clearTimeout(idleTimers[id]);
  armIdle(id);
  idleTimers[id].unref?.();
}

export function cancel(id) {
  return fetch(`${url(id)}/cancel`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
}

export const enginesDir = ENGINES_DIR;
export const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-'));
