// Il cervello va online: cerca sul web e legge le pagine. Niente chiavi API — la ricerca passa da DuckDuckGo
// (la versione HTML, senza JavaScript), la lettura scarica la pagina e ne tira fuori il testo. Gira sul PC, che
// esce verso internet come un browser. User-Agent generico: nessun dato personale dell'utente esce di qui.
const UA = 'Mozilla/5.0 (compatible; ideax/1.0; +local)';

function entita(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function senzaTag(html) {
  return entita(String(html).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// DuckDuckGo avvolge i link in /l/?uddg=<indirizzo vero>: lo srotoliamo.
function indirizzoVero(href) {
  try {
    const u = new URL(href, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) return uddg;
    return /^https?:/.test(href) ? href : null;
  } catch { return null; }
}

export async function cerca(query, { max = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('manca cosa cercare');
  // L'endpoint "lite" di DuckDuckGo: HTML semplice, POST con q. Molto più affidabile della versione piena.
  const res = await fetch('https://lite.duckduckgo.com/lite/', {
    method: 'POST',
    headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'text/html', 'Accept-Language': 'it-IT,it;q=0.9' },
    body: new URLSearchParams({ q }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`la ricerca non ha risposto (HTTP ${res.status})`);
  const html = await res.text();
  // href="indirizzo" … class='result-link' (apici singoli o doppi, href prima della classe). URL diretto.
  const link = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>/gi)];
  const snip = [...html.matchAll(/class=['"]result-snippet['"][^>]*>([\s\S]*?)(?=<\/td>|<td|<tr|<\/tr)/gi)].map((m) => senzaTag(m[1]));
  const risultati = [];
  for (let i = 0; i < link.length && risultati.length < max; i++) {
    const url = indirizzoVero(link[i][1]);
    if (!url) continue;
    risultati.push({ titolo: senzaTag(link[i][2]), url, estratto: snip[i] || '' });
  }
  if (!risultati.length) {
    const limitata = /anomaly|challenge|unusual traffic/i.test(html);
    return { query: q, risultati: [], nota: limitata ? 'la ricerca è stata limitata (troppe richieste): riprova tra un momento' : 'nessun risultato: prova parole diverse' };
  }
  return { query: q, risultati };
}

export async function apri(url, { max = 6000 } = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('indirizzo non valido: deve iniziare con http:// o https://');
  const res = await fetch(u, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Accept-Language': 'it-IT,it;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`la pagina non si apre (HTTP ${res.status})`);
  const tipo = res.headers.get('content-type') || '';
  const grezzo = await res.text();
  if (!/html|xml|text/.test(tipo)) return { url: res.url, tipo, nota: 'non è una pagina di testo: non la leggo' };
  const titolo = senzaTag((grezzo.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const corpo = senzaTag(grezzo
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '));
  const tagliato = corpo.length > max;
  return { url: res.url, titolo, testo: corpo.slice(0, max) + (tagliato ? ' …(pagina più lunga, troncata)' : ''), tagliato };
}
