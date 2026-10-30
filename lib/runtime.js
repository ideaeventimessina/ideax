// Il motore Python: installazione automatica (Windows) e avvio/arresto del worker.
// Su Windows ideax scarica un Python "portatile" nella cartella runtime/ e ci installa PyTorch adatto
// alla scheda video: non serve installare nulla a mano e non si tocca il resto del sistema.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, DATA_DIR, getSettings } from './store.js';

const IS_WIN = process.platform === 'win32';
const RUNTIME_DIR = path.join(ROOT, 'runtime');
const PY_DIR = path.join(RUNTIME_DIR, 'python');
const MARKER = path.join(RUNTIME_DIR, 'installed.json');
const WORKER_LOG = path.join(DATA_DIR, 'worker.log');

const PYTHON_VERSION = '3.12.8';
const PYTHON_ZIP = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP = 'https://bootstrap.pypa.io/get-pip.py';

// ---------- Dove sta Python ----------

export function pythonPath() {
  const candidates = IS_WIN
    ? [path.join(PY_DIR, 'python.exe'), path.join(ROOT, '.venv', 'Scripts', 'python.exe')]
    : [path.join(ROOT, '.venv', 'bin', 'python')];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

export function isInstalled() {
  const py = pythonPath();
  if (!py) return false;
  return py.startsWith(PY_DIR) ? fs.existsSync(MARKER) : true;
}

// ---------- Scheda video ----------

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 15000, windowsHide: true, ...opts }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

export async function detectGpu() {
  const out = await run('nvidia-smi', ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits']);
  if (!out?.trim()) return { vendor: process.platform === 'darwin' ? 'apple' : 'none' };
  const [name, driver, mem] = out.trim().split('\n')[0].split(',').map((x) => x.trim());
  return { vendor: 'nvidia', name, driver, vramGb: Math.round(Number(mem) / 1024) };
}

// Versione di PyTorch in base al driver NVIDIA: le schede RTX 50 richiedono CUDA 12.8
export function torchVariant(gpu) {
  if (gpu.vendor !== 'nvidia') return { id: 'cpu', label: 'solo processore (lento)', index: 'https://download.pytorch.org/whl/cpu' };
  const major = Number(String(gpu.driver).split('.')[0]) || 0;
  if (major >= 570) return { id: 'cu128', label: 'CUDA 12.8', index: 'https://download.pytorch.org/whl/cu128' };
  if (major >= 550) return { id: 'cu124', label: 'CUDA 12.4', index: 'https://download.pytorch.org/whl/cu124' };
  return { id: 'cu121', label: 'CUDA 12.1 (aggiorna il driver NVIDIA per prestazioni migliori)', index: 'https://download.pytorch.org/whl/cu121' };
}

// ---------- Installazione ----------

const STEPS = [
  ['gpu', 'Controllo della scheda video'],
  ['python', 'Python portatile'],
  ['pip', 'Gestore dei pacchetti'],
  ['torch', 'PyTorch (il motore di calcolo, circa 2,5 GB)'],
  ['deps', 'Librerie per immagini e video'],
];

export const setup = {
  status: isInstalled() ? 'done' : 'idle', // idle | running | done | error
  steps: STEPS.map(([id, label]) => ({ id, label, status: 'todo' })),
  current: null,
  detail: '',
  download: null, // { done, total } in byte
  log: [],
  error: null,
  gpu: null,
  variant: null,
};

function log(line) {
  const text = String(line).replace(/\r/g, '').trim();
  if (!text) return;
  setup.log.push(text);
  if (setup.log.length > 400) setup.log.splice(0, setup.log.length - 400);
  setup.detail = text.slice(0, 200);
}

function stepStatus(id, status) {
  const s = setup.steps.find((x) => x.id === id);
  if (s) s.status = status;
  if (status === 'running') setup.current = id;
}

export async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download non riuscito (${res.status}): ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  setup.download = { done: 0, total };
  const counter = new TransformStream({
    transform(chunk, ctrl) { setup.download.done += chunk.length; ctrl.enqueue(chunk); },
  });
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(dest));
  setup.download = null;
}

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: ROOT, windowsHide: true, ...opts });
    child.stdout.on('data', (d) => String(d).split('\n').forEach(log));
    child.stderr.on('data', (d) => String(d).split('\n').forEach(log));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} è terminato con codice ${code}`))));
  });
}

async function pip(args) {
  await exec(pythonPath(), ['-m', 'pip', ...args, '--no-warn-script-location', '--disable-pip-version-check'], {
    env: { ...process.env, PYTHONUTF8: '1', PIP_PROGRESS_BAR: 'off' },
  });
}

export async function startSetup() {
  if (setup.status === 'running') return setup;
  if (!IS_WIN) {
    setup.status = 'error';
    setup.error = 'L\'installazione automatica è per Windows. Su Linux e macOS usa ./install.sh.';
    return setup;
  }
  Object.assign(setup, { status: 'running', error: null, log: [], steps: STEPS.map(([id, label]) => ({ id, label, status: 'todo' })) });
  (async () => {
    try {
      stepStatus('gpu', 'running');
      setup.gpu = await detectGpu();
      setup.variant = torchVariant(setup.gpu);
      log(setup.gpu.vendor === 'nvidia'
        ? `Trovata ${setup.gpu.name} (${setup.gpu.vramGb} GB, driver ${setup.gpu.driver}): uso ${setup.variant.label}`
        : 'Nessuna scheda NVIDIA trovata: installo la versione per processore (funziona, ma è molto più lenta).');
      stepStatus('gpu', 'done');

      stepStatus('python', 'running');
      if (!fs.existsSync(path.join(PY_DIR, 'python.exe'))) {
        fs.mkdirSync(PY_DIR, { recursive: true });
        const zip = path.join(RUNTIME_DIR, 'python.zip');
        log(`Scarico Python ${PYTHON_VERSION}…`);
        await download(PYTHON_ZIP, zip);
        log('Estraggo Python…');
        await exec('tar', ['-xf', zip, '-C', PY_DIR]).catch(() =>
          exec('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${PY_DIR}'`]));
        fs.rmSync(zip, { force: true });
      }
      // Il Python "embeddable" ignora i pacchetti installati finché non si abilita "import site"
      for (const f of fs.readdirSync(PY_DIR).filter((x) => x.endsWith('._pth'))) {
        const file = path.join(PY_DIR, f);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^#\s*import site/m, 'import site'));
      }
      stepStatus('python', 'done');

      stepStatus('pip', 'running');
      if (!fs.existsSync(path.join(PY_DIR, 'Scripts', 'pip.exe'))) {
        const getPip = path.join(RUNTIME_DIR, 'get-pip.py');
        await download(GET_PIP, getPip);
        await exec(path.join(PY_DIR, 'python.exe'), [getPip, '--no-warn-script-location']);
        fs.rmSync(getPip, { force: true });
      }
      stepStatus('pip', 'done');

      stepStatus('torch', 'running');
      log('Scarico PyTorch: è il file più grande, può richiedere diversi minuti.');
      await pip(['install', 'torch', '--index-url', setup.variant.index]);
      stepStatus('torch', 'done');

      stepStatus('deps', 'running');
      await pip(['install', '-r', path.join(ROOT, 'worker', 'requirements.txt')]);
      stepStatus('deps', 'done');

      fs.writeFileSync(MARKER, JSON.stringify({ variant: setup.variant.id, gpu: setup.gpu, date: new Date().toISOString() }, null, 2));
      setup.status = 'done';
      setup.current = null;
      log('Motore installato. Avvio il worker…');
      startWorker();
    } catch (err) {
      setup.status = 'error';
      setup.error = err.message;
      if (setup.current) stepStatus(setup.current, 'error');
      log(`Errore: ${err.message}`);
    }
  })();
  return setup;
}

