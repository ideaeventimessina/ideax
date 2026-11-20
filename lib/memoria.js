// La memoria eterna, lato Node: parla col motore nel worker (worker/memoria.py), che tiene il database vettoriale
// ChromaDB in locale. Qui c'è solo l'instradamento. Best-effort: se il worker è spento o la memoria non è disponibile,
// torna { ok:false, motivo } e NON rompe il flusso — ideax lavora lo stesso, solo senza ricordare/ricavare.
import { getSettings } from './store.js';

async function chiama(rotta, corpo) {
  const base = getSettings().workerUrl;
  if (!base) return { ok: false, motivo: 'il motore non è configurato' };
  try {
    const r = await fetch(base + rotta, {
      method: corpo ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
      // il primo uso scarica il modello di embedding (~80 MB): diamo tempo
      signal: AbortSignal.timeout(180_000),
    });
    return await r.json().catch(() => ({ ok: false, motivo: `HTTP ${r.status}` }));
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

// Archivia un ricordo. ambito: 'tech_core' | 'creative_assets' | null (lo decide dal contesto).
export const ricorda = (testo, { ambito = null, metadati = {}, id = null } = {}) =>
  chiama('/memoria/ricorda', { testo, ambito, metadati, id });

// Ritrova i ricordi più vicini per significato. ambito null → sceglie la collezione dal contesto (o tutte e due).
export const ricava = (query, { ambito = null, quanti = 4 } = {}) =>
  chiama('/memoria/ricava', { query, ambito, quanti });

export const stato = () => chiama('/memoria/stato');

// Comodità: ricorda SENZA mai far fallire chi la chiama (per gli agganci automatici). Logga e prosegue.
export async function ricordaSilenzioso(testo, opts = {}) {
  try {
    const r = await ricorda(testo, opts);
    if (!r.ok) console.log(`[memoria] non ricordato (${r.motivo})`);
    return r;
  } catch (err) {
    console.log(`[memoria] non ricordato (${err.message})`);
    return { ok: false, motivo: err.message };
  }
}
