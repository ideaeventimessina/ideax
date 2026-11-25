// Prova end-to-end della sveglia push: ntfy FINTO + app FINTA, in locale.
// Dimostra: (1) a riposo l'app NON riceve richieste; (2) su una sveglia ideax drena e consegna il risultato.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-ponte-'));
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
process.env.IDEAX_HOME = HOME;
process.env.IDEAX_NO_OPEN = '1';

// -------- ntfy FINTO: GET /<topics>/json tiene aperto lo stream; POST /<topic> pubblica una sveglia --------
const abbonati = []; // { topics:Set, res }
const ntfy = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const parti = u.pathname.replace(/^\/+/, '').split('/');
  if (req.method === 'GET' && parti[1] === 'json') {
    const topics = new Set(parti[0].split(','));
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ id: 'open', event: 'open' }) + '\n');
    const sub = { topics, res };
    abbonati.push(sub);
    req.on('close', () => { const i = abbonati.indexOf(sub); if (i >= 0) abbonati.splice(i, 1); });
    return;
  }
  if (req.method === 'POST') { // pubblica sul topic = parti[0]
    const topic = parti[0];
    for (const s of abbonati) if (s.topics.has(topic)) s.res.write(JSON.stringify({ id: `m${Date.now()}`, event: 'message', topic, message: 'job' }) + '\n');
    res.writeHead(200); res.end('{"ok":true}'); return;
  }
  res.writeHead(404); res.end();
});

// -------- App FINTA: conta OGNI richiesta. Alla prima GET dopo una sveglia dà un lavoro, poi coda vuota. --------
let getLavori = 0, postRisultato = 0, totali = 0;
let codaHaLavoro = false; // lo accendo quando "pubblico" la sveglia
const app = http.createServer((req, res) => {
  totali++;
  const u = new URL(req.url, 'http://x');
  if (req.method === 'GET' && u.pathname === '/api/ponte/ideax/lavori') {
    getLavori++;
    const lavori = codaHaLavoro ? [{ id: 'j1', tipo: 'provademo', dati: {} }] : [];
    codaHaLavoro = false; // consegnato: la coda si svuota
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ lavori })); return;
  }
  if (req.method === 'POST' && u.pathname.startsWith('/api/ponte/ideax/lavori/')) {
    postRisultato++;
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return;
  }
  res.writeHead(200); res.end('{}');
});

await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
await new Promise((r) => app.listen(0, '127.0.0.1', r));
const ntfyUrl = `http://127.0.0.1:${ntfy.address().port}`;
const appUrl = `http://127.0.0.1:${app.address().port}`;
process.env.IDEAX_NTFY_BASE = ntfyUrl;

// Configura un sistema che punta all'app finta
const KEY = 'testkey-123';
fs.writeFileSync(path.join(HOME, 'data', 'settings.json'),
  JSON.stringify({ systems: [{ id: 'app1', name: 'AppFinta', url: appUrl, path: '/api/ponte/ideax', key: KEY, enabled: true }] }, null, 2));

const sistemi = await import('../lib/systems.js');
const sveglia = await import('../lib/sveglia.js');
const esci = (ok, m) => { console.log(ok ? `✅ ${m}` : `❌ ${m}`); if (!ok) process.exit(1); };

// Avvio: sottoscrive ntfy + UN drain iniziale (coda vuota → 1 GET, 0 POST)
sistemi.startAll();
await new Promise((r) => setTimeout(r, 1500));
esci(getLavori === 1, `all'avvio: 1 solo controllo della coda (GET=${getLavori}, POST=${postRisultato})`);

// RIPOSO: 8 secondi senza sveglia → NESSUNA nuova richiesta all'app
const getPrima = getLavori, totPrima = totali;
await new Promise((r) => setTimeout(r, 8000));
esci(totali === totPrima, `a riposo 8s: ZERO richieste all'app (prima=${totPrima}, dopo=${totali})`);
esci(sveglia.attiva(), 'la connessione di sveglia è aperta (una sola, in uscita)');

// SVEGLIA: l'app pubblica sul suo topic → ideax deve drenare e consegnare
codaHaLavoro = true;
await sveglia.pubblica(sveglia.topicPer(KEY), 'job');
await new Promise((r) => setTimeout(r, 2500));
// Il drain pulla il lavoro e poi RICONTROLLA una volta (coda vuota) per non lasciare nulla indietro: 2 GET, va bene.
esci(getLavori >= getPrima + 1, `dopo la sveglia: ideax ha preso il lavoro (GET ${getPrima}→${getLavori}, poi conferma coda vuota)`);
esci(postRisultato === 1, `dopo la sveglia: ideax ha consegnato il risultato (POST=${postRisultato})`);

// Di nuovo a riposo dopo il lavoro: silenzio
const totDopoLavoro = totali;
await new Promise((r) => setTimeout(r, 4000));
esci(totali === totDopoLavoro, `finito il lavoro: di nuovo ZERO richieste (dopo=${totali - totDopoLavoro} in più)`);

console.log('\n🎉 Sveglia push: a riposo zero richieste; su sveglia drena e consegna; una sola connessione in uscita.');
sveglia.stop(); ntfy.close(); app.close(); process.exit(0);
