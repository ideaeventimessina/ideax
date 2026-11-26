import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analizzaProgetto, proponiNelProgetto } from '../lib/progetto-locale.js';
import { confermaFileLocale } from '../lib/file-locali.js';

test('IDEAX ricostruisce i collegamenti e prepara una modifica motivata da approvare', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-progetto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const api = path.join(root, 'api.js');
  const original = 'export const max = 12;\n';
  fs.writeFileSync(api, original);
  fs.writeFileSync(path.join(root, 'app.js'), "import { max } from './api.js';\n");
  fs.writeFileSync(path.join(root, '.env'), 'PRIVATE=non indicizzare\n');
  fs.writeFileSync(path.join(root, 'foto.png'), Buffer.from([1, 2, 3]));
  const project = analizzaProgetto(root);
  assert.deepEqual(project.files.find(f => f.file === 'app.js').links, ['api.js']);
  assert.ok(project.skipped.includes('.env'));
  assert.equal(project.files.find(f => f.file === 'foto.png').read, false);
  const proposal = await proponiNelProgetto(root, 'api.js', 'Porta max a 15', input => {
    assert.equal(input.text, original);
    assert.equal(input.contesto[0].file, 'app.js');
    return { text: 'export const max = 15;\n', motivo: 'Aumento il limite letto da app.js.' };
  });
  assert.match(proposal.motivo, /app.js/);
  assert.equal(fs.readFileSync(api, 'utf8'), original);
  const saved = confermaFileLocale(proposal.id);
  assert.equal(fs.readFileSync(api, 'utf8'), 'export const max = 15;\n');
  assert.equal(fs.readFileSync(saved.backup, 'utf8'), original);
  await assert.rejects(proponiNelProgetto(root, '../altro.js', 'Modifica', () => {}), /Seleziona/);
});
