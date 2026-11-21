import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentiVoce, tonoRichiesto } from '../public/regia-voce.js';

test('la prima frase parte separatamente e una risposta lunga viene letta per intero', () => {
  const testo = 'Sei pronto? ' + 'Leggi tutto, con chiarezza. '.repeat(45) + 'Ultima frase.';
  const pezzi = segmentiVoce(testo);
  assert.equal(pezzi[0].input, 'Sei pronto?');
  assert.equal(pezzi.at(-1).input, 'Ultima frase.');
  assert.equal(pezzi.map((p) => p.input).join(' '), testo);
});

test('il tono modifica il ritmo e una domanda riceve una pausa più lunga', () => {
  const testo = 'Ascolta. Hai un minuto?';
  const calma = segmentiVoce(testo, tonoRichiesto('leggilo con tono calmo'));
  const vivace = segmentiVoce(testo, tonoRichiesto('usando un tono energico'));
  assert.ok(calma[0].velocita < vivace[0].velocita);
  assert.ok(calma[1].pausa > calma[0].pausa);
});
