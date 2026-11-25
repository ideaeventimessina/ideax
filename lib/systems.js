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
import * as sveglia from './sveglia.js';

let host = { createJob: null, chat: null };
export function configure(fns) { host = { ...host, ...fns }; }

const DEFAULT_PATH = '/api/ponte/ideax';
const states = {};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  delete states[id];
  risottoscrivi();
}

// Cosa sa fare ideax adesso: i sistemi mandano solo i lavori che può svolgere
export function capabilities() {
  const caps = ['genera', 'decorazione', 'vettorizza'];
  if (resolveBrain(buildCatalog().all).mode !== 'rules') caps.push('json', 'chat');
  if (engines.isInstalled('music')) caps.push('musica');
  if (engines.isInstalled('voice')) caps.push('voce', 'reel');
  // Video da foto o da testo (Wan su ComfyUI): si offre solo se il motore video c'è davvero, così chi chiede
  // (es. Bill) prova ideax soltanto quando può riuscire, altrimenti usa subito il suo fornitore di sempre.
  if (engines.isInstalled('comfyui') && (engines.isInstalled('wan') || engines.isInstalled('wan14b'))) caps.push('video');
  if (engines.isInstalled('comfyui') && (engines.isInstalled('qwenedit') || engines.isInstalled('kontext'))) caps.push('fotomontaggio');
  caps.push('scontorna', 'trascrivi');
  if (engines.isInstalled('upscale')) caps.push('ingrandisci');
  if (engines.isInstalled('voice') && engines.isInstalled('lipsync')) caps.push('personaggio');
  try { if (visionAvailable()) caps.push('vista'); } catch { /* il catalogo non è pronto: niente vista per ora */ }
  return caps;
}

