// Capisce dal prompt (e dagli allegati) quale lavoro serve, a quale modello affidarlo e quali LoRA usare.
import { TASKS, listServers, getSettings, getOverrides } from './store.js';
import { isInstalled as isEngineInstalled } from './engines.js';
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
  image_upscale: ['image_upscale'],
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
  // Pelle vera: i tag che trasformano una base SD1.5/SDXL realistica da "plastica" a fotografia. Vale per ritratti,
  // matrimoni e per i profili adulti (il contenuto lo mettono il prompt e le LoRA; qui c'è solo il fotorealismo).
  fotoreale: {
    label: 'Fotoreale (pelle vera)',
    prefix: 'raw photo, ',
    suffix: ', photorealistic, detailed skin texture, visible skin pores, natural skin, soft natural lighting, sharp focus, shot on DSLR, 8k uhd, film grain',
    negative: 'cartoon, anime, illustration, drawing, painting, 3d render, cgi, doll, plastic skin, airbrushed, smooth waxy skin, worst quality, low quality, lowres, bad anatomy, bad hands, extra fingers, deformed, disfigured, mutated, blurry, watermark, text, signature',
    params: {},
  },
  plain: { label: 'Nessuna aggiunta', prefix: '', suffix: '', negative: '', params: {} },
};

export function styleFor(model) {
  if (model.backend !== 'worker') return 'plain';
  if (model.promptStyle && model.promptStyle !== 'auto') return model.promptStyle;
  const name = `${model.name} ${model.file || ''}`;
  if (/pony/i.test(name)) return 'pony';
  if (/illustrious|noob|wai[-_ ]/i.test(name)) return 'illustrious';
  // Basi realistiche note (e qualunque nome che dica "realistic/photoreal"): pelle vera di default
  if (/epic[\s_-]?realism|epic[\s_-]?photogasm|realistic[\s_-]?vision|realvis|cyber[\s_-]?realistic|absolute[\s_-]?reality|photon|photogasm|majicmix[\s_-]?realistic|chillout|juggernaut|photoreal\w*|realism|realistic/i.test(name)) return 'fotoreale';
  // Flux, SD3 e i modelli video capiscono le frasi: niente tag né prompt negativo
  if (['sd15', 'sd2', 'sdxl'].includes(model.arch)) return 'natural';
  return 'plain';
}

export function applyStyle(model, prompt, negative) {
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

export async function translate(text) {
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
  // MOSS-Image gira su ComfyUI, installato come motore: compare come un modello qualsiasi
  const moss = mossGenerator();
  const wan = wanGenerator();
  const edits = editGenerators();
  return {
    all: local,
    generators: [...generators, ...(moss ? [moss] : []), ...(wan ? [wan] : []), ...edits, ...servers],
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
    // Parole intere: "me" non deve scattare dentro "come" o "mele"
    return words.some((w) => new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}\\p{N}])`, 'u').test(p));
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
  Ogni testo che deve COMPARIRE nell'immagine (scritte, titoli, nomi, date) va copiato tra virgolette doppie esattamente com'è, nella sua lingua, senza tradurlo.
- negative_prompt: cosa evitare (stringa vuota se non serve; per SD 1.5/SDXL metti difetti comuni come "blurry, low quality, deformed").
- lora_ids: gli id delle LoRA da applicare, solo se compatibili con l'architettura del modello scelto e utili alla richiesta (lista vuota se nessuna).
- reason: una frase in italiano che spiega la scelta.
- title: un titolo breve ed evocativo in italiano per la creazione (2-5 parole, senza virgolette).`;

// Titolo di riserva: le prime parole del prompt
export function fallbackTitle(prompt) {
  const words = prompt.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/[,.;:]+$/, '');
}

