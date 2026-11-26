// Sveglia push: invece di tenere aperta una richiesta sulle app 24/7 (che le teneva sveglie e costava centinaia di $),
// ideax apre UNA sola connessione in USCITA verso un canale gratuito (ntfy.sh) e aspetta. Quando un'app ha un lavoro,
// è l'APP a pubblicare una "sveglia" sul canale; ideax la riceve e solo allora va a prendere il lavoro da quell'app.
// A riposo: zero richieste alle app, zero database svegli. Nessuna porta aperta sul PC (è una connessione in uscita).
//
// Il canale di ogni app si ricava dalla chiave del ponte (IDEAX_KEY), quindi le due parti lo calcolano da sole senza
// configurare nient'altro, ed è segreto come la chiave. ntfy porta solo un "ping": i dati del lavoro continuano a
// viaggiare sul ponte autenticato (x-ideax-key), non su ntfy.
import crypto from 'node:crypto';

export const base = () => (process.env.IDEAX_NTFY_BASE || 'https://ntfy.sh').replace(/\/+$/, '');

// Il topic di un'app = "ideax-" + sha256(chiave). Deterministico e segreto: l'app lo calcola uguale dalla sua IDEAX_KEY.
export function topicPer(chiave) {
  return 'ideax-' + crypto.createHash('sha256').update(String(chiave || '')).digest('hex').slice(0, 32);
}

let corrente = null;

// Apre lo stream NDJSON di ntfy su più topic in una sola connessione. onWake(topic, messaggio) a ogni sveglia.
// Si riconnette da sola; alla riconnessione riparte da "since=<ultimo id>" così non perde le sveglie durante un calo.
export function avvia(topics, onWake, { onStato } = {}) {
  stop();
  const lista = [...new Set(topics)].filter(Boolean);
  if (!lista.length) return;
  const stato = { aborted: false, ac: null, ultimoId: null };
  corrente = stato;

  (async function run() {
    let backoff = 2000;
    while (!stato.aborted) {
      const ac = new AbortController();
      stato.ac = ac;
      try {
        // Prima connessione: una finestra breve all'indietro (30s), così una sveglia pubblicata appena prima che ideax
        // partisse non va persa — senza bussare alle app. Riconnessione: da dopo l'ultimo id ricevuto (niente sveglie perse).
        const since = stato.ultimoId ? `?since=${encodeURIComponent(stato.ultimoId)}` : '?since=30s';
        const res = await fetch(`${base()}/${lista.join(',')}/json${since}`, { headers: { Accept: 'application/x-ndjson' }, signal: ac.signal });
        if (!res.ok || !res.body) throw new Error(`ntfy HTTP ${res.status}`);
        onStato?.({ connesso: true });
        backoff = 2000;
        let buf = '';
        for await (const chunk of res.body) {
          buf += Buffer.from(chunk).toString('utf8');
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const riga = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!riga) continue;
            let m;
            try { m = JSON.parse(riga); } catch { continue; }
            if (m.id) stato.ultimoId = m.id;
            // ntfy manda anche "open" e "keepalive": la sveglia vera è event "message".
            if (m.event === 'message' && m.topic) { try { onWake(m.topic, m); } catch { /* una sveglia non deve rompere lo stream */ } }
          }
          if (stato.aborted) break;
        }
      } catch (err) {
        if (!stato.aborted) onStato?.({ connesso: false, errore: err.message });
      }
      if (stato.aborted) break;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60_000);
    }
  })();
}

export function stop() {
  if (corrente) {
    corrente.aborted = true;
    try { corrente.ac?.abort(); } catch { /* già chiusa */ }
    corrente = null;
  }
}

export function attiva() { return !!corrente && !corrente.aborted; }

// Pubblica una sveglia (usata nei test e disponibile se un giorno ideax deve svegliare sé stesso).
export async function pubblica(topic, testo = 'job') {
  const res = await fetch(`${base()}/${topic}`, { method: 'POST', body: testo, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ntfy publish HTTP ${res.status}`);
  return true;
}
