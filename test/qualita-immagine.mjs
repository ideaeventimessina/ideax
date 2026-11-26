import test from 'node:test';
import assert from 'node:assert/strict';
import { domandaImmagine, promptCorretto, verificaVerdetto, escludeSenzaRichiesta } from '../lib/qualita-immagine.js';

test('una scena incompleta viene scartata con evidenza utile per rigenerare', () => {
  const original = 'Winged kitten surfing in space, with duck feet, chased by a toddler riding a pony';
  const missing = 'Visible webbed duck feet and a separate pony carrying a toddler';
  assert.ok(domandaImmagine(original).endsWith(JSON.stringify(original)));
  assert.throws(() => verificaVerdetto({ coerente: false, motivo: 'Mancano piedi e inseguitore.', dettaglio: missing }),
    error => error.fuoriBrief && error.dettaglio === missing);
  assert.ok(promptCorretto(original, missing).includes(missing));
  assert.ok(promptCorretto(original, missing).endsWith(original));
  assert.equal(promptCorretto(original, ''), original);
  assert.throws(() => verificaVerdetto({ coerente: 'true', motivo: '', dettaglio: '' }), /non ha restituito un verdetto valido/);
  assert.doesNotThrow(() => verificaVerdetto({ coerente: true, motivo: 'Dettagli visibili.', dettaglio: '' }));
  assert.equal(escludeSenzaRichiesta(original, 'Do not show the Earth.'), true);
  assert.equal(escludeSenzaRichiesta('A scene without clouds', 'Do not show clouds.'), false);
});
