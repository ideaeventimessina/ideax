// Capisce dal prompt (e dagli allegati) quale lavoro serve, a quale modello affidarlo e quali LoRA usare.
import { TASKS, listServers, getSettings } from './store.js';
import { scanModels, ARCH_LABELS } from './scanner.js';
import { resolveBrain, askBrain } from './brain.js';

// Se manca un modello per il compito richiesto, si prova con questi in ordine.
const FALLBACK_TASKS = {
  animation: ['animation', 'image_to_video', 'video_generate'],
  image_to_video: ['image_to_video', 'animation'],
  video_generate: ['video_generate', 'animation'],
  video_edit: ['video_edit'],
  image_edit: ['image_edit'],
  image_generate: ['image_generate'],
};

const KW = {
  // "film" e "movie" da soli no: "come in un film" descrive uno stile, non chiede un video
  video: /\b(video|videoclip|clip|filmat\w*|cortometraggio|spot|trailer|reel)\b|\b(crea|fai|genera|realizza)\w* (un |il )?(film|movie)\b/i,
  animation: /\b(anim\w*|gif|loop|muov\w*|movimento|cinemagraph|cartone animato|motion|animate)\b/i,
};

// ---------- Stili di prompt per famiglia di modelli ----------
// I modelli SD/SDXL capiscono solo l'inglese e alcune famiglie (Pony, Illustrious) vogliono tag precisi:
// senza, le immagini escono sbiadite o fuori tema.
export const PROMPT_STYLES = {
  natural: {
    label: 'Normale',
    prefix: '',
    suffix: ', highly detailed, best quality',
    negative: 'lowres, worst quality, low quality, blurry, bad anatomy, deformed, extra fingers, watermark, text, signature',
    params: {},
  },
  pony: {
    label: 'Pony (score_9…)',
    prefix: 'score_9, score_8_up, score_7_up, ',
    suffix: '',
    negative: 'score_4, score_5, score_6, worst quality, low quality, blurry, bad anatomy, watermark, text, signature',
    params: { clip_skip: 2 },
  },
  illustrious: {
    label: 'Illustrious / NoobAI',
    prefix: 'masterpiece, best quality, amazing quality, ',
    suffix: '',
    negative: 'worst quality, low quality, lowres, bad anatomy, bad hands, blurry, watermark, text, signature',
    params: { clip_skip: 2 },
  },
  plain: { label: 'Nessuna aggiunta', prefix: '', suffix: '', negative: '', params: {} },
};

export function styleFor(model) {
  if (model.backend !== 'worker') return 'plain';
  if (model.promptStyle && model.promptStyle !== 'auto') return model.promptStyle;
  const name = `${model.name} ${model.file || ''}`;
  if (/pony/i.test(name)) return 'pony';
  if (/illustrious|noob|wai[-_ ]/i.test(name)) return 'illustrious';
  // Flux, SD3 e i modelli video capiscono le frasi: niente tag né prompt negativo
  if (['sd15', 'sd2', 'sdxl'].includes(model.arch)) return 'natural';
  return 'plain';
}

function applyStyle(model, prompt, negative) {
  const st = PROMPT_STYLES[styleFor(model)] || PROMPT_STYLES.plain;
  let p = prompt.trim();
  if (st.prefix && !p.toLowerCase().startsWith(st.prefix.split(',')[0])) p = st.prefix + p;
  if (st.suffix && !p.toLowerCase().includes(st.suffix.split(',')[1].trim())) p += st.suffix;
  const n = negative?.trim() || model.negativePrompt || st.negative;
  return { prompt: p, negativePrompt: n, styleParams: st.params };
}

// ---------- Traduzione locale (italiano → inglese) ----------
const IT_WORDS = /\b(il|lo|la|gli|le|un|una|uno|di|del|della|dei|delle|con|che|per|nel|nella|sul|sulla|davanti|dietro|sopra|sotto|stile|colori|luce|ritratto|paesaggio|tramonto|alba|notte|gatto|cane|donna|uomo|ragazza|ragazzo|bambino|mare|lago|montagna|cielo|città|foresta|fiori|crea|fai|disegna|immagine|foto|anima|rendi|cambia)\b/gi;

