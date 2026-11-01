// Il cervello .gguf gira con llama.cpp ufficiale (llama-server): ideax lo scarica da solo dalle release
// di GitHub, nella versione per schede NVIDIA (CUDA 12) o, se il driver è vecchio, Vulkan.
// Più robusto del pacchetto Python (niente compilazioni su Windows) e sempre aggiornato ai modelli nuovi (es. Qwen3).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ROOT, DATA_DIR } from './store.js';
import { detectGpu } from './runtime.js';

const IS_WIN = process.platform === 'win32';
const DIR = path.join(ROOT, 'runtime', 'llama');
const PORT = Number(process.env.IDEAX_LLM_PORT) || 7880;
const CTX = Number(process.env.IDEAX_LLM_CTX) || 16384;
const IDLE_MS = 20 * 60 * 1000;

export const llm = { status: 'idle', step: '', error: null, version: null, model: null, log: [] };
let proc = null;
let installing = null;
let idleTimer = null;

function log(line) {
  const l = String(line).trim();
  if (!l) return;
  llm.log.push(l);
  if (llm.log.length > 200) llm.log.splice(0, llm.log.length - 200);
}

function findExe(dir) {
  const name = IS_WIN ? 'llama-server.exe' : 'llama-server';
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return full;
    if (e.isDirectory()) {
      const found = findExe(full);
      if (found) return found;
    }
  }
  return null;
}

export const isInstalled = () => !!findExe(DIR);
export const exePath = () => findExe(DIR);

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${cmd} terminato con codice ${code}`))));
  });
}

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'ideax' } });
  if (!res.ok) throw new Error(`Download non riuscito (${res.status}): ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

// Quali file scaricare dalla release: CUDA 12 (+ librerie CUDA) se c'è una NVIDIA con driver adatto, altrimenti Vulkan o CPU
export function pickAssets(assets, gpu) {
  const find = (re) => assets.find((a) => re.test(a.name));
  if (IS_WIN) {
    const driver = Number(String(gpu.driver || '').split('.')[0]) || 0;
    if (gpu.vendor === 'nvidia' && driver >= 551) {
      // CUDA 12 va con i driver dal 551; CUDA 13 solo dal 580
      const main = find(/^llama-.*win-cuda-?12[\d.]*-x64\.zip$/i) || (driver >= 580 ? find(/^llama-.*win-cuda.*x64\.zip$/i) : null);
      if (main) {
        const ver = (main.name.match(/cuda-?([\d.]+)-x64/i) || [])[1] || '';
        const cudart = assets.find((a) => /^cudart-/i.test(a.name) && a.name.includes(`cuda-${ver}-x64`)) || find(/^cudart-.*win-cuda.*x64\.zip$/i);
        const cpu = find(/^llama-.*win-cpu-x64\.zip$/i);
        return { kind: `CUDA ${ver}`, files: [main, cudart, cpu].filter(Boolean) };
      }
    }
    const vulkan = find(/^llama-.*win-vulkan-x64\.zip$/i);
    if (vulkan) return { kind: 'Vulkan', files: [vulkan, find(/^llama-.*win-cpu-x64\.zip$/i)].filter(Boolean) };
    const cpu = find(/^llama-.*win-cpu-x64\.zip$/i);
    if (cpu) return { kind: 'CPU', files: [cpu] };
  } else if (process.platform === 'darwin') {
    const mac = find(process.arch === 'arm64' ? /^llama-.*bin-macos-arm64\.(zip|tar\.gz)$/ : /^llama-.*bin-macos-x64\.(zip|tar\.gz)$/);
    if (mac) return { kind: 'Metal', files: [mac] };
  } else {
    const linux = find(/^llama-.*bin-ubuntu-x64\.(zip|tar\.gz)$/);
    if (linux) return { kind: 'Linux', files: [linux] };
  }
  throw new Error('Nella release di llama.cpp non trovo un pacchetto adatto a questo PC');
}

