import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-code-'));
const { genera } = await import('../lib/siti.js');
const { saveSettings } = await import('../lib/store.js');

const broken = '<html><body><script>let count = 0; function count() {}</script></body></html>';
const working = '<html><body><output id="count">0</output><script>let value = 0;</script></body></html>';

test('Studio Code ritenta una volta se il JavaScript generato non compila', async (t) => {
  const requests = [];
  const replies = [broken, working, broken, broken];
  const model = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: replies.shift() } }] }));
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  t.after(() => { model.closeAllConnections(); model.close(); });
  saveSettings({ brain: { mode: 'server', serverUrl: `http://127.0.0.1:${model.address().port}/v1` } });

  assert.equal((await genera({ descrizione: 'Crea un contatore' })).html, working);
  assert.equal(requests.length, 2);
  assert.match(requests[1].messages.at(-1).content, /count/);
  await assert.rejects(genera({ descrizione: 'Crea un altro contatore' }), /contiene un errore/);
  assert.equal(requests.length, 4);
});
