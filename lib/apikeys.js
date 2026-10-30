// Chiavi API: una per ogni sistema che usa ideax. Si salva solo l'impronta (SHA-256):
// la chiave completa si vede una volta sola, quando viene creata.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getSettings, saveSettings } from './store.js';

const FILE = path.join(DATA_DIR, 'apikeys.json');
const hash = (key) => crypto.createHash('sha256').update(key).digest('hex');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return []; }
}

function save(keys) {
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(keys, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

const publicKey = ({ hash: _h, ...k }) => k;

export function listKeys() {
  // Gli utilizzi più recenti stanno ancora in memoria: li uniamo a quelli salvati
  const live = new Map((cache.keys || []).map((k) => [k.id, k]));
  return load().map((k) => publicKey(live.has(k.id) ? { ...k, lastUsedAt: live.get(k.id).lastUsedAt, uses: live.get(k.id).uses } : k));
}

export function createKey(name) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Dai un nome alla chiave, ad esempio il nome del sistema che la userà');
  const key = `ideax_sk_${crypto.randomBytes(24).toString('base64url')}`;
  const entry = { id: crypto.randomUUID().slice(0, 8), name: clean, prefix: key.slice(0, 14), hash: hash(key), createdAt: Date.now(), lastUsedAt: null, uses: 0 };
  save([...load(), entry]);
  cache.keys = null;
  return { ...publicKey(entry), key };
}

export function revokeKey(id) {
  if (cache.keys && dirty) save(cache.keys), dirty = false;
  save(load().filter((k) => k.id !== id));
  cache.keys = null;
}

// Uso registrato in memoria e salvato al massimo ogni 30 secondi
let dirty = false;
const cache = { keys: null, at: 0 };
setInterval(() => {
  if (dirty && cache.keys) { save(cache.keys); dirty = false; }
}, 30000).unref();

export function flushKeys() {
  if (dirty && cache.keys) { save(cache.keys); dirty = false; }
}

export function verifyKey(key) {
  if (!key) return null;
  if (!cache.keys || Date.now() - cache.at > 5000) cache.keys = load(), cache.at = Date.now();
  const h = hash(key);
  const found = cache.keys.find((k) => k.hash.length === h.length && crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(h)));
  if (!found) return null;
  found.lastUsedAt = Date.now();
  found.uses = (found.uses || 0) + 1;
  dirty = true;
  return publicKey(found);
}

// La chiave può arrivare come "Authorization: Bearer …", "X-API-Key: …" o "?key=…"
export function keyFromRequest(req, url) {
  const auth = req.headers.authorization || '';
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return req.headers['x-api-key'] || url.searchParams.get('key') || '';
}

// Segreto con cui ideax firma i webhook: creato al primo uso
export function webhookSecret() {
  const s = getSettings();
  if (s.api?.webhookSecret) return s.api.webhookSecret;
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  saveSettings({ api: { ...(s.api || {}), webhookSecret: secret } });
  return secret;
}

export function rotateWebhookSecret() {
  const s = getSettings();
  const secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
  saveSettings({ api: { ...(s.api || {}), webhookSecret: secret } });
  return secret;
}
