// Cervelli pronti: alleggerire un .gguf troppo grande e scaricare cervelli veloci senza censure.
// - Alleggerire: llama-quantize (incluso in llama.cpp ufficiale) trasforma un BF16/F16 in Q4_K_M o Q8_0.
//   Stesso modello, stesse risposte (quasi), 3-4 volte più piccolo e molto più veloce.
// - Scaricare: da Hugging Face, versioni "abliterated" (senza rifiuti) in formato Q4_K_M, cercate per nome.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR, getSettings, saveSettings } from './store.js';
import { scanModels } from './scanner.js';
import * as llama from './llamaserver.js';

const LLM_DIR = path.join(MODELS_DIR, 'llm');
const HF = process.env.IDEAX_HF_BASE || 'https://huggingface.co';

export const RECOMMENDED = [
  {
    key: 'lexi-8b',
    name: 'Llama 3.1 8B Lexi · scrittura libera',
    note: 'Fatto per scrivere senza filtri: racconti, battute, testi per adulti, risposte dirette. Veloce. Circa 5 GB.',
    search: ['Llama-3.1-8B-Lexi-Uncensored-V2 GGUF', 'Lexi-Uncensored-V2 GGUF', 'Lexi Uncensored GGUF'],
    sizeGb: 5,
  },
  {
    key: 'nemo-12b',
    name: 'Mistral Nemo 12B senza censure',
    note: 'Ottimo nella scrittura creativa e in italiano, più ricco nei testi lunghi. Circa 7 GB.',
    search: ['Mistral-Nemo-Instruct-2407-abliterated GGUF', 'Mistral-Nemo abliterated GGUF'],
    sizeGb: 7,
  },
  {
    key: 'qwen3-8b',
    name: 'Qwen3 8B senza censure',
    note: 'Il più equilibrato: veloce, ottimo italiano, sa usare gli strumenti. Circa 5 GB.',
    search: ['Qwen3-8B-abliterated GGUF', 'Qwen3-8B abliterated'],
    sizeGb: 5,
  },
  {
    key: 'gemma3-12b',
    name: 'Gemma 3 12B senza censure',
    note: 'Più colto e preciso nei testi, un po\' più lento. Circa 7 GB.',
    search: ['gemma-3-12b-it-abliterated GGUF', 'gemma-3-12b abliterated'],
    sizeGb: 7,
  },
  {
    key: 'llama31-8b',
    name: 'Llama 3.1 8B senza censure',
    note: 'Alternativa collaudata, molto diffusa. Circa 5 GB.',
    search: ['Meta-Llama-3.1-8B-Instruct-abliterated GGUF'],
    sizeGb: 5,
  },
];

export const job = { status: 'idle', kind: null, name: null, step: null, done: 0, total: 0, error: null };

const hfHeaders = () => {
  const t = getSettings().hfToken;
  return { 'User-Agent': 'ideax', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
};

function begin(kind, name) {
  if (job.status === 'running') throw new Error('Sto già preparando un cervello: aspetta che finisca.');
  Object.assign(job, { status: 'running', kind, name, step: 'Preparazione', done: 0, total: 0, error: null });
}

// Il nuovo file diventa il cervello principale; quello di prima (se più grande) passa di riserva
function adopt(file, previousId) {
  const m = scanModels().find((x) => x.path === file);
  if (!m) return;
  const { brain } = getSettings();
  saveSettings({ brain: { mode: brain.mode === 'rules' ? 'auto' : brain.mode, gguf: m.id, reserve: previousId || brain.reserve || '' } });
}

// ---------- Alleggerire ----------

function findQuantize() {
  const dir = path.join(path.dirname(llama.exePath() || ''), '');
  const name = process.platform === 'win32' ? 'llama-quantize.exe' : 'llama-quantize';
  const file = path.join(dir, name);
  return fs.existsSync(file) ? file : null;
}

export function lighten(modelId, type = 'Q4_K_M') {
  const m = scanModels().find((x) => x.id === modelId && x.kind === 'llm');
  if (!m) throw new Error('Cervello non trovato');
  if (!['Q4_K_M', 'Q5_K_M', 'Q8_0'].includes(type)) throw new Error('Formato non valido');
  begin('lighten', m.name);
  (async () => {
    try {
      if (!llama.isInstalled()) { job.step = 'Scarico llama.cpp'; await llama.install(); }
      const exe = findQuantize();
      if (!exe) throw new Error('Nel pacchetto di llama.cpp manca llama-quantize: aggiorna il motore del cervello e riprova.');
      const base = path.basename(m.path, '.gguf').replace(/[-_.](bf16|f16|f32|fp16)$/i, '');
      const out = path.join(LLM_DIR, `${base}-${type}.gguf`);
      fs.mkdirSync(LLM_DIR, { recursive: true });
      llama.stop();
      job.step = `Creo la versione ${type} (qualche minuto)`;
      await new Promise((resolve, reject) => {
        const p = spawn(exe, [m.path, `${out}.part`, type], { cwd: path.dirname(exe), windowsHide: true });
        let tail = '';
        const onData = (d) => {
          const t = String(d);
          tail = (tail + t).slice(-2000);
          const prog = [...t.matchAll(/\[\s*(\d+)\/\s*(\d+)\]/g)].pop();
          if (prog) Object.assign(job, { done: Number(prog[1]), total: Number(prog[2]) });
        };
        p.stdout.on('data', onData);
        p.stderr.on('data', onData);
        p.on('error', reject);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`llama-quantize terminato con codice ${code}: ${tail.trim().split('\n').pop()}`))));
      });
      fs.renameSync(`${out}.part`, out);
      adopt(out, m.id);
      Object.assign(job, { status: 'done', step: null });
    } catch (err) {
      Object.assign(job, { status: 'error', error: err.message, step: null });
    }
  })();
  return job;
}

