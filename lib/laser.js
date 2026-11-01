/* Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M */
// Decorazioni per il laser: dal tema a tracciati in millimetri, pronti per l'editor di IDEAlab.
// 1) il modello di immagini disegna una sagoma nera su fondo bianco (o un disegno al tratto da incidere)
// 2) il worker la vettorizza: contorni chiusi, parti sottili e varchi stretti tolti per il taglio
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, OUTPUT_DIR } from './store.js';
import { buildCatalog, translate } from './router.js';

// Taglio: il modello disegna una sagoma nera piena, come uno stencil: il suo profilo è il pezzo. Prima chiedeva
// un'illustrazione "per decorazione in legno con contorni scuri" e i modelli la prendevano alla lettera: un oggetto di
// legno fotografato, oppure un cuore fatto di due linee storte invece che pieno.
const STYLE = {
  taglio: {
    prompt: 'one solid black silhouette, completely filled with flat black, stencil style, simple bold shape, all parts connected in one single piece, centered, isolated on a pure white background, no outline, no shading, no text',
    negative: 'outline only, line art, hollow, unfilled, sketch, thin lines, wood, wooden, wood grain, texture, 3d render, photo, realistic, shadow, gradient, grey background, multiple objects, frame, border, text, letters, watermark',
  },
  incisione: {
    prompt: 'elegant line art illustration for laser engraving, clean bold dark lines, simple and readable, centered, isolated on a pure white background, no shading, no text',
    negative: 'photo, realistic, 3d render, gradient, shadow, grey fill, background scenery, text, letters, watermark, frame, border, hatching',
  },
};

// Circa 1 megapixel con le proporzioni del pezzo, lati multipli di 64
function sizeFor(wMm, hMm) {
  const ratio = Math.min(3, Math.max(1 / 3, wMm / hMm));
  const h = Math.sqrt(1024 * 1024 / ratio);
  const r64 = (v) => Math.max(512, Math.round(v / 64) * 64);
  return { width: r64(h * ratio), height: r64(h) };
}

// Per una sagoma piatta conta la VELOCITÀ, non la fedeltà fotografica (tanto poi la si vettorizza): un modello che
// entra nei 16 GB fa in secondi quello che Flux-dev (12B, sborda sulla CPU) fa in minuti. Ordine: Flux schnell (4 passi)
// → SDXL → SD 1.5 → Flux dev (ultimo, è il lento). Prima forzava Flux e basta: ecco perché un cuore ci metteva 10 minuti.
function preferredModel() {
  const gens = buildCatalog().generators.filter((g) => g.capabilities?.includes('image_generate'));
  const no = (g) => !/pony|anime|illustrious|noob|hentai/i.test(`${g.name} ${g.file || ''}`); // per una sagoma pulita, non un modello anime/espliciti
  return (gens.find((g) => /schnell/i.test(`${g.name} ${g.file || ''}`))
    || gens.find((g) => g.arch === 'sdxl' && no(g)) // SDXL generico (es. realityvision) prima di Pony
    || gens.find((g) => g.arch === 'sd15' && no(g))
    || gens.find((g) => g.arch === 'sdxl')
    || gens.find((g) => g.arch === 'sd15')
    || gens.find((g) => g.arch === 'flux')
    || gens[0] || null)?.id || null;
}

async function workerPost(pathname, body) {
  const res = await fetch(`${getSettings().workerUrl}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Vettorizzazione non riuscita (HTTP ${res.status})`);
  return data;
}

// Taglio: contorno + dettagli incisi. Incisione: solo i tratti, un livello.
async function piece(file, opts) {
  const image = fs.readFileSync(file).toString('base64');
  if (opts.mode === 'taglio') {
    return workerPost('/decorate', { image, width_mm: opts.width_mm, height_mm: opts.height_mm, min_mm: opts.min_mm, gap_mm: opts.gap_mm });
  }
  const v = await workerPost('/vectorize', { image, ...opts, threshold: 110 });
  return { w: v.w, h: v.h, svg: v.svg, livelli: [{ nome: 'Disegno inciso', operazione: 'incisione', d: v.d, pieno: true }] };
}

