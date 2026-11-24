import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';

test('La Regia conserva il brief, legge lo stato e anima solo la foto pronta', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-conversazione-'));
  process.env.IDEAX_HOME = home;
  try {
    const store = await import('../lib/store.js');
    const chats = await import('../lib/chats.js');
    const agent = await import('../lib/agent.js');
    store.saveSettings({ brain: { mode: 'server', serverUrl: 'http://127.0.0.1:1' } });
    store.saveServer({ name: 'Motori di prova', type: 'custom', endpoint: 'http://127.0.0.1:1', capabilities: ['image_generate', 'image_to_video'] });
    const jobs = new Map();
    agent.configure({
      getJob: id => jobs.get(id),
      createJob: async body => {
        const job = { ...body, id: String(jobs.size + 1), status: 'running', title: 'Prova' };
        jobs.set(job.id, job);
        return job;
      },
    });
    const chat = chats.createChat();
    const say = text => agent.send(chat, { text });
    const ready = id => {
      const url = `/outputs/prova-${id}.png`;
      fs.writeFileSync(path.join(store.OUTPUT_DIR, `prova-${id}.png`), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUuoAAAAASUVORK5CYII=', 'base64'));
      Object.assign(jobs.get(id), { status: 'done', results: [{ url, type: 'image/png' }] });
    };

    assert.deepEqual((await say('Crea una foto di una teiera rossa')).jobs, ['1']);
    ready('1');
    assert.deepEqual((await say('Aggiungi una tazza blu')).jobs, ['2']);
    ready('2');
    assert.deepEqual((await say('Falla con luce del tramonto')).jobs, ['3']);
    assert.match(jobs.get('3').prompt, /teiera rossa[\s\S]*tazza blu[\s\S]*luce del tramonto/);
    assert.match((await say('È pronta?')).content, /in corso/);
    assert.deepEqual((await say('Anima questa foto per 3 secondi')).jobs, ['3']);
    assert.equal(jobs.size, 3);
    ready('3');
    assert.match((await say('È pronta?')).content, /completato/);
    assert.deepEqual((await say('Anima questa foto per 3 secondi')).jobs, ['4']);
    assert.equal(jobs.get('4').task, 'image_to_video');
    assert.equal(jobs.get('4').attachments[0].name, 'prova-3.png');
    assert.deepEqual(jobs.get('4').params, { veloce: true, seconds: 3 });
    Object.assign(jobs.get('4'), { status: 'error', error: 'Motore non raggiungibile' });
    const riposta = await say('È partito?');
    assert.match(riposta.content, /fallito · Motore non raggiungibile/);
    assert.equal(jobs.size, 4);

    let calls = 0;
    const fakeBrain = createServer(async (req, res) => {
      for await (const _ of req) { /* Consuma il corpo prima di rispondere. */ }
      calls++;
      const out = calls === 1
        ? { reply: 'Genero una foto.', action: { tool: 'crea_immagine' } }
        : { reply: 'Va bene, partiamo dalla teiera.', action: { tool: 'nessuna' } };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(out) } }] }));
    });
    await new Promise(resolve => fakeBrain.listen(0, '127.0.0.1', resolve));
    try {
      store.saveSettings({ brain: { serverUrl: `http://127.0.0.1:${fakeBrain.address().port}` } });
      const saluto = await agent.send(chats.createChat(), { text: 'Ciao, oggi lavoriamo su una teiera rossa.' });
      assert.equal(saluto.content, 'Va bene, partiamo dalla teiera.');
      assert.equal(calls, 2);
      assert.equal(jobs.size, 4);
    } finally {
      await new Promise(resolve => fakeBrain.close(resolve));
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
