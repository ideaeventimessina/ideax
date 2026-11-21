// Catena di clip → Impagino: da un'idea a un video montato "con tutti i crismi".
// 1. il cervello scrive le scene (una clip ciascuna) e la musica;
// 2. ideax crea le clip una dopo l'altra (foto rifinita, poi animata) e la musica, sul PC;
// 3. le mette in una cartella e le passa al montatore di Impagino (sullo stesso PC), che monta sul ritmo,
//    fa i rallenty, il colore, i titoli e scrive anche il progetto CapCut da ritoccare a mano.
// Se il montatore non è acceso, la cartella resta pronta: la si apre da Impagino quando si vuole.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, OUTPUT_DIR, getSettings } from './store.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog } from './router.js';

let host = { createJob: null };
export function configure(fns) { host = { ...host, ...fns }; }

export const DIR = path.join(DATA_DIR, 'catene');
const montatoreUrl = () => (getSettings().montatore?.url || 'http://127.0.0.1:8765').replace(/\/+$/, '');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const loopback = (url) => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname);

function montatorePassword(url) {
  const explicit = process.env.IDEAX_MONTATORE_PASSWORD;
  if (explicit && (loopback(url) || new URL(url).protocol === 'https:')) return explicit;
  if (!loopback(url)) return '';
  try { return fs.readFileSync(path.join(os.homedir(), '.montatore', 'web_password'), 'utf8').trim(); }
  catch { return ''; }
}

async function connessioneMontatore() {
  const configured = getSettings().montatore?.url || process.env.IDEAX_MONTATORE_URL;
  const base = (configured || montatoreUrl()).replace(/\/+$/, '');
  const origins = configured ? [base] : [base, 'http://127.0.0.1:8080'];
  let diagnostic = 'Montatore non raggiungibile.';
  for (const origin of origins) {
    const candidates = origin.endsWith('/montatore') ? [origin] : [`${origin}/montatore`, origin];
    for (const url of candidates) {
      try {
        const address = new URL(url);
        if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password || address.search || address.hash) continue;
        let authorization;
        function request(endpoint, { timeout = 5000, headers, ...options } = {}) {
          return fetch(`${url}${endpoint}`, {
            ...options, redirect: 'error', signal: AbortSignal.timeout(timeout),
            headers: { ...headers, ...(authorization ? { Authorization: authorization } : {}) },
          });
        }
        let response = await request('/api/styles', { timeout: 2500 });
        const challenge = response.headers.get('www-authenticate') || '';
        if (response.status === 401 && /^Basic\s+realm\s*=\s*(?:"montatore"|montatore)\s*$/i.test(challenge)) {
          const password = montatorePassword(url);
          diagnostic = 'Il montatore richiede la propria password.';
          if (!password) continue;
          authorization = 'Basic ' + Buffer.from(`ideax:${password}`).toString('base64');
          response = await request('/api/styles', { timeout: 2500 });
          if (response.status === 401) diagnostic = 'La password del montatore è stata rifiutata.';
        }
        if (!response.ok) continue;
        const data = await response.json();
        let styles = Array.isArray(data) ? data : data?.styles;
        if (styles && !Array.isArray(styles) && typeof styles === 'object') styles = Object.keys(styles);
        if (!Array.isArray(styles)) continue;
        const stili = styles.map((style) => typeof style === 'string' ? style : style?.id || style?.name).filter(Boolean);
        return { url, request, stili };
      } catch { /* si prova il prossimo indirizzo */ }
    }
  }
  throw new Error(diagnostic);
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    titolo: { type: 'string' },
    sottotitolo: { type: 'string' },
    brief: { type: 'string' },
    musica: { type: 'string' },
    scene: {
      type: 'array',
      items: { type: 'object', properties: { descrizione: { type: 'string' } }, required: ['descrizione'] },
    },
  },
  required: ['titolo', 'brief', 'musica', 'scene'],
};

