// Memoria a lungo termine del cervello: quello che ideax sa di te, comune a tutte le chat.
// Sta in data/cervello/memoria.json, sul tuo PC. Ogni ricordo è una frase breve con una categoria e la sua fonte.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './store.js';

export const BRAIN_DIR = path.join(DATA_DIR, 'cervello');
const FILE = path.join(BRAIN_DIR, 'memoria.json');

export const CATEGORIES = {
  identita: 'Chi sei',
  lavoro: 'Lavoro e aziende',
  progetti: 'Progetti e sistemi',
  persone: 'Persone',
  preferenze: 'Gusti e preferenze',
  stile: 'Come comunicare',
  regole: 'Regole da rispettare',
  altro: 'Altro',
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    cache = { facts: [] };
  }
  return cache;
}

function save() {
  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, FILE);
}

const words = (t) => new Set(String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]{3,}/g) || []);

function similarity(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

export function listFacts() {
  return [...load().facts].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function stats() {
  const facts = load().facts;
  const byCategory = {};
  for (const f of facts) byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  return { total: facts.length, byCategory };
}

// Aggiunge un ricordo; se ce n'è già uno quasi uguale lo aggiorna invece di duplicarlo
export function remember(text, { category = 'altro', source = 'chat', chatId = null } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (clean.length < 4) return null;
  const cat = category in CATEGORIES ? category : 'altro';
  const mem = load();
  const now = Date.now();
  const same = mem.facts.find((f) => similarity(f.text, clean) >= 0.85);
  if (same) {
    if (clean.length >= same.text.length) same.text = clean;
    same.updatedAt = now;
    if (cat !== 'altro') same.category = cat;
    save();
    return { ...same, updated: true };
  }
  const fact = { id: crypto.randomUUID().slice(0, 8), text: clean, category: cat, source, chatId, createdAt: now, updatedAt: now };
  mem.facts.push(fact);
  save();
  return fact;
}

export function updateFact(id, patch) {
  const f = load().facts.find((x) => x.id === id);
  if (!f) return null;
  if (patch.text != null) f.text = String(patch.text).replace(/\s+/g, ' ').trim().slice(0, 500);
  if (patch.category in CATEGORIES) f.category = patch.category;
  f.updatedAt = Date.now();
  save();
  return f;
}

export function forget(idOrText) {
  const mem = load();
  const before = mem.facts.length;
  mem.facts = mem.facts.filter((f) => f.id !== idOrText && similarity(f.text, idOrText) < 0.85);
  if (mem.facts.length !== before) save();
  return before - mem.facts.length;
}

export function forgetAll() {
  cache = { facts: [] };
  save();
}

// I ricordi da mettere davanti al cervello: tutti se sono pochi, altrimenti i fondamentali + i più pertinenti
const CORE = ['identita', 'stile', 'regole'];
export function relevantFacts(query, budget = 6000) {
  const facts = listFacts();
  const total = facts.reduce((n, f) => n + f.text.length + 4, 0);
  if (total <= budget) return facts;
  const q = words(query);
  const scored = facts.map((f) => {
    let s = 0;
    for (const w of words(f.text)) if (q.has(w)) s++;
    if (CORE.includes(f.category)) s += 3;
    return { f, s: s + f.updatedAt / 1e14 };
  }).sort((a, b) => b.s - a.s);
  const out = [];
  let used = 0;
  for (const { f } of scored) {
    if (used + f.text.length > budget) continue;
    out.push(f);
    used += f.text.length + 4;
  }
  return out;
}

export function searchFacts(query, limit = 20) {
  const q = words(query);
  return listFacts()
    .map((f) => ({ f, s: [...words(f.text)].filter((w) => q.has(w)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.f);
}

export function asText(facts) {
  const groups = {};
  for (const f of facts) (groups[f.category] ||= []).push(f.text);
  return Object.entries(groups).map(([c, list]) => `${CATEGORIES[c] || c}:\n${list.map((t) => `- ${t}`).join('\n')}`).join('\n\n');
}
