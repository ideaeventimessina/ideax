// Libreria voci: personaggi uomo/donna pronti da usare nei video, nei reel e nelle letture.
// Sono voci SINTETICHE di Kokoro-82M (Apache-2.0, nessuna persona reale): ideax scarica il modello una volta,
// fa leggere a ogni voce un testo di prova di circa 20 secondi e lo usa come campione per Chatterbox,
// che poi la fa parlare in italiano (o in una delle sue 23 lingue) con tutta la sua espressività.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import * as engines from './engines.js';
import * as voices from './voices.js';
import { APP_ROOT } from './store.js';

const DIR = path.join(engines.enginesDir, 'voice-library');
const RELEASE = process.env.IDEAX_KOKORO_BASE || 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0';
const FILES = [
  { name: 'kokoro-v1.0.onnx', label: 'modello Kokoro (circa 310 MB)' },
  { name: 'voices-v1.0.bin', label: 'voci (circa 27 MB)' },
];
const PACKAGES = ['kokoro-onnx==0.4.9', 'soundfile'];

// Lingua del campione → codice di Kokoro (espeak) e lingua di Chatterbox
const LANG = {
  it: { kokoro: 'it', label: 'italiano' },
  'en-us': { kokoro: 'en-us', label: 'inglese americano' },
  'en-gb': { kokoro: 'en-gb', label: 'inglese britannico' },
  es: { kokoro: 'es', label: 'spagnolo' },
  fr: { kokoro: 'fr-fr', label: 'francese' },
  pt: { kokoro: 'pt-br', label: 'portoghese brasiliano' },
};

const TEXT = {
  it: 'Ciao, piacere di conoscerti. Oggi ti racconto una storia che mi sta molto a cuore. Tutto è iniziato in una mattina di primavera, quando ho deciso di cambiare strada e di inseguire un sogno. Non è stato facile, ci sono stati momenti difficili, ma ogni passo mi ha insegnato qualcosa. E adesso, guardandomi indietro, posso dire che ne è valsa davvero la pena. Grazie per essere qui con me.',
  en: 'Hi, it is great to meet you. Today I want to tell you a story that means a lot to me. It all started on a spring morning, when I decided to change direction and chase a dream. It was not easy, and there were hard moments, but every step taught me something. Now, looking back, I can honestly say it was worth it. Thank you for being here with me.',
  es: 'Hola, encantado de conocerte. Hoy quiero contarte una historia muy especial para mí. Todo empezó una mañana de primavera, cuando decidí cambiar de camino y perseguir un sueño. No fue fácil, hubo momentos difíciles, pero cada paso me enseñó algo. Y ahora, mirando atrás, puedo decir que valió la pena. Gracias por estar aquí conmigo.',
  fr: "Bonjour, ravi de te rencontrer. Aujourd'hui je veux te raconter une histoire qui me tient à cœur. Tout a commencé un matin de printemps, quand j'ai décidé de changer de route et de poursuivre un rêve. Ce n'était pas facile, il y a eu des moments difficiles, mais chaque pas m'a appris quelque chose. Et maintenant, je peux dire que cela en valait la peine. Merci d'être là avec moi.",
  pt: 'Olá, prazer em te conhecer. Hoje eu quero te contar uma história muito especial para mim. Tudo começou numa manhã de primavera, quando decidi mudar de caminho e seguir um sonho. Não foi fácil, houve momentos difíceis, mas cada passo me ensinou alguma coisa. E agora, olhando para trás, posso dizer que valeu a pena. Obrigado por estar aqui comigo.',
};