function planSystem(n, formato) {
  return [
    'Sei un regista di video brevi. Dall\'idea dell\'utente progetti un video fatto di clip da montare sul ritmo della musica.',
    `Scrivi esattamente ${n} scene, una per clip di circa 3-4 secondi, in un ordine che racconta una storia (apertura, sviluppo, chiusura).`,
    'Per ogni scena "descrizione" è il prompt per il generatore di immagini, in inglese, concreto e fotografico: soggetto, azione, luogo, luce, inquadratura (campo largo, primo piano, dettaglio), obiettivo. Alterna le inquadrature. Stesso stile, stessi personaggi e stessa palette in tutte le scene, descritti ogni volta allo stesso modo.',
    `Formato ${formato === '9:16' ? 'verticale 9:16 (reel, storie)' : 'orizzontale 16:9'}.`,
    '"musica": descrizione in inglese della base strumentale (genere, strumenti, bpm, atmosfera).',
    '"brief": due righe in italiano per il montatore: tono, ritmo, cosa deve sentire chi guarda.',
    '"titolo" e "sottotitolo": brevi, in italiano, da mettere in apertura.',
    'Rispondi solo con il JSON.',
  ].join('\n');
}

function fallbackPlan(idea, n) {
  return { titolo: idea.slice(0, 40), sottotitolo: '', brief: idea, musica: 'cinematic uplifting instrumental, 100 bpm', scene: Array.from({ length: n }, (_, i) => ({ descrizione: `${idea}, scene ${i + 1} of ${n}, cinematic photo` })) };
}

async function waitJob(job) {
  await job.done;
  if (job.status !== 'done') throw new Error(job.error || 'lavoro non riuscito');
  return job.results || [];
}

const fileOf = (url) => path.join(OUTPUT_DIR, path.basename(url));

export async function montatoreStato() {
  try {
    const { url, stili } = await connessioneMontatore();
    return { online: true, url, stili };
  } catch (error) {
    return { online: false, errore: error.message };
  }
}

