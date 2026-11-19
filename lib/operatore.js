// Operatore autonomo DENTRO ideax: ciclo chiuso Analisi → Codifica → Esecuzione → Validazione,
// guidato dal cervello locale di ideax. Ti risponde nell'interfaccia (pagina Operatore), e ogni
// azione con effetti (scrivere uno script, eseguirlo) si FERMA e chiede il tuo sì a schermo.
//
// v1: sa scrivere ed eseguire codice Python e validarlo. NIENTE web e NIENTE pagamenti — non per
// dimenticanza: il cervello può produrre solo i passi 'scrivi' | 'esegui' | 'valida' | 'fatto',
// quindi un pagamento è strutturalmente impossibile. Il web arriverà come passo successivo, e
// quando arriverà il checkout sarà sempre un "ti porto e mi fermo, paghi tu".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR } from './store.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog } from './router.js';
import { pythonPath } from './runtime.js';

const RADICE = path.join(DATA_DIR, 'operatore'); // la cartella di lavoro: gli script stanno solo qui
const MAX_GIRI = 30;
const runs = new Map();

// Cosa può decidere il cervello a ogni giro. Niente 'naviga'/'checkout': nessun web, nessun pagamento.
const SCHEMA_PASSO = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['scrivi', 'esegui', 'valida', 'fatto'] },
    nota: { type: 'string', description: 'una riga: cosa fai e perché' },
    nome_file: { type: 'string', description: 'per scrivi/esegui: nome del file .py dentro la cartella di lavoro' },
    codice: { type: 'string', description: 'per scrivi: il contenuto completo dello script' },
    esito: { type: 'boolean', description: 'per valida: l\'obiettivo è raggiunto?' },
    messaggio: { type: 'string', description: 'per fatto: la risposta finale per l\'utente' },
  },
  required: ['tipo'],
};

const SISTEMA = [
  'Sei un operatore autonomo dentro ideax. Raggiungi l\'obiettivo dell\'utente con un ciclo:',
  'decidi UN passo alla volta e restituiscilo come JSON secondo lo schema.',
  '- "scrivi": scrivi uno script Python completo (campo codice) in un file (campo nome_file, es. "lavoro.py").',
  '- "esegui": esegui uno script già scritto (nome_file). Ne riceverai l\'output nel passo dopo.',
  '- "valida": guarda l\'ultimo output e dì se l\'obiettivo è raggiunto (esito true/false).',
  '- "fatto": hai finito; scrivi la risposta finale nel campo messaggio.',
  'Scrivi codice che STAMPA i risultati, così la validazione può leggerli. Un solo passo per risposta.',
  'Non puoi navigare il web né pagare: non esistono passi per farlo.',
].join('\n');

function vista(run) {
  return {
    id: run.id, obiettivo: run.obiettivo, stato: run.stato, errore: run.errore || null,
    passi: run.passi, log: run.log.slice(-200), risultato: run.risultato || null,
    inAttesa: run.inAttesa ? { categoria: run.inAttesa.categoria, azione: run.inAttesa.azione, dettaglio: run.inAttesa.dettaglio } : null,
  };
}

function nota(run, msg) { run.log.push({ t: Date.now(), msg: String(msg) }); }

// Aspetta il sì dalla UI: mette il passo in "inAttesa" e si blocca finché /conferma non risponde.
function chiedi(run, richiesta) {
  return new Promise((resolve, reject) => {
    run.inAttesa = {
      ...richiesta,
      _rispondi: (ok) => { run.inAttesa = null; ok ? resolve() : reject(Object.assign(new Error('rifiutato dall\'utente'), { rifiutato: true })); },
    };
  });
}

function dentroRadice(nome) {
  const dest = path.resolve(RADICE, String(nome || '').replace(/^[/\\]+/, ''));
  if (dest !== RADICE && !dest.startsWith(RADICE + path.sep)) throw new Error('percorso fuori dalla cartella di lavoro');
  if (!/\.py$/i.test(dest)) throw new Error('per ora si scrivono solo file .py');
  return dest;
}

function scriviFile(run, passo) {
  const dest = dentroRadice(passo.nome_file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, String(passo.codice || ''), 'utf8');
  nota(run, `Scritto ${path.relative(RADICE, dest)} (${Buffer.byteLength(passo.codice || '')} byte).`);
  return dest;
}

// Esegue uno script e raccoglie l'output riga per riga (va anche nel log, in tempo reale).
function esegui(run, passo) {
  const dest = dentroRadice(passo.nome_file);
  if (!fs.existsSync(dest)) throw new Error(`lo script ${passo.nome_file} non esiste ancora`);
  const py = pythonPath() || 'python3';
  return new Promise((resolve) => {
    const child = spawn(py, [dest], { cwd: RADICE });
    run._child = child;
    let out = '';
    const onData = (d) => { const s = String(d); out += s; for (const r of s.split('\n')) if (r.trim()) nota(run, `  ${r}`); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* già morto */ } }, 10 * 60 * 1000);
    child.on('close', (code) => {
      clearTimeout(timer); run._child = null;
      nota(run, `Uscita con codice ${code}.`);
      resolve({ codice: code, output: out.slice(-8000) });
    });
    child.on('error', (err) => { clearTimeout(timer); run._child = null; resolve({ codice: -1, output: `errore di avvio: ${err.message}` }); });
  });
}

