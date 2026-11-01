// La regia: ideax conosce tutti i tuoi progetti e studia come farli rendere.
// - Progetti: da GitHub (project.json di Mission Control, README, note Replit) una scheda per progetto,
//   riassunta dal cervello: a cosa serve, cosa sa fare, per chi, come guadagna, come ideax lo usa.
// - Business: il cervello di riserva incrocia i progetti e propone idee concrete con primi passi strumento per strumento.
// - Missioni: un'idea scelta diventa una lista di passi ("userò Bill per…") con lo stato di ognuno.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getSettings } from './store.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog } from './router.js';
import * as github from './github.js';
import * as memory from './memory.js';

let host = { createJob: null, getJob: null };
export function configure(fns) { host = { ...host, ...fns }; }

const DIR = path.join(DATA_DIR, 'regia');
const FILE = path.join(DIR, 'regia.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return { projects: [], ideas: [], missions: [], studiedAt: null };
  }
}
function save(d) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2));
}

export const study = { status: 'idle', step: null, done: 0, total: 0, error: null };
export const thinking = { status: 'idle', error: null };

export function state() {
  const d = load();
  return { ...d, study, thinking };
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    a_cosa_serve: { type: 'string' },
    cosa_sa_fare: { type: 'array', items: { type: 'string' }, maxItems: 8 },
    per_chi: { type: 'string' },
    come_guadagna: { type: 'string' },
    stato: { type: 'string', enum: ['in produzione', 'in sviluppo', 'prototipo', 'fermo', 'non chiaro'] },
    categoria: { type: 'string', enum: ['social e marketing', 'gestionale', 'contenuti e media', 'siti e vetrine', 'assistente AI', 'giochi e app', 'strumento interno', 'altro'] },
    come_ideax_lo_usa: { type: 'string' },
  },
  required: ['a_cosa_serve', 'cosa_sa_fare', 'per_chi', 'come_guadagna', 'stato', 'categoria', 'come_ideax_lo_usa'],
};

function heavyBrain() {
  const b = resolveBrain(buildCatalog().all, { heavy: true });
  return b.mode === 'rules' ? null : b;
}

// Le persone e le aziende da conoscere ma non usare (es. il gestionale di IDEAeventi con Axel)
const KNOW_ONLY = /gestionale/i;

async function summarize(brain, p, texts) {
  if (!brain) {
    const first = (texts.readme || texts.replit || '').replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('_') && !l.startsWith('**')).slice(0, 2).join(' ');
    return { a_cosa_serve: p.description || first.slice(0, 300) || 'Da descrivere', cosa_sa_fare: [], per_chi: '', come_guadagna: '', stato: 'non chiaro', categoria: 'altro', come_ideax_lo_usa: '' };
  }
  return chatBrain(brain, [
    { role: 'system', content: 'Sei la regia di ideax. Leggi i documenti di un progetto software dell\'utente e scrivi una scheda breve, concreta, in italiano. Non inventare: se un dato non c\'è, scrivi "da chiarire". "come_ideax_lo_usa": in una frase, per cosa ideax (cervello locale con immagini, video, voce, musica, reel e regia dei progetti) può usare questo progetto in un piano di business.' },
    { role: 'user', content: `Progetto: ${p.name}\nIndirizzo: ${p.url || '—'}\nDescrizione GitHub: ${p.description || '—'}\n\nproject.json:\n${texts.project || '—'}\n\nREADME:\n${(texts.readme || '—').slice(0, 5000)}\n\nNote (replit.md):\n${(texts.replit || '—').slice(0, 7000)}` },
  ], SUMMARY_SCHEMA, { temperature: 0.2, maxTokens: 1200, timeout: 600_000 });
}

