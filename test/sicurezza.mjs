/* Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M */
// BANCO DI PROVA DELLA SICUREZZA (20/11/2026): chi vale come "questo PC" e cosa può fare un sistema
// collegato in sola lettura. Gira a ogni build insieme all'orchestratore e alla farm.
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-sicurezza-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richiestaLocale, origineAmmessa, originiExtra } from '../lib/locale.js';

const req = (ip, headers = {}) => ({ socket: { remoteAddress: ip }, headers });
const PORTA = 7800;

test('script sullo stesso PC (niente Origin): locale', () => {
  assert.equal(richiestaLocale(req('127.0.0.1'), PORTA), true);
  assert.equal(richiestaLocale(req('::1'), PORTA), true);
  assert.equal(richiestaLocale(req('::ffff:127.0.0.1'), PORTA), true);
});

test('la pagina di ideax stessa: locale', () => {
  for (const o of ['http://localhost:7800', 'http://127.0.0.1:7800', 'http://[::1]:7800']) {
    assert.equal(richiestaLocale(req('127.0.0.1', { origin: o, 'sec-fetch-site': 'same-origin' }), PORTA), true, o);
  }
  assert.equal(richiestaLocale(req('127.0.0.1', { 'sec-fetch-site': 'none' }), PORTA), true);
});

test('pagine di altri siti nel browser: NON locali', () => {
  assert.equal(richiestaLocale(req('127.0.0.1', { origin: 'https://cattivo.example' }), PORTA), false);
  assert.equal(richiestaLocale(req('127.0.0.1', { origin: 'http://localhost:3000' }), PORTA), false);
  assert.equal(richiestaLocale(req('127.0.0.1', { origin: 'null' }), PORTA), false);
  assert.equal(richiestaLocale(req('127.0.0.1', { origin: 'http://localhost.cattivo.example:7800' }), PORTA), false);
  // <img src="http://localhost:7800/outputs/…"> da un altro sito: niente Origin, ma Sec-Fetch-Site lo tradisce
  assert.equal(richiestaLocale(req('127.0.0.1', { 'sec-fetch-site': 'cross-site' }), PORTA), false);
  assert.equal(richiestaLocale(req('127.0.0.1', { 'sec-fetch-site': 'same-site' }), PORTA), false);
});

test('tunnel o proxy sullo stesso PC: NON locali', () => {
  for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'forwarded', 'x-real-ip', 'true-client-ip']) {
    assert.equal(richiestaLocale(req('127.0.0.1', { [h]: '203.0.113.9' }), PORTA), false, h);
  }
});

test('altri computer: NON locali', () => {
  assert.equal(richiestaLocale(req('192.168.1.20'), PORTA), false);
});

test('origini ammesse esplicitamente', () => {
  process.env.IDEAX_ORIGINI = 'http://localhost:3000/, https://app.example';
  const extra = originiExtra({ network: { origini: ['http://127.0.0.1:5173'] } });
  delete process.env.IDEAX_ORIGINI;
  assert.equal(origineAmmessa('http://localhost:3000', PORTA, extra), true);
  assert.equal(origineAmmessa('https://app.example', PORTA, extra), true);
  assert.equal(origineAmmessa('http://127.0.0.1:5173', PORTA, extra), true);
  assert.equal(origineAmmessa('https://altro.example', PORTA, extra), false);
  assert.equal(richiestaLocale(req('127.0.0.1', { origin: 'http://localhost:3000' }), PORTA, extra), true);
});

test('sola lettura: niente strumenti di scrittura GitHub, qualunque sia allowWrite', async () => {
  const store = await import('../lib/store.js');
  const { availableTools } = await import('../lib/agent.js');
  const SCRIVONO = ['github_scrivi_file', 'github_crea_ramo', 'github_crea_issue', 'github_commenta', 'github_crea_pr'];
  store.saveSettings({ github: { token: 'finto', allowWrite: true } });
  const locale = availableTools({});
  for (const t of SCRIVONO) assert.ok(locale.includes(t), `chat locale con allowWrite: ${t} deve esserci`);
  const remoto = availableTools({ client: 'Jarvis', soloLettura: true });
  for (const t of SCRIVONO) assert.ok(!remoto.includes(t), `soloLettura: ${t} non deve esserci`);
  assert.ok(remoto.includes('github_leggi'), 'la lettura resta');
  store.saveSettings({ github: { token: 'finto', allowWrite: false } });
  for (const t of SCRIVONO) assert.ok(!availableTools({}).includes(t), `allowWrite spento: ${t} non deve esserci`);
});
