import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { collauda, eseguiFunzione } from './collaudo.js';
import { DATA_DIR } from './store.js';

const archivio = path.join(DATA_DIR, 'operatore', 'giochi-collaudati');
const anteprime = new Map();
const mosse = new Set(['avvia', 'destra', 'sinistra', 'su', 'giu']);
const iniziale = { x: 0, z: 0, score: 0 };
const esempi = {
  funzione: 'passo',
  casi: [
    { argomenti: [{ x: 3, z: -1, score: 2 }, 'avvia'], atteso: iniziale },
    { argomenti: [iniziale, 'destra'], atteso: { x: 1, z: 0, score: 1 } },
    { argomenti: [{ x: 8, z: 0, score: 2 }, 'destra'], atteso: { x: 8, z: 0, score: 2 } },
    { argomenti: [iniziale, 'su'], atteso: { x: 0, z: -1, score: 0 } },
    { argomenti: [{ x: 1, z: 0, score: 4 }, 'sinistra'], atteso: { ...iniziale, score: 4 } },
  ],
};
export const provaBackend = (codice) => collauda(codice, esempi);

function valido(stato) {
  return stato && Object.keys(stato).length === 3 &&
    Number.isInteger(stato.x) && Math.abs(stato.x) <= 8 &&
    Number.isInteger(stato.z) && Math.abs(stato.z) <= 8 &&
    Number.isInteger(stato.score) && stato.score >= 0 && stato.score <= 10_000;
}

export async function apriAnteprima(gio, port = 0) {
  const token = randomBytes(16).toString('hex');
  const base = '/' + token + '/';
  let stato = iniziale, acceso = false, origine, inCorso = false;
  const server = createServer({ requestTimeout: 5000, headersTimeout: 5000 }, async (req, res) => {
    const rispondi = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; frame-ancestors 'none'; form-action 'none'; base-uri 'none'; sandbox allow-scripts allow-same-origin");
    if (req.headers.host !== origine.slice(7)) return rispondi(403, { error: 'Host non consentito.' });
    if (req.method === 'GET' && req.url === base) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(gio.frontend);
    }
    if (req.url !== base + 'azione' || req.method !== 'POST') return rispondi(404, { error: 'Risorsa sconosciuta.' });
    if (req.headers.origin !== origine || req.headers['content-type'] !== 'application/json') return rispondi(403, { error: 'Origine o formato non consentito.' });
    let azione;
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        size += chunk.length;
        if (size > 256) { req.resume(); return rispondi(413, { error: 'Richiesta troppo grande.' }); }
        chunks.push(chunk);
      }
      azione = JSON.parse(Buffer.concat(chunks)).azione;
    } catch { return rispondi(400, { error: 'Azione non valida.' }); }
    if (!mosse.has(azione)) return rispondi(422, { error: 'Azione sconosciuta.' });
    if (inCorso || (!acceso && azione !== 'avvia')) return rispondi(409, { error: 'Sessione non pronta.' });
    inCorso = true;
    try {
      const r = await eseguiFunzione(gio.backend, 'passo', (invoca) => ({ stato: invoca([stato, azione]) }));
      if (!valido(r.stato)) return rispondi(500, { error: r.errore || 'Il backend ha prodotto uno stato non valido.' });
      stato = r.stato;
      acceso = true;
      rispondi(200, stato);
    } catch {
      rispondi(500, { error: 'Motore del gioco non disponibile.' });
    } finally {
      inCorso = false;
    }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  origine = 'http://127.0.0.1:' + server.address().port;
  return { url: origine + base, chiudi() { server.close(); server.closeAllConnections(); } };
}

export function salvaGioco(id, titolo, gioco, prova) {
  fs.mkdirSync(archivio, { recursive: true });
  const file = path.join(archivio, id + '.json');
  const record = { id, titolo, data: new Date().toISOString(), casi: prova.casi, ...gioco };
  fs.writeFileSync(file + '.tmp', JSON.stringify(record));
  fs.renameSync(file + '.tmp', file);
  return record;
}

export function leggiGioco(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) throw new Error('ID progetto non valido.');
  return JSON.parse(fs.readFileSync(path.join(archivio, id + '.json'), 'utf8'));
}

export function elencaGiochi() {
  if (!fs.existsSync(archivio)) return [];
  return fs.readdirSync(archivio).filter((name) => /^[a-f0-9]{8}\.json$/.test(name)).flatMap((name) => {
    try {
      const { id, titolo, data, casi } = leggiGioco(name.slice(0, 8));
      return [{ id, titolo, data, casi }];
    } catch { return []; }
  }).sort((a, b) => b.data.localeCompare(a.data));
}

export async function gioca(id) {
  if (anteprime.has(id)) return { url: (await anteprime.get(id)).url };
  if (anteprime.size >= 5) {
    const [vecchio, pending] = anteprime.entries().next().value;
    anteprime.delete(vecchio);
    void pending.then((v) => v.chiudi(), () => {});
  }
  const pending = apriAnteprima(leggiGioco(id));
  anteprime.set(id, pending);
  try { return { url: (await pending).url }; }
  catch (err) { anteprime.delete(id); throw err; }
}
