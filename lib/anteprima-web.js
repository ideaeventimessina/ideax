import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './store.js';

const dir = path.join(DATA_DIR, 'anteprime-web');

export function richiestaInterattiva(testo) {
  return /\b(?:videogioc(?:o|hi)|gioco|giochi|minigame|snake|web app|app interattiva|simulatore)\b/i.test(testo)
    && (/\b(?:crea\w*|fai|fammi|genera\w*|svilupp\w*|costrui\w*|realizz\w*|voglio|vorrei)\b/i.test(testo) ||
        /^\s*(?:ok[, ]+)?[eè]\s+un\s+gioco\b/i.test(testo))
    && !/^\s*(?:spiega|come|perch[eé]|scrivi (?:solo )?il codice)/i.test(testo);
}

export function richiestaTrisCpu(testo) {
  return /\b(?:tris|tic[- ]tac[- ]toe)\b/i.test(testo) &&
    /\b(?:cpu|computer|bot|intelligenza artificiale|un giocatore|1 giocatore)\b/i.test(testo);
}

export function richiestaSnake(testo) {
  return /\bsnake\b/i.test(testo);
}

export function domandaStatoProgetto(testo) {
  const t = testo.trim();
  return /^a che punto (?:sei|è|siamo)(?:[\s?.!]|$)/i.test(t) ||
    (/^(?:qual\s*[èe]|vedi|dimmi|controlla|verifica|mostrami|come va|stato)(?:[\s?.!]|$)/i.test(t) &&
      /\b(?:stato|progresso)\b/i.test(t) &&
      (/\b(?:progetto|gioco|anteprima|lavoro)\b/i.test(t) || /\bstato[?.!]*$/i.test(t)));
}

export function seguitoAnteprima(testo) {
  if (/\b(?:non (?:mi )?funzion\w*|si blocca|non si avvia|corregg\w*|sistem\w*|ripar\w*|rifa[il]\w*)\b/i.test(testo)) return 'ripara';
  if (/\b(?:apri\w*|riapr\w*|mostr\w*)\b/i.test(testo) &&
      /\b(?:finestra|anteprima|giocare|gioco)\b/i.test(testo)) return 'apri';
  return null;
}

export function documentoIsolato(html) {
  // La politica precede qualunque markup generato. Il frame ha anche origine opaca.
  const navigazione = `<script>
    document.addEventListener('click', (event) => {
      if (event.defaultPrevented) return;
      const link = event.target.closest?.('a[href^="#"]');
      if (!link) return;
      event.preventDefault();
      let id = link.getAttribute('href').slice(1);
      try { id = decodeURIComponent(id); } catch {}
      if (!id) window.scrollTo(0, 0);
      else document.getElementById(id)?.scrollIntoView();
    });
  </script>`;
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">${navigazione}${html}`;
}

export function salvaAnteprima(titolo, html, { collaudo = 'interazione' } = {}) {
  const id = randomUUID().slice(0, 8);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({ titolo, html, collaudo }), { flag: 'wx' });
  return { id, titolo, collaudo };
}

export function leggiAnteprima(id) {
  if (!/^[a-f0-9]{8}$/.test(id)) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, id + '.json'), 'utf8')); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

export function elencaAnteprime() {
  if (!fs.existsSync(dir)) return [];
  const lista = fs.readdirSync(dir).filter((nome) => /^[a-f0-9]{8}\.json$/.test(nome)).flatMap(nome => {
    const id = nome.slice(0, 8);
    try {
      const dato = leggiAnteprima(id);
      if (!dato || typeof dato.titolo !== 'string') return [];
      if (/^ritorno dalla giungla$/i.test(dato.titolo) && dato.collaudo !== 'missione-3d') return [];
      return [{ id, titolo: dato.titolo, collaudo: dato.collaudo || 'interazione', data: fs.statSync(path.join(dir, nome)).mtimeMs }];
    } catch { return []; }
  }).sort((a, b) => b.data - a.data);
  const visti = new Set();
  return lista.filter(({ titolo }) => {
    const nome = titolo.toLowerCase();
    if (visti.has(nome)) return false;
    visti.add(nome);
    return true;
  });
}

export function cercaAnteprima(titolo) {
  return elencaAnteprime().find((dato) => dato.titolo.toLowerCase() === titolo.toLowerCase()) || null;
}
