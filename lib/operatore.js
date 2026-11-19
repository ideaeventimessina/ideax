// Operatore autonomo DENTRO ideax: ciclo chiuso Analisi → Codifica → Esecuzione → Validazione,
// guidato dal cervello locale di ideax. Ti risponde nell'interfaccia (pagina Operatore).
//
// Sa: scrivere ed eseguire codice Python, validarlo, e NAVIGARE il web con un browser vero
// (Playwright): aprire pagine dinamiche, leggere il DOM, cliccare, compilare, estrarre dati.
//
// Due modalità:
// - "strict" (default): OGNI azione con effetti si ferma e chiede il tuo sì a schermo.
// - "semi": auto-conferma SOLO scrivi/esegui/naviga/estrai nella cartella di lavoro (così il
//   loop di auto-correzione gira da solo); si ferma dopo 3 esecuzioni fallite di fila, e chiede
//   SEMPRE conferma per clic e compilazioni (azioni che toccano la pagina).
//
// Il PAGAMENTO non è mai automatico, in nessuna modalità: l'agente arriva al checkout e si ferma,
// paghi tu. Non c'è nessun passo che invia un pagamento.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, OUTPUT_DIR } from './store.js';
import { resolveBrain, chatBrain } from './brain.js';
import { buildCatalog } from './router.js';
import { pythonPath } from './runtime.js';
import * as engines from './engines.js';
import { look, visionModel } from './vision.js';

const RADICE = path.join(DATA_DIR, 'operatore'); // la cartella di lavoro: gli script stanno solo qui
const MAX_GIRI = 40;
const MAX_FALLITI = 3; // esecuzioni fallite di fila oltre cui, in semi, si torna a chiedere conferma
const runs = new Map();

// Cosa può decidere il cervello a ogni giro. C'è il web, ma NON c'è nessun passo che paga.
const SCHEMA_PASSO = {
  type: 'object',
  properties: {
    tipo: { type: 'string', enum: ['scrivi', 'esegui', 'valida', 'naviga', 'clicca', 'compila', 'estrai', 'fatto'] },
    nota: { type: 'string', description: 'una riga: cosa fai e perché' },
    nome_file: { type: 'string', description: 'per scrivi/esegui: nome del file .py dentro la cartella di lavoro' },
    codice: { type: 'string', description: 'per scrivi: il contenuto completo dello script' },
    url: { type: 'string', description: 'per naviga: l\'indirizzo da aprire' },
    selettore: { type: 'string', description: 'per clicca/compila/estrai: selettore CSS (facoltativo se usi testo)' },
    testo: { type: 'string', description: 'per clicca: il testo visibile dell\'elemento su cui cliccare' },
    valore: { type: 'string', description: 'per compila: cosa scrivere nel campo' },
    esito: { type: 'boolean', description: 'per valida: l\'obiettivo è raggiunto?' },
    messaggio: { type: 'string', description: 'per fatto: la risposta finale per l\'utente' },
  },
  required: ['tipo'],
};

const SISTEMA = [
  'Sei un operatore autonomo dentro ideax. Raggiungi l\'obiettivo dell\'utente con un ciclo:',
  'decidi UN passo alla volta e restituiscilo come JSON secondo lo schema.',
  'Codice:',
  '- "scrivi": scrivi uno script Python completo (campo codice) in un file (campo nome_file, es. "lavoro.py").',
  '- "esegui": esegui uno script già scritto (nome_file). Ne riceverai l\'output nel passo dopo.',
  'Web (browser vero, per pagine dinamiche con JavaScript):',
  '- "naviga": apri una pagina (campo url). Ti torna il testo della pagina e un elenco di elementi cliccabili.',
  '- "clicca": clicca un elemento, per TESTO visibile (campo testo) o selettore CSS (campo selettore).',
  '- "compila": scrivi "valore" in un campo (selettore o testo dell\'etichetta). NON compilare mai campi di carta/pagamento.',
  '- "estrai": prendi il testo di un elemento (selettore) o di tutta la pagina.',
  'Chiusura:',
  '- "valida": guarda l\'ultimo output/pagina e dì se l\'obiettivo è raggiunto (esito true/false).',
  '- "fatto": hai finito; scrivi la risposta finale nel campo messaggio.',
  'Un solo passo per risposta. Scrivi codice che STAMPA i risultati.',
  'PAGAMENTI: non puoi pagare. Arriva pure fino alla pagina di pagamento con "naviga", ma NON cliccare "Paga/Conferma" e NON compilare i dati della carta: fermati e lascia "fatto" dicendo all\'utente che tocca a lui pagare.',
].join('\n');

