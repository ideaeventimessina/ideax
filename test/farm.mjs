// BANCO DI PROVA DELLA FARM: la coda del capofila non deve mai dare lo stesso lavoro a due operai, né perdere un
// lavoro quando un operaio sparisce. Gira a ogni build insieme all'orchestratore.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
// I dati vanno in una cartella usa-e-getta: il banco non tocca le impostazioni vere.
process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-farm-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
const farm = await import('../lib/farm.js');

const operaio = (nome) => ({ id: nome, nome, capacita: ['genera'] });

test('di partenza è "solo", nessuna farm', () => {
  farm._reset();
  farm.setConfig({ role: 'solo' });
  assert.equal(farm.isCapofila(), false);
  assert.equal(farm.config().role, 'solo');
});

test('diventando capofila nasce una chiave, e resta la stessa', () => {
  farm._reset();
  farm.setConfig({ role: 'solo' });
  const c = farm.setConfig({ role: 'capofila' });
  assert.equal(c.role, 'capofila');
  assert.match(c.key, /^fx_/);
  const c2 = farm.setConfig({ role: 'capofila' });
  assert.equal(c2.key, c.key); // non si rigenera a ogni accensione
});

test('un lavoro va a UN operaio solo: il secondo che bussa non lo riprende', () => {
  farm._reset();
  const off = farm.offer({ prompt: 'un gatto' });
  const primo = farm.claim(['genera'], operaio('PC2'));
  const secondo = farm.claim(['genera'], operaio('PC3'));
  assert.equal(primo.length, 1);
  assert.equal(primo[0].id, off.id);
  assert.equal(secondo.length, 0); // già preso: niente doppione
  assert.equal(off.claimed, true);
});

test('capacità vuota = solo prova di collegamento, non prende lavori', () => {
  farm._reset();
  farm.offer({ prompt: 'x' });
  assert.equal(farm.claim([], operaio('PC2')).length, 0);
  assert.equal(farm.claim(['genera'], operaio('PC2')).length, 1);
});

test('un operaio non prende un tipo che non sa fare', () => {
  farm._reset();
  farm.offer({ prompt: 'x' }, 'musica');
  assert.equal(farm.claim(['genera', 'voce'], operaio('PC2')).length, 0);
  assert.equal(farm.claim(['musica'], operaio('PC2')).length, 1);
});

test('il risultato dell\'operaio scioglie la promise di chi aspetta', async () => {
  farm._reset();
  const off = farm.offer({ prompt: 'un gatto' });
  const [preso] = farm.claim(['genera'], operaio('PC2'));
  assert.ok(farm.deliver(preso.id, { ok: true, risultato: { risultati: [{ tipo: 'image/png', base64: 'AAA' }] } }));
  const r = await off.promise;
  assert.equal(r.risultati[0].base64, 'AAA');
});

test('se l\'operaio riporta un errore, la promise si rigetta (il capofila ripiegherà in locale)', async () => {
  farm._reset();
  const off = farm.offer({ prompt: 'x' });
  const [preso] = farm.claim(['genera'], operaio('PC2'));
  farm.deliver(preso.id, { ok: false, errore: 'scheda piena' });
  await assert.rejects(off.promise, /scheda piena/);
});

test('ritirare riesce solo se nessuno l\'ha preso (ripiego atomico in locale)', () => {
  farm._reset();
  const off1 = farm.offer({ prompt: 'a' });
  assert.equal(farm.withdraw(off1.id), true); // nessuno l'ha preso: il capofila se lo riprende
  const off2 = farm.offer({ prompt: 'b' });
  farm.claim(['genera'], operaio('PC2'));
  assert.equal(farm.withdraw(off2.id), false); // già in mano a un operaio: troppo tardi
});

test('il più vecchio si serve per primo (coda giusta)', () => {
  farm._reset();
  const a = farm.offer({ prompt: 'a' });
  const b = farm.offer({ prompt: 'b' });
  assert.equal(farm.claim(['genera'], operaio('PC2'))[0].id, a.id);
  assert.equal(farm.claim(['genera'], operaio('PC3'))[0].id, b.id);
});

test('gli operai visti di recente si contano; lo stato li elenca', () => {
  farm._reset();
  assert.equal(farm.operaiOnline(), 0);
  farm.claim(['genera'], operaio('PC2'));
  farm.claim(['genera'], operaio('PC3'));
  assert.equal(farm.operaiOnline(), 2);
  const s = farm.stato();
  assert.equal(s.operaiOnline, 2);
  assert.ok(s.operai.some((w) => w.nome === 'PC2'));
});

test('tornando "solo" la coda si svuota e chi aspetta viene rigettato', async () => {
  farm._reset();
  farm.setConfig({ role: 'capofila' });
  const off = farm.offer({ prompt: 'x' });
  farm.setConfig({ role: 'solo' });
  await assert.rejects(off.promise, /capofila spento/);
  assert.equal(farm.stato().inAttesa, 0);
});
