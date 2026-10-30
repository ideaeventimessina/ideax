// Le conversazioni con il cervello: una per file in data/cervello/chat/<id>.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BRAIN_DIR } from './memory.js';

const DIR = path.join(BRAIN_DIR, 'chat');
const cache = new Map();

const file = (id) => path.join(DIR, `${String(id).replace(/[^\w-]/g, '')}.json`);

export function getChat(id) {
  if (!id) return null;
  if (cache.has(id)) return cache.get(id);
  try {
    const chat = JSON.parse(fs.readFileSync(file(id), 'utf8'));
    cache.set(id, chat);
    return chat;
  } catch {
    return null;
  }
}

export function saveChat(chat) {
  fs.mkdirSync(DIR, { recursive: true });
  chat.updatedAt = Date.now();
  cache.set(chat.id, chat);
  const { pending, ...data } = chat;
  fs.writeFileSync(file(chat.id), JSON.stringify(data, null, 1));
  return chat;
}

export function createChat({ title = '', client = 'ideax', mode = '' } = {}) {
  const chat = { id: crypto.randomUUID().slice(0, 8), title, client, mode, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
  return saveChat(chat);
}

export function deleteChat(id) {
  cache.delete(id);
  try {
    fs.rmSync(file(id));
    return true;
  } catch {
    return false;
  }
}

export function addMessage(chat, msg) {
  const m = { id: crypto.randomUUID().slice(0, 8), ts: Date.now(), ...msg };
  chat.messages.push(m);
  saveChat(chat);
  return m;
}

export function listChats() {
  let names = [];
  try {
    names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => getChat(n.slice(0, -5))).filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((c) => {
      const last = [...c.messages].reverse().find((m) => m.content);
      return { id: c.id, title: c.title || 'Nuova chat', client: c.client, mode: c.mode, updatedAt: c.updatedAt, messages: c.messages.length, preview: last ? last.content.slice(0, 120) : '', pending: !!c.pending };
    });
}

// Ricerca nelle altre chat: così una conversazione può "parlare" con le altre
export function searchChats(query, { exclude = null, limit = 8 } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return [];
  const hits = [];
  for (const c of listChats()) {
    if (c.id === exclude) continue;
    const chat = getChat(c.id);
    for (const m of chat.messages) {
      const text = String(m.content || '').toLowerCase();
      const score = terms.filter((t) => text.includes(t)).length;
      if (!score) continue;
      const at = Math.max(0, text.indexOf(terms.find((t) => text.includes(t))) - 120);
      hits.push({ chatId: c.id, title: c.title, role: m.role, date: new Date(m.ts).toISOString().slice(0, 10), score, snippet: m.content.slice(at, at + 400) });
    }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