// Categoria di ciascun passo, per la guardia (conferma) e per la modalità semi-autonoma.
const CATEGORIA = {
  scrivi: 'scrittura', esegui: 'esecuzione',
  naviga: 'navigazione', estrai: 'navigazione', // sola lettura: in semi si auto-confermano
  clicca: 'interazione', compila: 'interazione', // toccano la pagina: in semi chiedono SEMPRE
};
// In modalità semi parte da solo tutto quello che l'agente fa (codice e web), FINCHÉ non si superano
// i 3 fallimenti di fila (poi torna a chiedere). Il pagamento NON è qui: è bloccato prima, a monte.
const AUTO_SEMI = new Set(['scrittura', 'esecuzione', 'navigazione', 'interazione']);

// ---------- Modalità Pipeline: input → JSON → scrittura + validazione automatica ----------
// Niente conversazione: un comando, un file. Il modello risponde SOLO col JSON; si scrive il file nella cartella
// di lavoro, si controlla la sintassi, e se è sbagliata ci si ri-prompta da soli finché compila. Il commit+push,
// invece, NON è automatico: è un'azione verso l'esterno e si conferma a mano (è l'unico passo che si ferma).
const SCHEMA_PIPELINE = {
  type: 'object',
  properties: {
    file: { type: 'string', description: 'nome del file (con estensione), dentro la cartella di lavoro' },
    azione: { type: 'string', enum: ['scrivi', 'modifica', 'aggiungi', 'inserisci'] },
    codice: { type: 'string', description: 'per scrivi/modifica il contenuto COMPLETO del file; per aggiungi/inserisci solo le righe nuove' },
    marker: { type: 'string', description: 'solo per "inserisci": la riga-marcatore dopo cui inserire il codice (es. // [MODULO_START]). Il resto del file resta intatto' },
    commit_msg: { type: 'string' },
  },
  required: ['file', 'azione', 'codice'],
};
const SISTEMA_PIPELINE = [
  'Sei un generatore di codice. Rispondi ESCLUSIVAMENTE con un JSON secondo lo schema: { file, azione, codice, marker?, commit_msg }.',
  'Nessuna introduzione, nessuna spiegazione, nessuna avvertenza, nessun testo fuori dal JSON.',
  'Azioni: "scrivi"/"modifica" = codice è il contenuto COMPLETO del file; "aggiungi" = codice sono righe da accodare in fondo;',
  '"inserisci" = codice va messo SUBITO DOPO la riga che contiene "marker" (il resto del file resta intatto): è il modo per aggiungere una funzione senza cancellare il codice esistente.',
  'commit_msg: una riga che descrive la modifica.',
].join('\n');

function dentroRadiceLibero(nome) {
  const pulito = String(nome || '').replace(/^[/\\]+/, '');
  const dest = path.resolve(RADICE, pulito);
  if (dest !== RADICE && !dest.startsWith(RADICE + path.sep)) throw new Error('percorso fuori dalla cartella di lavoro');
  if (!path.extname(dest)) throw new Error('il file deve avere un\'estensione');
  return dest;
}

// Controllo di sintassi locale: .py con py_compile, .js/.mjs/.cjs con node --check. Altri tipi: non si validano.
function validaSintassi(dest) {
  return new Promise((resolve) => {
    let cmd; let args;
    if (/\.py$/i.test(dest)) { cmd = pythonPath() || 'python3'; args = ['-m', 'py_compile', dest]; }
    else if (/\.(mjs|cjs|js)$/i.test(dest)) { cmd = process.execPath; args = ['--check', dest]; }
    else { resolve({ ok: true, saltato: true }); return; }
    const child = spawn(cmd, args, { cwd: RADICE });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.stdout.on('data', (d) => { err += String(d); });
    child.on('close', (code) => resolve(code === 0 ? { ok: true } : { ok: false, errore: err.slice(-2000).trim() }));
    child.on('error', (e) => resolve({ ok: false, errore: e.message }));
  });
}