export function studyProjects() {
  if (study.status === 'running') return study;
  if (!getSettings().github.token) throw new Error('Serve il token di GitHub (Cervello → GitHub) per leggere i tuoi progetti.');
  Object.assign(study, { status: 'running', step: 'Elenco dei repository', done: 0, total: 0, error: null });
  (async () => {
    try {
      const repos = await github.myRepos();
      study.total = repos.length;
      const brain = heavyBrain();
      const d = load();
      for (const r of repos) {
        study.step = `Studio ${r.repo}`;
        const [project, readme, replit] = await Promise.all([github.rawFile(r.repo, 'project.json', 6000), github.rawFile(r.repo, 'README.md'), github.rawFile(r.repo, 'replit.md')]);
        let pj = {};
        try { pj = JSON.parse(project); } catch {}
        const old = d.projects.find((x) => x.repo === r.repo) || {};
        const p = {
          id: old.id || crypto.randomUUID().slice(0, 8),
          repo: r.repo,
          name: pj.nome || r.repo.split('/')[1],
          url: pj.indirizzo || old.url || '',
          description: r.description || '',
          languages: pj.linguaggi || (r.language ? [r.language] : []),
          lastCommit: pj.ultimo_commit || r.updated,
          sendsTo: (pj.manda_dati_a || []).map((x) => x.progetto),
          dependsOn: pj.dipende_da || [],
          private: r.private,
        };
        let summary = old.summary;
        try {
          summary = await summarize(brain, p, { project, readme, replit });
        } catch (err) {
          summary = summary || { a_cosa_serve: p.description || 'Da descrivere', cosa_sa_fare: [], stato: 'non chiaro', categoria: 'altro' };
          study.error = `Riassunto di ${p.name} non riuscito: ${err.message}`;
        }
        // Le correzioni dell'utente restano: nota e "solo da conoscere" non si sovrascrivono
        const merged = { ...p, summary, note: old.note || '', knowOnly: old.knowOnly ?? KNOW_ONLY.test(r.repo), studiedAt: Date.now() };
        d.projects = [...d.projects.filter((x) => x.repo !== r.repo), merged];
        save(d);
        study.done++;
      }
      d.projects.sort((a, b) => String(b.lastCommit).localeCompare(String(a.lastCommit)));
      d.studiedAt = Date.now();
      save(d);
      rememberProjects(d.projects);
      Object.assign(study, { status: 'done', step: null });
    } catch (err) {
      Object.assign(study, { status: 'error', error: err.message, step: null });
    }
  })();
  return study;
}

// Ogni progetto diventa un ricordo: così la chat sa di cosa parli quando dici "Bill" o "IDEAlab"
function rememberProjects(projects) {
  for (const p of projects) {
    const s = p.summary || {};
    const text = `${p.name}${p.url ? ` (${p.url})` : ''}: ${s.a_cosa_serve || p.description || 'progetto'}${p.knowOnly ? ' — da conoscere, non da usare per ora' : ''}`;
    memory.remember(text, { category: 'progetti', source: 'regia' });
  }
}

export function updateProject(id, patch) {
  const d = load();
  const p = d.projects.find((x) => x.id === id);
  if (!p) throw new Error('Progetto non trovato');
  if (patch.note != null) p.note = String(patch.note).slice(0, 2000);
  if (patch.knowOnly != null) p.knowOnly = !!patch.knowOnly;
  save(d);
  return p;
}

// ---------- Business ----------

const IDEAS_SCHEMA = {
  type: 'object',
  properties: {
    idee: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          titolo: { type: 'string' },
          idea: { type: 'string' },
          clienti: { type: 'string' },
          offerta_e_prezzo: { type: 'string' },
          ricavo_mensile_stimato: { type: 'string' },
          tempo_al_primo_incasso: { type: 'string' },
          progetti: { type: 'array', items: { type: 'object', properties: { progetto: { type: 'string' }, ruolo: { type: 'string' } }, required: ['progetto', 'ruolo'] } },
          passi: { type: 'array', maxItems: 12, items: { type: 'object', properties: { strumento: { type: 'string' }, cosa: { type: 'string' } }, required: ['strumento', 'cosa'] } },
          rischi: { type: 'string' },
        },
        required: ['titolo', 'idea', 'clienti', 'offerta_e_prezzo', 'ricavo_mensile_stimato', 'tempo_al_primo_incasso', 'progetti', 'passi', 'rischi'],
      },
    },
  },
  required: ['idee'],
};

