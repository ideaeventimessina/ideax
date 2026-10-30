// Reel dal prompt: testo e scene → voce clonata → immagini verticali → musica → montaggio con sottotitoli.
// Ogni passo usa la fila della scheda video separatamente, così altri lavori possono inserirsi tra un passo e l'altro.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { OUTPUT_DIR, getSettings } from './store.js';
import { buildCatalog, pickModel, applyStyle, translate, looksItalian, fallbackTitle } from './router.js';
import { resolveBrain, askBrain } from './brain.js';
import { runModel, inGpuQueue } from './backends.js';
import * as engines from './engines.js';
import * as voices from './voices.js';
import * as music from './music.js';

const WORDS_PER_SECOND = 2.6; // ritmo tipico di un reel parlato in italiano

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, visual: { type: 'string' } },
        required: ['text', 'visual'],
        additionalProperties: false,
      },
    },
    music: { type: 'string' },
    caption: { type: 'string' },
    hashtags: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'scenes', 'music', 'caption', 'hashtags'],
  additionalProperties: false,
};

function planSystem(duration, scenes, style) {
  const words = Math.round(duration * WORDS_PER_SECOND);
  return `Sei un autore di reel per Instagram e TikTok. Scrivi un reel verticale di circa ${duration} secondi (circa ${words} parole in tutto).
Rispondi SOLO con un oggetto JSON:
- title: titolo breve in italiano.
- scenes: ${scenes} scene. Per ognuna:
  - text: la frase detta dalla voce fuori campo, in italiano parlato, chiara e diretta, 1–2 frasi brevi. La prima scena è un aggancio forte che fa fermare chi scorre (domanda, numero, affermazione sorprendente). L'ultima chiude con un invito all'azione.
  - visual: descrizione in INGLESE dell'immagine di quella scena, inquadratura verticale, concreta e visiva (soggetto, ambiente, luce, inquadratura), stile coerente in tutte le scene${style ? `: ${style}` : ''}. Niente testo scritto nell'immagine.
- music: descrizione in inglese della musica di sottofondo strumentale (genere, strumenti, atmosfera, BPM) adatta al tono.
- caption: didascalia del post in italiano, 1–3 frasi.
- hashtags: 5–8 hashtag pertinenti, senza #.`;
}

// Senza cervello: il testo lo scrive l'utente, ideax lo divide in scene da 1–2 frasi
function planFromScript(script, prompt, style) {
  const sentences = script.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  const scenes = [];
  for (const s of sentences) {
    const last = scenes[scenes.length - 1];
    if (last && last.text.split(' ').length < 9 && (last.text + ' ' + s).split(' ').length <= 22) last.text += ` ${s}`;
    else scenes.push({ text: s, visual: '' });
  }
  return {
    title: fallbackTitle(prompt || script),
    scenes,
    music: style ? `instrumental background music, ${style}` : 'modern uplifting instrumental background music for a social media reel, light percussion, 100 BPM',
    caption: '',
    hashtags: [],
  };
}

// Sottotitoli a blocchi di poche parole, distribuiti nel tempo della frase in proporzione alla lunghezza
export function captionChunks(text, start, duration, maxWords = 4) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks = [];
  for (let i = 0; i < words.length; i += maxWords) {
    // Non lasciare una parola sola alla fine
    const rest = words.length - i;
    const n = rest > maxWords && rest - maxWords === 1 ? maxWords - 1 : maxWords;
    chunks.push(words.slice(i, i + n).join(' '));
    i += n - maxWords;
  }
  const total = chunks.reduce((a, c) => a + c.length, 0) || 1;
  let t = start;
  return chunks.map((c) => {
    const d = (c.length / total) * duration;
    const out = { text: c, start: +t.toFixed(3), end: +(t + d).toFixed(3) };
    t += d;
    return out;
  });
}

function wavSeconds(file) {
  // WAV PCM: dimensione dei dati / byte al secondo
  const buf = fs.readFileSync(file);
  const byteRate = buf.readUInt32LE(28);
  let off = 12;
  while (off < buf.length - 8) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') return size / byteRate;
    off += 8 + size;
  }
  return 0;
}