// Compone il NUOVO contenuto del file SENZA ancora scriverlo (così lo si valida PRIMA di salvare):
// - scrivi/modifica: il contenuto completo nuovo.
// - aggiungi: il vecchio + le righe nuove in fondo.
// - inserisci: il codice messo SUBITO DOPO la riga del marcatore; il resto del file resta intatto.
function componiContenuto(dest, azione, codice, marker) {
  const nuovo = String(codice || '');
  const vecchio = fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : '';
  const conACapo = (t) => (t && !t.endsWith('\n') ? t + '\n' : t);
  if (azione === 'aggiungi') return { contenuto: conACapo(vecchio) + nuovo };
  if (azione === 'inserisci') {
    if (marker && vecchio.includes(marker)) {
      const i = vecchio.indexOf(marker);
      const fine = vecchio.indexOf('\n', i);
      const punto = fine >= 0 ? fine + 1 : vecchio.length;
      return { contenuto: conACapo(vecchio.slice(0, punto)) + nuovo + '\n' + vecchio.slice(punto) };
    }
    return { contenuto: conACapo(vecchio) + nuovo, nota: marker ? `marcatore "${marker}" non trovato: ho accodato in fondo` : 'nessun marcatore indicato: accodato in fondo' };
  }
  return { contenuto: nuovo }; // scrivi, modifica
}

// ---------- Target Router + percorso dinamico (confinato) + packaging ----------
export const PROGETTI_DIR = path.join(RADICE, 'progetti');
const IS_WIN = process.platform === 'win32';

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'lavoro';

// La base dove si scrive: il workspace (default) oppure una CARTELLA scelta dall'utente. In ogni caso i file
// restano DENTRO quella cartella (niente fuga con ../), e il modello NON può scegliere un percorso assoluto suo:
// la base la decide la persona, il modello scrive solo nomi relativi.
function baseSicura(cartella) {
  if (!cartella) return RADICE;
  const b = path.resolve(String(cartella));
  if (b === path.parse(b).root) throw new Error('scegli una cartella, non la radice del disco');
  return b;
}
function destinazione(run, file) {
  const base = run.radice || RADICE;
  const rel = path.join(run.sotto || '', String(file || '').replace(/^[/\\]+/, ''));
  const dest = path.resolve(base, rel);
  if (dest !== base && !dest.startsWith(base + path.sep)) throw new Error('percorso fuori dalla cartella consentita');
  if (!path.extname(dest)) throw new Error('il file deve avere un\'estensione');
  return dest;
}

// Classifica l'obiettivo e sceglie la sottocartella. SELF non tocca il codice VIVO di ideax: scrive una PROPOSTA
// da rivedere (proposte-self/…), non si auto-inietta nell'app che sta girando.
const SCHEMA_TARGET = {
  type: 'object',
  properties: { target: { type: 'string', enum: ['SELF', 'EXTERNAL', 'PROJECT'] }, nome: { type: 'string' } },
  required: ['target'],
};
const SISTEMA_TARGET = [
  'Classifica l\'obiettivo in UNA categoria e dai un nome breve (slug):',
  '- SELF: un potenziamento del sistema stesso (una proposta di modifica da rivedere).',
  '- EXTERNAL: uno strumento o script di utilità isolato.',
  '- PROJECT: un\'applicazione o sito completo (più file in una cartella).',
  'Rispondi SOLO col JSON { target, nome }.',
].join('\n');

function creaZip(cartella, destZip) {
  return new Promise((resolve, reject) => {
    const dir = path.dirname(cartella); const nome = path.basename(cartella);
    const [cmd, args] = IS_WIN
      ? ['powershell', ['-NoProfile', '-Command', `Compress-Archive -Force -LiteralPath '${cartella}\\*' -DestinationPath '${destZip}'`]]
      : ['sh', ['-c', `cd ${JSON.stringify(dir)} && (zip -r ${JSON.stringify(destZip)} ${JSON.stringify(nome)} || tar -a -cf ${JSON.stringify(destZip)} ${JSON.stringify(nome)})`]];
    const ch = spawn(cmd, args, { windowsHide: true });
    ch.on('close', (code) => (code === 0 ? resolve() : reject(new Error('creazione dello zip non riuscita'))));
    ch.on('error', reject);
  });
}

