// LA FARM: tre PC con la stessa 4080 che lavorano insieme. Uno fa da CAPOFILA (tiene la coda e parla con le app
// online), gli altri due fanno da OPERAI. Gli operai non hanno codice nuovo: usano "Collega app" (systems.js) puntato
// al capofila sulla rete locale, prendono un lavoro, lo svolgono con la pipeline piena e riportano il risultato —
// esattamente il patto del ponte (docs/ponte-ideax.md). Qui c'è solo il lato CAPOFILA: la coda condivisa.
//
// Perché una coda e non "spezza un lavoro sui tre": spezzare una singola generazione su macchine collegate via rete
// di casa costa più in chiacchiere di rete di quanto guadagni (CLAUDE.md di casa: si misura, non si stima). Tre GPU
// rendono tre volte di più facendo TRE lavori insieme, non UN lavoro in un terzo. Quindi: una coda, N operai.
//
// Una sola regola salva dai doppioni: la presa è ATOMICA. Node è a thread singolo, quindi claim() e withdraw()
// girano per intero senza che nient'altro si infili in mezzo — nessun database, nessun lucchetto. Tutti gli operai
// (e il capofila stesso) bussano a UN solo processo: il capofila. Lì dentro la corsa non esiste.
//
// Il capofila offre un lavoro agli operai SOLO quando la sua GPU è già occupata (server.js): un lavoro singolo su un
// sistema libero gira subito in locale, come prima. Gli operai assorbono l'ECCESSO. Se nessuno prende il lavoro entro
// "grace" secondi, o se l'operaio che l'ha preso sparisce, il lavoro ripiega sul capofila: mai perso, mai mutò.
import crypto from 'node:crypto';
import { getSettings, saveSettings } from './store.js';

const PRESO_SCADE_MS = 30 * 60 * 1000; // un operaio ha fino a 30 minuti per riportare (un video lungo ci mette minuti)
const OPERAIO_SPENTO_MS = 90 * 1000; // non si fa vedere da 90 s → spento

const queue = new Map(); // farmId → { id, tipo, dati, stato, creato, preso?, operaio?, resolve, reject, claimed }
const order = []; // i farmId in ordine di arrivo (il più vecchio si serve per primo)
const operai = new Map(); // chi degli altri PC si è fatto vedere: id → { nome, visto, capacita }

function removeOrder(id) {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
}

// Un "preso" mai riportato entro la scadenza: l'operaio è caduto. Lo si rigetta, così chi aspetta ripiega in locale.
function sweep() {
  const now = Date.now();
  for (const id of [...order]) {
    const j = queue.get(id);
    if (j && j.stato === 'preso' && now - j.preso > PRESO_SCADE_MS) {
      queue.delete(id);
      removeOrder(id);
      j.reject(new Error('l\'operaio ha preso il lavoro ma non l\'ha riportato in tempo'));
    }
  }
}

// ---------- Configurazione (ruolo, chiave, grace) ----------

export function config() {
  const f = getSettings().farm || {};
  return { role: f.role === 'capofila' ? 'capofila' : 'solo', key: f.key || '', grace: Number(f.grace) > 0 ? Number(f.grace) : 6 };
}

export function isCapofila() {
  return config().role === 'capofila';
}

// Diventa capofila (genera la chiave se manca), oppure torna "solo". Tornare solo svuota la coda: i lavori in attesa
// ripiegano sul capofila stesso (chi li aspetta li rigetta e li rifà in locale).
export function setConfig({ role, grace } = {}) {
  const cur = config();
  const next = { role: role === 'capofila' ? 'capofila' : role === 'solo' ? 'solo' : cur.role, key: cur.key, grace: cur.grace };
  if (grace != null && Number(grace) > 0) next.grace = Math.min(60, Number(grace));
  if (next.role === 'capofila' && !next.key) next.key = `fx_${crypto.randomBytes(24).toString('base64url')}`;
  saveSettings({ farm: next });
  if (next.role === 'solo') {
    for (const id of [...order]) { const j = queue.get(id); if (j) j.reject(new Error('capofila spento')); queue.delete(id); }
    order.length = 0;
  }
  return config();
}

