// Capisce dal prompt (e dagli allegati) quale lavoro serve, a quale modello affidarlo e quali LoRA usare.
import { TASKS, listServers } from './store.js';
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
  video: /\b(video|clip|filmat\w*|cortometraggio|scena animata|spot|trailer|reel|movie|film)\b/i,
  animation: /\b(anim\w*|gif|loop|muov\w*|movimento|cinemagraph|cartone animato|motion|animate)\b/i,
};

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

  const heuristic = () => {
    const task = forceTask || heuristicTask(prompt, attachments);
    const picked = pickModel(task, generators);
    if (!picked) throw new Error(`Nessun modello collegato sa fare: "${TASKS[task]}".`);
    return {
      task: picked.task,
      model: picked.model,
      prompt,
      negativePrompt: '',
      loras: matchLoras(prompt, picked.model, catalog.loras),
      reason: `Compito "${TASKS[task]}"` + (picked.task !== task ? `, ripiegato su "${TASKS[picked.task]}"` : '') +
        `; modello con priorità più alta: ${picked.model.name}.`,
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
      prompt: finalPrompt,
      negativePrompt: out.negative_prompt || '',
      loras: matchLoras(prompt + ' ' + finalPrompt, model, catalog.loras, out.lora_ids || []),
      reason: out.reason || '',
      brain: brain.label,
      title: out.title?.trim() || fallbackTitle(prompt),
    };
  } catch (err) {
    const h = heuristic();
    h.reason += ` (cervello ${brain.label} non disponibile: ${err.message})`;
    return h;
  }
}