async function request(sys, pathname, { method = 'GET', body, timeout = 40_000 } = {}) {
  const res = await fetch(`${sys.url}${sys.path || DEFAULT_PATH}${pathname}`, {
    method,
    headers: {
      'x-ideax-key': sys.key,
      'x-ideax-versione': VERSION,
      ...(_vramGb ? { 'x-ideax-vram': String(_vramGb) } : {}), // così il capofila manda i lavori pesanti alle schede grosse
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('l\'app rifiuta la chiave: il secret IDEAX_KEY dell\'app non è uguale alla chiave di questa riga (premi Chiave, ricopiala nei Secrets e ripubblica)'), { waitingKey: true });
  if (res.status === 503 && /configurat|chiave|key/i.test(String(data.error || ''))) throw Object.assign(new Error('l\'app ha il ponte ma non la chiave: aggiungi IDEAX_KEY nei Secrets dell\'app (premi Chiave per copiarla) e ripubblica'), { waitingKey: true });
  if (res.status === 404) throw Object.assign(new Error('l\'app pubblicata non ha ancora il ponte: il codice nuovo è su GitHub ma non nella versione online. Su Replit apri Git → Pull, poi Republish'), { waitingKey: true });
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
    secondi: job.startedAt && job.finishedAt ? Math.round((job.finishedAt - job.startedAt) / 100) / 10 : null,
    risultati: job.results.map((r) => ({ tipo: r.type, base64: fileB64(r.url), secondi: r.seconds })),
  };
}

// La vista c'è se è installato un cervello VL (Qwen3-VL, Gemma 3…): lo dice vision.js
let visionAvailable = () => false;
import('./vision.js').then((v) => { visionAvailable = () => !!v.visionModel(); }).catch(() => {});

// La VRAM di QUESTA scheda, calcolata una volta: l'operaio la dichiara al capofila (header x-ideax-vram) perché possa
// mandargli i lavori che la sua scheda regge. 0 = sconosciuta (non NVIDIA, o nvidia-smi assente): il capofila non blocca.
let _vramGb = 0;
import('./runtime.js').then((r) => r.detectGpu()).then((g) => { _vramGb = g?.vendor === 'nvidia' ? (g.vramGb || 0) : 0; }).catch(() => {});

// Un'immagine che arriva da un altro sistema: data URL oppure base64 nudo (si riconosce dai primi byte)
function toAttachment(x, i) {
  const v = String(x || '');
  if (v.startsWith('data:')) return { name: `immagine-${i + 1}`, dataUrl: v };
  const head = Buffer.from(v.slice(0, 16), 'base64');
  const type = head[0] === 0x89 ? 'image/png' : head[0] === 0xff ? 'image/jpeg' : head.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : 'image/png';
  return { name: `immagine-${i + 1}`, type, dataUrl: `data:${type};base64,${v}` };
}

// Fotomontaggio: { foto, immagini?: [stile, …], prompt, motore?: "qwen" | "kontext", negativo?, seme?, veloce? }
async function fotomontaggio(d, sys) {
  if (!d.foto) throw new Error('Manca la foto da trasformare');
  if (!String(d.prompt || '').trim()) throw new Error('Manca il prompt del fotomontaggio');
  const model = d.motore === 'kontext' ? 'engine-kontext' : d.motore === 'qwen' ? 'engine-qwenedit' : null;
  const need = d.motore === 'kontext' ? 'kontext' : d.motore === 'qwen' ? 'qwenedit' : null;
  if (need && !engines.isInstalled(need)) throw new Error(`Il motore "${engines.CATALOG[need].name}" non è installato su ideax (Modelli → Motori)`);
  const params = {
    ...(d.negativo ? { negative_prompt: String(d.negativo) } : {}),
    ...(d.seme != null ? { seed: Number(d.seme) } : {}),
    ...(d.veloce === false ? { lightning: false } : {}),
    face_fix: false, skin_fix: false, // la foto vera resta la base: niente ritocchi sopra
  };
  return runMedia({ prompt: String(d.prompt), task: 'image_edit', model, params, attachments: [d.foto, ...(d.immagini || [])].slice(0, 3).map(toAttachment) }, sys);
}

// Scontorno con BiRefNet sul worker: { foto } → PNG trasparente
async function scontorna(d) {
  if (!d.foto) throw new Error('Manca la foto da scontornare');
  const res = await fetch(`${getSettings().workerUrl}/scontorna`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: toAttachment(d.foto, 0).dataUrl }), signal: AbortSignal.timeout(300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Scontorno non riuscito (HTTP ${res.status})`);
  return { secondi: data.seconds, risultati: data.outputs.map((o) => ({ tipo: o.type, base64: o.data })) };
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
  // Video: { prompt, foto?, formato?, secondi? }. Con una foto è "anima questa foto" (Wan image→video),
  // senza è testo→video. Torna un MP4 in base64, come gli altri media. Il motore Wan deve essere installato
  // (lo garantisce la capacità "video"); se manca, runMedia fallisce e chi ha chiesto usa la sua riserva.
  video: (d, sys) => runMedia({
    prompt: String(d.prompt || ''),
    task: d.foto ? 'image_to_video' : 'video_generate',
    params: {
      ...(d.formato ? { aspect: d.formato } : {}),
      ...(d.secondi ? { seconds: Number(d.secondi) } : {}),
      ...(d.veloce === true ? { veloce: true } : {}),
    },
    attachments: d.foto ? [toAttachment(d.foto, 0)] : [],
  }, sys),
  musica: (d, sys) => runMedia({ prompt: d.prompt, kind: 'music', music: d }, sys),
  voce: (d, sys) => runMedia({ prompt: d.testo || d.prompt, kind: 'speech', speech: d }, sys),
  reel: (d, sys) => runMedia({ prompt: d.prompt || d.argomento || 'reel', kind: 'reel', reel: d }, sys),
  decorazione: (d, sys) => laser.decoration(d, { createJob: host.createJob, ctx: { client: sys.name } }),
  vettorizza: (d) => laser.vectorize(d),
  fotomontaggio,
  scontorna,
  // Trascrizione: { audio } → { testo, pezzi }
  async trascrivi(d) { return (await import('./transcribe.js')).transcribe(toAttachment(d.audio, 0).dataUrl.replace(/^data:image\/png/, 'data:application/octet-stream'), { lingua: d.lingua, tempi: d.tempi !== false }); },
  // Vista: { immagini: [..], domanda, schema? } → risposta (o JSON con lo schema)
  async vista(d) { return (await import('./vision.js')).look((d.immagini || [d.immagine]).filter(Boolean).map((x, i) => toAttachment(x, i).dataUrl), d.domanda, { schema: d.schema || null }); },
  // Ingrandimento 4×: { foto } → immagine
  ingrandisci: (d, sys) => runMedia({ prompt: 'ingrandisci', task: 'image_upscale', model: 'engine-upscale', attachments: [toAttachment(d.foto, 0)] }, sys),
  // Personaggio parlante: { testo, descrizione?, foto?, voce, formato? } → video
  personaggio: (d, sys) => runMedia({ prompt: d.testo, kind: 'personaggio', personaggio: { descrizione: d.descrizione, voce: d.voce, lingua: d.lingua, formato: d.formato }, attachments: d.foto ? [toAttachment(d.foto, 0)] : [] }, sys),
};

async function handle(sys, lavoro, st) {
  // "rif": da dove nasce il lavoro — es. "preventivo-42/riga-7". Lo manda il sistema che chiede (idealab); ideax lo
  // mostra tale e quale, così a ogni lavoro si LEGGE per cosa è, invece di fidarsi. Non lo inventa: se non arriva, è
  // vuoto, e questo stesso vuoto dice che quel sistema non lo sta ancora mandando.
  const rif = typeof lavoro.rif === 'string' && lavoro.rif ? lavoro.rif.slice(0, 120) : null;
  st.current = `${lavoro.tipo} #${lavoro.id}${rif ? ` · ${rif}` : ''}`;
  const started = Date.now();
  let body;
  try {
    const fn = HANDLERS[lavoro.tipo];
    if (!fn) throw new Error(`ideax non sa fare "${lavoro.tipo}"`);
    body = { ok: true, risultato: await fn(lavoro.dati || {}, sys), secondi: Math.round((Date.now() - started) / 1000) };
    st.done = (st.done || 0) + 1;
    console.log(`[ponte] ${sys.nome || sys.id}: ${lavoro.tipo}${rif ? ` per ${rif}` : ''} → fatto in ${Math.round((Date.now() - started) / 1000)}s`);
  } catch (err) {
    body = { ok: false, errore: String(err.message || err).slice(0, 500) };
    st.failed = (st.failed || 0) + 1;
    st.lastJobError = `${lavoro.tipo}${rif ? ` (${rif})` : ''}: ${body.errore}`;
    console.log(`[ponte] ${sys.nome || sys.id}: ${lavoro.tipo}${rif ? ` per ${rif}` : ''} → errore: ${body.errore}`);
  }
  st.current = null;
  st.history = [{ id: lavoro.id, tipo: lavoro.tipo, rif, ok: body.ok, secondi: Math.round((Date.now() - started) / 1000), t: Date.now() }, ...(st.history || [])].slice(0, 10);
  // Il risultato deve arrivare: qualche tentativo se la rete balla
  let deliveryError;
  for (let i = 0; i < 4; i++) {
    try {
      await request(sys, `/lavori/${encodeURIComponent(lavoro.id)}`, { method: 'POST', body, timeout: 120_000 });
      st.lastDeliveryError = null;
      return;
    } catch (err) {
      deliveryError = err;
      if (err.waitingKey) break;
      if (i < 3) await wait(2000 * (i + 1));
    }
  }
  st.lastDeliveryError = { id: lavoro.id, error: String(deliveryError.message || deliveryError) };
  if (deliveryError.waitingKey) throw deliveryError;
}

// ---------- Sveglia push: a riposo NESSUNA richiesta alle app. Si "drena" un'app solo quando arriva la sua sveglia
// (l'app pubblica su ntfy quando ha un lavoro) oppure all'accensione di ideax. Finito il lavoro, si torna in silenzio.
const draining = {};
const pending = {};

// Svolge TUTTI i lavori in coda su un'app con richieste attendi=0 (ritorno immediato dal server: niente long-poll,
// niente ciclo di interrogazioni sul database). Si ferma quando la coda è vuota. Un drain per app alla volta; una
// sveglia arrivata mentre si drena fa ripartire un giro (così non resta nulla in coda).
async function drena(id) {
  if (draining[id]) { pending[id] = true; return; }
  draining[id] = true;
  try {
    for (;;) {
      const sys = (getSettings().systems || []).find((s) => s.id === id);
      if (!sys || sys.enabled === false) { states[id] = { ...(states[id] || {}), status: 'spento' }; break; }
      const st = (states[id] ||= {});
      let jobs;
      try {
        const data = await request(sys, `/lavori?attendi=0&capacita=${capabilities().join(',')}`);
        Object.assign(st, { status: 'online', lastContact: Date.now(), error: null });
        jobs = data.lavori || [];
      } catch (err) {
        Object.assign(st, { status: err.waitingKey ? 'attesa chiave' : 'errore', error: err.name === 'TimeoutError' ? 'il sistema non risponde' : /fetch failed|ENOTFOUND|ECONNREFUSED/i.test(err.message + (err.cause?.code || '')) ? 'non trovo l\'app a questo indirizzo: controlla che sia giusto e che l\'app sia pubblicata' : err.message, lastTry: Date.now() });
        break;
      }
      for (const lavoro of jobs) {
        if (draining[id] !== true) break;
        await handle(sys, lavoro, st);
      }
      if (!jobs.length) {
        if (pending[id]) { pending[id] = false; continue; } // è arrivata una sveglia durante il drain: un altro giro
        break;
      }
    }
  } finally {
    const ancora = pending[id];
    draining[id] = false;
    pending[id] = false;
    if (ancora) drena(id);
    else if (states[id]?.status === 'online') states[id].status = 'in ascolto';
  }
}

// (Ri)apre l'UNICA connessione di sveglia su tutti i topic degli attivi, e mappa topic→app per il risveglio.
function risottoscrivi() {
  const attivi = (getSettings().systems || []).filter((s) => s.enabled !== false && s.key);
  if (!attivi.length) { sveglia.stop(); return; }
  const perTopic = {};
  for (const s of attivi) perTopic[sveglia.topicPer(s.key)] = s.id;
  sveglia.avvia(Object.keys(perTopic), (topic) => { const id = perTopic[topic]; if (id) drena(id); });
}

// Un controllo manuale (pulsante nell'interfaccia): prende subito ciò che è in coda, senza aspettare una sveglia.
export function controllaOra(id) { drena(id); return { ok: true }; }

export function restart(id) {
  states[id] = { ...(states[id] || {}), status: 'in ascolto' };
  risottoscrivi();
  drena(id); // all'accensione o alla modifica di un'app: UN solo controllo, per prendere ciò che era già in coda
}

export function startAll() {
  risottoscrivi();
  for (const s of getSettings().systems || []) if (s.enabled !== false) { states[s.id] = { ...(states[s.id] || {}), status: 'in ascolto' }; drena(s.id); }
}

export async function test(id) {
  const sys = (getSettings().systems || []).find((s) => s.id === id);
  if (!sys) throw new Error('Sistema non trovato');
  // attendi=0 e capacita vuota: solo una prova di collegamento, nessun lavoro preso
  await request(sys, '/lavori?attendi=0&capacita=', { timeout: 15_000 });
  return { ok: true };
}
