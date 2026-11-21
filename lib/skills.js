// Skill locali di ideax: capacità nuove che il sistema impara da solo e carica A CALDO, senza riavviarsi.
//
// Una skill è una cartella in data/skills/<slug>/ con dentro:
//   skill.json  → { nome, slug, descrizione, args:{<campo>:<cosa è>}, entry:"main.py", tipo:"python", creato, origine }
//   main.py     → il codice vero (legge l'input JSON da stdin, STAMPA il risultato — JSON se può, altrimenti testo)
//
// Perché a caldo e non col riavvio dell'exe: ideax si spedisce agli utenti a ogni versione, e un processo che
// riscrive il proprio codice e si riavvia è fragile. Una skill è un pezzo ISOLATO che gira in un processo Python
// a parte: aggiungerla al registro è immediato e non tocca il server che sta girando — quindi non si perde il
// contesto della conversazione. La stessa skill viene anche copiata in proposte-self/ dall'autopotenziamento,
// così un domani, con un vero scatto di versione, può entrare nel programma spedito a tutti (scelta deliberata).
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './store.js';
import { pythonPath } from './runtime.js';

export const SKILLS_DIR = path.join(DATA_DIR, 'skills');

export function slug(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'skill';
}

// Il percorso di una skill, confinato dentro SKILLS_DIR (niente fuga con ../).
function cartella(sl) {
  const pulito = slug(sl);
  const dir = path.resolve(SKILLS_DIR, pulito);
  if (dir !== path.resolve(SKILLS_DIR, pulito) || !dir.startsWith(SKILLS_DIR + path.sep)) {
    throw new Error('nome skill non valido');
  }
  return dir;
}

// Cache in memoria: elenco letto dal disco una volta e aggiornato quando si registra una skill nuova.
let cache = null;

export function elenca() {
  if (cache) return cache;
  const out = [];
  try {
    for (const nome of fs.readdirSync(SKILLS_DIR)) {
      const man = path.join(SKILLS_DIR, nome, 'skill.json');
      if (!fs.existsSync(man)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(man, 'utf8'));
        if (m && m.slug && m.entry) out.push(m);
      } catch { /* manifesto rotto: si salta, non si inventa */ }
    }
  } catch { /* la cartella non esiste ancora */ }
  cache = out;
  return out;
}

export function leggi(sl) {
  return elenca().find((m) => m.slug === slug(sl)) || null;
}

export function esiste(sl) { return !!leggi(sl); }

// Scrive la skill sul disco e la aggiunge al registro SUBITO (a caldo). I file sono già stati validati a monte
// (l'autopotenziamento controlla la sintassi prima di chiamare qui); qui si scrive e basta.
// files: { "main.py": "<contenuto>", ... }. Il manifesto deve avere nome, descrizione, entry.
export function registra(manifest, files) {
  const m = { ...manifest };
  m.slug = slug(m.slug || m.nome);
  if (!m.nome) m.nome = m.slug;
  if (!m.entry) throw new Error('manca il file di ingresso (entry) della skill');
  if (!m.tipo) m.tipo = 'python';
  if (!m.args || typeof m.args !== 'object') m.args = {};
  if (!files || !files[m.entry]) throw new Error(`manca il contenuto del file di ingresso ${m.entry}`);
  m.creato = m.creato || new Date().toISOString();

  const dir = cartella(m.slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const [nome, contenuto] of Object.entries(files)) {
    const pulito = String(nome).replace(/^[/\\]+/, '');
    const dest = path.resolve(dir, pulito);
    if (dest !== dir && !dest.startsWith(dir + path.sep)) throw new Error(`percorso fuori dalla skill: ${nome}`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, String(contenuto ?? ''), 'utf8');
  }
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify(m, null, 2), 'utf8');

  // Aggiorna il registro in memoria: da ora il cervello la vede e la può chiamare, senza riavviare nulla.
  cache = (cache || elenca()).filter((x) => x.slug !== m.slug).concat([m]);
  return m;
}

export function dimentica(sl) {
  const s = slug(sl);
  const dir = cartella(s);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* non c'era */ }
  if (cache) cache = cache.filter((x) => x.slug !== s);
  return { tolta: s };
}

// Esegue una skill: lancia il suo entry con Python, l'input (oggetto) va sia come JSON su stdin sia come argv[1].
// La skill STAMPA il risultato; si prova a leggerlo come JSON, altrimenti si torna il testo grezzo. Confinata:
// cwd = cartella della skill. Timeout di sicurezza. Non lancia eccezioni: gli errori tornano in { ok:false }.
export function esegui(sl, input = {}, { timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    let m;
    try { m = leggi(sl); } catch (e) { resolve({ ok: false, errore: e.message }); return; }
    if (!m) { resolve({ ok: false, errore: `skill "${sl}" non trovata` }); return; }
    if (m.tipo !== 'python') { resolve({ ok: false, errore: `tipo skill non eseguibile: ${m.tipo}` }); return; }

    const dir = cartella(m.slug);
    const entry = path.resolve(dir, String(m.entry).replace(/^[/\\]+/, ''));
    if (!entry.startsWith(dir + path.sep) && entry !== path.join(dir, m.entry)) {
      resolve({ ok: false, errore: 'ingresso fuori dalla cartella della skill' }); return;
    }
    if (!fs.existsSync(entry)) { resolve({ ok: false, errore: `il file ${m.entry} non esiste` }); return; }

    const py = pythonPath() || 'python3';
    const inJson = JSON.stringify(input ?? {});
    const child = spawn(py, [entry, inJson], { cwd: dir });
    let out = ''; let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* già morto */ } }, timeout);
    try { child.stdin.write(inJson); child.stdin.end(); } catch { /* la skill non legge stdin: va bene */ }
    child.on('close', (code) => {
      clearTimeout(timer);
      const grezzo = out.trim();
      let risultato = grezzo;
      try { risultato = JSON.parse(grezzo); } catch { /* non è JSON: resta testo */ }
      if (code === 0) resolve({ ok: true, risultato, grezzo, log: err.slice(-2000) });
      else resolve({ ok: false, errore: (err.trim() || grezzo || `uscita con codice ${code}`).slice(-3000), grezzo });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, errore: `avvio non riuscito: ${e.message}` }); });
  });
}
