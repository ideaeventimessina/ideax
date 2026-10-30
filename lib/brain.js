// Il "cervello" che interpreta i prompt: un LLM che gira sul tuo PC.
// - gguf: un file .gguf nella cartella dei modelli, eseguito dal worker Python (llama.cpp)
// - server: un server locale compatibile OpenAI (Ollama, LM Studio, llama.cpp server…)
// - rules: nessun LLM, solo regole a parole chiave
import { getSettings } from './store.js';
import * as llama from './llamaserver.js';

export function resolveBrain(models) {
  const { brain } = getSettings();
  const ggufs = models.filter((m) => m.kind === 'llm' && m.enabled);
  const gguf = ggufs.find((m) => m.id === brain.gguf) || ggufs[0];
  if (brain.mode === 'rules') return { mode: 'rules', label: 'regole integrate' };
  if (brain.mode === 'server') {
    return { mode: 'server', url: brain.serverUrl, model: brain.serverModel, label: `server locale ${brain.serverModel || ''}`.trim() };
  }
  if (gguf && (brain.mode === 'gguf' || brain.mode === 'auto')) return { mode: 'gguf', model: gguf, label: gguf.name };
  return { mode: 'rules', label: 'regole integrate' };
}

function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  return JSON.parse(cleaned.slice(start, end + 1));
}

export async function askBrain(brain, system, user, schema) {
  return chatBrain(brain, [{ role: 'system', content: system }, { role: 'user', content: user }], schema);
}

// Conversazione con il cervello: risposta sempre in JSON secondo lo schema (funziona anche con modelli piccoli)
export async function chatBrain(brain, messages, schema, { temperature = 0.2, maxTokens = 1024, timeout = 300_000 } = {}) {
  const signal = AbortSignal.timeout(timeout);
  if (brain.mode === 'gguf') {
    // llama.cpp ufficiale, scaricato e acceso da ideax al primo uso
    return parseJson(await llama.chat(brain.model.path, messages, schema, { temperature, maxTokens, timeout }));
  }
  if (brain.mode === 'server') {
    const res = await fetch(`${brain.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: brain.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        response_format: { type: 'json_schema', json_schema: { name: 'risposta', schema } },
      }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `server HTTP ${res.status}`);
    return parseJson(body.choices?.[0]?.message?.content);
  }
  throw new Error('nessun LLM configurato');
}
