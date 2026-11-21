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
import { durataWav, voceNativa, parla as parlaKokoro } from './voicelib.js';
import { detectGpu } from './runtime.js';
import { segmentiVoce } from '../public/regia-voce.js';

const WORDS_PER_SECOND = 2.6; // ritmo tipico di un reel parlato in italiano

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    scenes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { text: { type: 'string' }, visual: { type: 'string' }, headline: { type: 'string' } },
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

export function puntiRichiesti(tema) {
  return Number(String(tema).match(/\b([2-9]|10)\s+(?:cose|errori|motivi|idee|consigli|trucchi|passi|strategie|regole|punti|segnali|modi|domande|proposte)\b/i)?.[1] || 0);
}

export function elencoCompleto(plan, punti) {
  if (!punti) return true;
  const voci = (plan?.scenes || []).flatMap((scena) => {
    const m = String(scena.text || '').match(/^\s*(\d+)[.)]\s+(\S.+)$/s);
    return m ? [[Number(m[1]), m[2].toLowerCase().trim()]] : [];
  });
  return voci.length === punti && new Set(voci.map((v) => v[1])).size === punti && voci.every((v, i) => v[0] === i + 1);
}

const ICONE = ['ascolto', 'dialogo', 'preparazione', 'tempo', 'limite', 'alternativa', 'fiducia', 'accordo', 'riepilogo', 'attenzione'];

