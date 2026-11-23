import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-sistemi-'));
const { saveSystem, deleteSystem } = await import('../lib/systems.js');
const { validaSintassi } = await import('../lib/operatore.js');
const { collauda, preparaCollaudo } = await import('../lib/collaudo.js');
const { letturaGitHub } = await import('../lib/github-regia.js');
const { progettiCode, apriProgettoLocale } = await import('../lib/code-progetti.js');

test('Code avvia il progetto registrato solo quando viene aperto', async (t) => {
  const riserva = createServer();
  riserva.listen(0, '127.0.0.1');
  await once(riserva, 'listening');
  const port = riserva.address().port;
  await new Promise(resolve => riserva.close(resolve));
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax code-'));
  const url = `http://127.0.0.1:${port}/`;
  t.after(async () => {
    await fetch(url + 'chiudi', { signal: AbortSignal.timeout(1000) }).catch(() => {});
    await fs.promises.rm(cartella, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  });
  fs.writeFileSync(path.join(cartella, 'server.mjs'),
    `import {createServer} from 'node:http';
    const server = createServer((req,res) => {
      res.end('Code online');
      if (req.url === '/chiudi') server.close();
    }).listen(${port},'127.0.0.1');`);
  const registro = path.join(process.env.IDEAX_HOME, 'data', 'code-progetti-locali.json');
  fs.writeFileSync(registro, JSON.stringify([{ id: 'avvio-test', titolo: 'Progetto', url, avvio: { node: process.execPath, cartella } }]));
  t.after(() => fs.rmSync(registro, { force: true }));
  assert.equal(progettiCode().find(p => p.titolo === 'Progetto').avvia, 'avvio-test');
  await assert.rejects(fetch(url));
  const avvii = await Promise.all([apriProgettoLocale('avvio-test'), apriProgettoLocale('avvio-test')]);
  assert.deepEqual(avvii, [{ url }, { url }]);
  assert.equal(await (await fetch(url)).text(), 'Code online');
  await assert.rejects(apriProgettoLocale('sconosciuto'), /non registrato/);
});
const { domandaStatoProgetto, richiestaInterattiva, richiestaTrisCpu, richiestaSnake, seguitoAnteprima, documentoIsolato } = await import('../lib/anteprima-web.js');

test('le domande sullo stato della creazione sono riconosciute direttamente', () => {
  assert.equal(domandaStatoProgetto('Dimmi lo stato del progetto'), true);
  assert.equal(domandaStatoProgetto('A che punto è?'), true);
  assert.equal(domandaStatoProgetto('Vedi lo stato?'), true);
  assert.equal(domandaStatoProgetto('Controlla lo stato del meteo'), false);
});
const { REGOLA_PRECEDENTE, richiestaMissione, verificaRegola, preparaMissione } = await import('../lib/missione-giungla.js');

test('la missione scarta la vittoria prematura prima di produrre un documento', async () => {
  assert.ok(richiestaMissione('Correggi Ritorno dalla Giungla'));
  assert.match((await verificaRegola(REGOLA_PRECEDENTE)).errore, /regola\(0, false, "soccorso"\)/);
  const corretta = REGOLA_PRECEDENTE.replace("evento === 'soccorso'", "evento === 'soccorso' && inBase && passati === 100");
  const prova = await verificaRegola(corretta);
  assert.equal(prova.ok, true);
  assert.equal(prova.tabella.length, 101);
  assert.equal(prova.tabella[100][0].soccorso.vittoria, false);
  assert.equal(prova.tabella[100][1].soccorso.vittoria, true);
  const html = preparaMissione(prova.tabella);
  assert.doesNotMatch(html, /__MISSIONE_TABELLA__|__MOTORE_GIUNGLA__/);
  assert.match(html, /scenarioVista/);
});

test('le creazioni giocabili hanno un percorso distinto dalla scrittura di codice', () => {
  assert.equal(richiestaInterattiva('Crea un videogioco 3D'), true);
  assert.equal(richiestaInterattiva('Ok è un gioco 3D in prima persona'), true);
  assert.equal(richiestaInterattiva('Scrivi solo il codice per un gioco'), false);
  assert.equal(richiestaTrisCpu('Crea il gioco del tris 1 giocatore contro la CPU'), true);
  assert.equal(richiestaTrisCpu('Crea un gioco di scacchi contro la CPU'), false);
  assert.equal(richiestaTrisCpu('Crea un tris per due giocatori'), false);
  assert.equal(richiestaSnake('creami il gioco di snake quello dei nokia'), true);
  assert.equal(seguitoAnteprima('non funziona'), 'ripara');
  assert.equal(seguitoAnteprima('devi aprirmi la finestra per giocare non mi devi are il codice'), 'apri');
  assert.equal(seguitoAnteprima('scrivi il codice'), null);
  assert.match(documentoIsolato('<button>Avvia</button>'), /connect-src 'none'[\s\S]*scrollIntoView[\s\S]*<button>Avvia<\/button>/);
});

test('una lettura GitHub ha precedenza sullo scrittore, senza intercettare richieste di modifica', () => {
  assert.equal(letturaGitHub('Potresti collegarti al mio repo su GitHub, Andrea Gentile, e leggere le mie memorie').memorie, true);
  assert.deepEqual(letturaGitHub('Leggi https://github.com/example/project/blob/main/docs/memorie.md'), {
    repo: 'example/project', ref: 'main', percorso: 'docs/memorie.md', memorie: true,
  });
  assert.equal(letturaGitHub('Apri il repo su GitHub e modifica il README'), null);
  assert.equal(letturaGitHub('Racconta una storia su GitHub'), null);
});
const { apriAnteprima, elencaGiochi, salvaGioco, leggiGioco } = await import('../lib/progetti-guida.js');

test('il gioco usa un backend isolato e risponde solo sulla propria origine', async (t) => {
  const frontend = '<canvas id="world"></canvas>';
  const backend = 'function passo(s, a) { return a === "avvia" ? {x:0,z:0,score:0} : {x:s.x+1,z:0,score:1}; }';
  const gioco = await apriAnteprima({ frontend, backend });
  t.after(() => gioco.chiudi());
  const url = new URL(gioco.url);
  const post = (azione, origin = url.origin) => fetch(gioco.url + 'azione', {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ azione }),
  });
  const pagina = await fetch(url);
  assert.equal(await pagina.text(), frontend);
  assert.match(pagina.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await post('avvia', 'http://example.invalid')).status, 403);
  assert.equal((await post('destra')).status, 409);
  assert.equal((await post('salta')).status, 422);
  assert.deepEqual(await (await post('avvia')).json(), { x: 0, z: 0, score: 0 });
  assert.deepEqual(await (await post('destra')).json(), { x: 1, z: 0, score: 1 });
  assert.deepEqual(elencaGiochi(), []);
  salvaGioco('01234567', 'Prova', { frontend, backend }, { casi: 11 });
  assert.equal(elencaGiochi()[0].casi, 11);
  assert.equal(leggiGioco('01234567').backend, backend);
});

