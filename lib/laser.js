// Decorazioni per il laser: dal tema a tracciati in millimetri, pronti per l'editor di IDEAlab.
// 1) il modello di immagini disegna una sagoma nera su fondo bianco (o un disegno al tratto da incidere)
// 2) il worker la vettorizza: contorni chiusi, parti sottili e varchi stretti tolti per il taglio
import fs from 'node:fs';
import path from 'node:path';
import { getSettings, OUTPUT_DIR } from './store.js';
import { buildCatalog } from './router.js';

const STYLE = {
  taglio: {
    prompt: 'laser cut silhouette design, one single solid black shape on a pure white background, bold thick connected shapes, no thin lines, no small details, no text, no shading, no gradient, flat vector stencil, centered, isolated',
    negative: 'photo, realistic, 3d, gradient, shadow, texture, color, grey, text, letters, watermark, frame, border, thin lines, multiple objects, background scenery',
  },
  incisione: {
    prompt: 'clean line art for laser engraving, black lines on a pure white background, bold even strokes, simple elegant illustration, no shading, no gradient, no text, centered, isolated',
    negative: 'photo, realistic, 3d, gradient, shadow, color, grey fill, text, letters, watermark, frame, border, background scenery, hatching',
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

async function vectorizeFile(file, opts) {
  const res = await fetch(`${getSettings().workerUrl}/vectorize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: fs.readFileSync(file).toString('base64'), ...opts }),
    signal: AbortSignal.timeout(300_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `Vettorizzazione non riuscita (HTTP ${res.status})`);
  return data;
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
      const v = await vectorizeFile(file, opts);
      proposte.push({ ...v, immagine: `data:${r.type};base64,${fs.readFileSync(file).toString('base64')}` });
    } catch (err) {
      proposte.push({ errore: err.message });
    }
  }
  if (!proposte.some((p) => p.d)) throw new Error(proposte[0]?.errore || 'Nessuna proposta utilizzabile');
  return { tema, operazione: opts.mode, modello: job.modelName, proposte };
}
