// Client minimo per usare ideax da qualsiasi app JavaScript/Node (Node 18+ o browser).
//   import { Ideax } from './ideax.js';
//   const ai = new Ideax('http://192.168.1.10:7800');
//   const { results } = await ai.generate('un gatto astronauta ad acquerello');
export class Ideax {
  constructor(baseUrl = 'http://127.0.0.1:7800', token = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async #request(path, body) {
    const res = await fetch(this.baseUrl + path, {
      method: body ? 'POST' : 'GET',
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || data.error || `ideax: HTTP ${res.status}`);
    return data;
  }

  // options: { task, model, params, attachments: [{ url } | { dataUrl } | { base64, type }], wait }
  generate(prompt, options = {}) {
    return this.#request('/v1/generate', { prompt, ...options });
  }

  job(id) {
    return this.#request(`/v1/jobs/${id}`);
  }

  models() {
    return this.#request('/v1/models');
  }
}
