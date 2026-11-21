import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-gemello-'));
const engine = path.join(process.env.IDEAX_HOME, 'runtime', 'engines', 'twin');
fs.mkdirSync(engine, { recursive: true });
fs.writeFileSync(path.join(engine, 'installed.json'), '{}');
const { saveSettings } = await import('../lib/store.js');
const { createPhotoTwin, list, training } = await import('../lib/twin.js');
const { DATA_DIR } = await import('../lib/store.js');
saveSettings({ workerUrl: 'http://127.0.0.1:1', manageWorker: false });

test('richieste simultanee riservano un solo addestramento prima della preanalisi GPU', async () => {
  const photos = Array.from({ length: 8 }, () => ({
    type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  }));
  const [first, second] = await Promise.allSettled([
    createPhotoTwin({ name: 'Prova A', photos, consent: true }),
    createPhotoTwin({ name: 'Prova B', photos, consent: true }),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.match(second.reason.message, /già addestrando/);
  assert.equal(list().photo.length, 1);
  const deadline = Date.now() + 15_000;
  while (training.status === 'running' && Date.now() < deadline) await wait(50);
  assert.equal(training.status, 'error'); // l'istanza di prova non ha modelli né Python
});

test('foto identiche di un gemello pronto riutilizzano il risultato senza addestrare di nuovo', async () => {
  const file = path.join(DATA_DIR, 'gemello', 'gemelli.json');
  const stato = JSON.parse(fs.readFileSync(file, 'utf8'));
  const precedente = stato.photo[0];
  precedente.status = 'ready';
  precedente.lora = path.join(DATA_DIR, 'gemello', 'collaudo.safetensors');
  fs.writeFileSync(precedente.lora, 'fixture');
  fs.writeFileSync(file, JSON.stringify(stato), 'utf8');
  const photos = Array.from({ length: 8 }, () => ({
    type: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  }));
  const riuso = await createPhotoTwin({ name: precedente.name, photos, consent: true });
  assert.equal(riuso.id, precedente.id);
  assert.equal(riuso.reused, true);
  assert.equal(list().photo.length, 1);
  assert.notEqual(training.status, 'running');
});
