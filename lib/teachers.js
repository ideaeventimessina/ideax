// "Maestri": altri cervelli che sanno già tante cose di te (es. Axel). ideax li interroga per imparare in fretta.
// Due modi di collegarli:
// - openai: qualsiasi servizio compatibile con /chat/completions (indirizzo base, chiave, modello)
// - webhook: un indirizzo che riceve { message } in POST e risponde con { reply } (o answer / text / message / output)
import crypto from 'node:crypto';
import { getSettings, saveSettings } from './store.js';

export function listTeachers({ withSecrets = false } = {}) {
  return (getSettings().teachers || []).map((t) => (withSecrets ? t : { ...t, apiKey: t.apiKey ? '••••' + t.apiKey.slice(-4) : '' }));
}

export function findTeacher(nameOrId) {
  const all = listTeachers({ withSecrets: true });
  if (!nameOrId) return all[0] || null;
  const n = String(nameOrId).toLowerCase();
  return all.find((t) => t.id === nameOrId || t.name.toLowerCase() === n) || all.find((t) => t.name.toLowerCase().includes(n)) || null;
}

export function saveTeacher(input) {
  const list = listTeachers({ withSecrets: true });
  const old = list.find((t) => t.id === input.id);
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Dai un nome al maestro (es. Axel)');
  if (!/^https?:\/\//i.test(input.url || '')) throw new Error('Indirizzo non valido: deve iniziare con http:// o https://');
  const t = {
    id: old?.id || crypto.randomUUID().slice(0, 8),
    name,
    type: input.type === 'webhook' ? 'webhook' : 'openai',
    url: String(input.url).trim().replace(/\/$/, ''),
    model: String(input.model || '').trim(),
    // La chiave mascherata che torna dall'interfaccia non sovrascrive quella salvata
    apiKey: input.apiKey && !String(input.apiKey).startsWith('••••') ? String(input.apiKey).trim() : old?.apiKey || '',
  };
  saveSettings({ teachers: [...list.filter((x) => x.id !== t.id), t] });
  return { ...t, apiKey: t.apiKey ? '••••' + t.apiKey.slice(-4) : '' };
}

export function deleteTeacher(id) {
  saveSettings({ teachers: listTeachers({ withSecrets: true }).filter((t) => t.id !== id) });
}

export async function ask(teacher, question, { system = '', timeout = 180_000 } = {}) {
  const t = typeof teacher === 'string' ? findTeacher(teacher) : teacher;
  if (!t) throw new Error('Nessun maestro collegato: aggiungilo in Cervello → Impara da un altro cervello.');
  const headers = { 'Content-Type': 'application/json', ...(t.apiKey ? { Authorization: `Bearer ${t.apiKey}` } : {}) };
  const signal = AbortSignal.timeout(timeout);
  if (t.type === 'openai') {
    const messages = [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: question }];
    const res = await fetch(`${t.url}/chat/completions`, { method: 'POST', headers, body: JSON.stringify({ model: t.model || undefined, messages, temperature: 0.3 }), signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${t.name}: ${data.error?.message || data.error || `HTTP ${res.status}`}`);
    return String(data.choices?.[0]?.message?.content || '').trim();
  }
  const res = await fetch(t.url, { method: 'POST', headers, body: JSON.stringify({ message: question, question, from: 'ideax', system }), signal });
  const text = await res.text();
  if (!res.ok) throw new Error(`${t.name}: HTTP ${res.status} ${text.slice(0, 200)}`);
  try {
    const data = JSON.parse(text);
    return String(data.reply ?? data.answer ?? data.text ?? data.message ?? data.output ?? data.content ?? data.response ?? JSON.stringify(data)).trim();
  } catch {
    return text.trim();
  }
}
