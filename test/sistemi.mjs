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
