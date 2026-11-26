/* Questo codice è stato progettato, scritto e generato da Andrea Gentile C.f GNTNDR88S28F158M */
// LA POSTA INTERNA — in sola lettura. ideax la chiede a Bill con la chiave del ponte che ha già (nessuna chiave
// nuova); Bill la chiede al gestionale. Si legge soltanto: niente invii, niente «segna come letta».
// La si mostra SOLO alla pagina aperta su questo PC (vedi server.js).

const E_BILL = /billpro|bill-so/i;

export function ponteDiBill(sistemi = []) {
  return sistemi.find((s) => s.enabled !== false && s.key && E_BILL.test(s.url || '')) || null;
}

export async function leggiPosta(sistemi, { percorso = '/api/ponte/ideax', chiedi = fetch } = {}) {
  const bill = ponteDiBill(sistemi);
  if (!bill) return { configurata: false };
  try {
    const res = await chiedi(`${bill.url}${bill.path || percorso}/posta`, {
      headers: { 'x-ideax-key': bill.key }, redirect: 'error', signal: AbortSignal.timeout(25_000),
    });
    const dati = await res.json().catch(() => null);
    if (res.ok && dati && Array.isArray(dati.mail)) return { configurata: true, nonLette: Number(dati.nonLette) || 0, mail: dati.mail };
    if (res.status === 404 && !dati) return { configurata: true, errore: 'Bill non è ancora aggiornato: va ripubblicato.' };
    if (res.status === 401) return { configurata: true, errore: 'Bill rifiuta la chiave del ponte: controlla IDEAX_KEY in «Collega app».' };
    return { configurata: true, errore: (dati && typeof dati.error === 'string' && dati.error) || 'La posta non risponde: riprova.' };
  } catch {
    return { configurata: true, errore: 'Non riesco a raggiungere Bill: riprova.' };
  }
}
