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
      assert.equal(context.memories[0]?.testo || '', expectedMemory);
      return { files: ['index.html', 'README.md'], tests: ['test.mjs'],
        memoriaId: context.memories[0]?.id || '', metodo: 'Confronta i titoli dei file' };
    }
    return { edits: [{ prima: context.originale, dopo: context.target === 'index.html' ? '<title>' + title + '</title>' : '# ' + title, tutte: false }] };
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
  let sawFailure = false;
  const failed = await applicaIntervento(next.id, (_, context) => {
    assert.match(context.failure.output, /AssertionError/);
    if (context.inventory) {
      sawFailure = true;
      assert.equal(read('README.md'), '# Dopo');
      return { files: ['README.md'], tests: [], memoriaId: '', metodo: 'Correzione verificata' };
    }
    assert.equal(context.originale, '# Errore');
    return { edits: [{ prima: '# Errore', dopo: '# Correzione', tutte: false }] };
  });
  assert.equal(failed.passed, false);
  assert.equal(sawFailure, true);
  assert.equal(failed.remembered, undefined);
  assert.equal(failed.written.length, 2);
  assert.deepEqual(failed.remaining, []);
  assert.equal(read('index.html'), '<title>Dopo</title>');
  assert.equal(read('README.md'), '# Dopo');
  assert.deepEqual(failed.repair.tests, ['test.mjs']);
  assert.equal(failed.repair.isRepair, true);
  const invalidRepair = await applicaIntervento(failed.repair.id, () => assert.fail('Non avviare una seconda correzione automatica.'));
  assert.equal(invalidRepair.passed, false);
  assert.deepEqual(invalidRepair.remaining, []);
  assert.equal(read('README.md'), '# Dopo');
  const stale = await prepare('Nuovo', 'Confronta i titoli dei file');
  write('README.md', '# Esterno');
  await assert.rejects(applicaIntervento(stale.id), /è cambiato/);
  assert.equal(read('index.html'), '<title>Dopo</title>');

  const other = path.join(root, 'altro-progetto');
  fs.mkdirSync(other);
  const paths = ['uno.txt', 'due.txt', 'tre.txt', 'quattro.txt', 'cinque.txt'];
  for (const file of paths) write(path.join('altro-progetto', file), 'Vecchio');
  write('altro-progetto/scelto.test.mjs', "import test from 'node:test'; test('verifica', () => {});");
  write('altro-progetto/escluso.test.mjs', "import test from 'node:test'; test('non pertinente', () => { throw Error('non eseguire'); });");
  const cross = await preparaIntervento(other, 'Aggiorna le schede', '', (_, context) => {
    if (context.inventory) {
      assert.deepEqual(context.testInventory.map(v => v.file), ['escluso.test.mjs', 'scelto.test.mjs']);
      assert.equal(context.memories[0].stessoProgetto, false);
      return { files: paths, tests: ['scelto.test.mjs'], memoriaId: context.memories[0].id, metodo: 'Verifica le schede con il test pertinente.' };
    }
    return { edits: [{ prima: 'Vecchio', dopo: 'Nuovo', tutte: false }] };
  });
  assert.equal(cross.memoria.stessoProgetto, false);
  assert.deepEqual(cross.tests, ['scelto.test.mjs']);
  assert.equal(cross.changes.length, 5);
  assert.deepEqual(cross.changes[0].differenza, { line: 1, beforeCount: 1, afterCount: 1, before: ['Vecchio'], after: ['Nuovo'] });
  const crossResult = await applicaIntervento(cross.id);
  assert.equal(crossResult.passed, true, crossResult.output);
  assert.equal(crossResult.written.length, 5);
});
