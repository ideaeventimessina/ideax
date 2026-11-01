// Scarica un repository di Hugging Face in una cartella normale, senza la cache della libreria Python
// (su Windows quella cache può fallire con nomi di file non validi). Riprende i file interrotti e salta quelli completi.
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getSettings } from './store.js';

const HF = process.env.IDEAX_HF_BASE || 'https://huggingface.co';

function headers(extra = {}) {
  const t = getSettings().hfToken;
  return { 'User-Agent': 'ideax', ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra };
}

function denied(status, repo) {
  if (status === 401) return new Error('Token di Hugging Face mancante o non valido (Impostazioni → Hugging Face).');
  if (status === 403) return new Error(`Hugging Face non dà accesso a ${repo}: accetta la licenza su huggingface.co/${repo} con lo stesso account del token (Impostazioni → Hugging Face → Verifica).`);
  return new Error(`Hugging Face ha risposto ${status}`);
}

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^]*').replace(/\?/g, '.')}$`);

// patterns: come allow_patterns di Hugging Face ("*.json", "transformer/*"…). onProgress({ file, done, total })
export async function snapshot(repo, dest, patterns, { onProgress, log = () => {} } = {}) {
  const info = await fetch(`${HF}/api/models/${repo}?blobs=true`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!info.ok) throw denied(info.status, repo);
  const res = patterns.map(glob);
  const files = ((await info.json()).siblings || []).filter((s) => res.some((r) => r.test(s.rfilename)));
  if (!files.length) throw new Error(`Nel repository ${repo} non trovo i file da scaricare`);
  const total = files.reduce((n, f) => n + (f.size || f.lfs?.size || 0), 0);
  let done = 0;
  for (const f of files) {
    const size = f.size || f.lfs?.size || 0;
    const out = path.join(dest, ...f.rfilename.split('/'));
    if (fs.existsSync(out) && (!size || fs.statSync(out).size === size)) { done += size; continue; }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const part = `${out}.part`;
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    log(`Scarico ${f.rfilename}${have ? ' (riprendo)' : ''}`);
    const r = await fetch(`${HF}/${repo}/resolve/main/${f.rfilename.split('/').map(encodeURIComponent).join('/')}`, { headers: headers(have ? { Range: `bytes=${have}-` } : {}) });
    if (!r.ok) throw denied(r.status, repo);
    const append = have && r.status === 206;
    done += append ? have : 0;
    const body = Readable.fromWeb(r.body);
    body.on('data', (c) => { done += c.length; onProgress?.({ file: f.rfilename, done, total }); });
    await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
    if (size && fs.statSync(part).size !== size) throw new Error(`Download di ${f.rfilename} incompleto: riprova (riparte da dove si è fermato)`);
    fs.renameSync(part, out);
  }
  onProgress?.({ file: null, done: total, total });
  return { files: files.length, total };
}

// Mette un repository nella cache di Hugging Face nel formato che la libreria Python legge anche offline
// (hub/models--org--nome/refs/main + snapshots/<commit>/…): così un programma che chiede il modello per nome
// lo trova già pronto, senza scaricarlo con la sua cache.
export async function intoCache(repo, hubDir, patterns, opts = {}) {
  const info = await fetch(`${HF}/api/models/${repo}`, { headers: headers(), signal: AbortSignal.timeout(30_000) });
  if (!info.ok) throw denied(info.status, repo);
  const { sha } = await info.json();
  const base = path.join(hubDir, `models--${repo.replace('/', '--')}`);
  await snapshot(repo, path.join(base, 'snapshots', sha), patterns, opts);
  fs.mkdirSync(path.join(base, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(base, 'refs', 'main'), sha);
}
