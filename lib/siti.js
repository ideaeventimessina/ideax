// La pagina "Code" dello Studio: descrivi una pagina o una web app, il cervello locale la genera
// come UN file HTML autosufficiente (HTML+CSS+JS insieme), la vedi in anteprima, la ritocchi e la
// PUBBLICHI — ideax la serve subito a /siti/<nome>/ (sul PC, e sulla rete locale se l'hai accesa in
// Impostazioni → Rete). Per un indirizzo pubblico su internet serve un passo di deploy a parte.
import fs from 'node:fs';
import path from 'node:path';
import { Script } from 'node:vm';
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
  'Mantieni esattamente gli ID, i nomi e i testi dei controlli specificati. Controlla che ciascun selettore JavaScript punti a un elemento che esiste e che ogni controllo modifichi lo stato richiesto.',
  'Usa uno script in fondo al body e registra gli eventi con addEventListener, senza attributi onclick. Usa nomi distinti per gli elementi DOM e le funzioni.',
  'Rispondi SOLO con il codice della pagina, da <!doctype html> a </html>. Nessuna spiegazione, nessun testo fuori dal codice.',
].join('\n');

// Dal testo del cervello tira fuori la pagina: toglie i recinti markdown, parte da <!doctype/<html.
function estraiHtml(testo) {
  let t = String(testo || '').trim();
  const recinto = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (recinto) t = recinto[1].trim();
  const i = t.search(/<!doctype html|<html[\s>]/i);
  if (i > 0) t = t.slice(i);
  const end = t.search(/<\/html\s*>/i);
  if (end >= 0) t = t.slice(0, t.indexOf('>', end) + 1);
  return t.trim();
}

function controllaHtml(pagina) {
  if (!/<html[\s>]/i.test(pagina) || !/<\/html\s*>$/i.test(pagina)) {
    throw new Error('La pagina HTML è incompleta.');
  }
  for (const [, attributi, sorgente] of pagina.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const type = attributi.match(/(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/i);
    const mime = (type?.[1] ?? type?.[2] ?? type?.[3] ?? '').trim().split(';')[0];
    if (mime && !/^(text|application)\/(java|ecma)script$/i.test(mime)) continue;
    new Script(sorgente, { filename: 'pagina.html' }); // compila soltanto, senza eseguire il codice generato
  }
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
  for (let tentativo = 0; tentativo < 2; tentativo++) {
    const out = await textBrain(brain, messaggi, { temperature: 0.1, maxTokens: 8000, timeout: 600_000 });
    const pagina = estraiHtml(out);
    try {
      controllaHtml(pagina);
      return { html: pagina };
    } catch (error) {
      if (tentativo === 1) throw new Error(`La pagina generata contiene un errore: ${error.message}`);
      messaggi.push({ role: 'user', content: `La generazione precedente non è valida: ${error.message} Riscrivi la pagina completa correggendo l'errore.` });
    }
  }
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