export function looksItalian(text) {
  return (text.match(IT_WORDS) || []).length >= 2;
}

async function translate(text) {
  const res = await fetch(`${getSettings().workerUrl}/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(180_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || `HTTP ${res.status}`);
  return body.text;
}

// Tutto ciò che può generare: modelli locali (con le capacità aggiunte dai moduli di movimento) e server esterni.
export function buildCatalog() {
  const local = scanModels();
  const motions = local.filter((m) => m.kind === 'motion' && m.enabled);
  const generators = local
    .filter((m) => m.kind === 'checkpoint' && m.enabled && m.capabilities.length)
    .map((m) => {
      const motion = motions.find((x) => x.arch === m.arch);
      const caps = motion && !m.capabilities.includes('animation') ? [...m.capabilities, 'animation'] : m.capabilities;
      return { ...m, capabilities: caps, backend: 'worker', motion: motion || null };
    });
  const servers = listServers()
    .filter((s) => s.enabled)
    .map((s) => ({ ...s, backend: s.type, source: 'server', kind: 'checkpoint', arch: 'server' }));
  return {
    all: local,
    generators: [...generators, ...servers],
    loras: local.filter((m) => m.kind === 'lora' && m.enabled),
  };
}

export function heuristicTask(prompt, attachments) {
  const hasImage = attachments.some((a) => a.type?.startsWith('image/'));
  const hasVideo = attachments.some((a) => a.type?.startsWith('video/'));
  const wantsVideo = KW.video.test(prompt);
  const wantsAnim = KW.animation.test(prompt);
  if (hasVideo) return 'video_edit';
  if (hasImage) {
    if (wantsAnim) return 'animation';
    if (wantsVideo) return 'image_to_video';
    return 'image_edit';
  }
  if (wantsAnim) return 'animation';
  if (wantsVideo) return 'video_generate';
  return 'image_generate';
}

export function pickModel(task, generators) {
  for (const t of FALLBACK_TASKS[task] || [task]) {
    const candidates = generators.filter((m) => m.capabilities.includes(t)).sort((a, b) => b.priority - a.priority);
    if (candidates.length) return { model: candidates[0], task: t };
  }
  return null;
}

// LoRA compatibili con l'architettura del modello: quelle "sempre attive" e quelle le cui parole chiave compaiono nel prompt.
export function matchLoras(prompt, model, loras, chosenIds = []) {
  const p = prompt.toLowerCase();
  return loras.filter((l) => {
    if (l.arch !== model.arch) return false;
    if (l.loraAlways || chosenIds.includes(l.id)) return true;
    const words = String(l.triggerWords || '').split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
    return words.some((w) => p.includes(w));
  });
}

const ROUTE_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'string', enum: Object.keys(TASKS) },
    model_id: { type: 'string' },
    prompt: { type: 'string' },
    negative_prompt: { type: 'string' },
    lora_ids: { type: 'array', items: { type: 'string' } },
    reason: { type: 'string' },
    title: { type: 'string' },
  },
  required: ['task', 'model_id', 'prompt', 'negative_prompt', 'lora_ids', 'reason', 'title'],
  additionalProperties: false,
};

const SYSTEM = `Sei il router di uno studio creativo AI che gira in locale. Ricevi la richiesta dell'utente (spesso in italiano), gli allegati e il catalogo dei modelli.
Rispondi SOLO con un oggetto JSON con questi campi:
- task: uno tra ${Object.entries(TASKS).map(([k, v]) => `${k} (${v})`).join(', ')}.
  Immagine allegata + cambiarla → image_edit; + farla muovere → image_to_video o animation. Video allegato → video_edit. "animazione", "gif", "loop" → animation.
- model_id: l'id del modello più adatto, che deve avere quel task tra le capacità. Considera stile, descrizione e priorità (più alta = preferito).
- prompt: il prompt per il modello, in inglese, descrittivo e con tutti i dettagli chiesti (soggetto, stile, colori, inquadratura, movimento). Per i modelli SD 1.5/SDXL usa uno stile a parole chiave separate da virgole. Per le modifiche descrivi solo il risultato voluto.
- negative_prompt: cosa evitare (stringa vuota se non serve; per SD 1.5/SDXL metti difetti comuni come "blurry, low quality, deformed").
- lora_ids: gli id delle LoRA da applicare, solo se compatibili con l'architettura del modello scelto e utili alla richiesta (lista vuota se nessuna).
- reason: una frase in italiano che spiega la scelta.
- title: un titolo breve ed evocativo in italiano per la creazione (2-5 parole, senza virgolette).`;

// Titolo di riserva: le prime parole del prompt
export function fallbackTitle(prompt) {
  const words = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/[,.;:]+$/, '');
}

export async function route(prompt, attachments, { forceModelId, forceTask } = {}) {
  const catalog = buildCatalog();
  let generators = catalog.generators;
  if (!generators.length) {
    throw new Error('Nessun modello collegato. Trascina un file .safetensors nella pagina Modelli o collega un server locale.');
  }
  if (forceModelId) {
    generators = generators.filter((m) => m.id === forceModelId || m.name === forceModelId);
    if (!generators.length) throw new Error(`Modello non trovato: ${forceModelId}`);
  }

  const heuristic = async () => {
    const task = forceTask || heuristicTask(prompt, attachments);
    const picked = pickModel(task, generators);
    if (!picked) throw new Error(`Nessun modello collegato sa fare: "${TASKS[task]}".`);
    // Senza cervello traduciamo comunque in inglese con il traduttore locale del worker
    let english = prompt;
    let note = '';
    if (picked.model.backend === 'worker' && looksItalian(prompt)) {
      try {
        english = await translate(prompt);
        note = ' Prompt tradotto in inglese dal traduttore locale.';
      } catch (err) {
        note = ` Traduzione non riuscita (${err.message}): il prompt è stato inviato in italiano.`;
      }
    }
    const styled = applyStyle(picked.model, english, '');
    return {
      task: picked.task,
      model: picked.model,
      ...styled,
      loras: matchLoras(prompt + ' ' + english, picked.model, catalog.loras),
      reason: `Compito "${TASKS[task]}"` + (picked.task !== task ? `, ripiegato su "${TASKS[picked.task]}"` : '') +
        `; modello con priorità più alta: ${picked.model.name}.${note}`,
      brain: 'regole integrate',
      title: fallbackTitle(prompt),
    };
  };

  const brain = resolveBrain(catalog.all);
  if (brain.mode === 'rules') return heuristic();

  const list = generators.map((m) => ({
    id: m.id, name: m.name, architecture: ARCH_LABELS[m.arch] || m.arch,
    capabilities: m.capabilities, description: m.description, priority: m.priority,
  }));
  const loras = catalog.loras.map((l) => ({
    id: l.id, name: l.name, architecture: ARCH_LABELS[l.arch], trigger_words: l.triggerWords, description: l.description,
  }));
  const files = attachments.length ? attachments.map((a) => `${a.name} (${a.type})`).join(', ') : 'nessuno';
  const user = `Modelli:\n${JSON.stringify(list)}\n\nLoRA:\n${JSON.stringify(loras)}\n\nAllegati: ${files}\n` +
    (forceTask ? `Compito imposto: ${forceTask}\n` : '') + `\nRichiesta:\n${prompt}`;

  try {
    const out = await askBrain(brain, SYSTEM, user, ROUTE_SCHEMA);
    const task = forceTask || out.task;
    let model = generators.find((m) => m.id === out.model_id);
    if (!model || !model.capabilities.includes(task)) {
      const picked = pickModel(task, generators);
      if (!picked) return heuristic();
      model = picked.model;
    }
    const finalPrompt = out.prompt?.trim() || prompt;
    return {
      task: model.capabilities.includes(task) ? task : pickModel(task, generators).task,
      model,
      ...applyStyle(model, finalPrompt, out.negative_prompt),
      loras: matchLoras(prompt + ' ' + finalPrompt, model, catalog.loras, out.lora_ids || []),
      reason: out.reason || '',
      brain: brain.label,
      title: out.title?.trim() || fallbackTitle(prompt),
    };
  } catch (err) {
    const h = await heuristic();
    h.reason += ` (cervello ${brain.label} non disponibile: ${err.message})`;
    return h;
  }
}
