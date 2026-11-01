// Sistemi collegati: i tuoi programmi online (IDEAlab, billpro…) non possono chiamare il PC,
// quindi è ideax che va da loro a prendere il lavoro. Nessuna porta aperta, nessun tunnel:
// il PC esce verso internet come fa il browser.
//
// Il patto (docs/ponte-ideax.md):
//   GET  {url}{percorso}/lavori?attendi=25&capacita=…   intestazione x-ideax-key
//        → { lavori: [{ id, tipo, dati }] }              (i lavori restituiti sono già presi da ideax)
//   POST {url}{percorso}/lavori/{id}                      { ok: true, risultato } oppure { ok: false, errore }
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, saveSettings, VERSION, OUTPUT_DIR } from './store.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog } from './router.js';
import * as engines from './engines.js';
import * as laser from './laser.js';

let host = { createJob: null, chat: null };
export function configure(fns) { host = { ...host, ...fns }; }

const DEFAULT_PATH = '/api/ponte/ideax';
const states = {};
const loops = {};

const mask = (k) => (k ? `••••${k.slice(-4)}` : '');

export function listSystems({ withSecrets = false } = {}) {
  return (getSettings().systems || []).map((s) => ({
    ...s,
    key: withSecrets ? s.key : mask(s.key),
    state: states[s.id] || { status: s.enabled === false ? 'spento' : 'in attesa' },
  }));
}

