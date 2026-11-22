import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { elencaAnteprime } from './anteprima-web.js';
import { elencaGiochi } from './progetti-guida.js';

export function progettiCode() {
  let locali = [];
  try {
    const file = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'code-progetti-locali.json'), 'utf8'));
    if (Array.isArray(file)) locali = file.filter((p) =>
      p && typeof p.titolo === 'string' && /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/[^\s]*$/.test(p.url))
      .map(({ titolo, url, sorgenti }) => ({
        titolo, url, tipo: 'locale',
        ...(typeof sorgenti === 'string' && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/releases\/download\/[\w./-]+$/.test(sorgenti) ? { sorgenti } : {}),
      }));
  } catch (err) { if (err.code !== 'ENOENT') throw err; }
  return [
    ...elencaAnteprime().map(p => ({ ...p, tipo: 'anteprima' })),
    ...elencaGiochi().map(p => ({ ...p, tipo: 'gioco' })),
    ...locali,
  ];
}
