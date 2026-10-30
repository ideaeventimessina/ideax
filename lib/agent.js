// Il cervello conversazionale di ideax: parla con te, si ricorda di te (memoria comune a tutte le chat),
// usa gli strumenti (creazioni, altre chat, GitHub, maestri come Axel) e impara in fretta da testi e da altri cervelli.
// Funziona con l'LLM locale (.gguf o Ollama/LM Studio): ogni passo è un JSON { reply, action, remember }.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSettings, OUTPUT_DIR } from './store.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog, fallbackTitle } from './router.js';
import * as memory from './memory.js';
import * as chats from './chats.js';
import * as github from './github.js';
import * as teachers from './teachers.js';
import * as engines from './engines.js';
import * as voices from './voices.js';
import * as llama from './llamaserver.js';

// server.js ci passa le sue funzioni per creare e leggere i lavori (evita dipendenze circolari)
let host = { createJob: null, getJob: null, musicFromPrompt: null };
export function configure(fns) { host = { ...host, ...fns }; }

const MAX_STEPS = 6;
const HISTORY_BUDGET = 14000;

// ---------- Strumenti ----------

const TOOLS = {
  crea_immagine: { args: 'descrizione, proporzioni? (1:1, 2:3, 3:2, 9:16, 16:9)', desc: 'genera una o più immagini/foto', media: true },
  modifica_immagine: { args: 'istruzioni', desc: "modifica l'ultima immagine allegata o creata in questa chat", media: true },
  crea_video: { args: 'descrizione', desc: 'genera un video breve (dall\'ultima immagine della chat se l\'utente lo chiede)', media: true },
  crea_animazione: { args: 'descrizione', desc: 'genera una animazione/GIF', media: true },
  leggi_con_voce: { args: 'testo, voce?', desc: 'legge un testo con una voce clonata', media: true },
  crea_musica: { args: 'descrizione, secondi?, strumentale? (true/false), testo?', desc: 'compone musica, basi, jingle, canzoni', media: true },
  crea_reel: { args: 'argomento, secondi?', desc: 'crea un reel verticale completo (voce, immagini, musica, sottotitoli)', media: true },
  video_gemello: { args: 'testo, video?, voce?', desc: 'video del gemello dell\'utente che dice il testo, con la sua voce e le labbra a tempo', media: true },
  ricorda: { args: 'testo, categoria?', desc: 'salva esplicitamente un ricordo quando l\'utente lo chiede' },
  dimentica: { args: 'testo', desc: 'cancella un ricordo quando l\'utente lo chiede' },
  cerca_ricordi: { args: 'query', desc: 'cerca tra tutti i ricordi' },
  cerca_nelle_chat: { args: 'query', desc: 'cerca cosa si è detto nelle altre chat' },
  leggi_chat: { args: 'chat_id', desc: 'legge gli ultimi messaggi di un\'altra chat' },
  chiedi_al_maestro: { args: 'domanda, nome?', desc: 'fa una domanda a un altro cervello collegato (es. Axel)' },
  github_miei_repo: { args: '', desc: 'elenca i repository dell\'utente' },
  github_cerca_repo: { args: 'query', desc: 'cerca repository su GitHub' },
  github_info: { args: 'repo', desc: 'descrizione e README di un repository (proprietario/nome)' },
  github_leggi: { args: 'repo, percorso?, ramo?', desc: 'legge un file o elenca una cartella su GitHub' },
  github_cerca_codice: { args: 'repo, query', desc: 'cerca nel codice di un repository su GitHub' },
  github_issue: { args: 'repo, stato? (open/closed/all)', desc: 'elenca issue e pull request' },
  github_scarica: { args: 'repo, ramo?', desc: 'scarica un repository sul PC' },
  locale_elenca: { args: 'repo, cartella?', desc: 'elenca i file di un repository scaricato' },
  locale_leggi: { args: 'repo, percorso', desc: 'legge un file di un repository scaricato' },
  locale_cerca: { args: 'repo, testo', desc: 'cerca un testo nei file di un repository scaricato' },
  github_scrivi_file: { args: 'repo, percorso, contenuto, messaggio, ramo?', desc: 'crea o aggiorna un file con un commit (solo se l\'utente lo chiede)', write: true },
  github_crea_ramo: { args: 'repo, ramo, da?', desc: 'crea un ramo', write: true },
  github_crea_issue: { args: 'repo, titolo, testo?', desc: 'apre una issue', write: true },
  github_commenta: { args: 'repo, numero, testo', desc: 'commenta una issue o pull request', write: true },
  github_crea_pr: { args: 'repo, titolo, da_ramo, verso_ramo?, testo?', desc: 'apre una pull request', write: true },
};

