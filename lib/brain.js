// Il "cervello" che interpreta i prompt: un LLM che gira sul tuo PC.
// - gguf: un file .gguf nella cartella dei modelli, eseguito dal worker Python (llama.cpp)
// - server: un server locale compatibile OpenAI (Ollama, LM Studio, llama.cpp server…)
// - rules: nessun LLM, solo regole a parole chiave
import { getSettings } from './store.js';

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
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const signal = AbortSignal.timeout(120_000);
  if (brain.mode === 'gguf') {
    const res = await fetch(`${getSettings().workerUrl}/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_path: brain.model.path, messages, schema }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.detail || `worker HTTP ${res.status}`);
    return parseJson(body.content);
  }
  if (brain.mode === 'server') {
    const res = await fetch(`${brain.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: brain.model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_schema', json_schema: { name: 'route', schema } },
      }),
      signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `server HTTP ${res.status}`);
    return parseJson(body.choices?.[0]?.message?.content);
  }
  throw new Error('nessun LLM configurato');
}
