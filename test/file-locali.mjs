import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { anteprimaFileLocale, confermaFileLocale } from '../lib/file-locali.js';

test('l’anteprima lascia intatto il file, la conferma scrive e conserva l’originale', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-file-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prova.json');
  const original = '{"quantita":12}\r\n';
  fs.writeFileSync(file, original);
  const proposta = anteprimaFileLocale(file, '{"quantita":15}\n');
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  const saved = confermaFileLocale(proposta.id);
  assert.equal(fs.readFileSync(saved.backup, 'utf8'), original);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"quantita":15}\r\n');
  assert.throws(() => confermaFileLocale(proposta.id), /già usata/);
  const stale = anteprimaFileLocale(file, '{"quantita":16}');
  fs.writeFileSync(file, '{"quantita":17}');
  assert.throws(() => confermaFileLocale(stale.id), /è cambiato/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"quantita":17}');
  assert.throws(() => anteprimaFileLocale(file, 'JSON incompleto'), SyntaxError);
});
