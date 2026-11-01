// Il "cervello" che interpreta i prompt: un LLM che gira sul tuo PC.
// - gguf: un file .gguf nella cartella dei modelli, eseguito dal worker Python (llama.cpp)
// - server: un server locale compatibile OpenAI (Ollama, LM Studio, llama.cpp server…)
// - rules: nessun LLM, solo regole a parole chiave
import { getSettings } from './store.js';
import * as llama from './llamaserver.js';

// Due cervelli .gguf: uno veloce per parlare (il principale) e uno grande di riserva per i lavori pesanti
// (bozze strutturate, estrazione dei ricordi, "pensaci a fondo"). Senza scelta esplicita: il più piccolo parla, il più grande fa da riserva.
// Il cervello scrittore: un modello fatto per scrivere senza filtri (racconti, battute, testi per adulti).
// Scelto in Cervello oppure riconosciuto dal nome; non entra nella scelta automatica di principale e riserva.
const WRITER_NAME = /lexi|uncensored|dolphin|nemo.*abliterat|abliterat.*nemo/i;
export function writerModel(models) {
  const { brain } = getSettings();
  const llms = models.filter((m) => m.kind === 'llm' && m.enabled);
  return llms.find((m) => m.id === brain.writer) || llms.find((m) => WRITER_NAME.test(`${m.name} ${m.file || ''}`)) || null;
}
export function writerBrain(models) {
  const { brain } = getSettings();
  if (brain.mode === 'rules' || brain.mode === 'server') return null;
  const m = writerModel(models);
  return m ? { mode: 'gguf', model: m, label: m.name, writer: true } : null;
}

export function brainPair(models) {
  const { brain } = getSettings();
  const writer = writerModel(models);
  const all = models.filter((m) => m.kind === 'llm' && m.enabled).sort((a, b) => (a.size || 0) - (b.size || 0));
  const others = all.filter((m) => m !== writer || m.id === brain.gguf || m.id === brain.reserve);
  const ggufs = others.length ? others : all; // se c'è solo lo scrittore, fa anche da principale
  const primary = ggufs.find((m) => m.id === brain.gguf) || ggufs[0] || null;
  const rest = ggufs.filter((m) => m !== primary);
  // In automatico la riserva non supera i 13 GB: più grande non parte su una scheda da 16 GB (sceglierla a mano resta possibile)
  const reserve = rest.find((m) => m.id === brain.reserve) || (brain.reserve === 'none' ? null : rest.filter((m) => (m.size || 0) < 13e9).pop()) || null;
  return { primary, reserve };
}

export function resolveBrain(models, { heavy = false } = {}) {
  const { brain } = getSettings();
  if (brain.mode === 'rules') return { mode: 'rules', label: 'regole integrate' };
  if (brain.mode === 'server') {
    return { mode: 'server', url: brain.serverUrl, model: brain.serverModel, label: `server locale ${brain.serverModel || ''}`.trim() };
  }
  const { primary, reserve } = brainPair(models);
  const pick = heavy && reserve ? reserve : primary;
  if (pick && (brain.mode === 'gguf' || brain.mode === 'auto')) return { mode: 'gguf', model: pick, label: pick.name, heavy: pick === reserve && !!reserve };
  return { mode: 'rules', label: 'regole integrate' };
}

// I modelli piccoli sbagliano ogni tanto una virgola o troncano la risposta. Invece di arrendersi, proviamo a
// riparare i difetti più comuni; se non basta, chi chiama rigenera a temperatura 0 (vedi chatBrain).
function riparaJson(s) {
  let t = s
    .replace(/,\s*([}\]])/g, '$1') // virgola prima di } o ] (trailing comma)
    .replace(/}(\s*){/g, '},$1{') // due oggetti in fila senza virgola
    .replace(/](\s*)\[/g, '],$1['); // due array in fila senza virgola
  // Bilancia parentesi aperte e non chiuse (risposta troncata): chiude nell'ordine giusto
  const pila = [];
  let inStr = false, esc = false;
  for (const c of t) {
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') inStr = !inStr;
    else if (!inStr) { if (c === '{' || c === '[') pila.push(c); else if (c === '}' || c === ']') pila.pop(); }
  }
  if (inStr) t += '"';
  while (pila.length) t += pila.pop() === '{' ? '}' : ']';
  return t.replace(/,\s*([}\]])/g, '$1');
}

function parseJson(text) {
  const cleaned = String(text).replace(/```(?:json)?/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  const corpo = start >= 0 ? cleaned.slice(start, end >= start ? end + 1 : undefined) : cleaned;
  try {
    return JSON.parse(corpo);
  } catch (err) {
    try {
      return JSON.parse(riparaJson(corpo));
    } catch {
      throw Object.assign(err, { jsonText: corpo }); // il testo grezzo viaggia con l'errore: chatBrain può ritentare
    }
  }
}

export async function askBrain(brain, system, user, schema) {
  return chatBrain(brain, [{ role: 'system', content: system }, { role: 'user', content: user }], schema);
}

// Conversazione con il cervello: risposta sempre in JSON secondo lo schema (funziona anche con modelli piccoli)
// Testo libero (senza JSON): per racconti e risposte lunghe
export async function textBrain(brain, messages, { temperature = 0.85, maxTokens = 2500, timeout = 600_000 } = {}) {
  if (brain.mode === 'gguf') return String(await llama.chat(brain.model.path, messages, null, { temperature, maxTokens, timeout })).trim();
  if (brain.mode === 'server') {
    const res = await fetch(`${brain.url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: brain.model, messages, temperature, max_tokens: maxTokens }),
      signal: AbortSignal.timeout(timeout),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error?.message || `server HTTP ${res.status}`);
    return String(body.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }
  throw new Error('nessun LLM configurato');
}

export async function chatBrain(brain, messages, schema, { temperature = 0.2, maxTokens = 1024, timeout = 300_000 } = {}) {
  // Una generazione grezza (testo). Si può richiamare: se il primo JSON è rotto, si ritenta a temperatura 0.
  async function genera(temp) {
    if (brain.mode === 'gguf') {
      return String(await llama.chat(brain.model.path, messages, schema, { temperature: temp, maxTokens, timeout }));
    }
    if (brain.mode === 'server') {
      const res = await fetch(`${brain.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: brain.model, messages, temperature: temp, max_tokens: maxTokens,
          response_format: { type: 'json_schema', json_schema: { name: 'risposta', schema } },
        }),
        signal: AbortSignal.timeout(timeout),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error?.message || `server HTTP ${res.status}`);
      return String(body.choices?.[0]?.message?.content || '');
    }
    throw new Error('nessun LLM configurato');
  }
  try {
    return parseJson(await genera(temperature));
  } catch (err) {
    if (!('jsonText' in (err || {}))) throw err; // non è un errore di JSON (es. rete): non ha senso ritentare
    // Il primo JSON era malformato: i modelli piccoli di solito lo azzeccano al secondo giro, a temperatura 0
    return parseJson(await genera(0));
  }
}