// I personaggi: nome proposto, genere, lingua del campione e carattere della voce
export const CATALOG = [
  { key: 'if_sara', name: 'Sara', gender: 'donna', lang: 'it', desc: 'italiana, calda e chiara' },
  { key: 'im_nicola', name: 'Nicola', gender: 'uomo', lang: 'it', desc: 'italiano, pacato e rassicurante' },
  { key: 'af_heart', name: 'Heart', gender: 'donna', lang: 'en-us', desc: 'giovane, luminosa ed espressiva' },
  { key: 'af_bella', name: 'Bella', gender: 'donna', lang: 'en-us', desc: 'vivace, da pubblicità' },
  { key: 'af_nicole', name: 'Nicole', gender: 'donna', lang: 'en-us', desc: 'morbida, quasi sussurrata' },
  { key: 'af_sarah', name: 'Sarah', gender: 'donna', lang: 'en-us', desc: 'adulta, professionale' },
  { key: 'af_sky', name: 'Sky', gender: 'donna', lang: 'en-us', desc: 'leggera e giovanile' },
  { key: 'af_nova', name: 'Nova', gender: 'donna', lang: 'en-us', desc: 'moderna, da narratrice' },
  { key: 'bf_emma', name: 'Emma', gender: 'donna', lang: 'en-gb', desc: 'britannica, elegante' },
  { key: 'bf_isabella', name: 'Isabella', gender: 'donna', lang: 'en-gb', desc: 'britannica, matura' },
  { key: 'ef_dora', name: 'Dora', gender: 'donna', lang: 'es', desc: 'spagnola, solare' },
  { key: 'ff_siwis', name: 'Siwis', gender: 'donna', lang: 'fr', desc: 'francese, raffinata' },
  { key: 'pf_dora', name: 'Dora BR', gender: 'donna', lang: 'pt', desc: 'brasiliana, allegra' },
  { key: 'am_adam', name: 'Adam', gender: 'uomo', lang: 'en-us', desc: 'profondo, da trailer' },
  { key: 'am_michael', name: 'Michael', gender: 'uomo', lang: 'en-us', desc: 'adulto, caldo e sicuro' },
  { key: 'am_fenrir', name: 'Fenrir', gender: 'uomo', lang: 'en-us', desc: 'grave e potente' },
  { key: 'am_puck', name: 'Puck', gender: 'uomo', lang: 'en-us', desc: 'giovane e scherzoso' },
  { key: 'am_eric', name: 'Eric', gender: 'uomo', lang: 'en-us', desc: 'deciso, da presentatore' },
  { key: 'am_liam', name: 'Liam', gender: 'uomo', lang: 'en-us', desc: 'giovane adulto, amichevole' },
  { key: 'am_onyx', name: 'Onyx', gender: 'uomo', lang: 'en-us', desc: 'scuro e misterioso' },
  { key: 'bm_george', name: 'George', gender: 'uomo', lang: 'en-gb', desc: 'britannico, maturo e autorevole' },
  { key: 'bm_lewis', name: 'Lewis', gender: 'uomo', lang: 'en-gb', desc: 'britannico, profondo' },
  { key: 'bm_fable', name: 'Fable', gender: 'uomo', lang: 'en-gb', desc: 'britannico, da cantastorie' },
  { key: 'em_alex', name: 'Alex', gender: 'uomo', lang: 'es', desc: 'spagnolo, energico' },
  { key: 'pm_alex', name: 'Alex BR', gender: 'uomo', lang: 'pt', desc: 'brasiliano, cordiale' },
];

export const job = { status: 'idle', phase: null, key: null, done: 0, total: 0, error: null };

function added() {
  const map = {};
  for (const v of voices.listVoices()) if (v.origin?.kokoro) map[v.origin.kokoro] = v.name;
  return map;
}

export function list() {
  const have = added();
  return {
    ready: FILES.every((f) => fs.existsSync(path.join(DIR, f.name))),
    job,
    voices: CATALOG.map((c) => ({ ...c, language: LANG[c.lang].label, added: have[c.key] || null })),
  };
}

