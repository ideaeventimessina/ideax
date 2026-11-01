// La vista: il cervello VL (es. Qwen3-VL) guarda le immagini e risponde. Per vedere, llama.cpp vuole il "proiettore"
// (mmproj) dello stesso modello: ideax lo scarica una volta dal repository ufficiale della famiglia. Il proiettore
// non cambia con le versioni senza censure (si tocca solo la parte che scrive), quindi quello ufficiale va bene.
import fs from 'node:fs';
import path from 'node:path';
import { enginesDir } from './engines.js';
import { snapshot } from './hfdownload.js';
import * as llama from './llamaserver.js';
import { buildCatalog } from './router.js';
import { brainPair } from './brain.js';

const DIR = path.join(enginesDir, 'vista');
export const job = { status: 'idle', step: null, done: 0, total: 0, error: null };

const VL = /qwen[\d.]*-?vl|vision|llava|gemma-?3|minicpm-?v|pixtral|internvl/i;
export const isVisionModel = (m) => !!m && m.kind === 'llm' && VL.test(`${m.name} ${m.file || ''} ${path.basename(m.path || '')}`);

// Il repository ufficiale con il proiettore, dalla famiglia e dalla taglia del modello
function projectorSource(m) {
  const name = `${m.name} ${path.basename(m.path || '')}`;
  const size = (name.match(/(\d+(?:\.\d+)?)\s*b\b/i) || name.match(/-(\d+(?:\.\d+)?)b/i) || [])[1];
  if (/qwen3-?vl/i.test(name)) return { repo: `Qwen/Qwen3-VL-${size || 8}B-Instruct-GGUF`, patterns: ['*mmproj*F16*.gguf', '*mmproj*f16*.gguf'] };
  if (/qwen2\.5-?vl/i.test(name)) return { repo: `ggml-org/Qwen2.5-VL-${size || 7}B-Instruct-GGUF`, patterns: ['mmproj*f16*.gguf', 'mmproj*F16*.gguf'] };
  if (/gemma-?3/i.test(name)) return { repo: `ggml-org/gemma-3-${size || 12}b-it-GGUF`, patterns: ['mmproj*f16*.gguf', 'mmproj*F16*.gguf'] };
  return null;
}

// Il cervello che vede: il principale se è VL, altrimenti il primo modello VL installato
export function visionModel(models = buildCatalog().all) {
  const { primary, reserve } = brainPair(models);
  if (isVisionModel(primary)) return primary;
  if (isVisionModel(reserve)) return reserve;
  return models.find((m) => isVisionModel(m) && m.enabled) || null;
}

export async function ensureProjector(m) {
  // Un proiettore già accanto al modello (scaricato insieme dall'utente) vale come il nostro
  const near = fs.readdirSync(path.dirname(m.path)).find((f) => /mmproj/i.test(f) && f.endsWith('.gguf'));
  if (near) return path.join(path.dirname(m.path), near);
  const src = projectorSource(m);
  if (!src) throw new Error(`Non so dove trovare il file della vista per ${m.name}: mettilo (mmproj…gguf) nella stessa cartella del modello`);
  const dest = path.join(DIR, src.repo.replace('/', '__'));
  const have = fs.existsSync(dest) && fs.readdirSync(dest, { recursive: true }).find((f) => /mmproj.*\.gguf$/i.test(String(f)));
  if (have) return path.join(dest, String(have));
  Object.assign(job, { status: 'downloading', step: `Scarico la vista di ${m.name} (circa 1 GB, una volta sola)`, error: null });
  let last;
  for (const pattern of src.patterns) {
    try {
      await snapshot(src.repo, dest, [pattern], { onProgress: (p) => Object.assign(job, { done: p.done, total: p.total }) });
      last = null;
      break;
    } catch (err) { last = err; }
  }
  if (last) { Object.assign(job, { status: 'error', error: last.message, step: null }); throw last; }
  Object.assign(job, { status: 'ready', step: null });
  const f = fs.readdirSync(dest, { recursive: true }).find((x) => /mmproj.*\.gguf$/i.test(String(x)));
  return path.join(dest, String(f));
}

// Guarda le immagini (data URL) e risponde alla domanda; con uno schema JSON risponde in quel formato
export async function look(images, domanda, { schema = null, maxTokens = 1500, temperature = 0.2 } = {}) {
  const m = visionModel();
  if (!m) throw new Error('Per vedere le immagini serve un cervello VL (es. Qwen3-VL): scaricalo in Cervello');
  const mmproj = await ensureProjector(m);
  const content = [{ type: 'text', text: String(domanda || 'Descrivi questa immagine in italiano, in modo preciso.') },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
  const out = await llama.chat(m.path, [{ role: 'user', content }], schema, { temperature, maxTokens, mmproj, timeout: 600_000 });
  if (!schema) return { risposta: String(out).trim(), modello: m.name };
  const t = String(out).replace(/```(?:json)?/g, '');
  return { ...JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)), modello: m.name };
}