// Unisce le voci delle scene allineandole all'inizio di ciascuna scena (silenzio dove non si parla)
function concatWavs(files, durations, scenes, out) {
  const parts = files.map((f) => (f ? fs.readFileSync(f) : null));
  const header = parts.find(Boolean);
  const byteRate = header.readUInt32LE(28);
  const blockAlign = header.readUInt16LE(32);
  const silence = (sec) => Buffer.alloc(Math.max(0, Math.round((sec * byteRate) / blockAlign)) * blockAlign);
  const datas = parts.map((b) => {
    if (!b) return Buffer.alloc(0);
    let off = 12;
    while (off < b.length - 8) {
      const size = b.readUInt32LE(off + 4);
      if (b.toString('ascii', off, off + 4) === 'data') return b.subarray(off + 8, off + 8 + size);
      off += 8 + size;
    }
    return Buffer.alloc(0);
  });
  const body = Buffer.concat(datas.flatMap((d, i) => {
    const spoken = d.length / byteRate;
    return [d, silence(scenes[i].duration - spoken)];
  }));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + body.length, 4); head.write('WAVE', 8);
  head.write('fmt ', 12); head.writeUInt32LE(16, 16);
  header.copy(head, 20, 20, 36); // formato, canali, frequenza, byte al secondo, allineamento, bit
  head.write('data', 36); head.writeUInt32LE(body.length, 40);
  fs.writeFileSync(out, Buffer.concat([head, body]));
}

// Controlla e completa un piano arrivato da fuori
export function normalizePlan(plan, prompt) {
  const scenes = (Array.isArray(plan.scenes) ? plan.scenes : [])
    .map((s) => (typeof s === 'string' ? { text: s } : s))
    .filter((s) => s && (String(s.text || '').trim() || s.image));
  if (!scenes.length) throw new Error('Il piano del reel non contiene scene: serve "scenes": [{ "text": "…", "visual": "…" }, …]');
  if (scenes.length > 20) throw new Error('Il piano ha troppe scene: massimo 20');
  return {
    title: plan.title || fallbackTitle(prompt || scenes[0].text || 'Reel'),
    scenes: scenes.map((s) => ({
      text: String(s.text || '').trim(),
      visual: String(s.visual || s.image_prompt || '').trim(),
      image: s.image || s.image_url || null,
      duration: s.duration,
    })),
    music: plan.music || 'modern uplifting instrumental background music for a social media reel, 100 BPM',
    caption: plan.caption || '',
    hashtags: Array.isArray(plan.hashtags) ? plan.hashtags : [],
  };
}