export function proposeBusiness(focus = '') {
  if (thinking.status === 'running') return thinking;
  const d = load();
  if (!d.projects.length) throw new Error('Prima fai studiare i tuoi progetti (Regia → Studia i miei progetti).');
  const brain = heavyBrain();
  if (!brain) throw new Error('Per proporre business serve un cervello (pagina Cervello).');
  Object.assign(thinking, { status: 'running', error: null });
  (async () => {
    try {
      const usable = d.projects.filter((p) => !p.knowOnly);
      const known = d.projects.filter((p) => p.knowOnly);
      const list = (ps) => ps.map((p) => {
        const s = p.summary || {};
        return `- ${p.name}${p.url ? ` (${p.url})` : ''} [${s.categoria || '?'} · ${s.stato || '?'}]: ${s.a_cosa_serve || p.description}. Sa fare: ${(s.cosa_sa_fare || []).join('; ')}. Per chi: ${s.per_chi || '?'}. Ricavi: ${s.come_guadagna || '?'}.${p.note ? ` Nota dell'utente: ${p.note}` : ''}`;
      }).join('\n');
      const facts = memory.asText(memory.relevantFacts('lavoro aziende clienti obiettivi progetti', 4000));
      const out = await chatBrain(brain, [
        { role: 'system', content: 'Sei la regia di ideax, consulente di business pratico. Proponi idee per far guadagnare l\'utente usando i progetti che ha GIÀ (riusali e combinali, non proporre di costruire da zero ciò che esiste). Ogni idea: chi paga, cosa compra, a che prezzo, una stima onesta del ricavo mensile (con l\'ipotesi), il tempo al primo incasso e i passi concreti, ciascuno con lo strumento da usare (il nome di un progetto, oppure "ideax", oppure "tu" per ciò che deve fare l\'utente: firmare, chiamare clienti, collegare un account). Italiano, concreto, niente promesse gonfiate.' },
        { role: 'user', content: `Progetti utilizzabili:\n${list(usable)}\n\nDa conoscere ma da NON usare per ora:\n${list(known) || '—'}\n\nCosa so dell'utente:\n${facts || '—'}\n\n${focus ? `Richiesta specifica: ${focus}` : 'Proponi le 3-5 idee più promettenti, dalla più veloce a incassare.'}` },
      ], IDEAS_SCHEMA, { temperature: 0.6, maxTokens: 6000, timeout: 900_000 });
      const fresh = (out.idee || []).map((i) => ({ id: crypto.randomUUID().slice(0, 8), createdAt: Date.now(), focus, ...i }));
      const cur = load();
      cur.ideas = [...fresh, ...cur.ideas].slice(0, 30);
      save(cur);
      Object.assign(thinking, { status: 'done' });
    } catch (err) {
      Object.assign(thinking, { status: 'error', error: err.message });
    }
  })();
  return thinking;
}