// Supporto per il cervello .gguf (llama.cpp), facoltativo
export const llmSetup = { status: 'idle', error: null };
export async function installLlmSupport() {
  if (!pythonPath()) throw new Error('Installa prima il motore.');
  if (llmSetup.status === 'running') return llmSetup;
  Object.assign(llmSetup, { status: 'running', error: null });
  const variant = JSON.parse(fs.existsSync(MARKER) ? fs.readFileSync(MARKER, 'utf8') : '{}').variant || 'cpu';
  const wheels = `https://abetlen.github.io/llama-cpp-python/whl/${variant === 'cpu' ? 'cpu' : 'cu124'}`;
  pip(['install', 'llama-cpp-python', '--prefer-binary', '--only-binary', 'llama-cpp-python', '--extra-index-url', wheels])
    .then(() => { llmSetup.status = 'done'; restartWorker(); })
    .catch((err) => Object.assign(llmSetup, { status: 'error', error: `${err.message}. In alternativa usa Ollama (Impostazioni → Cervello → Server locale).` }));
  return llmSetup;
}

// ---------- Processo del worker ----------

export const worker = { state: 'stopped', pid: null, restarts: 0, tail: [] };
let child = null;
let stopping = false;

function workerPort() {
  try {
    const u = new URL(getSettings().workerUrl);
    if (!['127.0.0.1', 'localhost'].includes(u.hostname)) return null; // worker su un altro PC: non lo gestiamo noi
    return u.port || '80';
  } catch {
    return null;
  }
}

export async function workerResponds() {
  try {
    const r = await fetch(`${getSettings().workerUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function startWorker() {
  if (child || getSettings().manageWorker === false) return;
  const port = workerPort();
  const py = pythonPath();
  if (!port || !py || !isInstalled()) return;
  if (await workerResponds()) { worker.state = 'external'; return; }
  stopping = false;
  worker.state = 'starting';
  const out = fs.createWriteStream(WORKER_LOG, { flags: 'a' });
  child = spawn(py, [path.join(ROOT, 'worker', 'server.py')], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, IDEAX_WORKER_PORT: port, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
  });
  worker.pid = child.pid;
  const onData = (d) => {
    out.write(d);
    for (const line of String(d).split('\n')) {
      const t = line.trim();
      if (!t) continue;
      worker.tail.push(t);
      if (/Uvicorn running|Application startup complete/.test(t)) worker.state = 'running';
    }
    if (worker.tail.length > 200) worker.tail.splice(0, worker.tail.length - 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', (code) => {
    child = null;
    worker.pid = null;
    out.end();
    if (stopping) { worker.state = 'stopped'; return; }
    worker.state = 'crashed';
    worker.tail.push(`Il worker si è fermato (codice ${code}).`);
    if (worker.restarts < 3) {
      worker.restarts++;
      setTimeout(startWorker, 2000);
    }
  });
}

export function stopWorker() {
  stopping = true;
  if (child) child.kill();
}

export async function restartWorker() {
  worker.restarts = 0;
  if (child) {
    const c = child;
    stopWorker();
    await new Promise((r) => { c.once('exit', r); setTimeout(r, 5000); });
  }
  await startWorker();
}