export function iconaScheda(testo, proposta) {
  const soggetti = [
    ['ascolto', /\b(?:ascolt\w*|esigenz\w*|emozion\w*)\b/i],
    ['alternativa', /\b(?:alternativ\w*|opzion\w*|piano b)\b/i],
    ['tempo', /\b(?:temp[oi]|scadenz\w*|fretta|pazienz\w*)\b/i],
    ['limite', /\b(?:limit\w*|confin\w*|sogli\w*)\b/i],
    ['riepilogo', /\b(?:riepilog\w*|punti d[’']accordo|accordo per iscritt\w*)\b/i],
  ];
  return soggetti.find(([, pattern]) => pattern.test(testo))?.[0] || (ICONE.includes(proposta) ? proposta : 'attenzione');
}

function planSystem(duration, scenes, style, punti, editoriale) {
  if (editoriale) return [
    'Scrivi un reel italiano con tono calmo, concreto e rispettoso. Evita allarmismo, urgenza, battute infantili, promesse o regali inventati.',
    'Restituisci JSON con title, scenes, music, caption, hashtags. Per ogni scena restituisci text, headline e visual.',
    'Usa circa ' + Math.round(duration * 1.55) + ' parole in tutto per lasciare tempo alle pause, in ' + scenes + ' scene.',
    punti ? 'Scrivi esattamente ' + punti + ' punti distinti, una scena ciascuno, con text che comincia da "1. " a "' + punti + '. ". Un errore e una conseguenza concreta per punto. Nessuna apertura o chiusura separata.' : 'Apri con il tema e chiudi con un consiglio pratico.',
    'headline è una breve azione concreta con il suo oggetto: "Ascolta le esigenze", "Prepara un’alternativa". Evita titoli vaghi come "Non ignorare" e parole ripetute. visual contiene una sola icona da questo elenco: ' + ICONE.join(', ') + '.',
    'Una frase breve per scena, niente maiuscole enfatiche. Usa punteggiatura naturale e lascia respiro dopo ogni punto.',
  ].filter(Boolean).join('\n');
  const words = Math.round(duration * 2.15);
  return `Sei un autore di reel per Instagram e TikTok. Scrivi un reel verticale di circa ${duration} secondi (circa ${words} parole in tutto).
Rispondi SOLO con un oggetto JSON:
- title: titolo breve in italiano.
- scenes: ${scenes} scene. Per ognuna:
  - text: la frase detta dalla voce fuori campo, in italiano parlato, chiara e diretta, 1–2 frasi brevi. La prima scena è un aggancio forte che fa fermare chi scorre (domanda, numero, affermazione sorprendente). L'ultima chiude con un invito all'azione.
  - visual: descrizione in INGLESE dell'immagine di quella scena, inquadratura verticale, concreta e visiva (soggetto, ambiente, luce, inquadratura), stile coerente in tutte le scene${style ? `: ${style}` : ''}. Niente testo scritto nell'immagine.
- music: descrizione in inglese della musica di sottofondo strumentale (genere, strumenti, atmosfera, BPM) adatta al tono.
- caption: didascalia del post in italiano, 1–3 frasi.
- hashtags: 5–8 hashtag pertinenti, senza #.
${punti ? `L’argomento richiede ${punti} punti. Dopo un aggancio breve, dedica una scena distinta a ciascuno dei ${punti} punti. Il campo text di ogni punto deve cominciare con il suo numero e un punto, da "1. " a "${punti}. ". Scrivi tutti i punti con consigli concreti e chiudi in una scena separata. L’aggancio e la chiusura non sono punti dell’elenco.` : ''}`;
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

// Unisce le voci delle scene allineandole all'inizio di ciascuna scena (silenzio dove non si parla)
function concatWavs(files, scenes, out) {
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

// La voce mantiene l'intonazione. Se il parlato ci sta, il tempo in più va alle immagini.
export function allineaReel(durations, target) {
  const natural = durations.reduce((sum, seconds) => sum + seconds, 0);
  const total = target || natural;
  const ratio = total / natural;
  const tempo = Math.max(1, natural / total);
  let start = 0;
  const scenes = durations.map((seconds, i) => {
    const end = i === durations.length - 1 ? total : start + seconds * ratio;
    const scene = { start, duration: end - start };
    start = end;
    return scene;
  });
  return { total, tempo, scenes };
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
  const punti = puntiRichiesti(job.prompt);
  const editoriale = r.model === 'ideax-illustrato' || (!r.model && !r.plan && punti > 0 && /\b(?:cartoon|illustrat\w*|editorial\w*|infografic\w*)\b/i.test(r.style || ''));
  const nScenes = punti ? (editoriale ? punti : punti + 2) : Math.min(12, Math.max(3, Math.round(duration / 5)));
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
      const system = planSystem(duration, nScenes, r.style, punti, editoriale);
      const tema = 'Argomento del reel:\n' + job.prompt;
      plan = await askBrain(brain, system, tema, PLAN_SCHEMA);
      if (!elencoCompleto(plan, punti)) {
        log('Completo l’elenco prima di generare la voce.');
        plan = await askBrain(brain, system, tema + '\nRiscrivi il copione includendo tutti i ' + punti + ' punti, numerati e in ordine.', PLAN_SCHEMA);
      }
      if (!plan?.scenes?.length) throw new Error('Il cervello non ha restituito le scene: riprova o scrivi tu il testo.');
      if (!elencoCompleto(plan, punti)) throw new Error('Il copione è incompleto: mancano punti dell’elenco. Incolla i punti in «Ho già il testo» per generare il reel dal tuo elenco.');
    } else {
      throw new Error('Per scrivere il testo del reel serve un cervello (Impostazioni → Cervello: Ollama, LM Studio o un file .gguf). In alternativa scrivi tu il testo nel campo "Testo".');
    }
    job.title = plan.title || fallbackTitle(job.prompt);
    job.reelPlan = plan;
    job.routedPrompt = plan.scenes.map((s) => s.text).join(' ');

    // 2. Voce fuori campo, scena per scena (così conosciamo la durata esatta di ognuna)
    const voice = r.voice === false ? null : voices.findVoice(r.voice);
    if (r.voice !== false && !voice) throw new Error('Serve una voce: creala nella pagina Voce, oppure scegli "senza voce".');
    const locale = r.language || voice?.language || 'it';
    let nativa = voceNativa(voice, locale);
    const durations = [];
    const voiceFiles = [];
    const numeri = ['uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci'];
    for (const [i, scene] of plan.scenes.entries()) {
      if (job.cancelled) throw new Error('Annullato');
      step('Registro la voce', i + 1, plan.scenes.length);
      if (!voice || !scene.text) {
        durations.push(Math.max(scene.text ? 2.5 : Number(scene.duration) || 2.5, scene.text.split(' ').length / WORDS_PER_SECOND));
        if (voice) voiceFiles.push(null);
        continue;
      }
      const text = locale === 'it' && punti
        ? scene.text.replace(/^(\d{1,2})[.)]\s+/, (m, n) => numeri[n - 1] ? numeri[n - 1] + '. ' : m)
        : scene.text;
      let wav;
      if (nativa && text.length <= 1200) {
        try {
          const profilo = editoriale ? (segmentiVoce(text, 'narrativa')[0] || {}) : {};
          wav = await parlaKokoro(text, { ...nativa, velocita: profilo.velocita, pausa: profilo.pausa ? Math.min(170, profilo.pausa) : 0 });
          if (!i) log('Uso la voce sintetica originale di ' + voice.name + ' su CPU.');
        } catch {
          nativa = null;
          log('Ripiego sul motore di clonazione per la voce.');
        }
      }
      if (!wav) {
        if (!engines.isInstalled('voice')) throw new Error('Il motore voce non è installato: installalo dalla pagina Voce.');
        const out = await inGpuQueue(job, log, () => engines.call('voice', '/speak', {
          text, language: locale, reference: voices.samplePath(voice.id), format: 'wav',
          ...(voice.defaults || {}),
        }));
        wav = Buffer.from(out.data, 'base64');
      }
      const f = path.join(dir, `voce-${i}.wav`);
      fs.writeFileSync(f, wav);
      voiceFiles.push(f);
      durations.push(durataWav(wav));
    }
    if (voice) log(`Voce registrata con "${voice.name}".`);

    // 3. Immagini verticali, una per scena, sempre con lo stesso modello per uno stile coerente
    const images = [];
    let musicFile = null;
    if (editoriale) {
      step('Creo le immagini');
      const schede = plan.scenes.map((s, i) => {
        const numero = String(s.text || '').match(/^\s*(\d+)[.)]\s*/)?.[1];
        const testo = String(s.text || '').replace(/^\s*\d+[.)]\s*/, '');
        const label = String(s.headline || testo.split(/[.!?;:]/)[0] || plan.title || job.prompt).trim().slice(0, 100);
        const titolo = label.charAt(0).toLocaleUpperCase('it') + label.slice(1);
        const icona = iconaScheda(testo, s.visual || (i === plan.scenes.length - 1 ? 'riepilogo' : 'attenzione'));
        const badge = numero ? 'Punto ' + numero + (punti ? ' di ' + punti : '') : i ? 'In pratica' : 'Il punto di partenza';
        return { titolo, icona, badge };
      });
      const result = await fetch(getSettings().workerUrl + '/reel/illustrazioni', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serie: String(plan.title || job.prompt).slice(0, 100), schede, cartella: dir, musica: r.music === true, durata: duration }),
        signal: AbortSignal.timeout(60000),
      });
      const art = await result.json().catch(() => ({}));
      if (!result.ok || art.images?.length !== schede.length) throw new Error('Composizione delle schede non riuscita: ' + (art.detail || result.status));
      images.push(...art.images);
      musicFile = art.music;
      log('Schede illustrate con la stessa palette e composizione.');
    } else {
      let picked = r.model
        ? { model: catalog.generators.find((m) => (m.id === r.model || m.name === r.model) && m.capabilities.includes('image_generate')) }
        : pickModel('image_generate', catalog.generators);
      let preview = false;
      if (!r.model && picked?.model.arch === 'flux') {
        const gpu = await detectGpu().catch(() => null);
        if (gpu?.vendor === 'nvidia' && gpu.vramGb > 0 && gpu.vramGb <= 16) {
          const veloce = pickModel('image_generate', catalog.generators.filter((m) => m.backend === 'worker' && m.arch === 'sdxl' && m.format !== 'diffusers'), { onlyGeneral: true });
          if (veloce) { picked = veloce; preview = true; }
        }
      }
      if (!picked?.model) throw new Error('Serve un modello di immagini: collegane uno nella pagina Modelli.');
      const model = picked.model;
      log(`Immagini con ${model.name}.`);
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
          attachments: [], loras: [], log: [], get cancelled() { return job.cancelled; },
          params: { ...(styled.styleParams || {}), ...(model.params || {}), aspect: '9:16',
            ...(preview ? { width: 576, height: 1024, num_inference_steps: 18 } : {}),
            ...(r.seed != null ? { seed: Number(r.seed) + i } : {}) },
        };
        const res = await runModel(model, 'image_generate', sub, (m) => log('Scena ' + (i + 1) + ': ' + m), { owner: job });
        images.push(path.join(OUTPUT_DIR, path.basename(res[0].url)));
        if (job.cancelled) throw new Error('Annullato');
      }
    }

    // 4. Tempi: ogni scena dura quanto la sua voce più una breve pausa
    const GAP = 0.23;
    const lengths = plan.scenes.map((s, i) => {
      // Una durata indicata nel piano vale come minimo (es. una scena senza testo che deve restare 2 secondi)
      return Math.max(Number(s.duration) || 0, durations[i] + (i < plan.scenes.length - 1 ? GAP : 0.4));
    });
    const { total, tempo, scenes } = allineaReel(lengths, r.duration != null ? duration : null);
    const captions = r.captions === false ? [] : plan.scenes.flatMap((s, i) => captionChunks(s.text, scenes[i].start, durations[i] / tempo, editoriale ? 14 : 4));
    let voiceTrack = null;
    if (voiceFiles.some(Boolean)) {
      voiceTrack = path.join(dir, 'voce.wav');
      concatWavs(voiceFiles, scenes.map((s) => ({ duration: s.duration * tempo })), voiceTrack);
    }

    // 5. Musica di sottofondo della durata giusta
    if (!musicFile && r.music !== false) {
      if (engines.isInstalled('music')) {
        step('Compongo la musica');
        const desc = typeof r.music === 'string' && r.music.trim() ? r.music : plan.music;
        const m = await inGpuQueue(job, log, async () => {
          await engines.freeForEngine('music'); // libera per la musica; su due schede il worker immagini resta acceso
          return music.generate({ prompt: desc, duration: Math.ceil(total), instrumental: true, quality: 'fast' },
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
        scenes: scenes.map(({ start, duration: d }, i) => ({ image: images[i], start, duration: d })),
        captions, voice: voiceTrack, voice_tempo: tempo, music: musicFile, output, fps: 24,
        ...(editoriale ? { static_frames: true, caption_position: 0.77 } : {}),
        music_volume: voiceTrack ? Number(r.musicVolume ?? (editoriale ? 0.14 : 0.18)) : 0.8,
      }),
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok && voiceTrack && tempo > 1 && body.voice_tempo !== tempo) {
      throw new Error('Il worker video va aggiornato: serve il supporto per adattare la durata della voce.');
    }
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
