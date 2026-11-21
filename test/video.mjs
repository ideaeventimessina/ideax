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
const { puntiRichiesti, elencoCompleto, allineaReel } = await import('../lib/reels.js');

test('i due Wan installati si possono selezionare separatamente', async () => {
  const ids = buildCatalog().generators.filter((model) => model.arch === 'wan').map((model) => model.id);
  assert.deepEqual(ids, ['engine-wan14b', 'engine-wan']);
  const explicit = await route('Stable studio shot', [], {
    forceModelId: 'engine-wan14b', forceTask: 'video_generate', literalPrompt: true, fastVideo: true,
  });
  assert.equal(explicit.model.id, 'engine-wan14b');
});

test('un reel da 30 secondi conserva tutte le scene e allinea la voce alla durata del montaggio', () => {
  const lungo = allineaReel([4, 5, 7, 6, 5, 6, 7], 30);
  assert.equal(lungo.total, 30);
  assert.equal(lungo.tempo, 40 / 30);
  assert.equal(lungo.scenes.length, 7);
  const ultima = lungo.scenes.at(-1);
  assert.equal(ultima.start + ultima.duration, 30);
  for (const [i, s] of lungo.scenes.entries()) assert.ok(Math.abs(s.duration * lungo.tempo - [4, 5, 7, 6, 5, 6, 7][i]) < 1e-10);
  const breve = allineaReel([3, 6, 6], 30);
  assert.equal(breve.tempo, 1);
  assert.deepEqual(breve.scenes.map(s => s.duration), [6, 12, 12]);
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