export function saveSystem(input) {
  const list = getSettings().systems || [];
  const old = list.find((s) => s.id === input.id);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Dai un nome al sistema (es. IDEAlab)');
  let url = String(input.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Indirizzo non valido: deve iniziare con https://');
  const s = {
    id: old?.id || crypto.randomUUID().slice(0, 8),
    name,
    url,
    path: String(input.path || old?.path || DEFAULT_PATH).trim() || DEFAULT_PATH,
    key: input.key && !String(input.key).startsWith('••••') ? String(input.key).trim() : old?.key || '',
    enabled: input.enabled !== false,
  };
  if (!s.key) throw new Error('Serve la chiave che il sistema si aspetta da ideax');
  saveSettings({ systems: [...list.filter((x) => x.id !== s.id), s] });
  restart(s.id);
  return listSystems().find((x) => x.id === s.id);
}

// "Crea ponte": basta l'indirizzo. ideax sceglie il nome, genera la chiave e si mette in ascolto da solo;
// all'utente resta solo da incollare la chiave nei Secrets dell'app (IDEAX_KEY) e ripubblicarla.
const KNOWN = [[/private-ai-hub|jarvis/i, 'Jarvis'], [/idealab/i, 'IDEAlab'], [/billpro|bill-so/i, 'Bill'], [/ideaeventi/i, 'IDEAeventi']];

export function createBridge(input) {
  let url = String(input.url || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Scrivi l\'indirizzo dell\'app (es. idealab.replit.app)');
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  let host;
  try { host = new URL(url).hostname; } catch { throw new Error('Indirizzo non valido'); }
  url = new URL(url).origin;
  const list = getSettings().systems || [];
  const sameHost = (u) => { try { return new URL(u).host === new URL(url).host; } catch { return false; } };
  const old = list.find((x) => sameHost(x.url));
  if (old) { if (old.enabled === false) saveSystem({ ...old, enabled: true }); return { id: old.id, name: old.name, url: old.url, key: old.key, secret: 'IDEAX_KEY', existing: true }; }
  const label = host.split('.')[0];
  const name = KNOWN.find(([re]) => re.test(host))?.[1] || (/^[\d.]+$|^localhost$/.test(host) ? 'App locale' : label.charAt(0).toUpperCase() + label.slice(1));
  const key = `ix_${crypto.randomBytes(24).toString('base64url')}`;
  const s = saveSystem({ name, url, key });
  return { id: s.id, name, url, key, secret: 'IDEAX_KEY' };
}

export function systemKey(id) {
  const s = (getSettings().systems || []).find((x) => x.id === id);
  if (!s) throw new Error('Sistema non trovato');
  return { key: s.key, secret: 'IDEAX_KEY' };
}

export function deleteSystem(id) {
  saveSettings({ systems: (getSettings().systems || []).filter((s) => s.id !== id) });
  delete loops[id];
  delete states[id];
}

// Cosa sa fare ideax adesso: i sistemi mandano solo i lavori che può svolgere
export function capabilities() {
  const caps = ['genera', 'decorazione', 'vettorizza'];
  if (resolveBrain(buildCatalog().all).mode !== 'rules') caps.push('json', 'chat');
  if (engines.isInstalled('music')) caps.push('musica');
  if (engines.isInstalled('voice')) caps.push('voce', 'reel');
  return caps;
}

async function request(sys, pathname, { method = 'GET', body, timeout = 40_000 } = {}) {
  const res = await fetch(`${sys.url}${sys.path || DEFAULT_PATH}${pathname}`, {
    method,
    headers: {
      'x-ideax-key': sys.key,
      'x-ideax-versione': VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('chiave non ancora attiva nell\'app: incollala nei Secrets come IDEAX_KEY e ripubblica'), { waitingKey: true });
  if (res.status === 503 && /configurat|chiave|key/i.test(String(data.error || ''))) throw Object.assign(new Error('nell\'app manca ancora IDEAX_KEY: incolla la chiave nei Secrets e ripubblica'), { waitingKey: true });
  if (res.status === 404) throw new Error('il sistema non ha ancora il ponte per ideax (404)');
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- I lavori ----------

const fileB64 = (url) => fs.readFileSync(path.join(OUTPUT_DIR, path.basename(url))).toString('base64');

async function runMedia(body, sys) {
  const job = await host.createJob({ ...body, metadata: { ...(body.metadata || {}), sistema: sys.name } }, { client: sys.name });
  await job.done;
  if (job.status !== 'done') throw new Error(job.error || 'lavoro non riuscito');
  return {
    titolo: job.title, modello: job.modelName, prompt: job.routedPrompt,
    risultati: job.results.map((r) => ({ tipo: r.type, base64: fileB64(r.url), secondi: r.seconds })),
  };
}

const HANDLERS = {
  // Risposta strutturata dal cervello locale (es. le bozze di Mathis): { sistema, richiesta, schema, temperatura, maxToken }
  async json(d) {
    // Le risposte strutturate per gli altri sistemi (es. le bozze di Mathis) le fa il cervello di riserva, se c'è
    const brain = resolveBrain(buildCatalog().all, { heavy: true });
    if (brain.mode === 'rules') throw new Error('ideax non ha un cervello caricato');
    return chatBrain(brain, [{ role: 'system', content: String(d.sistema || '') }, { role: 'user', content: String(d.richiesta || '') }],
      d.schema || { type: 'object' }, { temperature: Number(d.temperatura ?? 0.5), maxTokens: Math.min(8000, Number(d.maxToken) || 4000), timeout: 600_000 });
  },
  async chat(d, sys) { return host.chat(d, sys); },
  genera: (d, sys) => runMedia(d, sys),
  musica: (d, sys) => runMedia({ prompt: d.prompt, kind: 'music', music: d }, sys),
  voce: (d, sys) => runMedia({ prompt: d.testo || d.prompt, kind: 'speech', speech: d }, sys),
  reel: (d, sys) => runMedia({ prompt: d.prompt || d.argomento || 'reel', kind: 'reel', reel: d }, sys),
  decorazione: (d, sys) => laser.decoration(d, { createJob: host.createJob, ctx: { client: sys.name } }),
  vettorizza: (d) => laser.vectorize(d),
};

async function handle(sys, lavoro, st) {
  st.current = `${lavoro.tipo} #${lavoro.id}`;
  const started = Date.now();
  let body;
  try {
    const fn = HANDLERS[lavoro.tipo];
    if (!fn) throw new Error(`ideax non sa fare "${lavoro.tipo}"`);
    body = { ok: true, risultato: await fn(lavoro.dati || {}, sys), secondi: Math.round((Date.now() - started) / 1000) };
    st.done = (st.done || 0) + 1;
  } catch (err) {
    body = { ok: false, errore: String(err.message || err).slice(0, 500) };
    st.failed = (st.failed || 0) + 1;
    st.lastJobError = `${lavoro.tipo}: ${body.errore}`;
  }
  st.current = null;
  st.history = [{ id: lavoro.id, tipo: lavoro.tipo, ok: body.ok, secondi: Math.round((Date.now() - started) / 1000), t: Date.now() }, ...(st.history || [])].slice(0, 10);
  // Il risultato deve arrivare: qualche tentativo se la rete balla
  for (let i = 0; i < 4; i++) {
    try {
      await request(sys, `/lavori/${encodeURIComponent(lavoro.id)}`, { method: 'POST', body, timeout: 120_000 });
      return;
    } catch (err) {
      if (/chiave|404/.test(err.message)) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}

async function loop(id, token) {
  let backoff = 5000;
  while (loops[id] === token) {
    const sys = (getSettings().systems || []).find((s) => s.id === id);
    if (!sys || sys.enabled === false) { states[id] = { ...(states[id] || {}), status: 'spento' }; return; }
    const st = (states[id] ||= {});
    try {
      const data = await request(sys, `/lavori?attendi=25&capacita=${capabilities().join(',')}`);
      Object.assign(st, { status: 'online', lastContact: Date.now(), error: null });
      backoff = 5000;
      for (const lavoro of data.lavori || []) {
        if (loops[id] !== token) return;
        await handle(sys, lavoro, st);
      }
    } catch (err) {
      Object.assign(st, { status: err.waitingKey ? 'attesa chiave' : 'errore', error: err.name === 'TimeoutError' ? 'il sistema non risponde' : /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(err.message + (err.cause?.code || '')) ? 'non trovo l\'app a questo indirizzo: controlla che sia giusto e che l\'app sia pubblicata' : err.message, lastTry: Date.now() });
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  }
}

export function restart(id) {
  const token = Symbol(id);
  loops[id] = token;
  states[id] = { ...(states[id] || {}), status: 'in collegamento' };
  loop(id, token);
}

export function startAll() {
  for (const s of getSettings().systems || []) if (s.enabled !== false) restart(s.id);
}

export async function test(id) {
  const sys = (getSettings().systems || []).find((s) => s.id === id);
  if (!sys) throw new Error('Sistema non trovato');
  // attendi=0 e capacita vuota: solo una prova di collegamento, nessun lavoro preso
  await request(sys, '/lavori?attendi=0&capacita=', { timeout: 15_000 });
  return { ok: true };
}