// UN task della pipeline: istruzione → JSON → scrivi su temporaneo → valida → definitivo, con auto-correzione
// della sintassi (fino a MAX_FALLITI). Non tocca run.stato: torna { ok, file, commit_msg, errore }. Così lo usano
// sia la Pipeline (un task) sia l'Orchestratore (tanti task in fila).
async function eseguiTaskPipeline(run, istruzione, brain) {
  let errorePrecedente = null;
  for (let giro = 0; giro <= MAX_FALLITI && !run.cancelled; giro++) {
    const messaggi = [{ role: 'system', content: SISTEMA_PIPELINE }, { role: 'user', content: istruzione }];
    if (errorePrecedente) messaggi.push({ role: 'user', content: `Il file che hai prodotto ha un ERRORE di sintassi:\n${errorePrecedente}\nCorreggilo e rispondi di nuovo SOLO col JSON (file, azione, codice, marker?, commit_msg).` });
    let out;
    try { out = await chatBrain(brain, messaggi, SCHEMA_PIPELINE, { temperature: 0.1, maxTokens: 4000, timeout: 600_000 }); }
    catch (e) { return { ok: false, errore: `il cervello non ha risposto: ${e.message}` }; }
    if (!out?.file || !out?.codice) return { ok: false, errore: 'il cervello non ha prodotto un JSON valido' };
    let dest;
    try { dest = destinazione(run, out.file); } catch (e) { return { ok: false, errore: e.message }; }
    let composto;
    try { composto = componiContenuto(dest, out.azione || 'scrivi', out.codice, out.marker); }
    catch (e) { return { ok: false, errore: e.message }; }
    // Validazione PRIMA della scrittura definitiva: temporaneo → controllo → solo se buono prende il posto del vero.
    const dir = path.dirname(dest); const ext = path.extname(dest);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.op-tmp-${crypto.randomUUID().slice(0, 6)}${ext}`);
    fs.writeFileSync(tmp, composto.contenuto, 'utf8');
    const v = await validaSintassi(tmp);
    if (v.ok) {
      fs.renameSync(tmp, dest);
      if (composto.nota) nota(run, composto.nota);
      nota(run, `[${out.azione || 'scrivi'}] ${out.file} (${Buffer.byteLength(composto.contenuto)} byte)${v.saltato ? ' · tipo non validato' : ' · sintassi OK'}`);
      return { ok: true, file: out.file, percorso: dest, commit_msg: out.commit_msg || `aggiorna ${out.file}`, validato: !v.saltato };
    }
    try { fs.rmSync(tmp, { force: true }); } catch { /* già via */ }
    errorePrecedente = v.errore;
    run.falliti = giro + 1;
    nota(run, `Sintassi NON valida, correggo da solo (tentativo ${giro + 1}/${MAX_FALLITI}): ${String(v.errore).slice(0, 200)}`);
  }
  return { ok: false, errore: `sintassi non valida dopo ${MAX_FALLITI} tentativi` };
}

async function cicloPipeline(run) {
  const brain = resolveBrain(buildCatalog().all, { heavy: true });
  if (brain.mode === 'rules') { run.stato = 'errore'; run.errore = 'Serve un cervello (LLM) acceso: installane uno dalla pagina Cervello.'; return; }
  fs.mkdirSync(run.radice || RADICE, { recursive: true });
  run.stato = 'in corso';
  const r = await eseguiTaskPipeline(run, run.obiettivo, brain);
  if (run.cancelled) { run.stato = 'fermato'; return; }
  if (!r.ok) { run.stato = 'errore'; run.errore = r.errore; return; }
  run.pipeline = { file: r.file, percorso: r.percorso, commit_msg: r.commit_msg, validato: r.validato };
  run.risultato = `Pronto: ${r.file}${r.validato ? ' (sintassi OK)' : ' (tipo non validato)'}. Messaggio di commit: "${r.commit_msg}". Per mandarlo su GitHub serve la tua conferma.`;
  run.stato = 'pronto';
}

// ---------- Orchestratore: scompone un obiettivo in task atomici e li manda alla pipeline uno alla volta ----------
const SCHEMA_SCOMPOSIZIONE = {
  type: 'object',
  properties: { tasks: { type: 'array', maxItems: 12, items: { type: 'object', properties: { descrizione: { type: 'string' } }, required: ['descrizione'] } } },
  required: ['tasks'],
};
// Semantic Mapper: normalizza i termini generici dell'utente in istruzioni tecniche precise, una per task.
const SISTEMA_SCOMPOSIZIONE = [
  'Scomponi l\'obiettivo dell\'utente in una lista di TASK ATOMICI: ognuno è UNA sola azione tecnica, fattibile in un passo.',
  'NORMALIZZA i termini generici in specifiche tecniche precise: ogni task dice COSA fare, in QUALE file, e COME',
  '(es. "crea la funzione somma(a, b) nel file calcolo.py che ritorna a+b").',
  'Ordina i task così che ognuno si possa fare dopo i precedenti. Pochi task, concreti. Rispondi SOLO col JSON { tasks: [{ descrizione }] }.',
].join('\n');

async function cicloOrchestratore(run) {
  const brain = resolveBrain(buildCatalog().all, { heavy: true });
  if (brain.mode === 'rules') { run.stato = 'errore'; run.errore = 'Serve un cervello (LLM) acceso: installane uno dalla pagina Cervello.'; return; }
  fs.mkdirSync(run.radice || RADICE, { recursive: true });
  run.stato = 'in corso';
  // Target Router: SELF (proposta da rivedere) | EXTERNAL (strumento isolato) | PROJECT (app/sito in una cartella).
  let cls;
  try { cls = await chatBrain(brain, [{ role: 'system', content: SISTEMA_TARGET }, { role: 'user', content: run.obiettivo }], SCHEMA_TARGET, { temperature: 0.1, maxTokens: 300, timeout: 300_000 }); }
  catch { cls = { target: 'PROJECT' }; }
  const nome = slug(cls?.nome || run.obiettivo);
  run.target = ['SELF', 'EXTERNAL', 'PROJECT'].includes(cls?.target) ? cls.target : 'PROJECT';
  run.sotto = { SELF: `proposte-self/${nome}`, EXTERNAL: `tools/${nome}`, PROJECT: `progetti/${nome}` }[run.target];
  nota(run, `Target: ${run.target} → cartella "${run.sotto}"${run.target === 'SELF' ? ' (è una PROPOSTA da rivedere, non tocco il codice vivo di ideax)' : ''}`);
  nota(run, 'Scompongo l\'obiettivo in sotto-task…');
  let piano;
  try { piano = await chatBrain(brain, [{ role: 'system', content: SISTEMA_SCOMPOSIZIONE }, { role: 'user', content: run.obiettivo }], SCHEMA_SCOMPOSIZIONE, { temperature: 0.2, maxTokens: 2000, timeout: 600_000 }); }
  catch (e) { run.stato = 'errore'; run.errore = `scomposizione non riuscita: ${e.message}`; return; }
  const tasks = (piano?.tasks || []).map((t) => String(t?.descrizione || '').trim()).filter(Boolean);
  if (!tasks.length) { run.stato = 'errore'; run.errore = 'non sono riuscito a scomporre l\'obiettivo in task'; return; }
  run.piano = tasks;
  nota(run, `Piano: ${tasks.length} task.`);
  tasks.forEach((t, i) => nota(run, `  ${i + 1}. ${t}`));
  const fatti = [];
  // Dispatcher sequenziale: ogni task si completa (iniezione + validazione) PRIMA del successivo.
  for (let i = 0; i < tasks.length && !run.cancelled; i++) {
    nota(run, `▶ Task ${i + 1}/${tasks.length}: ${tasks[i]}`);
    run.falliti = 0;
    const r = await eseguiTaskPipeline(run, tasks[i], brain);
    if (!r.ok) { run.stato = 'errore'; run.errore = `Task ${i + 1} (${tasks[i].slice(0, 60)}) fallito: ${r.errore}`; if (fatti.length) run.pipeline = { multi: fatti }; return; }
    fatti.push({ file: r.file, commit_msg: r.commit_msg });
  }
  if (run.cancelled) { run.stato = 'fermato'; return; }
  // Anteprima locale solo per i PROJECT nel workspace (serviti da ideax a /progetti/<nome>/).
  const anteprima = (run.target === 'PROJECT' && !run.radiceUtente && run.sotto?.startsWith('progetti/'))
    ? `/${run.sotto.split('/').map(encodeURIComponent).join('/')}/` : null;
  run.pipeline = { multi: fatti, cartella: run.sotto, target: run.target, anteprima, zippabile: true, commit_msg: `orchestratore: ${run.obiettivo.slice(0, 60)}` };
  run.risultato = `Fatti ${fatti.length} task su ${tasks.length} (${run.target}, cartella "${run.sotto}"): ${fatti.map((f) => f.file).join(', ')}.${anteprima ? ` Anteprima: ${anteprima}` : ''} Lo zip e il push su GitHub si fanno a conferma.`;
  run.stato = 'pronto';
}

function vista(run) {
  return {
    id: run.id, obiettivo: run.obiettivo, stato: run.stato, errore: run.errore || null, modalita: run.modalita,
    pipeline: run.pipeline || null, piano: run.piano || null,
    passi: run.passi, log: run.log.slice(-200), risultato: run.risultato || null,
    inAttesa: run.inAttesa ? { categoria: run.inAttesa.categoria, azione: run.inAttesa.azione, dettaglio: run.inAttesa.dettaglio } : null,
  };
}

function nota(run, msg) { run.log.push({ t: Date.now(), msg: String(msg) }); }

// Chiede il sì, oppure procede da solo in modalità semi-autonoma. In semi, partono da sole solo le azioni
// di sandbox e di lettura (AUTO_SEMI), e solo finché non si sono accumulati 3 fallimenti di fila: oltre, si
// torna a chiedere. Clic, compilazioni e tutto ciò che tocca una pagina chiedono SEMPRE. Il pagamento mai.
function chiedi(run, richiesta) {
  if (run.modalita === 'semi' && AUTO_SEMI.has(richiesta.categoria) && run.falliti < MAX_FALLITI) {
    nota(run, `(semi) procedo da solo: ${richiesta.azione}`);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    run.inAttesa = {
      ...richiesta,
      _rispondi: (ok) => { run.inAttesa = null; ok ? resolve() : reject(Object.assign(new Error('rifiutato dall\'utente'), { rifiutato: true })); },
    };
  });
}

// ---------- Il browser (motore "Regista web"/Playwright di ideax) ----------
// L'operatore guida un browser vero via l'engine "webdemo" (vedi worker/engines/webdemo_server.py: rotte /br/*).
// Una sessione per run; se l'engine non è installato, il passo fallisce e l'errore torna al cervello (che riprova
// o si ferma), senza rompere il ciclo.

async function browser(run, rotta, corpo) {
  if (!engines.isInstalled('webdemo')) throw new Error('Il motore browser (Regista web) non è installato: installalo da Modelli → Motori.');
  engines.touch('webdemo'); // non farlo spegnere per inattività tra un passo e l'altro
  return engines.call('webdemo', rotta, { sessione: run.id, ...corpo }, { timeout: 120_000 });
}

async function passoBrowser(run, passo) {
  run.haBrowser = true;
  if (passo.tipo === 'naviga') {
    const r = await browser(run, '/br/vai', { url: passo.url });
    run.ultimaSchermata = r.schermata || null; // il cervello che vede la userà per decidere
    return `Aperta: ${r.url || passo.url}\nTitolo: ${r.titolo || ''}\nCliccabili: ${JSON.stringify((r.cliccabili || []).slice(0, 25))}\nTesto:\n${(r.testo || '').slice(0, 4000)}`;
  }
  if (passo.tipo === 'clicca') {
    const r = await browser(run, '/br/clicca', { selettore: passo.selettore, testo: passo.testo });
    run.ultimaSchermata = r.schermata || null;
    return `Cliccato (${passo.testo || passo.selettore}). Ora: ${r.url || ''}\nTitolo: ${r.titolo || ''}\nCliccabili: ${JSON.stringify((r.cliccabili || []).slice(0, 25))}\nTesto:\n${(r.testo || '').slice(0, 3000)}`;
  }
  if (passo.tipo === 'compila') {
    await browser(run, '/br/compila', { selettore: passo.selettore, testo: passo.testo, valore: passo.valore });
    return `Scritto "${String(passo.valore).slice(0, 80)}" nel campo ${passo.selettore || passo.testo}.`;
  }
  if (passo.tipo === 'estrai') {
    const r = await browser(run, '/br/estrai', { selettore: passo.selettore });
    return `Estratto:\n${(r.dato || '').slice(0, 6000)}`;
  }
  throw new Error(`passo browser sconosciuto: ${passo.tipo}`);
}

// Un clic/compilazione che riguarda il pagamento: l'agente non lo fa. Si riconosce dal testo/selettore.
const PAGAMENTO_RE = /\b(pag[ao]|paga|pay|checkout|conferma (ordine|acquisto|pagamento)|place order|purchase|acquista( ora)?|buy now|carta|card number|cvv|cvc|iban|scadenza|expiry)\b/i;
function toccaPagamento(passo) {
  return PAGAMENTO_RE.test(`${passo.testo || ''} ${passo.selettore || ''} ${passo.valore || ''} ${passo.nota || ''}`);
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

function storiaTesto(run) {
  const righe = [];
  for (const p of run.passi) {
    righe.push(`> ${JSON.stringify({ tipo: p.tipo, nota: p.nota, nome_file: p.nome_file, url: p.url, testo: p.testo, selettore: p.selettore })}`);
    if (p.output != null) righe.push(`Risultato${p.codice_uscita != null ? ` (codice ${p.codice_uscita})` : ''}:\n${p.output}`);
  }
  return righe.join('\n');
}

async function pianifica(run, brain) {
  // Se c'è una schermata fresca della pagina e un cervello che VEDE (es. Qwen3-VL), decide GUARDANDO la pagina —
  // come una persona: vede dove sono i pulsanti e i link. È il modo giusto di cliccare su pagine dinamiche.
  if (run.ultimaSchermata && visionModel()) {
    const domanda = [
      SISTEMA, `Obiettivo: ${run.obiettivo}`, storiaTesto(run),
      'Questa immagine è la pagina aperta ADESSO nel browser. Guardala: dove sono i pulsanti, i campi, i link, i numeri. Decidi il prossimo passo per avvicinarti all\'obiettivo (clicca indicando il TESTO visibile dell\'elemento). Rispondi SOLO col JSON dello schema.',
    ].filter(Boolean).join('\n\n');
    try {
      return await look([`data:image/jpeg;base64,${run.ultimaSchermata}`], domanda, { schema: SCHEMA_PASSO, maxTokens: 1500, temperature: 0.2 });
    } catch (e) {
      nota(run, `(la vista non ha risposto: ${e.message}; continuo col testo)`);
    }
  }
  const messaggi = [{ role: 'system', content: SISTEMA }, { role: 'user', content: `Obiettivo: ${run.obiettivo}` }];
  for (const p of run.passi) {
    messaggi.push({ role: 'assistant', content: JSON.stringify({ tipo: p.tipo, nota: p.nota, nome_file: p.nome_file, url: p.url, testo: p.testo, selettore: p.selettore }) });
    if (p.output != null) messaggi.push({ role: 'user', content: `Risultato del passo${p.codice_uscita != null ? ` (codice ${p.codice_uscita})` : ''}:\n${p.output}` });
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
      const registro = { tipo: passo.tipo, nota: passo.nota || '', nome_file: passo.nome_file || null, url: passo.url || null, testo: passo.testo || null, selettore: passo.selettore || null, output: null, codice_uscita: null };
      try {
        if (passo.tipo === 'fatto') { run.risultato = passo.messaggio || 'Finito.'; run.stato = 'finito'; run.passi.push(registro); return; }
        if (passo.tipo === 'scrivi') {
          await chiedi(run, { categoria: 'scrittura', azione: `scrivere lo script ${passo.nome_file}`, dettaglio: String(passo.codice || '').slice(0, 4000) });
          scriviFile(run, passo);
          run.ultimaSchermata = null;
        } else if (passo.tipo === 'esegui') {
          await chiedi(run, { categoria: 'esecuzione', azione: `eseguire ${passo.nome_file}`, dettaglio: '' });
          run.ultimaSchermata = null;
          const r = await esegui(run, passo);
          registro.output = r.output; registro.codice_uscita = r.codice; run.ultimo = r;
          run.falliti = r.codice === 0 ? 0 : run.falliti + 1; // contatore per la modalità semi
          if (run.falliti === MAX_FALLITI) nota(run, `${MAX_FALLITI} esecuzioni fallite di fila: da ora chiedo conferma prima di continuare.`);
        } else if (passo.tipo === 'naviga' || passo.tipo === 'clicca' || passo.tipo === 'compila' || passo.tipo === 'estrai') {
          if (toccaPagamento(passo)) {
            // Blocco duro: l'operatore non paga e non compila dati di carta, in nessuna modalità.
            nota(run, '💳 Questo passo riguarda il pagamento: non lo eseguo. Tocca a te.');
            registro.output = 'BLOCCATO: riguarda il pagamento. L\'operatore non clicca "Paga/Conferma" e non compila i dati della carta. Fermati e con "fatto" di\' all\'utente che il pagamento lo completa lui a mano.';
          } else {
            const azione = { naviga: `aprire ${passo.url}`, clicca: `cliccare "${passo.testo || passo.selettore}"`, compila: `scrivere in "${passo.selettore || passo.testo}"`, estrai: `estrarre "${passo.selettore || 'la pagina'}"` }[passo.tipo];
            await chiedi(run, { categoria: CATEGORIA[passo.tipo], azione, dettaglio: passo.valore ? `valore: ${String(passo.valore).slice(0, 200)}` : '' });
            // Un passo browser che non riesce NON ferma il lavoro: l'errore torna al cervello, che riprova
            // con un altro elemento o conclude. Dopo MAX_FALLITI di fila, in semi si torna a chiedere conferma.
            try {
              registro.output = await passoBrowser(run, passo);
              run.falliti = 0;
            } catch (e) {
              nota(run, `  non riuscito: ${e.message}`);
              registro.output = `Il passo "${passo.tipo}" non è riuscito: ${e.message}. Quell'elemento non c'è o non è cliccabile: guarda l'elenco "Cliccabili" dell'ultima pagina e prova un testo/selettore diverso, oppure concludi con "fatto" spiegando all'utente cosa hai trovato.`;
              run.falliti += 1;
              if (run.falliti === MAX_FALLITI) nota(run, `${MAX_FALLITI} passi falliti di fila: torno a chiedere conferma.`);
            }
          }
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
    if (run.haBrowser) browser(run, '/br/chiudi', {}).catch(() => {}); // chiudi la pagina del browser di questo run
  }
}

