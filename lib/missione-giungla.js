import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { eseguiFunzione } from './collaudo.js';
import { APP_ROOT } from './store.js';

export const TITOLO_GIUNGLA = 'Ritorno dalla Giungla';
export const REGOLA_PRECEDENTE = `function regola(passati, inBase, evento) {
  if (evento === 'riavvio') return {passati:0, vittoria:false};
  if (evento === 'azione') return {passati:Math.min(100,passati+1), vittoria:false};
  return {passati, vittoria:evento === 'soccorso'};
}`;

export function richiestaMissione(testo) {
  return /ritorno dalla giungla/i.test(testo) ||
    (/\b(?:giungla|vietnam)\b/i.test(testo) && /\b(?:commiliton\w*|soccorso|compagno)\b/i.test(testo));
}

export function verificaRegola(codice) {
  return eseguiFunzione(codice, 'regola', (invoca) => {
    const tabella = [];
    for (let n = 0; n <= 100; n++) {
      const stati = [];
      for (const base of [false, true]) {
        const azioni = {};
        for (const evento of ['riavvio', 'azione', 'soccorso']) {
          const atteso = {
            passati: evento === 'riavvio' ? 0 : evento === 'azione' ? Math.min(100, n + 1) : n,
            vittoria: evento === 'soccorso' && base && n === 100,
          };
          const ottenuto = invoca([n, base, evento]);
          if (!isDeepStrictEqual(ottenuto, atteso)) {
            return { ok: false, errore: `regola(${n}, ${base}, "${evento}"): atteso ${JSON.stringify(atteso)}, ottenuto ${JSON.stringify(ottenuto)}` };
          }
          azioni[evento] = atteso;
        }
        stati.push(azioni);
      }
      tabella.push(stati);
    }
    return { ok: true, tabella };
  });
}

export function preparaMissione(tabella) {
  const base = fs.readFileSync(path.join(APP_ROOT, 'public', 'missione-giungla.html'), 'utf8');
  return base.replace('__MISSIONE_TABELLA__', () => JSON.stringify(tabella));
}