async function download(f) {
  const out = path.join(DIR, f.name);
  if (fs.existsSync(out)) return;
  const part = `${out}.part`;
  const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
  job.phase = `Scarico ${f.label}`;
  const res = await fetch(`${RELEASE}/${f.name}`, { headers: have ? { Range: `bytes=${have}-` } : {} });
  if (!res.ok) throw new Error(`Download di ${f.name} non riuscito (HTTP ${res.status})`);
  const append = have && res.status === 206;
  job.total = Number(res.headers.get('content-length') || 0) + (append ? have : 0);
  job.done = append ? have : 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { job.done += c.length; });
  await pipeline(body, fs.createWriteStream(part, { flags: append ? 'a' : 'w' }));
  fs.renameSync(part, out);
}

function runPy(py, args) {
  return new Promise((resolve, reject) => {
    import('node:child_process').then(({ execFile }) => {
      execFile(py, args, { windowsHide: true, timeout: 10 * 60_000, env: { ...process.env, PYTHONUTF8: '1' } }, (err, stdout, stderr) => {
        if (err) reject(new Error(String(stderr || err.message).trim().split('\n').slice(-3).join(' ').slice(0, 400)));
        else resolve(String(stdout));
      });
    });
  });
}

// PARLATO VELOCE per la Regia: legge un testo DIRETTAMENTE con Kokoro (CPU, ~310 MB, non tocca la scheda video).
// È l'opposto di runSpeech/Chatterbox, che per parlare scarica i 12 GB del worker immagini e ci mette 10 secondi: qui
// niente GPU, niente sfratto del modello immagini, risposta in un paio di secondi. Torna i byte di un WAV, o null.
let sessione;
let sessioneInAvvio;
let processoKokoro;
let prossimoId = 0;

async function avviaKokoro() {
  fs.mkdirSync(DIR, { recursive: true });
  for (const f of FILES) await download(f);
  const py = await engines.sideEnv('voicelib', path.join(DIR, 'env'), '3.11', PACKAGES);
  const child = spawn(py, [path.join(APP_ROOT, 'worker', 'engines', 'kokoro_session.py'), ...FILES.map((f) => path.join(DIR, f.name))], {
    windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', ONNX_PROVIDER: 'CPUExecutionProvider' },
  });
  processoKokoro = child;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-500); });
  const corrente = { child, pending };
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 45000);
    const termina = (error) => {
      clearTimeout(timer);
      lines.close();
      if (sessione === corrente) sessione = null;
      if (processoKokoro === child) processoKokoro = null;
      const err = error instanceof Error ? error : new Error(stderr.trim() || 'Motore Kokoro fermato.');
      reject(err);
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err); }
      pending.clear();
    };
    child.once('error', termina);
    child.once('close', termina);
    child.stdin.on('error', termina);
    lines.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { clearTimeout(timer); sessione = corrente; resolve(); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(Buffer.from(msg.audio, 'base64'));
    });
  });
  return corrente;
}

export function preparaKokoro() {
  if (sessione) return Promise.resolve(sessione);
  sessioneInAvvio ??= avviaKokoro().finally(() => { sessioneInAvvio = null; });
  return sessioneInAvvio;
}

export function fermaKokoro() {
  processoKokoro?.kill();
}

export function voceNativa(voice, lingua) {
  const voce = voice?.origin?.kokoro;
  const locale = lingua === 'en' ? 'en-us' : lingua;
  if (!voce || Object.keys(voice.defaults || {}).length || !Object.hasOwn(LANG, locale)) return null;
  return CATALOG.some((v) => v.key === voce) ? { voce, lingua: locale } : null;
}

export function durataWav(buf) {
  const byteRate = buf.readUInt32LE(28);
  for (let off = 12; off + 8 <= buf.length;) {
    const size = buf.readUInt32LE(off + 4);
    if (buf.toString('ascii', off, off + 4) === 'data') return byteRate ? size / byteRate : 0;
    off += 8 + size + (size % 2);
  }
  return 0;
}

