// REGISTA WEB: ideax apre un browser vero sulle tue pagine, fa login con i tuoi accessi, fa quello che il copione
// dice e registra lo schermo. Il copione lo scrive il cervello conoscendo le pagine del sito e, se c'è, la strategia
// discussa con Bill: insieme decidono cosa mostrare. Il video torna a ideax, che può montarlo in un reel con voce.
//
// Gli accessi (url, utente, password) restano in data/accessi.json sul PC: non finiscono nel video, nei log, né fuori.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, OUTPUT_DIR, getSettings } from './store.js';
import * as engines from './engines.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog } from './router.js';

const FILE = path.join(DATA_DIR, 'accessi.json');

let host = { createJob: null };
export function configure(fns) { host = { ...host, ...fns }; }

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { siti: [] }; } }
function save(d) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(d, null, 2)); fs.chmodSync?.(FILE, 0o600); }

// Gli accessi senza le password (per l'interfaccia): la password non esce mai da qui
export function listAccessi() {
  return load().siti.map((s) => ({ id: s.id, nome: s.nome, url: s.url, utente: s.utente, haPassword: !!s.password, campi: s.campi || null }));
}
export function saveAccesso(input) {
  const d = load();
  const old = d.siti.find((s) => s.id === input.id);
  const url = String(input.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) throw new Error('Indirizzo non valido (serve https://)');
  const nome = String(input.nome || '').trim() || new URL(url).hostname;
  const s = {
    id: old?.id || crypto.randomUUID().slice(0, 8),
    nome, url, utente: String(input.utente || '').trim(),
    password: input.password && !String(input.password).startsWith('••') ? String(input.password) : (old?.password || ''),
    // selettori del login (dove scrivere utente/password e cosa cliccare); se vuoti, il cervello li deduce guardando la pagina
    campi: input.campi || old?.campi || null,
  };
  d.siti = [...d.siti.filter((x) => x.id !== s.id), s];
  save(d);
  return { id: s.id };
}
export function deleteAccesso(id) { const d = load(); d.siti = d.siti.filter((s) => s.id !== id); save(d); }
function accessoPer(url) {
  const d = load();
  try { const h = new URL(url).hostname; return d.siti.find((s) => { try { return new URL(s.url).hostname === h; } catch { return false; } }); } catch { return null; }
}

const COPIONE_SCHEMA = {
  type: 'object',
  properties: {
    titolo: { type: 'string' },
    passi: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object',
        properties: {
          azione: { type: 'string', enum: ['vai', 'click', 'scrivi', 'scorri', 'evidenzia', 'aspetta', 'commento'] },
          url: { type: 'string' }, selettore: { type: 'string' }, testo: { type: 'string' },
          a: { type: 'string' }, ms: { type: 'number' },
        },
        required: ['azione'],
      },
    },
  },
  required: ['titolo', 'passi'],
};

// Il cervello scrive il copione: cosa far vedere, in che ordine, con quali sottotitoli.
export async function scriviCopione({ url, obiettivo, pagine = [], strategia = '' }) {
  const brain = resolveBrain(buildCatalog().all);
  if (brain.mode === 'rules') {
    return { titolo: obiettivo || 'Demo', passi: [{ azione: 'vai', url }, { azione: 'commento', testo: obiettivo || '', ms: 2500 }, { azione: 'scorri', a: 'fondo' }] };
  }
  const out = await chatBrain(brain, [
    { role: 'system', content: 'Sei il regista di un video dimostrativo di un sito/gestionale. Scrivi un copione di passi che il browser eseguirà e registrerà. Azioni: vai(url), click(selettore o testo), scrivi(selettore,testo), scorri(a: "fondo"|"cima"|pixel), evidenzia(selettore CSS), aspetta(ms o selettore), commento(testo = sottotitolo a schermo, ms). Mostra le cose migliori per convincere un cliente, con sottotitoli brevi in italiano. 8-15 passi. Non inventare selettori improbabili: preferisci "commento", "scorri", "evidenzia" su titoli/sezioni evidenti. Il login lo fa ideax da sé, non metterlo nel copione. Solo JSON.' },
    { role: 'user', content: `Sito: ${url}\nObiettivo del video: ${obiettivo}\nPagine note: ${pagine.join(', ') || '—'}\n${strategia ? `Strategia (da Bill): ${strategia}` : ''}` },
  ], COPIONE_SCHEMA, { temperature: 0.5, maxTokens: 2500 });
  return out;
}

