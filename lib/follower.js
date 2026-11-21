import { cerca } from './web.js';

const PIATTAFORME = [
  ['Instagram', 'instagram.com'], ['Facebook', 'facebook.com'], ['TikTok', 'tiktok.com'],
  ['YouTube', 'youtube.com'], ['X', 'x.com'], ['LinkedIn', 'linkedin.com'], ['Threads', 'threads.net'],
];

export function profiloRichiesto(testo) {
  return String(testo).match(/^(?:conta|verifica|trova|quanti sono)\s+(?:(?:tutti|i|le|il|numero|di)\s+)*(?:follower|iscritti)\s+(?:di|della|del|per)\s+@?([\w.-]+)(?=\s|[?!]?$)/i)?.[1] || null;
}

function profiloCorrisponde(url, dominio, account) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || (u.hostname !== dominio && !u.hostname.endsWith('.' + dominio))) return false;
    const parti = u.pathname.split('/').filter(Boolean);
    const indice = dominio === 'linkedin.com' && parti[0] === 'company' ? 1 : 0;
    return parti.length === indice + 1 && parti[indice]?.replace(/^@/, '').toLowerCase() === account.toLowerCase();
  } catch { return false; }
}

function leggiConteggio(testo) {
  const m = String(testo).match(/(?:^|[\s:·–(])(\d+(?:[.,\u202f ]\d+)*)(?:\s*([KM]|mila|milioni))?\s+(?:follower(?:s)?|iscritti|subscribers)\b/i);
  if (!m) return null;
  const numero = m[1].trim();
  if (!m[2]) {
    if (!/^\d+$|^\d{1,3}(?:[.,\u202f ]\d{3})+$/.test(numero)) return null;
    const valore = Number(numero.replace(/[^\d]/g, ''));
    return Number.isSafeInteger(valore) ? { valore, stimato: false } : null;
  }
  const valore = Number(numero.replace(',', '.')) * (/^(m|milioni)$/i.test(m[2]) ? 1e6 : 1e3);
  return Number.isFinite(valore) ? { valore: Math.round(valore), stimato: true } : null;
}

async function paginaPubblica(url) {
  let pagina = new URL(url);
  const youtube = pagina.hostname === 'www.youtube.com';
  const signal = AbortSignal.timeout(7000);
  for (let i = 0; i < 3; i++) {
    const risposta = await fetch(pagina, { redirect: 'manual', signal });
    if (risposta.ok) return risposta.text();
    const next = risposta.headers.get('location');
    if (!youtube || risposta.status < 300 || risposta.status >= 400 || !next) return '';
    pagina = new URL(next, pagina);
    if (pagina.protocol !== 'https:' || !['www.youtube.com', 'consent.youtube.com'].includes(pagina.hostname)) return '';
  }
  return '';
}

export async function contaFollower(account, ricerca = cerca, leggi = paginaPubblica) {
  const sito = /^[a-z0-9-]+$/i.test(account) ? 'https://www.' + account + '.com/' : null;
  const html = sito ? await leggi(sito).catch(() => '') : '';
  const link = [...html.matchAll(/\bhref=["'](https:\/\/[^"'<> ]+)["']/gi)].map((m) => m[1]);
  for (const [, array] of html.matchAll(/"sameAs"\s*:\s*(\[[^\]]{0,8000}\])/g)) {
    try { link.push(...JSON.parse(array).filter((u) => typeof u === 'string')); } catch { /* metadati non validi */ }
  }
  const instagram = link.map((url) => url.match(/^https:\/\/(?:www\.)?instagram\.com\/([\w.-]+)\/?(?:[?#].*)?$/i)?.[1])
    .find((nome) => nome?.toLowerCase().startsWith(account.toLowerCase()));
  const esiti = await Promise.all(PIATTAFORME.map(async ([nome, dominio]) => {
    try {
      const nomi = [...new Set([account, instagram].filter(Boolean))];
      const collegamento = link.find((u) => nomi.some((n) => profiloCorrisponde(u, dominio, n)));
      const candidato = nome === 'YouTube' && instagram ? 'https://www.youtube.com/@' + instagram : null;
      const diretta = collegamento || candidato;
      if (diretta) {
        const pagina = await leggi(diretta).catch(() => '');
        const titolo = pagina.match(/<title[^>]*>(.*?)<\/title>/i)?.[1] || '';
        const titoloCorrisponde = titolo.toLowerCase().replace(/[^a-z0-9]/g, '').includes(account.toLowerCase());
        const descrizione = pagina.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i)?.[1] || '';
        const iscritti = nome === 'YouTube' ? pagina.match(/"accessibilityLabel"\s*:\s*"([^"]+\b(?:iscritti|subscribers))"/i)?.[1] : '';
        const conteggio = leggiConteggio(descrizione + ' ' + (iscritti || ''));
        if (conteggio && (collegamento || titoloCorrisponde)) return { nome, url: diretta, ...conteggio };
      }
      const r = await ricerca('site:' + dominio + ' "' + (instagram || account) + '" follower OR subscribers');
      const profilo = r.risultati.find((x) => nomi.some((n) => profiloCorrisponde(x.url, dominio, n)));
      if (!profilo && collegamento) return { nome, url: collegamento, motivo: 'conteggio assente dalla pagina pubblica' };
      if (!profilo) return { nome, motivo: r.nota || 'profilo esatto assente dai risultati' };
      const conteggio = leggiConteggio(profilo.titolo + ' ' + profilo.estratto);
      return { nome, url: profilo.url, ...conteggio, ...(conteggio ? {} : { motivo: 'conteggio assente dai risultati pubblici' }) };
    } catch {
      return { nome, motivo: 'ricerca temporaneamente indisponibile' };
    }
  }));
  const disponibili = esiti.filter((e) => e.valore != null);
  const fmt = (n) => n.toLocaleString('it-IT');
  const totale = disponibili.reduce((n, e) => n + e.valore, 0);
  return [
    'Follower di @' + account,
    ...esiti.map((e) => e.nome + ' — ' + (e.valore == null ? e.motivo : (e.stimato ? 'circa ' : '') + fmt(e.valore)) + (e.url ? ' · ' + e.url : '')),
    disponibili.length
      ? 'Somma dei conteggi pubblici trovati: ' + (disponibili.some((e) => e.stimato) ? 'circa ' : '') + fmt(totale) + ' su ' + disponibili.length + ' piattaforme. La somma può contare le stesse persone su più social. I risultati indicizzati possono essere datati.'
      : 'Nessun conteggio pubblico verificabile dai risultati di ricerca. Puoi riprovare con il nome utente esatto, preceduto da @.',
  ].join('\n');
}