// job.catena: { clip, formato, stile, musica_provenienza, monta }
export async function runCatena(job, log) {
  const c = job.catena || {};
  const clipUrls = c.clip_urls ?? null;
  if (clipUrls !== null && (!Array.isArray(clipUrls) || clipUrls.length < 2 || clipUrls.length > 12
    || clipUrls.some((url) => typeof url !== 'string' || !/^\/outputs\/[\w.-]+\.mp4$/i.test(url)
      || !fs.lstatSync(fileOf(url), { throwIfNoEntry: false })?.isFile()))) {
    throw new Error('clip_urls richiede da 2 a 12 MP4 già presenti negli output di IDEAX.');
  }
  const n = Math.min(12, Math.max(2, Number(c.clip) || 6));
  const formato = c.formato === '16:9' ? '16:9' : '9:16';
  const step = (phase, s = 0, total = 0) => { job.progress = { phase, step: s, total }; };
  Object.assign(job, { task: 'catena', modelName: 'Catena di clip', status: 'running' });

  // 1. Le scene
  step('Scrivo le scene');
  const brain = resolveBrain(buildCatalog().all);
  let plan;
  if (clipUrls) {
    plan = fallbackPlan(job.prompt, 0);
  } else if (Array.isArray(c.scene) && c.scene.length) {
    plan = { ...fallbackPlan(job.prompt, c.scene.length), scene: c.scene.map((d) => ({ descrizione: String(d) })) };
  } else if (brain.mode !== 'rules') {
    log(`Il cervello (${brain.label}) scrive ${n} scene…`);
    plan = await chatBrain(brain, [{ role: 'system', content: planSystem(n, formato) }, { role: 'user', content: `Idea del video:\n${job.prompt}` }], PLAN_SCHEMA, { temperature: 0.7, maxTokens: 2500 });
    if (!plan?.scene?.length) plan = fallbackPlan(job.prompt, n);
  } else {
    plan = fallbackPlan(job.prompt, n);
  }
  plan.scene = plan.scene.slice(0, n);
  job.title = plan.titolo || job.prompt.slice(0, 40);
  log(clipUrls ? `Riutilizzo ${clipUrls.length} clip. Titolo: ${job.title}` : `Scene: ${plan.scene.length}. Titolo: ${job.title}`);

  const dir = path.join(DIR, `${new Date().toISOString().slice(0, 10)}-${job.id}`);
  const clipsDir = path.join(dir, 'clip');
  fs.mkdirSync(clipsDir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'piano.json'), JSON.stringify({ idea: job.prompt, formato, ...plan }, null, 2));

  // 2. Le clip in due fasi, per non far rimbalzare la scheda video fra due modelli grandi a ogni clip:
  //    prima tutte le foto di partenza (rifinite: pelle e volti), poi tutte le animazioni.
  const n2 = plan.scene.length;
  const videoParams = { aspect: formato, seconds: c.veloce ? 3 : 4, ...(c.veloce ? { veloce: true } : {}) };
  const stills = [];
  for (const [i, sc] of plan.scene.entries()) {
    if (job.cancelled) throw new Error('Annullato');
    step(`Foto ${i + 1} di ${n2}`, i, n2 * 2);
    log(`Foto ${i + 1}: ${sc.descrizione.slice(0, 120)}`);
    try {
      const sub = await host.createJob({ prompt: sc.descrizione, task: 'image_generate', params: { aspect: formato } }, { client: 'catena' });
      job.current = sub.id;
      const img = (await waitJob(sub)).find((r) => r.type?.startsWith('image/'));
      if (!img) throw new Error('nessuna immagine tra i risultati');
      stills.push({ i, sc, img });
    } catch (err) {
      if (job.cancelled) throw err;
      log(`Foto ${i + 1} non riuscita: ${err.message}`);
    }
  }
  const clips = (clipUrls || []).map((url, i) => {
    const file = path.join(clipsDir, `${String(i + 1).padStart(2, '0')}.mp4`);
    fs.copyFileSync(fileOf(url), file);
    return { url, file };
  });
  for (const { i, sc, img } of stills) {
    if (job.cancelled) throw new Error('Annullato');
    step(`Clip ${i + 1} di ${n2}`, n2 + i, n2 * 2);
    try {
      const buf = fs.readFileSync(fileOf(img.url));
      const sub = await host.createJob({
        prompt: sc.descrizione, task: 'image_to_video', params: videoParams,
        attachments: [{ name: path.basename(img.url), type: img.type, dataUrl: `data:${img.type};base64,${buf.toString('base64')}` }],
      }, { client: 'catena' });
      job.current = sub.id;
      const video = (await waitJob(sub)).find((r) => r.type === 'video/mp4');
      if (!video) throw new Error('nessun video tra i risultati');
      const dest = path.join(clipsDir, `${String(i + 1).padStart(2, '0')}.mp4`);
      fs.copyFileSync(fileOf(video.url), dest);
      clips.push({ url: video.url, file: dest });
    } catch (err) {
      if (job.cancelled) throw err;
      log(`Clip ${i + 1} non riuscita: ${err.message}`);
    }
  }
  if (clips.length < 2) throw new Error('Sono riuscite meno di due clip: controlla il motore video nella pagina Modelli e riprova');

  // 3. La musica (motore musica di ideax, sul PC)
  let music = null;
  if (!c.audio_originale && c.musica_file && fs.existsSync(c.musica_file)) music = c.musica_file;
  else if (!c.audio_originale) {
    step('Compongo la musica');
    try {
      const sub = await host.createJob({ prompt: plan.musica, kind: 'music', music: { instrumental: true, duration: Math.max(20, Math.min(120, clips.length * 4 + 4)) } }, { client: 'catena' });
      const res = await waitJob(sub);
      const audio = res.find((r) => r.type?.startsWith('audio/'));
      if (audio) {
        music = path.join(dir, `musica${path.extname(audio.url) || '.mp3'}`);
        fs.copyFileSync(fileOf(audio.url), music);
      }
    } catch (err) {
      log(`Musica non riuscita (${err.message}): il montatore ne chiederà una`);
    }
  }

  const results = clips.map((x) => ({ url: x.url, type: 'video/mp4' }));
  job.catenaInfo = { cartella: dir, clip: clips.length, musica: music };

  // 4. Il montaggio con Impagino
  if (c.monta === false) {
    log(`Clip pronte in ${clipsDir}: aprile da Impagino quando vuoi.`);
    return results;
  }
  let montatore;
  try { montatore = await connessioneMontatore(); }
  catch (error) {
    log(`${error.message} Le clip sono pronte in ${clipsDir}.`);
    job.catenaInfo.daMontare = true;
    return results;
  }
  if (!music && !c.audio_originale) {
    log('Senza musica il montatore non può montare: clip pronte nella cartella.');
    job.catenaInfo.daMontare = true;
    return results;
  }
  const montato = await monta(job, {
    clipsDir, music, plan, stile: c.stile, provenienza: c.musica_provenienza, log, step, montatore,
    audioOriginale: c.audio_originale, draftCapcut: c.draft_capcut,
  });
  return [...montato, ...results];
}

