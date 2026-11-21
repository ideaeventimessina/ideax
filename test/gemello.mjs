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