export function rotateKey() {
  const key = `fx_${crypto.randomBytes(24).toString('base64url')}`;
  saveSettings({ farm: { ...config(), key } });
  return key;
}

// ---------- La coda ----------

// Il capofila offre un lavoro. Torna { id, promise, claimed }: promise si scioglie quando un operaio riporta il
// risultato (o si rigetta se l'operaio cade). `claimed` dice se qualcuno l'ha già preso (serve al ripiego in locale).
export function offer(dati, tipo = 'genera') {
  const id = crypto.randomUUID().slice(0, 12);
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  const j = { id, tipo, dati, stato: 'attesa', creato: Date.now(), resolve, reject, claimed: false };
  queue.set(id, j);
  order.push(id);
  return { id, promise, get claimed() { return j.claimed; } };
}

// Un operaio (o il capofila stesso) prende il lavoro più vecchio che sa fare. capacita vuota = solo una prova di
// collegamento, non prende niente. Segna anche che quell'operaio è vivo.
export function claim(capacita, operaio) {
  sweep();
  noteWorker(operaio);
  const caps = new Set(capacita || []);
  if (!caps.size) return [];
  for (const id of order) {
    const j = queue.get(id);
    if (j && j.stato === 'attesa' && caps.has(j.tipo)) {
      j.stato = 'preso';
      j.claimed = true;
      j.preso = Date.now();
      j.operaio = operaio?.id || operaio?.nome || 'operaio';
      return [{ id: j.id, tipo: j.tipo, dati: j.dati }];
    }
  }
  return [];
}

// L'operaio riporta: { ok:true, risultato } oppure { ok:false, errore }. Scioglie la promise di chi aspetta.
export function deliver(id, body) {
  const j = queue.get(id);
  if (!j) return false;
  queue.delete(id);
  removeOrder(id);
  if (body && body.ok) j.resolve(body.risultato);
  else j.reject(new Error(String((body && body.errore) || 'l\'operaio non ha finito il lavoro').slice(0, 500)));
  return true;
}

// Il capofila ritira un lavoro per farlo da sé: riesce SOLO se nessuno l'ha ancora preso (atomico). Se è già "preso"
// torna false — troppo tardi, lo sta facendo un operaio. La promise si abbandona (nessuno la aspetta più): non la si
// rigetta, o diventerebbe un "unhandled rejection".
export function withdraw(id) {
  const j = queue.get(id);
  if (!j || j.stato !== 'attesa') return false;
  queue.delete(id);
  removeOrder(id);
  return true;
}

// ---------- Gli operai ----------

export function noteWorker(operaio) {
  if (!operaio) return;
  const id = operaio.id || operaio.ip || operaio.nome || 'operaio';
  const old = operai.get(id);
  operai.set(id, { nome: operaio.nome || old?.nome || id, visto: Date.now(), capacita: operaio.capacita || old?.capacita || [] });
}

export function operaiOnline() {
  const now = Date.now();
  let n = 0;
  for (const w of operai.values()) if (now - w.visto < OPERAIO_SPENTO_MS) n++;
  return n;
}

export function stato() {
  sweep();
  const now = Date.now();
  const c = config();
  let attesa = 0, corso = 0;
  for (const j of queue.values()) { if (j.stato === 'attesa') attesa++; else corso++; }
  const lista = [...operai.values()]
    .map((w) => ({ nome: w.nome, capacita: w.capacita, online: now - w.visto < OPERAIO_SPENTO_MS, visto: w.visto }))
    .sort((a, b) => b.visto - a.visto);
  return { role: c.role, capofila: c.role === 'capofila', operai: lista, operaiOnline: operaiOnline(), inAttesa: attesa, inCorso: corso };
}

// Solo per il banco di prova: riporta tutto allo stato di partenza. Le promise rimaste si abbandonano (non si
// rigettano, o sarebbero "unhandled rejection": nessuno le aspetta più).
export function _reset() {
  queue.clear();
  order.length = 0;
  operai.clear();
}
