// Personaggio parlante: un personaggio qualsiasi (non il tuo gemello) che dice un testo, con la voce scelta e le
// labbra a tempo. È una catena di motori che ideax ha già:
//   1. la foto del personaggio (allegata, oppure creata e rifinita: pelle e volti);
//   2. un video di qualche secondo del personaggio che parla verso la camera (Wan 2.2 dalla foto);
//   3. la voce (Libreria voci o voce clonata) che legge il testo;
//   4. LatentSync rifà le labbra del video sulla voce (il video si ripete se la voce è più lunga).
import fs from 'node:fs';
import path from 'node:path';
import { OUTPUT_DIR } from './store.js';
import * as engines from './engines.js';
import * as voices from './voices.js';
import { freeGpu } from './twin.js';

let host = { createJob: null };
export function configure(fns) { host = { ...host, ...fns }; }

async function waitJob(job) {
  await job.done;
  if (job.status !== 'done') throw new Error(job.error || 'lavoro non riuscito');
  return job.results || [];
}
const fileOf = (url) => path.join(OUTPUT_DIR, path.basename(url));
const dataUrl = (r) => `data:${r.type};base64,${fs.readFileSync(fileOf(r.url)).toString('base64')}`;

// job.personaggio: { descrizione, voce, lingua, formato }; job.prompt = il testo da dire; allegato facoltativo = la foto
export async function runPersonaggio(job, log) {
  const p = job.personaggio || {};
  const voice = voices.findVoice(p.voce);
  if (!voice) throw new Error('Serve una voce: aggiungine una dalla Libreria voci (pagina Voce) o creane una');
  for (const [id, nome] of [['voice', 'Voce'], ['lipsync', 'Gemello video']]) {
    if (!engines.isInstalled(id)) throw new Error(`Serve il motore "${nome}": installalo dalla pagina Modelli`);
  }
  const formato = p.formato === '16:9' ? '16:9' : '9:16';
  Object.assign(job, { task: 'talk', modelName: `Personaggio · voce ${voice.name}`, title: job.title || (p.descrizione || job.prompt).slice(0, 60), routedPrompt: job.prompt, brain: 'foto + Wan + voce + LatentSync', status: 'running' });
  job.startedAt = Date.now();
  const step = (phase) => { job.progress = { phase }; log(phase); };

  // 1. La foto
  let foto = job.attachments.find((a) => a.type?.startsWith('image/'));
  if (!foto) {
    if (!p.descrizione) throw new Error('Descrivi il personaggio o allega la sua foto');
    step('Creo la foto del personaggio');
    const sub = await host.createJob({ prompt: `photorealistic portrait of ${p.descrizione}, facing the camera, mouth slightly open as if speaking, natural light, sharp focus`, task: 'image_generate', params: { aspect: formato } }, { client: 'personaggio' });
    const img = (await waitJob(sub)).find((r) => r.type?.startsWith('image/'));
    if (!img) throw new Error('Non sono riuscito a creare la foto del personaggio');
    foto = { name: path.basename(img.url), type: img.type, dataUrl: dataUrl(img) };
  }
  if (job.cancelled) throw new Error('Annullato');

  // 2. Il video che parla
  step('Animo il personaggio');
  const vjob = await host.createJob({
    prompt: `${p.descrizione || 'the person'} talking naturally to the camera, subtle head and shoulder movements, blinking, expressive face, static camera`,
    task: 'image_to_video', params: { aspect: formato, seconds: 5 }, attachments: [foto],
  }, { client: 'personaggio' });
  const clip = (await waitJob(vjob)).find((r) => r.type === 'video/mp4');
  if (!clip) throw new Error('Non sono riuscito ad animare il personaggio');
  if (job.cancelled) throw new Error('Annullato');

  // 3. La voce
  await freeGpu('voice');
  step(`Leggo il testo con la voce "${voice.name}"`);
  job.backend = 'voice';
  const speech = await engines.call('voice', '/speak', {
    text: job.prompt, language: p.lingua || voice.language || 'it', reference: voices.samplePath(voice.id), format: 'wav', ...(voice.defaults || {}),
  });
  const audio = path.join(OUTPUT_DIR, `${job.id}-voce.wav`);
  fs.writeFileSync(audio, Buffer.from(speech.data, 'base64'));
  engines.stop('voice');
  if (job.cancelled) throw new Error('Annullato');

  // 4. Le labbra
  step('Muovo le labbra sulla voce');
  job.backend = 'lipsync';
  const out = path.join(OUTPUT_DIR, `${job.id}-personaggio.mp4`);
  await engines.call('lipsync', '/lipsync', { video: fileOf(clip.url), audio, out }, {
    timeout: 60 * 60 * 1000,
    onProgress: (pr) => { job.progress = pr.total ? { step: pr.step, total: pr.total, phase: pr.phase || 'Muovo le labbra' } : { phase: pr.phase || 'Carico il modello' }; },
  });
  return [{ url: `/outputs/${path.basename(out)}`, type: 'video/mp4', seconds: speech.seconds }];
}