// ---------- Scaricare ----------

async function hfJson(url) {
  const r = await fetch(url, { headers: hfHeaders(), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Hugging Face ha risposto ${r.status}`);
  return r.json();
}

// Cerca il repository più scaricato che ha un file Q4_K_M in un pezzo solo
async function resolveFile(rec) {
  for (const q of rec.search) {
    const repos = await hfJson(`${HF}/api/models?search=${encodeURIComponent(q.replace(/ GGUF$/, ''))}&filter=gguf&sort=downloads&direction=-1&limit=12`);
    for (const r of repos) {
      const info = await hfJson(`${HF}/api/models/${r.id || r.modelId}`).catch(() => null);
      const file = info?.siblings?.map((x) => x.rfilename).find((f) => /q4_k_m\.gguf$/i.test(f) && !/-\d{5}-of-\d{5}/.test(f) && !f.includes('/'));
      if (file) return { repo: info.id || r.id, file };
    }
  }
  throw new Error('Su Hugging Face non trovo una versione Q4_K_M di questo cervello in questo momento');
}

// asWriter: diventa il cervello scrittore (testi senza filtri) invece del principale. onDone: chiamata a fine download.
export function download(key, { asWriter = false, onDone } = {}) {
  const rec = RECOMMENDED.find((r) => r.key === key);
  if (!rec) throw new Error('Cervello sconosciuto');
  begin('download', rec.name);
  job.promise = (async () => {
    try {
      job.step = 'Cerco su Hugging Face';
      const { repo, file } = await resolveFile(rec);
      const dest = path.join(LLM_DIR, file);
      fs.mkdirSync(LLM_DIR, { recursive: true });
      if (!fs.existsSync(dest)) {
        job.step = `Scarico ${file} da ${repo}`;
        const res = await fetch(`${HF}/${repo}/resolve/main/${encodeURIComponent(file)}`, { headers: hfHeaders() });
        if (!res.ok) throw new Error(`Download non riuscito (${res.status})`);
        job.total = Number(res.headers.get('content-length')) || rec.sizeGb * 1e9;
        const body = Readable.fromWeb(res.body);
        body.on('data', (c) => { job.done += c.length; });
        await pipeline(body, fs.createWriteStream(`${dest}.part`));
        fs.renameSync(`${dest}.part`, dest);
      }
      if (asWriter || key === 'lexi-8b') {
        const m = scanModels().find((x) => x.path === dest);
        if (m) saveSettings({ brain: { ...getSettings().brain, mode: getSettings().brain.mode === 'rules' ? 'auto' : getSettings().brain.mode, writer: m.id } });
      } else {
        const { primary } = (await import('./brain.js')).brainPair(scanModels());
        adopt(dest, primary && primary.path !== dest && (primary.size || 0) > 8e9 ? primary.id : null);
      }
      Object.assign(job, { status: 'done', step: null, repo, file });
      await onDone?.(null);
    } catch (err) {
      Object.assign(job, { status: 'error', error: err.message, step: null });
      await onDone?.(err);
    }
  })();
  return job;
}
