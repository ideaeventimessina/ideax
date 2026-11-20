/* Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M */
// CHI È "DI QUESTO PC" — revisione di sicurezza del 20/11/2026.
//
// Prima bastava che la connessione arrivasse da 127.0.0.1 per saltare la chiave API, e CORS era "*".
// Due buchi:
//  1. qualsiasi pagina web aperta nel browser di Andrea poteva chiamare http://localhost:7800 (il
//     browser parte da questo PC, quindi la connessione è "loopback") e leggere le risposte;
//  2. un tunnel sullo stesso PC (cloudflared, ngrok…) consegna a ideax le richieste di internet
//     da 127.0.0.1: da fuori sembravano locali.
//
// Ora una richiesta è locale solo se:
//  - arriva da loopback, E
//  - non ha intestazioni di inoltro (le mette un tunnel o un proxy), E
//  - non ha Origin, oppure ha l'Origin della pagina di ideax stessa (localhost/127.0.0.1/[::1] sulla
//    porta di ideax) o una delle origini ammesse esplicitamente, E
//  - il browser non la marca come cross-site (Sec-Fetch-Site), così anche un <img>/<a> da un altro
//    sito non passa.
// Gli script e le app sullo stesso PC (Node, Python, curl) non mandano Origin: restano locali come prima.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const INOLTRO = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip',
  'cf-connecting-ip', 'cf-ray', 'cf-ipcountry', 'true-client-ip', 'x-client-ip', 'x-cluster-client-ip',
  'fastly-client-ip', 'x-original-forwarded-for', 'ngrok-trace-id', 'x-ngrok-forwarded',
];
const NOMI_LOCALI = new Set(['localhost', '127.0.0.1', '[::1]']);

export const daLoopback = (req) => LOOPBACK.has(req.socket?.remoteAddress);

export const haInoltro = (req) => INOLTRO.some((h) => req.headers[h] != null);

const pulisci = (o) => String(o || '').trim().replace(/\/+$/, '').toLowerCase();

// Le origini in più si scrivono in IDEAX_ORIGINI (separate da virgola) o in settings.json → network.origini.
export function originiExtra(settings = {}) {
  const daEnv = String(process.env.IDEAX_ORIGINI || '').split(',');
  const daFile = Array.isArray(settings?.network?.origini) ? settings.network.origini : [];
  return new Set([...daEnv, ...daFile].map(pulisci).filter(Boolean));
}

// L'origine è quella della pagina di ideax (stessa porta, nome locale) oppure una ammessa esplicitamente
export function origineAmmessa(origin, port, extra = new Set()) {
  if (!origin) return false;
  const o = pulisci(origin);
  if (extra.has(o)) return true;
  let u;
  try { u = new URL(o); } catch { return false; }
  return u.protocol === 'http:' && NOMI_LOCALI.has(u.hostname) && Number(u.port || 80) === Number(port);
}

export function richiestaLocale(req, port, extra = new Set()) {
  if (!daLoopback(req) || haInoltro(req)) return false;
  const sito = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sito === 'cross-site' || sito === 'same-site') return false;
  const origin = req.headers.origin;
  if (origin == null || origin === '') return true;
  return origineAmmessa(origin, port, extra);
}