const NONE = 'nessuna';

function stepSchema(toolNames) {
  return {
    type: 'object',
    properties: {
      reply: { type: 'string' },
      action: {
        type: 'object',
        properties: { tool: { type: 'string', enum: [NONE, ...toolNames] }, args: { type: 'object' } },
        required: ['tool', 'args'],
      },
      remember: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          properties: { text: { type: 'string' }, category: { type: 'string', enum: Object.keys(memory.CATEGORIES) } },
          required: ['text', 'category'],
        },
      },
    },
    required: ['reply', 'action', 'remember'],
  };
}

const STEP_LABEL = {
  crea_immagine: 'Creo l\'immagine', modifica_immagine: 'Modifico l\'immagine', crea_video: 'Creo il video', crea_animazione: 'Creo l\'animazione',
  leggi_con_voce: 'Leggo con la voce', crea_musica: 'Compongo la musica', crea_reel: 'Preparo il reel', video_gemello: 'Preparo il video del gemello',
  ricorda: 'Mi segno', dimentica: 'Dimentico', cerca_ricordi: 'Cerco nei ricordi', cerca_nelle_chat: 'Cerco nelle altre chat', leggi_chat: 'Leggo un\'altra chat',
  chiedi_al_maestro: 'Chiedo al maestro', github_miei_repo: 'Guardo i tuoi repository', github_cerca_repo: 'Cerco su GitHub', github_info: 'Leggo il repository',
  github_leggi: 'Leggo su GitHub', github_cerca_codice: 'Cerco nel codice', github_issue: 'Guardo le issue', github_scarica: 'Scarico il repository',
  locale_elenca: 'Guardo i file', locale_leggi: 'Leggo il file', locale_cerca: 'Cerco nei file', github_scrivi_file: 'Scrivo su GitHub',
  github_crea_ramo: 'Creo il ramo', github_crea_issue: 'Apro la issue', github_commenta: 'Commento', github_crea_pr: 'Apro la pull request',
};

function stepLabel(tool, a) {
  const what = a.repo || a.query || a.nome || a.percorso || '';
  return `${STEP_LABEL[tool] || tool}${what && !TOOLS[tool]?.media ? ` · ${String(what).slice(0, 60)}` : ''}`;
}

const pick = (a, ...keys) => { for (const k of keys) if (a?.[k] != null && a[k] !== '') return a[k]; return undefined; };

function fileToDataUrl(url) {
  const file = path.join(OUTPUT_DIR, path.basename(url));
  const type = url.endsWith('.png') ? 'image/png' : /\.jpe?g$/.test(url) ? 'image/jpeg' : url.endsWith('.webp') ? 'image/webp' : url.endsWith('.mp4') ? 'video/mp4' : 'application/octet-stream';
  return { name: path.basename(url), type, dataUrl: `data:${type};base64,${fs.readFileSync(file).toString('base64')}` };
}

// L'ultima immagine della chat: allegata dall'utente oppure creata da ideax
function lastImage(chat) {
  for (const m of [...chat.messages].reverse()) {
    const att = (m.attachments || []).filter((x) => x.type?.startsWith('image/')).pop();
    if (att) return att.url;
    for (const id of [...(m.jobs || [])].reverse()) {
      const j = host.getJob?.(id);
      const r = j?.results?.find((x) => /^image\/(png|jpeg|webp)/.test(x.type));
      if (r) return r.url;
    }
  }
  return null;
}

