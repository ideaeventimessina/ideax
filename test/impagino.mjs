import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-impagino-'));
process.env.IDEAX_MONTATORE_PASSWORD = 'password-di-prova';
const { saveSettings, OUTPUT_DIR } = await import('../lib/store.js');
const { montatoreStato, runCatena } = await import('../lib/catena.js');

test('catena riusa le clip e scarica il video dal blueprint autenticato', async (t) => {
  const mp4 = Buffer.from([0, 0, 0, 8, 102, 116, 121, 112]);
  for (const name of ['prima.mp4', 'seconda.mp4']) fs.writeFileSync(path.join(OUTPUT_DIR, name), mp4);
  let create;
  let downloads = 0;
  const server = createServer(async (req, res) => {
    const expected = 'Basic ' + Buffer.from('ideax:password-di-prova').toString('base64');
    if (req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="montatore"' });
      return res.end();
    }
    if (req.url === '/montatore/output/finale.mp4') {
      downloads++;
      res.setHeader('Content-Type', 'video/mp4');
      return res.end(mp4);
    }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/montatore/api/styles') return res.end('{"styles":[{"name":"greco"}]}');
    if (req.url === '/montatore/api/create') {
      let body = '';
      for await (const chunk of req) body += chunk;
      create = JSON.parse(body);
      return res.end('{"ok":true,"job":"montato"}');
    }
    if (req.url === '/montatore/api/status/montato') {
      return res.end('{"stato":"fatto","risultato":{"url":"/output/finale.mp4","tagli":2,"durata":5,"musica":"originale"}}');
    }
    res.writeHead(404);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  saveSettings({ montatore: { url: base } });
  assert.deepEqual(await montatoreStato(), { online: true, url: `${base}/montatore`, stili: ['greco'] });

  const job = {
    id: 'prova', prompt: 'Montaggio di prova',
    catena: { clip_urls: ['/outputs/prima.mp4', '/outputs/seconda.mp4'], audio_originale: true },
  };
  const results = await runCatena(job, () => {});
  assert.deepEqual(fs.readdirSync(create.clips).sort(), ['01.mp4', '02.mp4']);
  assert.equal(create.modo, 'sequenza');
  assert.equal(create.audio, 'originale');
  assert.equal(downloads, 1);
  assert.equal(job.catenaInfo.montato, true);
  assert.equal(results[0].url, '/outputs/prova-montato.mp4');
  assert.deepEqual(fs.readFileSync(path.join(OUTPUT_DIR, 'prova-montato.mp4')), mp4);
});
