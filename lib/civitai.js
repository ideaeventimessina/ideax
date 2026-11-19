// Scarica una LoRA (o un modello) da Civitai nella cartella loras di ideax, con un link e la chiave API.
// Civitai è dove stanno le LoRA di movimento per Wan, comprese quelle per adulti: la maggior parte dei file
// richiede la chiave (Account → API Keys). Il file arriva nella cartella loras e lo scanner lo riconosce da solo
// (anche l'architettura: una LoRA "wan…" diventa arch 'wan' e si accende sul video).
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODELS_DIR, getSettings, saveOverride } from './store.js';
import { scanModels } from './scanner.js';

export const civitaiJob = { status: 'idle', done: 0, total: 0, error: null, nome: null };

function parseUrl(url) {
  const u = String(url || '').trim();
  const m = u.match(/civitai\.com\/models\/(\d+)/i);
  if (!m) throw new Error('Incolla il link del modello su Civitai, es. https://civitai.com/models/123456');
  const v = u.match(/[?&]modelVersionId=(\d+)/i);
  return { modelId: m[1], versionId: v ? v[1] : null };
}

export async function scarica({ url, adulto = false }) {
  if (civitaiJob.status === 'downloading') return civitaiJob;
  const token = (getSettings().civitaiToken || '').trim();
  const { modelId, versionId } = parseUrl(url);
  Object.assign(civitaiJob, { status: 'downloading', done: 0, total: 0, error: null, nome: null });
  (async () => {
    try {
      const auth = token ? { headers: { Authorization: `Bearer ${token}` } } : {};
      const meta = await fetch(`https://civitai.com/api/v1/models/${modelId}`, { ...auth, signal: AbortSignal.timeout(20_000) });
      if (meta.status === 401) throw new Error('Civitai rifiuta la chiave: controllala in Impostazioni → Civitai.');
      if (!meta.ok) throw new Error(`Civitai ha risposto ${meta.status}`);
      const data = await meta.json();
      const versioni = data.modelVersions || [];
      const ver = (versionId ? versioni.find((x) => String(x.id) === versionId) : versioni[0]);
      if (!ver) throw new Error('Versione del modello non trovata.');
      const file = (ver.files || []).find((f) => /\.safetensors$/i.test(f.name)) || (ver.files || [])[0];
      if (!file?.downloadUrl) throw new Error('Nessun file scaricabile in questa versione.');
      civitaiJob.nome = file.name;
      const dlUrl = `${file.downloadUrl}${file.downloadUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      const res = await fetch(dlUrl, { headers: { 'User-Agent': 'ideax/1.0' } });
      if (res.status === 401 || res.status === 403) throw new Error('Questo file richiede la chiave API di Civitai (Impostazioni → Civitai).');
      if (!res.ok) throw new Error(`Download non riuscito (${res.status}).`);
      const dir = path.join(MODELS_DIR, 'loras');
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, file.name);
      civitaiJob.total = Number(res.headers.get('content-length')) || 0;
      const counter = new TransformStream({ transform(chunk, ctrl) { civitaiJob.done += chunk.length; ctrl.enqueue(chunk); } });
      await pipeline(Readable.fromWeb(res.body.pipeThrough(counter)), fs.createWriteStream(dest + '.part'));
      fs.renameSync(dest + '.part', dest);
      // Marca la LoRA come "per adulti", così si accende da sola sui contenuti espliciti compatibili
      if (adulto) {
        const m = scanModels().find((x) => x.path === dest);
        if (m) saveOverride(m.id, { adultLora: true });
      }
      Object.assign(civitaiJob, { status: 'done' });
    } catch (err) {
      Object.assign(civitaiJob, { status: 'error', error: err.message });
    }
  })();
  return civitaiJob;
}