const PIANO_SCHEMA = {
  type: 'object',
  properties: {
    modello_ricavo: { type: 'string' },
    prezzo: { type: 'string' },
    mercato: { type: 'string' },
    ricavo_mensile_stimato: { type: 'string' },
    tempo_al_primo_incasso: { type: 'string' },
    contenuti: { type: 'array', maxItems: 10, items: { type: 'object', properties: {
      tipo: { type: 'string', enum: ['reel', 'immagine', 'video', 'video da registrazione schermo', 'articolo', 'post', 'landing'] },
      strumento: { type: 'string' }, idea: { type: 'string' }, quanti: { type: 'string' },
    }, required: ['tipo', 'strumento', 'idea'] } },
    social: { type: 'array', maxItems: 6, items: { type: 'object', properties: { piattaforma: { type: 'string' }, cosa: { type: 'string' } }, required: ['piattaforma', 'cosa'] } },
    campagne: { type: 'array', maxItems: 5, items: { type: 'object', properties: { piattaforma: { type: 'string' }, pubblico: { type: 'string' }, budget_mese: { type: 'string' }, messaggio: { type: 'string' } }, required: ['piattaforma', 'pubblico', 'budget_mese'] } },
    passi: { type: 'array', maxItems: 14, items: { type: 'object', properties: { strumento: { type: 'string' }, cosa: { type: 'string' } }, required: ['strumento', 'cosa'] } },
    rischi: { type: 'string' },
  },
  required: ['modello_ricavo', 'prezzo', 'mercato', 'ricavo_mensile_stimato', 'tempo_al_primo_incasso', 'contenuti', 'social', 'campagne', 'passi'],
};

// Il piano per far rendere UN progetto: ricavo, prezzo, contenuti (con quale strumento), social, campagne adv, passi.
export function pianoGuadagno(projectId, focus = '') {
  if (thinking.status === 'running') throw new Error('Sto già ragionando: aspetta che finisca.');
  const d = load();
  const prj = d.projects.find((p) => p.id === projectId);
  if (!prj) throw new Error('Progetto non trovato');
  const brain = heavyBrain();
  if (!brain) throw new Error('Per il piano serve un cervello (pagina Cervello).');
  Object.assign(thinking, { status: 'running', error: null });
  (async () => {
    try {
      const s = prj.summary || {};
      const altri = d.projects.filter((p) => p.id !== projectId && !p.knowOnly).map((p) => `${p.name} (${p.summary?.categoria || '?'})`).join(', ');
      const facts = memory.asText(memory.relevantFacts('lavoro aziende clienti obiettivi', 3000));
      const out = await chatBrain(brain, [
        { role: 'system', content: 'Sei la regia di ideax: fai rendere un software. Dato UN progetto, scrivi il piano concreto per fare soldi con quello, usando gli strumenti dell\'utente. Strumenti disponibili: ideax (immagini, video, reel, personaggi, musica, voce, siti, video da registrazioni dello schermo caricate), Bill (pagine social e campagne per le aziende), i suoi altri progetti. Per ogni contenuto di' + ' "contenuti" indica il tipo e lo strumento (di solito "ideax"). Per le campagne indica piattaforma (Meta, TikTok, Google), pubblico, budget mensile realistico e il messaggio. I "passi" sono azioni concrete, ciascuna con lo strumento ("ideax", "Bill", il nome di un progetto, oppure "tu" per ciò che fa l\'utente). Stime oneste, niente numeri gonfiati. Italiano.' },
        { role: 'user', content: `Progetto: ${prj.name}${prj.url ? ` (${prj.url})` : ''}\nA cosa serve: ${s.a_cosa_serve || prj.description}\nSa fare: ${(s.cosa_sa_fare || []).join('; ')}\nPer chi: ${s.per_chi || '?'}\nRicavi oggi: ${s.come_guadagna || '?'}\nStato: ${s.stato || '?'}${prj.note ? `\nNota: ${prj.note}` : ''}\n\nAltri progetti disponibili: ${altri || '—'}\nCosa so dell\'utente: ${facts || '—'}\n\n${focus || 'Fai il piano per portarlo a rendimento il prima possibile.'}` },
      ], PIANO_SCHEMA, { temperature: 0.55, maxTokens: 5000, timeout: 900_000 });
      const cur = load();
      const prj2 = cur.projects.find((p) => p.id === projectId);
      if (prj2) { prj2.piano = { ...out, creatoIl: Date.now(), focus }; save(cur); }
      Object.assign(thinking, { status: 'done' });
    } catch (err) {
      Object.assign(thinking, { status: 'error', error: err.message });
    }
  })();
  return thinking;
}

