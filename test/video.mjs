import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-video-'));
for (const id of ['comfyui', 'wan', 'wan14b']) {
  const engine = path.join(process.env.IDEAX_HOME, 'runtime', 'engines', id);
  fs.mkdirSync(engine, { recursive: true });
  fs.writeFileSync(path.join(engine, 'installed.json'), '{}');
}

const { buildCatalog, route } = await import('../lib/router.js');
const { puntiRichiesti, elencoCompleto } = await import('../lib/reels.js');

test('i due Wan installati si possono selezionare separatamente', async () => {
  const ids = buildCatalog().generators.filter((model) => model.arch === 'wan').map((model) => model.id);
  assert.deepEqual(ids, ['engine-wan14b', 'engine-wan']);
  const explicit = await route('Stable studio shot', [], {
    forceModelId: 'engine-wan14b', forceTask: 'video_generate', literalPrompt: true, fastVideo: true,
  });
  assert.equal(explicit.model.id, 'engine-wan14b');
});

test('la modalità veloce sceglie Wan 5B, il video standard conserva la priorità 14B', async () => {
  const options = { forceTask: 'image_to_video' };
  const photo = [{ type: 'image/png' }];
  const standard = await route('Slow camera movement', photo, options);
  const fast = await route('Slow camera movement', photo, { ...options, fastVideo: true });
  assert.equal(standard.model.id, 'engine-wan14b');
  assert.equal(fast.model.id, 'engine-wan');
});

test('un reel con cinque punti richiede cinque scene di elenco distinte e numerate', () => {
  const punti = puntiRichiesti('5 COSE CHE TI FANNO PERDERE UNA TRATTATIVA');
  assert.equal(punti, 5);
  const scene = (testi) => ({ scenes: testi.map((text) => ({ text })) });
  assert.equal(elencoCompleto(scene(['Introduzione', '1. Primo', '2. Secondo', '3. Terzo', '4. Quarto', 'Chiusura']), punti), false);
  assert.equal(elencoCompleto(scene(['Introduzione', '1. Primo', '2. Secondo', '3. Terzo', '4. Quarto', '5. Quinto', 'Chiusura']), punti), true);
  assert.equal(puntiRichiesti('Crea un reel di 30 secondi sulla trattativa'), 0);
});
