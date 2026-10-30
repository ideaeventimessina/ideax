// Client per usare ideax da qualsiasi sistema JavaScript (Node 18+ o browser).
//
//   import { Ideax } from './ideax.js';
//   const ai = new Ideax('http://192.168.1.10:7800', 'ideax_sk_…');
//   const job = await ai.generate('Un faro al tramonto, stile acquerello', { params: { aspect: '16:9' } });
//   console.log(job.results[0].url);
//
//   // Con un file (Blob/File nel browser, Buffer in Node) e un webhook
//   await ai.generate('Mettilo su una spiaggia', { files: [foto], callback_url: 'https://…/ideax-webhook' });
export class Ideax {
  constructor(baseUrl = 'http://127.0.0.1:7800', apiKey = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  async #request(path, { method = 'GET', json, form } = {}) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        ...(json ? { 'Content-Type': 'application/json' } : {}),
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: json ? JSON.stringify(json) : form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 500) throw new Error(data.error?.message || data.error || `ideax: HTTP ${res.status}`);
    return data;
  }

  // options: task, model, params, metadata, callback_url, wait, inline,
  //          attachments: [{ url } | { dataUrl } | { base64, type }], files: [Blob | File | Buffer]
  generate(prompt, { files, ...options } = {}) {
    if (!files?.length) return this.#request('/v1/generate', { method: 'POST', json: { prompt, ...options } });
    const form = new FormData();
    form.append('prompt', prompt);
    for (const [k, v] of Object.entries(options)) {
      if (v !== undefined) form.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    files.forEach((f, i) => form.append('files', f instanceof Blob ? f : new Blob([f]), f.name || `file-${i + 1}`));
    return this.#request('/v1/generate', { method: 'POST', form });
  }

  // Legge un testo con una voce clonata: options = language, format, exaggeration, cfg_weight, seed, callback_url, metadata, wait
  speak(text, voice, options = {}) {
    return this.#request('/v1/speech', { method: 'POST', json: { text, voice, ...options } });
  }

  voices() { return this.#request('/v1/voices'); }

  // Crea una voce da un campione (Blob/File nel browser, Buffer in Node). Serve il consenso della persona.
  createVoice(name, sample, { language = 'it', consent = false } = {}) {
    const form = new FormData();
    form.append('name', name);
    form.append('language', language);
    form.append('consent', String(!!consent));
    form.append('file', sample instanceof Blob ? sample : new Blob([sample]), sample.name || 'campione.wav');
    return this.#request('/v1/voices', { method: 'POST', form });
  }

  job(id) { return this.#request(`/v1/jobs/${id}`); }
  cancel(id) { return this.#request(`/v1/jobs/${id}/cancel`, { method: 'POST' }); }
  models() { return this.#request('/v1/models'); }
  health() { return this.#request('/v1/health'); }
  creations({ type, q, limit, offset } = {}) {
    const qs = new URLSearchParams(Object.entries({ type, q, limit, offset }).filter(([, v]) => v != null));
    return this.#request(`/v1/creations?${qs}`);
  }
  creation(id) { return this.#request(`/v1/creations/${id}`); }
  deleteCreation(id) { return this.#request(`/v1/creations/${id}`, { method: 'DELETE' }); }

  // Aspetta che un lavoro avviato con wait: false finisca
  async waitFor(id, everyMs = 1500) {
    for (;;) {
      const j = await this.job(id);
      if (['done', 'error', 'cancelled'].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }

  // Scarica un risultato (con la chiave, necessaria dagli altri computer)
  async download(url) {
    const res = await fetch(url, { headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {} });
    if (!res.ok) throw new Error(`ideax: download HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

// Verifica la firma di un webhook (Node). body = testo grezzo ricevuto, signature = intestazione X-Ideax-Signature
export async function verifyWebhook(body, signature, secret) {
  const { createHmac, timingSafeEqual } = await import('node:crypto');
  const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  return typeof signature === 'string' && signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
