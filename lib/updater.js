// Aggiornamenti automatici da GitHub Releases.
// Quando esce una versione nuova, ideax scarica ideax-setup.exe, lo avvia in modalità silenziosa e si chiude:
// l'installatore sostituisce il programma (i tuoi dati restano dove sono) e riapre ideax.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { VERSION, INSTALLED, IS_SEA, APP_ROOT, HOME_POINTER, getSettings } from './store.js';
import { stopWorker } from './runtime.js';
import { stopAll as stopEngines } from './engines.js';

export const update = {
  current: VERSION,
  status: 'idle', // idle | checking | none | available | downloading | installing | error
  latest: null,
  notes: '',
  pageUrl: null,
  assetUrl: null,
  checkedAt: null,
  error: null,
  download: null,
  canInstall: IS_SEA && process.platform === 'win32',
  installed: INSTALLED,
};

// Confronto tra versioni "1.2.10" e "1.10.0"
export function newer(a, b) {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

export async function checkForUpdate() {
  const repo = getSettings().update.repo;
  if (!repo || update.status === 'downloading' || update.status === 'installing') return update;
  update.status = 'checking';
  update.error = null;
  try {
    const res = await fetch(`${process.env.IDEAX_UPDATE_API || 'https://api.github.com'}/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ideax/${VERSION}` },
      signal: AbortSignal.timeout(15000),
    });
    update.checkedAt = Date.now();
    if (res.status === 404) {
      Object.assign(update, { status: 'none', latest: null, error: 'Nessuna versione pubblicata (o repository privato).' });
      return update;
    }
    if (!res.ok) throw new Error(`GitHub ha risposto ${res.status}`);
    const rel = await res.json();
    const asset = (rel.assets || []).find((a) => /setup.*\.exe$/i.test(a.name));
    Object.assign(update, {
      latest: String(rel.tag_name || '').replace(/^v/, ''),
      notes: String(rel.body || '').slice(0, 4000),
      pageUrl: rel.html_url,
      assetUrl: asset?.browser_download_url || null,
    });
    update.status = newer(update.latest, VERSION) ? 'available' : 'none';
  } catch (err) {
    Object.assign(update, { status: 'error', error: err.message, checkedAt: Date.now() });
  }
  return update;
}

// Motivo per cui l'aggiornamento non può partire, oppure null
export function installBlocker() {
  if (update.status !== 'available' || !update.assetUrl) return 'Nessun aggiornamento da installare.';
  if (!update.canInstall) return 'L\'aggiornamento automatico funziona con ideax.exe su Windows. Scarica la nuova versione dalla pagina del rilascio.';
  return null;
}

// Non lancia mai eccezioni: gli errori finiscono in update.error e si vedono nell'interfaccia
export async function installUpdate() {
  if (installBlocker()) return update;
  update.status = 'downloading';
  try {
    const file = path.join(os.tmpdir(), `ideax-setup-${update.latest}.exe`);
    const res = await fetch(update.assetUrl, { headers: { 'User-Agent': `ideax/${VERSION}` } });
    if (!res.ok) throw new Error(`Download non riuscito (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    update.download = { done: 0, total };
    const counter = new TransformStream({ transform(chunk, ctrl) { update.download.done += chunk.length; ctrl.enqueue(chunk); } });
    await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(file));

    // Dalla versione portatile: l'installazione userà come cartella dati quella attuale, senza spostare nulla
    if (!INSTALLED) {
      fs.mkdirSync(path.dirname(HOME_POINTER), { recursive: true });
      fs.writeFileSync(HOME_POINTER, APP_ROOT);
    }
    update.status = 'installing';
    update.download = null;
    // Prima spegniamo i motori Python, così nessun file resta in uso…
    stopWorker();
    stopEngines();
    // …poi avviamo l'installatore: /S = silenzioso, /UPDATE = riapri ideax alla fine.
    // L'installatore aspetta che ideax si chiuda; ideax si chiude tra un attimo, dopo aver risposto alla pagina.
    setTimeout(() => {
      spawn(file, ['/S', '/UPDATE'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      setTimeout(() => process.exit(0), 1500);
    }, 1500);
  } catch (err) {
    Object.assign(update, { status: 'error', error: err.message });
  }
  return update;
}

// Controllo all'avvio e poi ogni 6 ore
export function scheduleChecks() {
  const run = () => { if (getSettings().update.auto) checkForUpdate(); };
  setTimeout(run, 5000);
  setInterval(run, 6 * 60 * 60 * 1000).unref();
}
