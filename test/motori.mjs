import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-motori-'));
const { saveSettings } = await import('../lib/store.js');
const engines = await import('../lib/engines.js');

test('la voce mantenuta pronta restituisce il risultato e conserva gli errori del motore', async (t) => {
  saveSettings({ voice: { keepWarm: true } });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.endsWith('/health')) return Response.json({ ok: true });
    if (url.endsWith('/speak')) return Response.json({ data: 'wav' });
    return Response.json({ detail: 'Campione assente' }, { status: 422 });
  });
  assert.deepEqual(await engines.call('voice', '/speak', { text: 'Prova' }), { data: 'wav' });
  assert.doesNotThrow(() => engines.touch('voice'));
  await assert.rejects(engines.call('voice', '/prepare', {}), /Campione assente/);
});
