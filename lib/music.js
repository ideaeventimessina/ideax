// Musica con ACE-Step 1.5: ideax parla con il server REST ufficiale del motore (porta 7872).
// /release_task crea il lavoro, /query_result ne segue lo stato, /v1/audio restituisce il file.
import * as engines from './engines.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(base, route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code && data.code !== 200)) throw new Error(`Motore musica: ${data.error || `HTTP ${res.status}`}`);
  return data.data;
}

// Parametri di ideax → parametri di ACE-Step
export function toTask(opts) {
  const lyrics = String(opts.lyrics || '').trim();
  // Canzone senza testo: il "pianificatore" di ACE-Step scrive da solo testo e descrizione partendo dalla richiesta
  const autoLyrics = opts.instrumental === false && !lyrics;
  const instrumental = !autoLyrics && (opts.instrumental !== false || !lyrics);
  const task = {
    prompt: opts.prompt,
    lyrics: instrumental ? '[Instrumental]' : lyrics,
    ...(autoLyrics ? { sample_mode: true, sample_query: opts.prompt } : {}),
    vocal_language: opts.language || 'it',
    audio_duration: Math.min(600, Math.max(10, Number(opts.duration) || 30)),
    audio_format: opts.format === 'wav' ? 'wav' : 'mp3',
    batch_size: 1,
    // Il "pianificatore" (LM) migliora struttura e qualità; si può spegnere per andare più veloci
    thinking: opts.quality !== 'fast',
    inference_steps: Number(opts.steps) || 8,
  };
  if (opts.bpm) task.bpm = Math.min(300, Math.max(30, Number(opts.bpm)));
  if (opts.key) task.key_scale = String(opts.key);
  if (opts.seed != null && opts.seed !== '') Object.assign(task, { use_random_seed: false, seed: Number(opts.seed) });
  return task;
}

export async function generate(opts, { onProgress, isCancelled } = {}) {
  // Primo brano dopo l'avvio del motore: ACE-Step carica i modelli e prepara il pianificatore (più lento)
  const coldStart = !engines.listEngines().find((e) => e.id === 'music')?.running;
  const base = await engines.ensureRunning('music');
  const task = toTask(opts);
  const { task_id: id } = await post(base, '/release_task', task);
  const started = Date.now();
  for (;;) {
    await sleep(1500);
    engines.touch('music');
    if (isCancelled?.()) throw new Error('Annullato');
    const [r] = await post(base, '/query_result', { task_id_list: [id] });
    if (r?.status === 2) throw new Error(`Motore musica: generazione non riuscita${r.error ? ` (${r.error})` : ''}`);
    if (r?.status === 1) {
      const result = (typeof r.result === 'string' ? JSON.parse(r.result) : r.result)[0];
      const file = await fetch(base + result.file, { signal: AbortSignal.timeout(120_000) });
      if (!file.ok) throw new Error(`Motore musica: download del brano non riuscito (${file.status})`);
      return {
        buffer: Buffer.from(await file.arrayBuffer()),
        type: task.audio_format === 'wav' ? 'audio/wav' : 'audio/mpeg',
        metas: result.metas || {},
        seconds: Number(result.metas?.duration) || task.audio_duration,
        elapsed: Math.round((Date.now() - started) / 1000),
      };
    }
    onProgress?.({ phase: 'Compongo', elapsed: Math.round((Date.now() - started) / 1000), coldStart, detail: engines.lastLog('music') });
    if (Date.now() - started > 30 * 60 * 1000) throw new Error('Motore musica: tempo scaduto');
  }
}
