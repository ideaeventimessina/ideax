import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './store.js';

const dir = path.join(DATA_DIR, 'anteprime-web');

export function richiestaInterattiva(testo) {
  return /\b(?:videogioc(?:o|hi)|gioco|giochi|minigame|web app|app interattiva|simulatore)\b/i.test(testo)
    && (/\b(?:crea\w*|fai|fammi|genera\w*|svilupp\w*|costrui\w*|realizz\w*|voglio|vorrei)\b/i.test(testo) ||
        /^\s*(?:ok[, ]+)?[eè]\s+un\s+gioco\b/i.test(testo))
    && !/^\s*(?:spiega|come|perch[eé]|scrivi (?:solo )?il codice)/i.test(testo);
}

export function documentoIsolato(html) {
  // La politica precede qualunque markup generato. Il frame ha anche origine opaca.
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'">${html}`;
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
      if (/^ritorno dalla giungla$/i.test(dato.titolo) && dato.collaudo !== 'missione') return [];
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