export function install() {
  if (installing) return installing;
  installing = (async () => {
    Object.assign(llm, { status: 'installing', step: 'Cerco l\'ultima versione di llama.cpp', error: null });
    try {
      // Non tutte le release hanno i programmi pronti (alcune sono solo codice): si prende la più recente che li ha
      const res = await fetch(process.env.IDEAX_LLAMA_RELEASES || 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=40', { headers: { 'User-Agent': 'ideax', Accept: 'application/vnd.github+json' } });
      if (!res.ok) throw new Error(`GitHub non risponde (${res.status})`);
      const releases = (await res.json()).filter((r) => !r.draft);
      const gpu = await detectGpu();
      let rel = null;
      let picked = null;
      for (const r of releases) {
        try { picked = pickAssets(r.assets || [], gpu); rel = r; break; } catch {}
      }
      if (!picked) {
        const names = (releases[0]?.assets || []).map((x) => x.name).slice(0, 12).join(', ');
        throw new Error(`Nelle ultime release di llama.cpp non trovo un pacchetto per questo PC${names ? ` (file trovati: ${names})` : ''}`);
      }
      const { kind, files } = picked;
      const tmp = path.join(ROOT, 'runtime', 'llama-new');
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      // L'eseguibile completo va scompattato per ultimo: i pacchetti aggiuntivi (librerie) finiscono nella stessa cartella
      for (const f of [...files].reverse()) {
        llm.step = `Scarico ${f.name} (${Math.round(f.size / 1e6)} MB)`;
        log(llm.step);
        const archive = path.join(tmp, f.name);
        await download(f.browser_download_url, archive);
        await run('tar', ['-xf', archive, '-C', tmp]);
        fs.rmSync(archive, { force: true });
      }
      const exe = findExe(tmp);
      if (!exe) throw new Error('Nel pacchetto scaricato non c\'è llama-server');
      // Le librerie CUDA devono stare accanto all'eseguibile
      const exeDir = path.dirname(exe);
      for (const e of fs.readdirSync(tmp)) {
        const full = path.join(tmp, e);
        if (fs.statSync(full).isFile() && path.dirname(full) !== exeDir) fs.renameSync(full, path.join(exeDir, e));
      }
      if (!IS_WIN) fs.chmodSync(exe, 0o755);
      stop();
      fs.rmSync(DIR, { recursive: true, force: true });
      fs.renameSync(tmp, DIR);
      fs.writeFileSync(path.join(DIR, 'versione.json'), JSON.stringify({ tag: rel.tag_name, kind, date: new Date().toISOString() }, null, 2));
      Object.assign(llm, { status: 'ready', step: '', version: `${rel.tag_name} · ${kind}` });
      log(`Installato llama.cpp ${rel.tag_name} (${kind})`);
    } catch (err) {
      Object.assign(llm, { status: 'error', step: '', error: err.message });
      log(`Errore: ${err.message}`);
      throw err;
    } finally {
      installing = null;
    }
  })();
  return installing;
}

async function healthy() {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// Perché il cervello non è partito, detto in modo utile
function startFailure(modelPath) {
  const tail = llm.log.slice(-60).join('\n');
  const name = path.basename(modelPath);
  if (/unknown model architecture|unknown architecture|unsupported model/i.test(tail)) return `Il motore del cervello non conosce ancora il modello ${name}: usane un altro (Cervello → I cervelli) oppure aggiorna il motore.`;
  if (/out of memory|failed to allocate|cudaMalloc|not enough memory|ErrorOutOfDeviceMemory/i.test(tail)) return `${name} non ci sta in memoria: alleggeriscilo in Q4_K_M (Cervello → I cervelli) o scegline uno più piccolo.`;
  const err = llm.log.filter((l) => /error|errore|failed|exception|abort/i.test(l)).slice(-2).join(' · ');
  return `Il cervello ${name} non è partito${err ? `: ${err.slice(0, 300)}` : ' (guarda data/cervello.log)'}`;
}

export function stop() {
  clearTimeout(idleTimer);
  if (proc) {
    try { proc.kill(); } catch {}
    proc = null;
  }
  llm.model = null;
  if (llm.status === 'running' || llm.status === 'loading') llm.status = 'ready';
}

// Accende llama-server con il modello chiesto (se è già acceso con un altro, lo riavvia)
// mmproj: il file della vista dei modelli VL (Qwen3-VL…): con quello il cervello vede le immagini
export async function ensure(modelPath, { mmproj = null } = {}) {
  if (!isInstalled()) await install();
  if (proc && llm.model === modelPath && (llm.mmproj || null) === (mmproj || null) && (await healthy())) return touch();
  stop();
  const exe = findExe(DIR);
  llm.status = 'loading';
  llm.step = `Carico ${path.basename(modelPath)}`;
  const out = fs.createWriteStream(path.join(DATA_DIR, 'cervello.log'), { flags: 'a' });
  proc = spawn(exe, ['-m', modelPath, ...(mmproj ? ['--mmproj', mmproj] : []), '--host', '127.0.0.1', '--port', String(PORT), '-c', String(CTX), '-ngl', 'auto'], { cwd: path.dirname(exe), windowsHide: true });
  const child = proc;
  llm.model = modelPath;
  llm.mmproj = mmproj || null;
  const onData = (d) => { out.write(d); String(d).split('\n').forEach(log); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('error', (err) => { log(`Avvio non riuscito: ${err.message}`); });
  child.on('exit', (code) => {
    out.end();
    if (proc === child) { proc = null; llm.model = null; llm.status = 'ready'; }
    if (code) log(`Il cervello si è fermato (codice ${code})`);
  });
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    if (proc !== child) throw new Error(startFailure(modelPath));
    if (await healthy()) {
      llm.status = 'running';
      llm.step = '';
      return touch();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop();
  throw new Error('Il cervello ci mette troppo a partire: guarda il registro in Impostazioni');
}

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { log('Inattivo da 20 minuti: libero la scheda video.'); stop(); }, IDLE_MS);
  idleTimer.unref?.();
}

export async function chat(modelPath, messages, schema, { temperature = 0.2, maxTokens = 1024, timeout = 300_000, mmproj } = {}) {
  // Se il cervello è già acceso con la vista, la si tiene (non serve riavviarlo per un messaggio di solo testo)
  await ensure(modelPath, { mmproj: mmproj ?? (llm.model === modelPath ? llm.mmproj : null) });
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages,
      temperature,
      max_tokens: maxTokens,
      // llama-server accetta lo schema sia nel formato della sua documentazione sia in quello di OpenAI
      ...(schema ? { response_format: { type: 'json_schema', schema, json_schema: { name: 'risposta', schema } } } : {}),
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.json().catch(() => ({}));
  touch();
  if (!res.ok) throw new Error(body.error?.message || `cervello HTTP ${res.status}`);
  return body.choices?.[0]?.message?.content || '';
}

// Stato iniziale: se è già installato lo diciamo subito
try {
  const v = JSON.parse(fs.readFileSync(path.join(DIR, 'versione.json'), 'utf8'));
  Object.assign(llm, { status: 'ready', version: `${v.tag} · ${v.kind}` });
} catch {}
