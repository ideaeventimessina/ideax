import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as pausa } from 'node:timers/promises';
import { DATA_DIR } from './store.js';
import { elencaAnteprime } from './anteprima-web.js';
import { elencaGiochi } from './progetti-guida.js';

function progettiLocali() {
  try {
    const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code-progetti-locali.json'), 'utf8'));
    return Array.isArray(file) ? file.filter((p) =>
      p && typeof p.titolo === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[^\s]*$/.test(p.url)) : [];
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const idValido = (id) => typeof id === 'string' && /^[a-z0-9-]{1,48}$/.test(id);

export function progettiCode() {
  const locali = progettiLocali().map(({ id, titolo, url, sorgenti, avvio }) => ({
    titolo, url, tipo: 'locale',
    ...(idValido(id) && avvio ? { avvia: id } : {}),
    ...(typeof sorgenti === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w./-]+$/.test(sorgenti) ? { sorgenti } : {}),
  }));
  return [
    ...elencaAnteprime().map(p => ({ ...p, tipo: 'anteprima' })),
    ...elencaGiochi().map(p => ({ ...p, tipo: 'gioco' })),
    ...locali,
  ];
}

const avvii = new Map();
const processi = new Set();
process.on('exit', () => { for (const child of processi) child.kill(); });

async function risponde(url) {
  try {
    const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(600) });
    await r.body?.cancel();
    return r.ok;
  } catch { return false; }
}

async function avviaProgetto({ titolo, url, avvio }) {
  const { node, cartella } = avvio;
  if (typeof node !== 'string' || !path.isAbsolute(node) || !/^node(?:\.exe)?$/i.test(path.basename(node)) ||
      typeof cartella !== 'string' || !path.isAbsolute(cartella)) throw new Error('Configurazione di avvio del progetto non valida.');
  const entry = path.join(cartella, 'server.mjs');
  if (!fs.existsSync(node) || !fs.existsSync(entry)) throw new Error('Manca Node.js o il progetto locale. Apri i sorgenti per ripristinarlo.');
  if (await risponde(url)) return { url };

  // L'eseguibile e la cartella provengono esclusivamente dal registro locale, mai dalla richiesta HTTP.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(SystemRoot|windir|TEMP|TMP|HOME|USERPROFILE|PATH)$/i.test(k)));
  const child = spawn(node, [entry], { cwd: cartella, env, windowsHide: true, stdio: 'ignore' });
  processi.add(child);
  child.unref();
  let problema;
  child.once('error', () => { problema = 'Node.js non si avvia.'; processi.delete(child); });
  child.once('exit', () => { problema ||= 'Il server si è chiuso prima di rispondere.'; processi.delete(child); });
  for (let i = 0; i < 30 && !problema; i++) {
    if (await risponde(url)) return { url };
    await pausa(200);
  }
  if (processi.has(child)) child.kill();
  throw new Error(titolo + ': ' + (problema || 'il server locale non risponde.'));
}

export async function apriProgettoLocale(id) {
  if (!idValido(id)) throw new Error('Progetto non trovato.');
  if (avvii.has(id)) return avvii.get(id);
  const progetto = progettiLocali().find((p) => p.id === id && p.avvio);
  if (!progetto) throw new Error('Progetto locale non registrato.');
  const avvio = avviaProgetto(progetto).finally(() => avvii.delete(id));
  avvii.set(id, avvio);
  return avvio;
}