// Fa produrre a ideax i contenuti del piano di un progetto (reel, immagini, video, demo del sito). Gli altri passi
// (Bill, campagne, "tu") restano nella lista da spuntare: ideax crea, l'utente collega e paga.
export async function creaContenuti(projectId) {
  const d = load();
  const prj = d.projects.find((p) => p.id === projectId);
  if (!prj?.piano) throw new Error('Prima fai il piano (Regia → Fai soldi con questo).');
  if (!host.createJob) throw new Error('Creazione non disponibile.');
  const avviati = [];
  for (const c of prj.piano.contenuti || []) {
    if (!/ideax/i.test(c.strumento || '')) continue; // solo ciò che fa ideax
    let body = null;
    const prompt = `${c.idea}${prj.piano.tagline ? `. ${prj.piano.tagline}` : ''} — ${prj.name}`;
    if (c.tipo === 'reel') body = { prompt: c.idea, kind: 'reel', reel: { duration: 30 } };
    else if (c.tipo === 'immagine' || c.tipo === 'post' || c.tipo === 'landing') body = { prompt, task: 'image_generate' };
    else if (c.tipo === 'video') body = { prompt, task: 'video_generate' };
    else if (c.tipo === 'video da registrazione schermo') body = prj.url ? { prompt: c.idea, kind: 'demo', demo: { url: prj.url, obiettivo: c.idea, monta: true } } : null;
    if (!body) continue;
    try {
      const job = await host.createJob({ ...body, metadata: { regia: projectId } }, { client: 'regia' });
      avviati.push({ jobId: job.id, tipo: c.tipo, idea: c.idea });
    } catch (err) {
      avviati.push({ errore: err.message, tipo: c.tipo, idea: c.idea });
    }
  }
  if (!avviati.length) throw new Error('Nel piano non ci sono contenuti che ideax può creare da solo (sono tutti su Bill o a tuo carico).');
  const cur = load(); const p2 = cur.projects.find((p) => p.id === projectId);
  if (p2) { p2.piano.lavori = avviati; p2.piano.lavoriIl = Date.now(); save(cur); }
  return avviati;
}

export function deleteIdea(id) {
  const d = load();
  d.ideas = d.ideas.filter((i) => i.id !== id);
  save(d);
}

// ---------- Missioni ----------

export function startMission(ideaId) {
  const d = load();
  const idea = d.ideas.find((i) => i.id === ideaId);
  if (!idea) throw new Error('Idea non trovata');
  const m = {
    id: crypto.randomUUID().slice(0, 8),
    title: idea.titolo,
    ideaId,
    createdAt: Date.now(),
    steps: idea.passi.map((p, i) => ({ id: `${i + 1}`, tool: p.strumento, what: p.cosa, status: 'da fare', note: '' })),
  };
  d.missions.unshift(m);
  save(d);
  return m;
}

export function updateStep(missionId, stepId, patch) {
  const d = load();
  const m = d.missions.find((x) => x.id === missionId);
  const st = m?.steps.find((x) => x.id === stepId);
  if (!st) throw new Error('Passo non trovato');
  if (['da fare', 'in corso', 'fatto', 'bloccato'].includes(patch.status)) st.status = patch.status;
  if (patch.note != null) st.note = String(patch.note).slice(0, 1000);
  st.updatedAt = Date.now();
  save(d);
  return m;
}

export function deleteMission(id) {
  const d = load();
  d.missions = d.missions.filter((m) => m.id !== id);
  save(d);
}

// Per la chat: i progetti in poche righe
export function projectsText() {
  return load().projects.map((p) => `${p.name}${p.knowOnly ? ' (solo da conoscere)' : ''}: ${p.summary?.a_cosa_serve || p.description || ''}`).join('\n');
}