// Passa la cartella al montatore e aspetta il video montato
export async function monta(job, { clipsDir, music, plan, stile, provenienza, log, step, montatore, audioOriginale, draftCapcut }) {
  const connection = montatore || await connessioneMontatore();
  step('Monto con Impagino');
  log(`Passo ${clipsDir} al montatore di Impagino`);
  const body = {
    clips: clipsDir,
    brief: plan.brief || job.prompt,
    style: stile || 'greco',
    out: `${(plan.titolo || 'Montaggio ideax').slice(0, 48)} - ${job.id}`,
    ...(audioOriginale ? { modo: 'sequenza', audio: 'originale' } : { music: [music] }),
    ...(draftCapcut === false ? { draft_capcut: false } : {}),
    // La musica l'ha composta ideax sul PC: la provenienza la dichiara chi monta (regola di Impagino)
    musica: ['suno-pro', 'licenziata', 'da-dichiarare'].includes(provenienza) ? provenienza : 'da-dichiarare',
    title: plan.titolo || undefined,
    subtitle: plan.sottotitolo || undefined,
  };
  const r = await connection.request('/api/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 20000 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.ok || typeof d.job !== 'string' || !d.job) throw new Error(d.error === 'capcut_aperto' ? 'CapCut è aperto: chiudilo e riprova (il montatore scrive il progetto CapCut)' : `Montatore: ${d.error || `HTTP ${r.status}`}`);
  let last = '';
  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    if (job.cancelled) throw new Error('Annullato');
    const status = await connection.request(`/api/status/${encodeURIComponent(d.job)}`);
    if (!status.ok) throw new Error(`Stato del montatore non disponibile (HTTP ${status.status}).`);
    const s = await status.json();
    if (s.step && s.step !== last) { last = s.step; log(`Impagino: ${s.step}`); step(`Impagino: ${s.step}`); }
    if (s.stato === 'errore') throw new Error(`Montatore: ${s.errore}`);
    if (s.stato === 'fatto') {
      const v = s.risultato || {};
      const prefix = new URL(connection.url).pathname.replace(/\/$/, '');
      const endpoint = prefix && v.url?.startsWith(`${prefix}/output/`) ? v.url.slice(prefix.length) : v.url;
      if (typeof endpoint !== 'string' || !/^\/output\/[^/?#]+\.mp4$/i.test(endpoint)) {
        throw new Error('Il montatore ha restituito un indirizzo video non valido.');
      }
      const res = await connection.request(endpoint, { timeout: 120_000 });
      if (!res.ok) throw new Error(`Non riesco a scaricare il montato (${res.status})`);
      const name = `${job.id}-montato.mp4`;
      const video = Buffer.from(await res.arrayBuffer());
      if (job.cancelled) throw new Error('Annullato');
      if (video.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Il montatore non ha restituito un file MP4.');
      fs.writeFileSync(path.join(OUTPUT_DIR, name), video);
      log(`Montato: ${v.tagli} tagli, ${v.durata} s${v.rallenty ? `, ${v.rallenty} rallenty` : ''}${v.draft ? `. Progetto CapCut: ${v.draft}` : ''}`);
      if (v.draft_errore) log(`Impagino: ${v.draft_errore}`);
      job.catenaInfo = { ...(job.catenaInfo || {}), montato: true, capcut: v.draft || null, musica_provenienza: v.musica };
      return [{ url: `/outputs/${name}`, type: 'video/mp4' }];
    }
    if (s.stato === 'sconosciuto') throw new Error('Il montatore ha perso il lavoro (riavviato?): riprova');
    await wait(1000);
  }
  throw new Error('Il montatore non ha completato il lavoro entro 30 minuti.');
}