async function pianifica(run, brain) {
  const messaggi = [{ role: 'system', content: SISTEMA }, { role: 'user', content: `Obiettivo: ${run.obiettivo}` }];
  for (const p of run.passi) {
    messaggi.push({ role: 'assistant', content: JSON.stringify({ tipo: p.tipo, nota: p.nota, nome_file: p.nome_file }) });
    if (p.output != null) messaggi.push({ role: 'user', content: `Output del passo (codice ${p.codice_uscita}):\n${p.output}` });
  }
  messaggi.push({ role: 'user', content: 'Qual è il prossimo passo? Rispondi SOLO col JSON dello schema.' });
  return chatBrain(brain, messaggi, SCHEMA_PASSO, { temperature: 0.2, maxTokens: 1500, timeout: 600_000 });
}

async function ciclo(run) {
  const brain = resolveBrain(buildCatalog().all, { heavy: true });
  if (brain.mode === 'rules') { run.stato = 'errore'; run.errore = 'Serve un cervello (LLM) caricato in ideax: installane uno dalla pagina Cervello.'; return; }
  fs.mkdirSync(RADICE, { recursive: true });
  run.stato = 'in corso';
  try {
    for (let giro = 0; giro < MAX_GIRI && !run.cancelled; giro++) {
      let passo;
      try { passo = await pianifica(run, brain); }
      catch (err) { run.stato = 'errore'; run.errore = `il cervello non ha risposto: ${err.message}`; return; }
      if (!passo || !passo.tipo) { run.stato = 'errore'; run.errore = 'il cervello non ha prodotto un passo valido'; return; }
      nota(run, `[${passo.tipo}] ${passo.nota || ''}`);
      const registro = { tipo: passo.tipo, nota: passo.nota || '', nome_file: passo.nome_file || null, output: null, codice_uscita: null };
      try {
        if (passo.tipo === 'fatto') { run.risultato = passo.messaggio || 'Finito.'; run.stato = 'finito'; run.passi.push(registro); return; }
        if (passo.tipo === 'scrivi') {
          await chiedi(run, { categoria: 'scrittura', azione: `scrivere lo script ${passo.nome_file}`, dettaglio: String(passo.codice || '').slice(0, 4000) });
          scriviFile(run, passo);
        } else if (passo.tipo === 'esegui') {
          await chiedi(run, { categoria: 'esecuzione', azione: `eseguire ${passo.nome_file}`, dettaglio: '' });
          const r = await esegui(run, passo);
          registro.output = r.output; registro.codice_uscita = r.codice; run.ultimo = r;
        } else if (passo.tipo === 'valida') {
          run.ok = !!passo.esito;
          nota(run, `Validazione: ${run.ok ? 'OK' : 'non superata'}.`);
          if (run.ok) { run.risultato = passo.nota || 'Obiettivo raggiunto.'; run.stato = 'finito'; run.passi.push(registro); return; }
        }
      } catch (err) {
        if (err.rifiutato) { run.stato = 'fermato'; nota(run, '✋ Fermato da te.'); run.passi.push(registro); return; }
        run.stato = 'errore'; run.errore = err.message; return;
      }
      run.passi.push(registro);
    }
    if (run.cancelled) { run.stato = 'fermato'; } else if (run.stato === 'in corso') { run.stato = 'esaurito'; run.errore = `Mi sono fermato dopo ${MAX_GIRI} passi senza concludere.`; }
  } finally {
    if (run.inAttesa) run.inAttesa = null;
  }
}

// ---------- API usata dal server ----------

export function avvia(obiettivo) {
  const testo = String(obiettivo || '').trim();
  if (!testo) throw new Error('Scrivi cosa deve fare l\'operatore');
  const id = crypto.randomUUID().slice(0, 8);
  const run = { id, obiettivo: testo, stato: 'in corso', passi: [], log: [], inAttesa: null, cancelled: false, risultato: null, errore: null };
  runs.set(id, run);
  // vecchi run: teniamo gli ultimi 20
  for (const k of [...runs.keys()].slice(0, -20)) runs.delete(k);
  ciclo(run); // gira in sottofondo; la UI segue con /stato
  return vista(run);
}

export function stato(id) {
  const run = runs.get(id);
  if (!run) throw new Error('operatore non trovato');
  return vista(run);
}

export function rispondi(id, ok) {
  const run = runs.get(id);
  if (!run) throw new Error('operatore non trovato');
  if (!run.inAttesa) return vista(run);
  run.inAttesa._rispondi(!!ok);
  return vista(run);
}

export function ferma(id) {
  const run = runs.get(id);
  if (!run) throw new Error('operatore non trovato');
  run.cancelled = true;
  if (run._child) { try { run._child.kill(); } catch { /* già morto */ } }
  if (run.inAttesa) run.inAttesa._rispondi(false);
  return vista(run);
}