// Un'immagine con scritte dentro (testo tra virgolette, inviti, locandine, menu…): la fa Qwen-Image
export const TEXT_CUE = /["“«][^"”»]{2,}["”»]|\b(scritt[ao]|con (il )?testo|testo\s+["“«]|invit[oi]|locandin[ae]|poster|volantin[oi]|copertin[ae]|menu|menù|biglietto|cartellon[ei]|insegna|logo con|titolo)\b/i;
export const UPSCALE_CUE = /\b(ingrandisc\w*|ingrandiment\w*|aumenta (la )?risoluzione|alta risoluzione|upscal\w*|per la stampa|più grande|4k|8k)\b/i;

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
  // Regole fisse prima del cervello: scritte nell'immagine → Qwen-Image; "ingrandisci" con foto → upscaler 4×
  if (!forceModelId) {
    const hasImage = attachments.some((a) => a.type?.startsWith('image/'));
    const only = (id) => generators.filter((m) => m.id === id);
    if (hasImage && UPSCALE_CUE.test(prompt) && only('engine-upscale').length) {
      generators = only('engine-upscale');
      forceTask = 'image_upscale';
    } else if (!hasImage && (forceTask || heuristicTask(prompt, attachments)) === 'image_generate' && TEXT_CUE.test(prompt) && only('engine-qwenimage').length) {
      generators = only('engine-qwenimage');
      forceTask = 'image_generate';
    }
  }

  const heuristic = async () => {
    const task = forceTask || heuristicTask(prompt, attachments);
    const picked = pickModel(task, generators);
    if (!picked) {
      const hint = /video|animation/.test(task)
        ? ' Per i video serve un modello video (es. Wan o LTX in cartella diffusers) oppure ComfyUI collegato a ideax: Flux, SDXL e SD 1.5 fanno solo immagini.'
        : '';
      throw new Error(`Nessun modello collegato sa fare: "${TASKS[task]}".${hint}`);
    }
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

// Fotomontaggio su ComfyUI: Qwen-Image-Edit (primo) e FLUX.1 Kontext (fedele). Partono dalla foto vera e tengono il volto.
function editGenerators() {
  if (!isEngineInstalled('comfyui')) return [];
  const list = [
    { id: 'engine-qwenedit', engine: 'qwenedit', name: 'Fotomontaggio Qwen', backend: 'qwenedit', arch: 'qwenedit', priority: 60,
      description: 'Trasforma una foto vera tenendo il volto: temi, costumi, scenari, caricature con un foglio di stile (fino a 3 immagini).' },
    { id: 'engine-kontext', engine: 'kontext', name: 'Fotomontaggio Kontext', backend: 'kontext', arch: 'kontext', priority: 45,
      description: 'Modifiche fedelissime al volto e alla foto: vestiti, sfondo, luce, dettagli.' },
    { id: 'engine-qwenimage', engine: 'qwenimage', name: 'Immagini con testo (Qwen-Image)', backend: 'qwenimage', arch: 'qwenimage', priority: -5, caps: ['image_generate'],
      description: 'Immagini con scritte perfette: inviti, locandine, copertine, menu, loghi. Il testo va tra virgolette.' },
    { id: 'engine-upscale', engine: 'upscale', name: 'Ingrandimento 4×', backend: 'upscale', arch: 'upscale', priority: 0, caps: ['image_upscale'],
      description: 'Ingrandisce 4 volte un\'immagine per la stampa.' },
  ];
  return list.filter((g) => isEngineInstalled(g.engine)).map((g) => {
    const o = getOverrides()[g.id] || {};
    if (o.enabled === false) return null;
    return {
      id: g.id, name: o.name || g.name, source: 'engine', kind: 'checkpoint', arch: g.arch, backend: g.backend,
      capabilities: g.caps || ['image_edit'], priority: o.priority != null ? Number(o.priority) : g.priority, enabled: true, promptStyle: 'natural',
      description: o.description || g.description, params: o.params || {},
    };
  }).filter(Boolean);
}

// Wan 2.2 su ComfyUI: il motore video principale quando c'è (priorità più alta di Stable Video Diffusion)
function wanGenerator() {
  if (isEngineInstalled('wan14b') && isEngineInstalled('comfyui')) {
    const o = getOverrides()['engine-wan14b'] || {};
    if (o.enabled !== false) return {
      id: 'engine-wan14b', name: o.name || 'Wan 2.2 14B (video)', source: 'engine', kind: 'checkpoint', arch: 'wan', backend: 'wan14b',
      capabilities: ['video_generate', 'image_to_video', 'animation'], priority: o.priority != null ? Number(o.priority) : 55, enabled: true, promptStyle: 'natural',
      description: o.description || 'Video 14B da una foto: più dettaglio e movimento. Pesante (fp8). Usa le LoRA per Wan.', params: o.params || {},
    };
  }
  if (!isEngineInstalled('wan') || !isEngineInstalled('comfyui')) return null;
  const o = getOverrides()['engine-wan'] || {};
  if (o.enabled === false) return null;
  return {
    id: 'engine-wan', name: o.name || 'Wan 2.2 (video)', source: 'engine', kind: 'checkpoint', arch: 'wan', backend: 'wan',
    capabilities: ['video_generate', 'image_to_video', 'animation'], priority: o.priority != null ? Number(o.priority) : 50, enabled: true, promptStyle: 'natural',
    description: o.description || 'Video 720p a 24 fotogrammi al secondo, fino a 5 secondi, da testo o da una foto. Prompt descrittivi in inglese: soggetto, azione, movimento di camera, luce.',
    params: o.params || {},
  };
}

function mossGenerator() {
  if (!isEngineInstalled('comfyui')) return null;
  const o = getOverrides()['engine-moss'] || {};
  if (o.enabled === false) return null;
  return {
    id: 'engine-moss', name: o.name || 'MOSS-Image', source: 'engine', kind: 'checkpoint', arch: 'moss', backend: 'moss',
    capabilities: ['image_generate'], priority: Number(o.priority) || 0, enabled: true, promptStyle: 'natural',
    description: o.description || 'Segue alla lettera prompt lunghi e dettagliati in inglese. Usa le LoRA fatte per Moss.',
    params: o.params || {},
  };
}
