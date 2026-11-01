import { test } from 'node:test';
import assert from 'node:assert/strict';
import { istruzioniDataset } from '../lib/personaggi.js';

test('il dataset ha scene pulite (viso) più scene vestite; nsfw aggiunge pose adulte', () => {
  const pulito = istruzioniDataset('a blonde woman', false);
  const adulto = istruzioniDataset('a blonde woman', true);
  assert.ok(pulito.length >= 12);
  assert.ok(pulito.every((s) => /same exact person, a blonde woman/.test(s)));
  // niente pose esplicite nel dataset "pulito"
  assert.ok(!pulito.some((s) => /lingerie|bikini|swimsuit|boudoir/.test(s)));
  // nsfw: compaiono pose in lingerie/bikini
  assert.ok(adulto.some((s) => /lingerie|bikini|boudoir/.test(s)));
});

test('ogni scena chiede coerenza del volto', () => {
  for (const s of istruzioniDataset('a man', false)) assert.match(s, /consistent facial features/);
});