const vecOpts = (d) => ({
  width_mm: Number(d.larghezzaMm) || 100,
  height_mm: Number(d.altezzaMm) || 100,
  mode: d.operazione === 'incisione' || d.operazione === 'intaglio' ? 'incisione' : 'taglio',
  min_mm: Number(d.minimoMm) || 3,
  gap_mm: Number(d.distanzaMm) || 2,
});

export async function vectorize(d) {
  if (!d.immagine) throw new Error('Manca l\'immagine da vettorizzare');
  const res = await fetch(`${getSettings().workerUrl}/vectorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: d.immagine, ...vecOpts(d) }),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Vettorizzazione non riuscita (HTTP ${res.status})`);
  return data;
}

// dati: { tema, larghezzaMm, altezzaMm, operazione: taglio|incisione, varianti? }
// Sotto questa soglia il disegno è fatto di linee (vedi "pieno" nel worker): per il taglio si rigenera una volta
const PIENO_MIN = 0.5;

export async function decoration(d, { createJob, ctx = {} }) {
  const tema = String(d.tema || '').trim();
  if (!tema) throw new Error('Scrivi il tema della decorazione');
  const opts = vecOpts(d);
  const style = STYLE[opts.mode];
  // I modelli SD/SDXL capiscono l'inglese: "cuore sagoma nero" arrivava così com'era (il router traduce solo se
  // riconosce l'italiano dalle sue parole, e qui non ce n'erano). Se il traduttore non risponde, resta il tema.
  const soggetto = await translate(tema).then((t) => String(t || '').trim() || tema).catch(() => tema);
  const varianti = Math.min(4, Math.max(1, Number(d.varianti) || 1));
  let modello = null;
  let proposte = [];
  for (let giro = 0; giro < (opts.mode === 'taglio' ? 2 : 1); giro++) {
    const job = await createJob({
      prompt: `${soggetto}, ${style.prompt}`,
      task: 'image_generate',
      model: preferredModel(),
      // Una sagoma non ha pelle né volti: niente rifinitura (toglie DUE giri di diffusione da 24-30 passi, il grosso del tempo).
      // Stile "natural": su una base fotoreale lo stile del modello aggiungerebbe "raw photo, DSLR" e vieterebbe "illustration".
      params: { ...sizeFor(opts.width_mm, opts.height_mm), negative_prompt: style.negative, num_images_per_prompt: varianti, face_fix: false, skin_fix: false, prompt_style: 'natural' },
      metadata: { laser: true, tema },
    }, ctx);
    await job.done;
    if (job.status !== 'done') throw new Error(job.error || 'Il modello di immagini non ha risposto');
    modello = job.modelName;
    for (const r of job.results.filter((x) => x.type.startsWith('image/'))) {
      const file = path.join(OUTPUT_DIR, path.basename(r.url));
      try {
        const { anteprima, ...v } = await piece(file, opts);
        // d resta per chi usava la versione precedente (un solo tracciato): è il contorno
        // l'anteprima leggera del worker; l'immagine intera solo se manca (incisione)
        proposte.push({ ...v, d: v.livelli[0].d, immagine: anteprima || `data:${r.type};base64,${fs.readFileSync(file).toString('base64')}` });
      } catch (err) {
        proposte.push({ errore: err.message });
      }
    }
    // Basta una sagoma piena; se sono tutte di sole linee si riprova una volta e poi si tengono le migliori
    if (opts.mode !== 'taglio' || proposte.some((p) => p.d && (p.pieno ?? 1) >= PIENO_MIN)) break;
  }
  const buone = proposte.filter((p) => p.d && (p.pieno ?? 1) >= PIENO_MIN);
  if (buone.length) proposte = buone;
  else proposte.sort((a, b) => (b.pieno ?? 0) - (a.pieno ?? 0));
  proposte = proposte.slice(0, varianti);
  if (!proposte.some((p) => p.d)) throw new Error(proposte[0]?.errore || 'Nessuna proposta utilizzabile');
  return { tema, operazione: opts.mode, modello, proposte };
}