export async function parla(testo, { voce = 'if_sara', lingua = 'it', velocita = 1, pausa = 0 } = {}) {
  const t = String(testo || '').trim();
  if (!t) return null;
  if (!/^[a-z]{2}_[a-z]+$/.test(String(voce))) voce = 'if_sara';   // solo un nome di voce Kokoro valido
  const language = Object.hasOwn(LANG, lingua) ? LANG[lingua].kokoro : 'it';
  const speed = Math.max(0.75, Math.min(1.25, Number(velocita) || 1));
  const pause = Math.max(0, Math.min(1200, Number(pausa) || 0));
  const { child, pending } = await preparaKokoro();
  const id = ++prossimoId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 45000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, text: t.slice(0, 1200), voice: voce, language, speed, pause }) + '\n');
  });
}

// Le voci femminili della libreria Kokoro, per il menu della Regia (l'italiana Sara come predefinita).
export const VOCI_REGIA = CATALOG.filter((c) => c.gender === 'donna').map((c) => ({ key: c.key, name: c.name, lang: c.lang, desc: c.desc }));

// Aggiunge un personaggio alle voci di ideax. mix: "af_bella:0.6,af_sarah:0.4" per una voce nuova a metà tra due
export async function add({ key, name, mix, gender, lang } = {}) {
  if (job.status === 'running') throw new Error('Sto già preparando una voce: aspetta che finisca');
  const preset = CATALOG.find((c) => c.key === key);
  if (!preset && !mix) throw new Error('Voce non trovata nella libreria');
  const voiceName = String(name || preset?.name || '').trim().slice(0, 60);
  if (!voiceName) throw new Error('Dai un nome al personaggio');
  if (voices.listVoices().some((v) => v.name.toLowerCase() === voiceName.toLowerCase())) throw new Error(`Esiste già una voce chiamata "${voiceName}": scegli un altro nome`);
  if (!engines.isInstalled('voice')) throw new Error('Prima installa il motore voce (qui sopra nella pagina Voce)');
  if (mix && !/^([a-z]{2}_[a-z]+:\d*\.?\d+,?)+$/.test(String(mix))) throw new Error('Miscela non valida');
  const l = preset?.lang || (LANG[lang] ? lang : 'it');
  Object.assign(job, { status: 'running', key: key || mix, phase: 'Preparo', done: 0, total: 0, error: null });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ideax-kokoro-'));
  try {
    fs.mkdirSync(DIR, { recursive: true });
    for (const f of FILES) await download(f);
    job.phase = 'Preparo l\'ambiente della libreria voci (solo la prima volta)';
    const py = await engines.sideEnv('voicelib', path.join(DIR, 'env'), '3.11', PACKAGES);
    job.phase = `Faccio parlare ${voiceName}`;
    const textFile = path.join(tmp, 'testo.txt');
    fs.writeFileSync(textFile, TEXT[l.split('-')[0]] || TEXT.it);
    const wav = path.join(tmp, 'campione.wav');
    await runPy(py, [path.join(APP_ROOT, 'worker', 'engines', 'kokoro_once.py'), path.join(DIR, FILES[0].name), path.join(DIR, FILES[1].name), mix || key, LANG[l].kokoro, textFile, wav]);
    job.phase = 'La aggiungo alle tue voci';
    const v = await voices.createVoice({
      name: voiceName,
      language: 'it',
      file: { name: 'campione.wav', buffer: fs.readFileSync(wav) },
      synthetic: { source: 'Kokoro-82M (Apache-2.0)', kokoro: mix ? null : key, mix: mix || null },
      gender: preset?.gender || gender || null,
      description: preset
        ? `${preset.desc}${l === 'it' ? '' : ` (accento ${LANG[l].label})`}`
        : `personaggio nato da ${String(mix).split(',').map((p) => { const [k, w] = p.split(':'); return `${CATALOG.find((c) => c.key === k)?.name || k} ${Math.round(Number(w) * 100)}%`; }).join(' + ')}`,
    });
    Object.assign(job, { status: 'done', phase: null });
    return v;
  } catch (err) {
    Object.assign(job, { status: 'error', phase: null, error: err.message });
    throw err;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