async function saveProvidedImage(src, base) {
  let buf;
  if (/^data:/.test(src)) buf = Buffer.from(src.slice(src.indexOf(',') + 1), 'base64');
  else if (/^https?:\/\//.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Immagine della scena non scaricabile (${res.status}): ${src}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else buf = Buffer.from(src, 'base64');
  const file = `${base}.img`;
  fs.writeFileSync(file, buf);
  return file;
}

export async function runReel(job, log) {
  const r = job.reel || {};
  const duration = Math.min(120, Math.max(10, Number(r.duration) || 30));
  const nScenes = Math.min(12, Math.max(3, Math.round(duration / 5)));
  const dir = fs.mkdtempSync(path.join(OUTPUT_DIR, `.reel-${job.id}-`));
  const step = (phase, s = 0, total = 0) => { job.progress = { phase, step: s, total }; };
  job.task = 'reel';
  job.modelName = 'Reel';
  job.status = 'running';

  try {
    // 1. Testo e scene
    step('Scrivo il testo');
    let plan;
    const catalog = buildCatalog();
    const brain = resolveBrain(catalog.all);
    if (r.plan) {
      // Piano già pronto da un altro sistema (es. billpro): si esegue così com'è, senza riscriverlo
      plan = normalizePlan(r.plan, job.prompt);
      log(`Piano ricevuto: ${plan.scenes.length} scene.`);
    } else if (r.script?.trim()) {
      plan = planFromScript(r.script, job.prompt, r.style);
      log(`Uso il tuo testo: ${plan.scenes.length} scene.`);
    } else if (brain.mode !== 'rules') {
      log(`Il cervello (${brain.label}) scrive testo e scene…`);
      plan = await askBrain(brain, planSystem(duration, nScenes, r.style), `Argomento del reel:\n${job.prompt}`, PLAN_SCHEMA);
      if (!plan?.scenes?.length) throw new Error('Il cervello non ha restituito le scene: riprova o scrivi tu il testo.');
    } else {
      throw new Error('Per scrivere il testo del reel serve un cervello (Impostazioni → Cervello: Ollama, LM Studio o un file .gguf). In alternativa scrivi tu il testo nel campo "Testo".');
    }
    job.title = plan.title || fallbackTitle(job.prompt);
    job.reelPlan = plan;
    job.routedPrompt = plan.scenes.map((s) => s.text).join(' ');

    // 2. Voce fuori campo, scena per scena (così conosciamo la durata esatta di ognuna)
    const voice = r.voice === false ? null : voices.findVoice(r.voice);
    if (r.voice !== false && !voice) throw new Error('Serve una voce: creala nella pagina Voce, oppure scegli "senza voce".');
    if (voice && !engines.isInstalled('voice')) throw new Error('Il motore voce non è installato: installalo dalla pagina Voce.');
    const durations = [];
    const voiceFiles = [];
    for (const [i, scene] of plan.scenes.entries()) {
      step('Registro la voce', i + 1, plan.scenes.length);
      if (!voice || !scene.text) {
        durations.push(Math.max(scene.text ? 2.5 : Number(scene.duration) || 2.5, scene.text.split(' ').length / WORDS_PER_SECOND));
        if (voice) voiceFiles.push(null);
        continue;
      }
      const out = await inGpuQueue(job, log, () => engines.call('voice', '/speak', {
        text: scene.text, language: r.language || voice.language || 'it', reference: voices.samplePath(voice.id), format: 'wav',
        ...(voice.defaults || {}),
      }));
      const f = path.join(dir, `voce-${i}.wav`);
      fs.writeFileSync(f, Buffer.from(out.data, 'base64'));
      voiceFiles.push(f);
      durations.push(wavSeconds(f));
    }
    if (voice) log(`Voce registrata con "${voice.name}".`);

    // 3. Immagini verticali, una per scena, sempre con lo stesso modello per uno stile coerente
    const picked = r.model
      ? { model: catalog.generators.find((m) => m.id === r.model || m.name === r.model), task: 'image_generate' }
      : pickModel('image_generate', catalog.generators);
    if (!picked?.model) throw new Error('Serve un modello di immagini: collegane uno nella pagina Modelli.');
    const model = picked.model;
    log(`Immagini con ${model.name}.`);
    const images = [];
    for (const [i, scene] of plan.scenes.entries()) {
      step('Creo le immagini', i + 1, plan.scenes.length);
      // Immagine fornita dal piano (foto del prodotto, logo…): si usa quella invece di generarla
      if (scene.image) {
        images.push(await saveProvidedImage(scene.image, path.join(dir, `scena-${i + 1}`)));
        continue;
      }
      let visual = scene.visual?.trim();
      if (!visual) visual = looksItalian(scene.text) ? await translate(scene.text).catch(() => scene.text) : scene.text;
      if (r.style) visual = `${visual}, ${r.style}`;
      const styled = applyStyle(model, `${visual}, vertical composition`, '');
      const sub = {
        id: `${job.id}-s${i + 1}`, prompt: scene.text, routedPrompt: styled.prompt, negativePrompt: styled.negativePrompt,
        attachments: [], loras: [], log: [], cancelled: job.cancelled,
        params: { ...(styled.styleParams || {}), ...(model.params || {}), aspect: '9:16', ...(r.seed != null ? { seed: Number(r.seed) + i } : {}) },
      };
      const res = await runModel(model, 'image_generate', sub, (m) => log(`Scena ${i + 1}: ${m}`));
      images.push(path.join(OUTPUT_DIR, path.basename(res[0].url)));
      if (job.cancelled) throw new Error('Annullato');
    }

    // 4. Tempi: ogni scena dura quanto la sua voce più una breve pausa
    const GAP = 0.35;
    let t = 0;
    const scenes = plan.scenes.map((s, i) => {
      // Una durata indicata nel piano vale come minimo (es. una scena senza testo che deve restare 2 secondi)
      const d = Math.max(Number(s.duration) || 0, durations[i] + (i < plan.scenes.length - 1 ? GAP : 1.0));
      const out = { image: images[i], start: +t.toFixed(3), duration: +d.toFixed(3), text: s.text, voice: durations[i] };
      t += d;
      return out;
    });
    const total = t;
    const captions = r.captions === false ? [] : scenes.flatMap((s) => captionChunks(s.text, s.start, s.voice));
    let voiceTrack = null;
    if (voiceFiles.some(Boolean)) {
      voiceTrack = path.join(dir, 'voce.wav');
      concatWavs(voiceFiles, durations, scenes, voiceTrack);
    }

    // 5. Musica di sottofondo della durata giusta
    let musicFile = null;
    if (r.music !== false) {
      if (engines.isInstalled('music')) {
        step('Compongo la musica');
        const desc = typeof r.music === 'string' && r.music.trim() ? r.music : plan.music;
        const m = await inGpuQueue(job, log, async () => {
          await fetch(`${getSettings().workerUrl}/unload`, { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(() => {});
          engines.stop('voice');
          return music.generate({ prompt: desc, duration: Math.ceil(total) + 2, instrumental: true, quality: 'high' },
            { isCancelled: () => job.cancelled });
        });
        musicFile = path.join(dir, 'musica.mp3');
        fs.writeFileSync(musicFile, m.buffer);
        log(`Musica: ${desc}`);
      } else {
        log('Motore musica non installato: reel senza musica di sottofondo.');
      }
    }

    // 6. Montaggio
    step('Monto il reel');
    const name = `${job.id}-reel-${crypto.randomUUID().slice(0, 4)}.mp4`;
    const output = path.join(OUTPUT_DIR, name);
    const res = await fetch(`${getSettings().workerUrl}/compose`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scenes: scenes.map(({ image, start, duration: d }) => ({ image, start, duration: d })),
        captions, voice: voiceTrack, music: musicFile, output,
        music_volume: voiceTrack ? Number(r.musicVolume ?? 0.18) : 0.8,
      }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `Montaggio: HTTP ${res.status}`);

    // Sottotitoli anche come file .srt, per chi li vuole caricare a parte
    const srt = captions.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
    const srtName = name.replace(/\.mp4$/, '.srt');
    fs.writeFileSync(path.join(OUTPUT_DIR, srtName), srt);

    // Copertina: l'immagine della prima scena, copiata accanto al reel
    const coverName = name.replace(/\.mp4$/, '-copertina.png');
    fs.copyFileSync(images[0], path.join(OUTPUT_DIR, coverName));
    job.results = [
      { url: `/outputs/${name}`, type: 'video/mp4', seconds: body.seconds },
      { url: `/outputs/${coverName}`, type: 'image/png', role: 'cover' },
      { url: `/outputs/${srtName}`, type: 'application/x-subrip', role: 'subtitles' },
    ];
    job.reason = `${plan.scenes.length} scene, ${Math.round(total)} secondi${voice ? `, voce "${voice.name}"` : ''}${musicFile ? ', musica di sottofondo' : ''}.`;
    job.status = 'done';
    log(`Reel pronto: ${Math.round(total)} secondi.`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function srtTime(s) {
  const ms = Math.round(s * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const sec = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  return `${h}:${m}:${sec},${String(ms % 1000).padStart(3, '0')}`;
}