// job.demo: { url, obiettivo, pagine?, strategia?, passi?, voce?, monta? }
export async function runDemo(job, log) {
  const dm = job.demo || {};
  if (!dm.url) throw new Error('Manca l\'indirizzo del sito da registrare');
  if (!engines.isInstalled('webdemo')) throw new Error('Installa il motore "Regista web" dalla pagina Modelli');
  Object.assign(job, { task: 'demo', modelName: 'Regista web', title: job.title || dm.obiettivo || 'Demo', status: 'running' });
  job.startedAt = Date.now();
  const step = (phase) => { job.progress = { phase }; log(phase); };

  step('Scrivo il copione');
  const copione = Array.isArray(dm.passi) && dm.passi.length ? { titolo: dm.obiettivo || 'Demo', passi: dm.passi } : await scriviCopione(dm);
  job.title = copione.titolo || job.title;

  // Il login in testa, con gli accessi salvati per quel sito
  const acc = accessoPer(dm.url);
  const passi = [];
  if (acc && (acc.utente || acc.password)) {
    const campi = acc.campi?.utente ? [
      ...(acc.campi.utente ? [{ selettore: acc.campi.utente, valore: acc.utente }] : []),
      ...(acc.campi.password ? [{ selettore: acc.campi.password, valore: acc.password }] : []),
    ] : [
      { selettore: 'input[type=email], input[name*=user i], input[name*=email i], #user, #email', valore: acc.utente },
      { selettore: 'input[type=password], #pass, #password', valore: acc.password },
    ];
    passi.push({ azione: 'login', url: acc.url, campi, invia: acc.campi?.invia || 'button[type=submit], button:has-text("Accedi"), button:has-text("Entra"), input[type=submit]' });
  }
  passi.push(...copione.passi);

  step('Apro il browser e registro…');
  const base = await engines.ensureRunning('webdemo');
  const r = await fetch(`${base}/registra`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passi, larghezza: dm.larghezza || 1280, altezza: dm.altezza || 720, secondi_max: dm.secondi_max || 180 }),
    signal: AbortSignal.timeout(20 * 60_000),
  });
  const data = await r.json().catch(() => ({}));
  engines.stop('webdemo');
  if (!r.ok) throw new Error(data.detail || `Registrazione non riuscita (HTTP ${r.status})`);
  const name = `${job.id}-demo.${data.type === 'video/webm' ? 'webm' : 'mp4'}`;
  fs.writeFileSync(path.join(OUTPUT_DIR, name), Buffer.from(data.base64, 'base64'));
  log(`Registrati ${data.passi} passi in ${data.secondi} s.`);
  const risultati = [{ url: `/outputs/${name}`, type: data.type, seconds: data.secondi }];

  // Montaggio con voce: la registrazione diventa un reel (voce che racconta + sottotitoli)
  if (dm.monta && host.createJob) {
    step('Monto il video con la voce…');
    try {
      const sub = await host.createJob({
        prompt: dm.obiettivo || copione.titolo, kind: 'reel',
        reel: { duration: Math.min(90, Math.max(20, Math.round(data.secondi))), voice: dm.voce, clip: `/outputs/${name}` },
      }, { client: 'webdemo' });
      await sub.done;
      const montato = (sub.results || []).find((x) => x.type === 'video/mp4');
      if (montato) risultati.unshift(montato);
    } catch (err) { log(`Montaggio saltato: ${err.message}`); }
  }
  return risultati;
}