async function startMedia(tool, a, chat, ctx) {
  const desc = String(pick(a, 'descrizione', 'istruzioni', 'testo', 'argomento', 'prompt') || '').trim();
  if (!desc) throw new Error('manca la descrizione');
  const base = { prompt: desc, metadata: { chat: chat.id } };
  let body;
  if (tool === 'crea_immagine') body = { ...base, task: 'image_generate', params: a.proporzioni ? { aspect: a.proporzioni } : {} };
  if (tool === 'modifica_immagine' || (tool === 'crea_video' && /dall|questa|quest'|anima/i.test(desc))) {
    const img = lastImage(chat);
    if (!img && tool === 'modifica_immagine') throw new Error('in questa chat non c\'è un\'immagine da modificare: chiedi all\'utente di allegarla');
    if (img) body = { ...base, task: tool === 'crea_video' ? 'image_to_video' : 'image_edit', attachments: [fileToDataUrl(img)] };
  }
  if (!body && tool === 'crea_video') body = { ...base, task: 'video_generate' };
  if (tool === 'crea_animazione') body = { ...base, task: 'animation' };
  if (tool === 'leggi_con_voce') {
    if (!engines.isInstalled('voice')) throw new Error('il motore voce non è installato (pagina Voce)');
    body = { ...base, kind: 'speech', speech: { voice: a.voce } };
  }
  if (tool === 'crea_musica') {
    if (!engines.isInstalled('music')) throw new Error('il motore musica non è installato (pagina Musica)');
    const guess = host.musicFromPrompt?.(desc) || {};
    const secondi = Number(pick(a, 'secondi', 'durata')) || guess.duration || 30;
    const instrumental = a.strumentale != null ? !['false', false, 'no'].includes(a.strumentale) : guess.instrumental ?? true;
    body = { ...base, kind: 'music', music: { duration: secondi, instrumental, lyrics: a.testo || undefined } };
  }
  if (tool === 'video_gemello') body = { ...base, kind: 'talk', talk: { twin: a.video, voice: a.voce } };
  if (tool === 'crea_reel') body = { ...base, kind: 'reel', reel: { duration: Number(a.secondi) || 30 } };
  const job = await host.createJob(body, ctx);
  return { job: job.id, stato: 'avviato: il risultato apparirà nella chat quando è pronto' };
}

async function runTool(tool, a, chat, ctx) {
  if (TOOLS[tool]?.media) return startMedia(tool, a, chat, ctx);
  switch (tool) {
    case 'ricorda': {
      const f = memory.remember(pick(a, 'testo', 'text'), { category: a.categoria || a.category, source: 'chat', chatId: chat.id });
      return f ? { salvato: f.text } : { errore: 'niente da salvare' };
    }
    case 'dimentica': return { cancellati: memory.forget(pick(a, 'testo', 'text', 'id')) };
    case 'cerca_ricordi': return memory.searchFacts(pick(a, 'query', 'testo') || '').map((f) => f.text);
    case 'cerca_nelle_chat': return chats.searchChats(pick(a, 'query', 'testo') || '', { exclude: chat.id });
    case 'leggi_chat': {
      const c = chats.getChat(pick(a, 'chat_id', 'id'));
      if (!c) throw new Error('chat non trovata');
      return { titolo: c.title, messaggi: c.messages.slice(-20).map((m) => `${m.role === 'user' ? 'Utente' : 'ideax'}: ${String(m.content).slice(0, 600)}`) };
    }
    case 'chiedi_al_maestro': {
      const t = teachers.findTeacher(pick(a, 'nome', 'name'));
      if (!t) throw new Error('nessun maestro collegato con quel nome');
      return { maestro: t.name, risposta: (await teachers.ask(t, pick(a, 'domanda', 'question') || '')).slice(0, 6000) };
    }
    case 'github_miei_repo': return github.myRepos();
    case 'github_cerca_repo': return github.searchRepos(pick(a, 'query', 'testo'));
    case 'github_info': return github.repoInfo(a.repo);
    case 'github_leggi': return github.readRemote(a.repo, pick(a, 'percorso', 'path') || '', pick(a, 'ramo', 'ref') || '');
    case 'github_cerca_codice': return github.searchCode(a.repo, pick(a, 'query', 'testo'));
    case 'github_issue': return github.listIssues(a.repo, a.stato);
    case 'github_scarica': return github.download(a.repo, pick(a, 'ramo', 'ref') || '');
    case 'locale_elenca': return github.localFiles(a.repo, pick(a, 'cartella', 'folder') || '');
    case 'locale_leggi': return github.localRead(a.repo, pick(a, 'percorso', 'path'));
    case 'locale_cerca': return github.localSearch(a.repo, pick(a, 'testo', 'query'));
    case 'github_scrivi_file': return github.writeFile(a.repo, pick(a, 'percorso', 'path'), pick(a, 'contenuto', 'content') ?? '', pick(a, 'messaggio', 'message'), pick(a, 'ramo', 'branch') || '');
    case 'github_crea_ramo': return github.createBranch(a.repo, a.ramo, a.da || '');
    case 'github_crea_issue': return github.createIssue(a.repo, a.titolo, a.testo || '');
    case 'github_commenta': return github.comment(a.repo, a.numero, a.testo);
    case 'github_crea_pr': return github.createPullRequest(a.repo, a.titolo, a.da_ramo, a.verso_ramo || '', a.testo || '');
    default: throw new Error(`strumento sconosciuto: ${tool}`);
  }
}

// ---------- Prompt di sistema ----------

function systemPrompt(chat, query) {
  const s = getSettings();
  const name = s.assistant.name || 'ideax';
  const facts = memory.relevantFacts(query);
  const others = chats.listChats().filter((c) => c.id !== chat.id).slice(0, 8);
  const tchs = teachers.listTeachers();
  const repos = github.listDownloaded();
  const toolNames = availableTools();
  const canWrite = s.github.allowWrite && s.github.token;
  const vs = voices.listVoices();
  const today = new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  return [
    `Sei ${name}, il cervello personale dell'utente: giri sul suo PC, senza cloud. Oggi è ${today}.`,
    'Parli italiano in modo naturale, caldo e diretto, come un collaboratore che lo conosce bene. Frasi chiare, niente giri di parole. Usa il markdown solo quando aiuta (elenchi, codice).',
    s.assistant.style ? `Come preferisce che tu parli: ${s.assistant.style}` : '',
    '',
    'COSA SAI DELL\'UTENTE (ricordi, comuni a tutte le chat):',
    facts.length ? memory.asText(facts) : '(ancora niente: è il momento di conoscerlo)',
    '',
    'IMPARARE: ogni volta che l\'utente rivela qualcosa di stabile su di sé (nome, lavoro, aziende, clienti, progetti e sistemi, persone, gusti, regole, modo di comunicare) mettilo in "remember" come frase breve in terza persona (es. "Si chiama Marco", "Gestisce l\'agenzia X"). Non salvare cose già presenti nei ricordi, saluti o richieste passeggere.',
    chat.mode === 'intervista'
      ? 'MODALITÀ INTERVISTA: stai conoscendo l\'utente. Fai UNA domanda alla volta, breve e concreta, partendo da ciò che non sai ancora (chi è, lavoro, aziende, progetti, sistemi che usa, persone chiave, obiettivi, gusti, come vuole che tu parli). Commenta in una riga la risposta, salva ciò che impari e passa alla domanda successiva.'
      : '',
    '',
    'STRUMENTI: se serve, scegline UNO in "action" con i suoi argomenti; riceverai il risultato e potrai continuare. Quando hai finito usa "nessuna" e scrivi la risposta in "reply". Non inventare mai risultati: se non sai, usa uno strumento o dillo.',
    'Per creare immagini, video, animazioni, voce, musica o reel usa SEMPRE lo strumento di creazione (scrivi la descrizione in inglese ricca di dettagli visivi per immagini e video) e in "reply" dì in una riga cosa stai creando.',
    'Se l\'utente vuole una foto di sé stesso ("una foto di me…") scrivi nella descrizione "photo of me" seguito dalla scena: ideax userà il suo gemello foto.',
    canWrite ? 'Le modifiche su GitHub sono permesse, ma falle solo se l\'utente le chiede esplicitamente e riassumi cosa hai cambiato.' : 'Su GitHub puoi solo leggere e scaricare: le modifiche sono disattivate nelle impostazioni.',
    ...toolNames.map((t) => `- ${t}(${TOOLS[t].args}): ${TOOLS[t].desc}`),
    '',
    others.length ? `ALTRE CHAT (puoi cercarle o leggerle):\n${others.map((c) => `- ${c.id}: ${c.title}`).join('\n')}` : '',
    tchs.length ? `MAESTRI COLLEGATI: ${tchs.map((t) => t.name).join(', ')}` : '',
    repos.length ? `REPOSITORY SCARICATI SUL PC: ${repos.join(', ')}` : '',
    vs.length ? `VOCI CLONATE: ${vs.map((v) => v.name).join(', ')}` : '',
    '',
    'Rispondi SOLO con il JSON richiesto: {"reply": "...", "action": {"tool": "...", "args": {...}}, "remember": [...]}.',
  ].filter((l) => l !== '').join('\n');
}

function availableTools() {
  const s = getSettings();
  return Object.keys(TOOLS).filter((t) => {
    if (TOOLS[t].write && !(s.github.allowWrite && s.github.token)) return false;
    if (t === 'chiedi_al_maestro' && !teachers.listTeachers().length) return false;
    if (t === 'leggi_con_voce' && !engines.isInstalled('voice')) return false;
    if (t === 'crea_musica' && !engines.isInstalled('music')) return false;
    if (t === 'video_gemello' && (!engines.isInstalled('lipsync') || !engines.isInstalled('voice'))) return false;
    return true;
  });
}

function historyMessages(chat) {
  const out = [];
  let used = 0;
  for (const m of [...chat.messages].reverse()) {
    if (!m.content && !m.attachments?.length) continue;
    let text = String(m.content || '');
    if (m.role === 'user' && m.attachments?.length) text += `\n[allegati: ${m.attachments.map((x) => x.name).join(', ')}]`;
    if (m.role === 'assistant' && m.jobs?.length) text += '\n[ho avviato una creazione, mostrata all\'utente]';
    if (m.files?.length) text = `${text}\n\n${m.files.map((f) => `--- ${f.name} ---\n${f.text}`).join('\n\n')}`;
    text = text.slice(0, 6000);
    if (used + text.length > HISTORY_BUDGET && out.length) break;
    used += text.length;
    out.unshift({ role: m.role === 'user' ? 'user' : 'assistant', content: text });
  }
  return out;
}

// ---------- Esecuzione di un messaggio ----------

const TEXT_FILE = /\.(txt|md|markdown|csv|json|ya?ml|xml|html?|js|ts|py|sql|log)$/i;

// Salva gli allegati del messaggio: immagini e video tra i file di ideax, i testi letti per il cervello
function storeAttachments(list = []) {
  const attachments = [];
  const files = [];
  for (const a of list) {
    if (!a?.dataUrl) continue;
    const buf = Buffer.from(a.dataUrl.slice(a.dataUrl.indexOf(',') + 1), 'base64');
    const type = a.type || a.dataUrl.slice(5, a.dataUrl.indexOf(';'));
    if (/^(image|video|audio)\//.test(type)) {
      const ext = (path.extname(a.name || '') || `.${type.split('/')[1]}`).replace(/[^.\w]/g, '').slice(0, 6);
      const name = `chat-${crypto.randomUUID().slice(0, 8)}${ext}`;
      fs.writeFileSync(path.join(OUTPUT_DIR, name), buf);
      attachments.push({ name: a.name || name, type, url: `/outputs/${name}` });
    } else if (TEXT_FILE.test(a.name || '') || type.startsWith('text/') || type === 'application/json') {
      files.push({ name: a.name || 'testo', text: buf.toString('utf8').slice(0, 40000) });
    }
  }
  return { attachments, files };
}

const running = new Map();

export function isBusy(chatId) { return running.has(chatId); }

// Aggiunge il messaggio dell'utente e fa partire il cervello; restituisce una promessa con la risposta
export function send(chat, { text, attachments, ctx = {} }) {
  if (running.has(chat.id)) throw new Error('Sto ancora rispondendo al messaggio precedente');
  const content = String(text || '').trim();
  const stored = storeAttachments(attachments);
  if (!content && !stored.attachments.length && !stored.files.length) throw new Error('Scrivi un messaggio');
  const userMsg = chats.addMessage(chat, { role: 'user', content, ...stored });
  if (!chat.title) { chat.title = fallbackTitle(content || stored.files[0]?.name || 'Allegato'); chats.saveChat(chat); }
  chat.pending = { startedAt: Date.now(), steps: [], text: '' };
  const p = run(chat, userMsg, ctx)
    .catch((err) => chats.addMessage(chat, { role: 'assistant', content: `Non sono riuscito a rispondere: ${err.message}`, error: true }))
    .finally(() => { delete chat.pending; running.delete(chat.id); chats.saveChat(chat); });
  running.set(chat.id, p);
  return p;
}

async function run(chat, userMsg, ctx) {
  const brain = resolveBrain(buildCatalog().all);
  if (brain.mode === 'rules') return runWithoutBrain(chat, userMsg, ctx);
  if (brain.mode === 'gguf' && llama.llm.model !== brain.model.path) {
    chat.pending.steps = [llama.isInstalled() ? 'Accendo il cervello' : 'Scarico il motore del cervello (solo la prima volta, qualche minuto)'];
    await llama.ensure(brain.model.path);
    chat.pending.steps = [];
  }
  const tools = availableTools();
  const schema = stepSchema(tools);
  const query = `${userMsg.content} ${chat.messages.slice(-4).map((m) => m.content).join(' ')}`;
  const messages = [{ role: 'system', content: systemPrompt(chat, query) }, ...historyMessages(chat)];
  const steps = [];
  const jobs = [];
  const remembered = [];
  let reply = '';
  for (let i = 0; i < MAX_STEPS; i++) {
    const out = await chatBrain(brain, messages, schema, { temperature: 0.6, maxTokens: 1500 });
    for (const r of Array.isArray(out.remember) ? out.remember : []) {
      const f = memory.remember(r?.text, { category: r?.category, source: 'chat', chatId: chat.id });
      if (f && !f.updated) remembered.push(f.text);
    }
    const tool = out.action?.tool;
    reply = String(out.reply || '').trim();
    if (!tool || tool === NONE || !TOOLS[tool]) break;
    const args = out.action.args && typeof out.action.args === 'object' ? out.action.args : {};
    const label = stepLabel(tool, args);
    steps.push(label);
    chat.pending.steps = [...steps];
    chat.pending.text = reply;
    let result;
    try {
      result = await runTool(tool, args, chat, ctx);
      if (result?.job) jobs.push(result.job);
    } catch (err) {
      result = { errore: err.message };
      steps[steps.length - 1] = `${label} · non riuscito`;
    }
    // Le creazioni vanno avanti da sole: la risposta di questo passo basta
    if (TOOLS[tool].media && !result.errore) {
      if (!reply) reply = 'Ci lavoro: il risultato arriva qui sotto.';
      break;
    }
    messages.push({ role: 'assistant', content: JSON.stringify({ reply, action: { tool, args } }) });
    messages.push({ role: 'user', content: `[RISULTATO di ${tool}]\n${JSON.stringify(result).slice(0, 9000)}\n\nContinua: usa un altro strumento oppure rispondi all'utente con "nessuna".` });
    if (i === MAX_STEPS - 1) reply = reply || 'Ho raccolto quello che serviva, ma mi sono fermato: dimmi come proseguire.';
  }
  return chats.addMessage(chat, { role: 'assistant', content: reply || '…', steps, jobs, remembered, brain: brain.label });
}

// Senza LLM: niente conversazione vera, ma ricordi espliciti e creazioni funzionano lo stesso
const CREATE = /\b(crea|creami|genera|generami|fammi|fai|disegna|disegnami|realizza|produci|componi|scrivi una canzone|immagine|foto|video|reel|musica|base|animazione)\b/i;
async function runWithoutBrain(chat, userMsg, ctx) {
  const text = userMsg.content;
  const rem = text.match(/^\s*(ricorda(ti)?|memorizza|segnati)\s+(che\s+)?(.+)/i);
  if (rem) {
    memory.remember(rem[4], { source: 'chat', chatId: chat.id });
    return chats.addMessage(chat, { role: 'assistant', content: 'Fatto, me lo ricordo.', remembered: [rem[4]] });
  }
  if (CREATE.test(text) || userMsg.attachments?.length) {
    const body = { prompt: text || 'migliora questa immagine', metadata: { chat: chat.id } };
    if (userMsg.attachments?.length) body.attachments = userMsg.attachments.map((x) => fileToDataUrl(x.url));
    if (/\b(reel|tiktok|shorts?)\b/i.test(text)) Object.assign(body, { kind: 'reel', reel: { duration: Number(text.match(/(\d+)\s*(s\b|sec)/i)?.[1]) || 30 } });
    else if (engines.isInstalled('music') && host.musicFromPrompt?.(text)) Object.assign(body, { kind: 'music', music: host.musicFromPrompt(text) });
    const job = await host.createJob(body, ctx);
    return chats.addMessage(chat, { role: 'assistant', content: 'Ci lavoro: il risultato arriva qui sotto.', jobs: [job.id] });
  }
  return chats.addMessage(chat, {
    role: 'assistant',
    needsBrain: true,
    content: 'Per conversare davvero mi serve un cervello: un modello linguistico che gira sul tuo PC. Vai in **Cervello** e segui "Dammi un cervello" (consiglio Qwen3 14B, file .gguf da circa 9 GB), oppure collega Ollama o LM Studio. Intanto posso già creare: chiedimi un\'immagine, un video, una musica o un reel.',
  });
}

// ---------- Addestramento rapido ----------

const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      maxItems: 30,
      items: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string', enum: Object.keys(memory.CATEGORIES) } }, required: ['text', 'category'] },
    },
  },
  required: ['facts'],
};