test('i test JS distinguono sorgenti eseguibili, risposte errate e calcoli fuori tempo', async () => {
  const verifica = preparaCollaudo({ funzione: 'doppio', casi: [{ argomenti: [4], atteso: 8 }] });
  assert.deepEqual(await collauda('function doppio(x) { return x * 2 }', verifica), { ok: true, casi: 1 });
  const fallito = await collauda('function doppio(x) { return x }', verifica);
  assert.match(fallito.errore, /input \[4\].*atteso 8.*ottenuto 4/);
  assert.equal((await collauda('function doppio() { while (true) {} }', verifica)).ok, false);
  assert.equal((await collauda('function doppio() { return process.pid }', verifica)).ok, false);
  assert.throws(() => preparaCollaudo({ funzione: 'x(); y', casi: verifica.casi }));
});

test('la Pipeline valida moduli in una cartella esterna senza avviare il codice', async (t) => {
  const cartella = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-progetto esterno-'));
  t.after(() => fs.rmSync(cartella, { recursive: true, force: true }));
  const file = path.join(cartella, 'server.mjs');
  fs.writeFileSync(file, "import fs from 'node:fs'; throw new Error('non eseguire'); export { fs };");
  assert.deepEqual(await validaSintassi(file), { ok: true });
  fs.writeFileSync(file, 'export const = ;');
  assert.equal((await validaSintassi(file)).ok, false);
});

test('un ponte che risponde subito con una coda vuota non viene interrogato in un ciclo serrato', async (t) => {
  let polls = 0;
  let firstPoll;
  const first = new Promise((resolve) => { firstPoll = resolve; });
  const app = createServer((_req, res) => {
    polls++;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"lavori":[]}');
    firstPoll();
  });
  app.listen(0, '127.0.0.1');
  await once(app, 'listening');
  const system = saveSystem({ name: 'Ponte di prova', url: `http://127.0.0.1:${app.address().port}`, key: 'fixture' });
  t.after(() => { deleteSystem(system.id); app.closeAllConnections(); app.close(); });
  await first;
  await wait(1200);
  assert.ok(polls <= 2, `Ricevute ${polls} richieste a vuoto`);
});