// ---------- API usata dal server ----------

export function avvia(obiettivo, modalita, cartella) {
  const testo = String(obiettivo || '').trim();
  if (!testo) throw new Error('Scrivi cosa deve fare l\'operatore');
  const id = crypto.randomUUID().slice(0, 8);
  const mod = ['semi', 'pipeline', 'orchestratore'].includes(modalita) ? modalita : 'strict';
  // Percorso dinamico: la base la sceglie l'utente (una cartella), non il modello. Default = workspace.
  let radice;
  try { radice = baseSicura(cartella); } catch (e) { throw new Error(e.message); }
  const run = {
    id, obiettivo: testo, stato: 'in corso', passi: [], log: [], inAttesa: null, cancelled: false,
    risultato: null, errore: null, modalita: mod, falliti: 0, haBrowser: false, pipeline: null, piano: null,
    radice, radiceUtente: !!cartella, sotto: null, target: null,
  };
  runs.set(id, run);
  // vecchi run: teniamo gli ultimi 20
  for (const k of [...runs.keys()].slice(0, -20)) runs.delete(k);
  const motore = mod === 'orchestratore' ? cicloOrchestratore : mod === 'pipeline' ? cicloPipeline : ciclo;
  motore(run); // gira in sottofondo; la UI segue con /stato
  return vista(run);
}

export function stato(id) {
  const run = runs.get(id);
  if (!run) throw new Error('operatore non trovato');
  return vista(run);
}

// Packaging: zippa la cartella del progetto di questo run e torna l'indirizzo per scaricarlo.
export async function zip(id) {
  const run = runs.get(id);
  if (!run) throw new Error('operatore non trovato');
  if (!run.sotto) throw new Error('questo lavoro non ha una cartella di progetto da zippare');
  const cartella = path.resolve(run.radice || RADICE, run.sotto);
  if (!fs.existsSync(cartella)) throw new Error('la cartella del progetto non esiste');
  const nome = `${slug(run.sotto.split('/').pop())}-${id}.zip`;
  const destZip = path.join(OUTPUT_DIR, nome);
  try { fs.rmSync(destZip, { force: true }); } catch { /* non c'era */ }
  await creaZip(cartella, destZip);
  if (!fs.existsSync(destZip)) throw new Error('lo zip non è stato creato');
  return { url: `/outputs/${nome}`, nome };
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