// Da un testo qualsiasi ai ricordi: con il cervello estrae i fatti, senza cervello salva le frasi così come sono
export async function extractFacts(text, source) {
  const brain = resolveBrain(buildCatalog().all);
  const chunks = [];
  for (let i = 0; i < text.length; i += 3500) chunks.push(text.slice(i, i + 3500));
  const saved = [];
  for (const chunk of chunks.slice(0, 40)) {
    let facts;
    if (brain.mode !== 'rules') {
      try {
        const out = await chatBrain(brain, [
          { role: 'system', content: 'Estrai dal testo i fatti utili e duraturi sulla persona di cui si parla (l\'utente): identità, lavoro, aziende, clienti, progetti, sistemi software, persone, gusti, regole, modo di comunicare. Ogni fatto è una frase breve e autonoma in italiano, in terza persona. Ignora dettagli passeggeri. Rispondi solo in JSON.' },
          { role: 'user', content: chunk },
        ], FACTS_SCHEMA, { temperature: 0.1, maxTokens: 2000 });
        facts = out.facts;
      } catch {
        facts = null;
      }
    }
    if (!facts) {
      facts = chunk.split(/(?<=[.!?])\s+|\n+/).map((t) => t.replace(/^[-*•\d.)\s]+/, '').trim()).filter((t) => t.length > 15 && t.length < 400).map((t) => ({ text: t, category: 'altro' }));
    }
    for (const f of facts) {
      const r = memory.remember(f.text, { category: f.category, source });
      if (r && !r.updated) saved.push(r.text);
    }
  }
  return saved;
}

