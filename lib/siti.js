// La pagina "Code" dello Studio: descrivi una pagina o una web app, il cervello locale la genera
// come UN file HTML autosufficiente (HTML+CSS+JS insieme), la vedi in anteprima, la ritocchi e la
// PUBBLICHI — ideax la serve subito a /siti/<nome>/ (sul PC, e sulla rete locale se l'hai accesa in
// Impostazioni → Rete). Per un indirizzo pubblico su internet serve un passo di deploy a parte.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import { resolveBrain, textBrain } from './brain.js';
import { buildCatalog } from './router.js';

export const SITI_DIR = path.join(DATA_DIR, 'siti');

const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'pagina';

const SISTEMA = [
  'Sei un generatore di pagine web. Produci UNA sola pagina HTML completa e autosufficiente:',
  'tutto in un file — HTML, CSS e JavaScript INLINE (niente file esterni, niente CDN a meno che l\'utente',
  'lo chieda). Deve funzionare aperta da sola in un browser. Responsive, pulita, accessibile.',
  'Rispondi SOLO con il codice della pagina, da <!doctype html> a </html>. Nessuna spiegazione, nessun testo fuori dal codice.',
].join('\n');

// Dal testo del cervello tira fuori la pagina: toglie i recinti markdown, parte da <!doctype/<html.
function estraiHtml(testo) {
  let t = String(testo || '').trim();
  const recinto = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (recinto) t = recinto[1].trim();
  const i = t.search(/<!doctype html|<html[\s>]/i);
  if (i > 0) t = t.slice(i);
  return t.trim();
}

// Genera o modifica. `html` presente = "ecco la pagina attuale, cambiala così": modifica iterativa.
export async function genera({ descrizione, html }) {
  const testo = String(descrizione || '').trim();
  if (!testo) throw new Error('Scrivi cosa deve fare la pagina');
  const brain = resolveBrain(buildCatalog().all, { heavy: true });
  if (brain.mode === 'rules') throw new Error('Serve un cervello (LLM) acceso: installane uno dalla pagina Cervello.');
  const messaggi = [{ role: 'system', content: SISTEMA }];
  if (html && html.trim()) {
    messaggi.push({ role: 'user', content: `Questa è la pagina attuale:\n\n${html}` });
    messaggi.push({ role: 'user', content: `Modificala così (restituisci la pagina intera aggiornata): ${testo}` });
  } else {
    messaggi.push({ role: 'user', content: `Crea questa pagina: ${testo}` });
  }
  const out = await textBrain(brain, messaggi, { temperature: 0.4, maxTokens: 8000, timeout: 600_000 });
  const pagina = estraiHtml(out);
  if (!/<html[\s>]/i.test(pagina)) throw new Error('il cervello non ha prodotto una pagina HTML valida: riprova, magari più specifico');
  return { html: pagina };
}

export function pubblica({ nome, html }) {
  const pagina = String(html || '').trim();
  if (!/<html[\s>]/i.test(pagina)) throw new Error('Non c\'è ancora una pagina da pubblicare');
  const s = slug(nome);
  const dir = path.join(SITI_DIR, s);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), pagina, 'utf8');
  fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ nome: String(nome || s), slug: s, aggiornato: Date.now() }), 'utf8');
  return { nome: String(nome || s), slug: s, url: `/siti/${s}/` };
}

export function elenca() {
  if (!fs.existsSync(SITI_DIR)) return [];
  return fs.readdirSync(SITI_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => {
    let meta = { nome: d.name, slug: d.name, aggiornato: 0 };
    try { meta = { ...meta, ...JSON.parse(fs.readFileSync(path.join(SITI_DIR, d.name, '.meta.json'), 'utf8')) }; } catch { /* senza meta */ }
    return { nome: meta.nome, slug: d.name, url: `/siti/${d.name}/`, aggiornato: meta.aggiornato };
  }).sort((a, b) => b.aggiornato - a.aggiornato);
}

export function elimina(s) {
  const dir = path.join(SITI_DIR, path.basename(String(s)));
  if (dir.startsWith(SITI_DIR + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}
