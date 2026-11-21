import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.IDEAX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-video-'));
for (const id of ['comfyui', 'wan', 'wan14b']) {
  const engine = path.join(process.env.IDEAX_HOME, 'runtime', 'engines', id);
  fs.mkdirSync(engine, { recursive: true });
  fs.writeFileSync(path.join(engine, 'installed.json'), '{}');
}

const { buildCatalog, route } = await import('../lib/router.js');

test('i due Wan installati si possono selezionare separatamente', async () => {
  const ids = buildCatalog().generators.filter((model) => model.arch === 'wan').map((model) => model.id);
  assert.deepEqual(ids, ['engine-wan14b', 'engine-wan']);
  const explicit = await route('Stable studio shot', [], {
    forceModelId: 'engine-wan14b', forceTask: 'video_generate', literalPrompt: true, fastVideo: true,
  });
  assert.equal(explicit.model.id, 'engine-wan14b');
});

test('la modalità veloce sceglie Wan 5B, il video standard conserva la priorità 14B', async () => {
  const options = { forceTask: 'image_to_video' };
  const photo = [{ type: 'image/png' }];
  const standard = await route('Slow camera movement', photo, options);
  const fast = await route('Slow camera movement', photo, { ...options, fastVideo: true });
  assert.equal(standard.model.id, 'engine-wan14b');
  assert.equal(fast.model.id, 'engine-wan');
});
