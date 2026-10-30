// Decorazioni per il laser: dal tema a tracciati in millimetri, pronti per l'editor di IDEAlab.
// 1) il modello di immagini disegna una sagoma nera su fondo bianco (o un disegno al tratto da incidere)
// 2) il worker la vettorizza: contorni chiusi, parti sottili e varchi stretti tolti per il taglio
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, OUTPUT_DIR } from './store.js';
import { buildCatalog } from './router.js';

// Il modello disegna un'illustrazione vera (colori pieni, contorni netti): dal suo profilo nasce il pezzo da tagliare,
// dai suoi tratti scuri i dettagli da incidere. Il risultato si vede come sarà nel legno o nel plexiglass.
const STYLE = {
  taglio: {
    prompt: 'cute flat vector illustration designed for a laser cut wooden decoration, single subject, bold clean dark outlines, simple flat colors, all parts connected in one solid piece, centered, isolated on a pure white background, no shadow, no text',
    negative: 'photo, realistic, 3d render, gradient, texture, drop shadow, background scenery, text, letters, watermark, frame, border, thin floating details, multiple separate objects',
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

// Per le sagome il modello migliore è Flux, se c'è
function preferredModel() {
  const gens = buildCatalog().generators.filter((g) => g.capabilities?.includes('image_generate'));
  return (gens.find((g) => g.arch === 'flux') || null)?.id || null;
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
export async function decoration(d, { createJob, ctx = {} }) {
  const tema = String(d.tema || '').trim();
  if (!tema) throw new Error('Scrivi il tema della decorazione');
  const opts = vecOpts(d);
  const style = STYLE[opts.mode];
  const job = await createJob({
    prompt: `${tema}, ${style.prompt}`,
    task: 'image_generate',
    model: preferredModel(),
    params: { ...sizeFor(opts.width_mm, opts.height_mm), negative_prompt: style.negative, num_images_per_prompt: Math.min(4, Math.max(1, Number(d.varianti) || 1)) },
    metadata: { laser: true, tema },
  }, ctx);
  await job.done;
  if (job.status !== 'done') throw new Error(job.error || 'Il modello di immagini non ha risposto');
  const proposte = [];
  for (const r of job.results.filter((x) => x.type.startsWith('image/'))) {
    const file = path.join(OUTPUT_DIR, path.basename(r.url));
    try {
      const v = await piece(file, opts);
      // d resta per chi usava la versione precedente (un solo tracciato): è il contorno
      proposte.push({ ...v, d: v.livelli[0].d, immagine: `data:${r.type};base64,${fs.readFileSync(file).toString('base64')}` });
    } catch (err) {
      proposte.push({ errore: err.message });
    }
  }
  if (!proposte.some((p) => p.d)) throw new Error(proposte[0]?.errore || 'Nessuna proposta utilizzabile');
  return { tema, operazione: opts.mode, modello: job.modelName, proposte };
}
