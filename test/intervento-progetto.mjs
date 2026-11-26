import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('un intervento approva i file insieme e conserva solo metodi verificati', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-intervento-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  process.env.IDEAX_HOME = path.join(root, 'ideax');
  const { preparaIntervento, applicaIntervento } = await import('../lib/intervento-progetto.js');
  const write = (f, value) => fs.writeFileSync(path.join(root, f), value);
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  write('index.html', '<title>Prima</title>');
  write('README.md', '# Prima');
  write('test.mjs', "import assert from 'node:assert/strict'; import fs from 'node:fs'; assert.equal(fs.readFileSync('index.html','utf8'), '<title>Dopo</title>'); assert.equal(fs.readFileSync('README.md','utf8'), '# Dopo');");
  const prepare = (title, expectedMemory) => preparaIntervento(root, 'Allinea il nome', 'test.mjs', (_, context) => {
    if (context.inventory) {
      assert.equal(context.metodo, expectedMemory);
      return { files: ['index.html', 'README.md'], motivo: 'Allineamento', metodo: 'Confronta i titoli dei file' };
    }
    return { text: context.target === 'index.html' ? '<title>' + title + '</title>' : '# ' + title, motivo: 'Cambio titolo.' };
  });

  const proposal = await prepare('Dopo', '');
  assert.equal(read('README.md'), '# Prima');
  const result = await applicaIntervento(proposal.id);
  assert.equal(result.passed, true, result.output);
  assert.equal(result.remembered, true);
  assert.equal(result.written.length, 2);
  assert.equal(fs.readFileSync(result.written[1].backup, 'utf8'), '# Prima');
  await assert.rejects(applicaIntervento(proposal.id), /già usato/);
  const next = await prepare('Errore', 'Confronta i titoli dei file');
  const failed = await applicaIntervento(next.id);
  assert.equal(failed.passed, false);
  assert.equal(failed.remembered, undefined);
  assert.equal(failed.written.length, 2);
  assert.deepEqual(failed.remaining, []);
  assert.equal(read('index.html'), '<title>Dopo</title>');
  const stale = await prepare('Nuovo', 'Confronta i titoli dei file');
  write('README.md', '# Esterno');
  await assert.rejects(applicaIntervento(stale.id), /è cambiato/);
  assert.equal(read('index.html'), '<title>Dopo</title>');
});