export const learning = { status: 'idle', teacher: null, step: 0, total: 0, current: '', learned: 0, error: null, chatId: null };

const LESSON = [
  'Chi è la persona che segui? Nome, ruolo, dove vive e lavora, in poche righe.',
  'Di cosa si occupa nel lavoro? Aziende, attività, servizi che vende, clienti tipici.',
  'Quali progetti e sistemi software sta costruendo o usa ogni giorno (per esempio billpro)? A cosa serve ciascuno e come sono collegati?',
  'Quali sono i suoi obiettivi adesso e nei prossimi mesi?',
  'Chi sono le persone importanti con cui lavora (soci, collaboratori, clienti chiave) e che ruolo hanno?',
  'Come preferisce che gli si parli? Tono, lunghezza delle risposte, cose che lo infastidiscono.',
  'Quali regole, abitudini o preferenze devo rispettare quando lavoro per lui (stile grafico, marchi, colori, toni di voce, cose da non fare mai)?',
  'Che gusti ha per immagini, video, musica e contenuti social? Che stile hanno i suoi reel e i suoi post?',
  'C\'è altro di importante che dovrei sapere per aiutarlo come fai tu?',
];

export function learnFromTeacher(teacherName, extra = []) {
  if (learning.status === 'running') throw new Error('Sto già imparando: aspetta che finisca');
  const t = teachers.findTeacher(teacherName);
  if (!t) throw new Error('Maestro non trovato');
  const questions = [...LESSON, ...extra.filter(Boolean)];
  const chat = chats.createChat({ title: `Lezione da ${t.name}`, mode: 'lezione' });
  Object.assign(learning, { status: 'running', teacher: t.name, step: 0, total: questions.length, current: '', learned: 0, error: null, chatId: chat.id });
  const system = `Sei ${t.name}. Stai passando a ideax, il nuovo cervello locale della stessa persona che segui, tutto quello che sai di lei, così potrà aiutarla come fai tu. Rispondi in italiano, in modo concreto e dettagliato, con fatti (nomi, cifre, esempi). Se non sai qualcosa dillo.`;
  (async () => {
    for (const q of questions) {
      learning.step++;
      learning.current = q;
      try {
        chats.addMessage(chat, { role: 'user', content: q });
        const answer = await teachers.ask(t, q, { system });
        chats.addMessage(chat, { role: 'assistant', content: answer, from: t.name });
        learning.learned += (await extractFacts(answer, t.name)).length;
      } catch (err) {
        learning.error = err.message;
        if (learning.step === 1) break; // il maestro non risponde: inutile continuare
      }
    }
    learning.status = learning.error && learning.learned === 0 ? 'error' : 'done';
    learning.current = '';
  })();
  return learning;
}
