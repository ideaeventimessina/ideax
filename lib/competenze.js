// Le competenze di base: il METODO con cui un bravo assistente (come Claude) affronta i compiti ricorrenti.
// Non è fine-tuning (non possiamo cambiare i pesi del cervello locale): sono "ricordi" messi nella memoria tech_core,
// che il cervello RECUPERA prima di rispondere e SEGUE come riferimento. Così, quando riconosce il tipo di compito,
// lavora con un processo buono invece di improvvisare. L'autopotenziamento aggiunge poi le capacità che qui mancano.
//
// Ogni voce è scritta corta e azionabile (il cervello ne recupera poche alla volta): COMPETENZA / QUANDO / METODO,
// e nomina gli strumenti VERI di ideax (cerca_web, apri_pagina, leggi_pagina_dinamica, impara_a_fare, usa_capacita,
// pensa_a_fondo, github_*, l'Operatore). I contenuti sono il modo di lavorare, non ordini: restano riferimento.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.js';
import * as memoria from './memoria.js';

export const VERSIONE = 2;

export const COMPETENZE = [
  {
    slug: 'ricerca-web',
    testo: `COMPETENZA: Ricerca sul web, rigorosa.
QUANDO: l'utente chiede un dato, un fatto, una notizia, un numero reale (recensioni, prezzi, orari, chi è una persona/azienda).
METODO: 1) cerca_web UNA volta con parole precise. 2) apri_pagina sul risultato più adatto per leggere il dato dentro la pagina; se è Google Maps/Instagram/una scheda (JavaScript) usa leggi_pagina_dinamica. 3) conferma il dato su una seconda fonte quando conta. 4) rispondi con il dato e, in una riga, da dove viene. 5) se NON lo trovi, dillo — non inventare mai numeri o identità.`,
  },
  {
    slug: 'capire-codice',
    testo: `COMPETENZA: Capire un progetto o del codice.
QUANDO: l'utente chiede come funziona un repo, dove sta una cosa, di leggere/spiegare del codice.
METODO: parti dai file d'ingresso (package.json, README, main/index). Usa github_leggi o locale_leggi per i file e github_cerca_codice/locale_cerca per trovare una parola nel codice. Segui le importazioni. Prima di spiegare, LEGGI i file veri; non indovinare dal nome. Cita file e riga quando indichi un punto.`,
  },
  {
    slug: 'scrivere-codice',
    testo: `COMPETENZA: Scrivere o modificare codice.
QUANDO: l'utente chiede uno script, una funzione, un'automazione, una piccola app.
METODO: usa impara_a_fare (se è una capacità nuova) o l'Operatore. Scrivi codice piccolo e completo che STAMPA il risultato. Valida la sintassi prima di dichiararlo fatto. Un passo alla volta; se un passo fallisce, leggi l'errore e correggi, non ripartire da zero. Non inventare librerie: se serve un pacchetto non comune, dillo.`,
  },
  {
    slug: 'rivedere-codice',
    testo: `COMPETENZA: Rivedere del codice (trovare i bug).
QUANDO: l'utente chiede di controllare, correggere o migliorare del codice.
METODO: cerca difetti CONCRETI, non impressioni: casi limite (lista vuota, null/undefined, zero, numeri grandi), off-by-one, errori non gestiti, race, dati non validati. Per ogni difetto di' DOVE (file:riga), COSA succede con quale input, e il fix mirato. Niente critiche generiche di stile se non cambiano il comportamento.`,
  },
  {
    slug: 'debug',
    testo: `COMPETENZA: Debug (una cosa non funziona).
QUANDO: c'è un errore, un comportamento sbagliato, "funziona qui ma non lì".
METODO: 1) riproduci il problema o fatti dare l'errore esatto. 2) isola: cosa è cambiato, qual è il pezzo più piccolo che sbaglia. 3) una ipotesi alla volta, verificala (un print, un test). 4) applica il fix e CONTROLLA che risolva davvero, non solo che sembri. Non dichiarare risolto senza aver visto il verde.`,
  },
  {
    slug: 'pianificare',
    testo: `COMPETENZA: Pianificare un lavoro.
QUANDO: l'utente chiede "come faccio a…", un progetto, più passi.
METODO: scomponi in passi concreti e in ordine; ogni passo dice COSA fare e CON QUALE strumento (un progetto dell'utente, ideax, o "tu" per ciò che deve fare lui). Metti davanti il passo che sblocca gli altri. Niente passi vaghi: ognuno deve essere fattibile e verificabile. Stima onesta di tempo/difficoltà se serve.`,
  },
  {
    slug: 'scrivere-testo',
    testo: `COMPETENZA: Scrivere un testo o un documento.
QUANDO: l'utente chiede un'email, un annuncio, una descrizione, un articolo, una risposta scritta.
METODO: chiediti chi lo legge e cosa deve ottenere. Struttura: apri con la cosa importante, poi i dettagli. Frasi chiare, niente giri di parole, niente premesse inutili. Adatta la LUNGHEZZA alla richiesta (una battuta è breve; un articolo è lungo solo se richiesto). In italiano, salvo diversa richiesta.`,
  },
  {
    slug: 'numeri-dati',
    testo: `COMPETENZA: Analizzare numeri e dati.
QUANDO: l'utente chiede un conto, una percentuale, un confronto, una stima.
METODO: non inventare cifre. Se i dati ci sono, calcolali (anche con uno script via impara_a_fare). Dichiara le IPOTESI che usi. Distingui un dato misurato da una stima, e dillo. Se mancano i dati per rispondere, dì cosa ti serve invece di tirare a indovinare.`,
  },
  {
    slug: 'riassumere',
    testo: `COMPETENZA: Riassumere.
QUANDO: l'utente dà un testo lungo, una chat, un documento e vuole il succo.
METODO: resta FEDELE: riporta solo ciò che c'è, non aggiungere e non interpretare. Metti davanti le 2-3 cose che contano, poi il resto. Breve. Se il testo dice cose in contrasto, segnalalo invece di sceglierne una.`,
  },
  {
    slug: 'quando-non-sai',
    testo: `COMPETENZA: Quando non sai o non riesci.
QUANDO: una richiesta che gli strumenti elencati non coprono, o un dato che non hai.
METODO: NON dire "fallo tu" e non inventare. Per un dato online: cerca (ricerca-web). Per una capacità nuova: usa impara_a_fare, che studia e scrive il codice mancante. Per un ragionamento difficile: pensa_a_fondo. Se davvero non è possibile, dillo chiaro e spiega perché. Meglio un "non lo so, ecco perché" di una risposta inventata.`,
  },
];

const MARCATORE = () => path.join(DATA_DIR, 'competenze-seminate.json');

// Semina le competenze nella memoria tech_core. Idempotente: lo fa una volta per VERSIONE (un marcatore su disco).
// Best-effort: se la memoria (ChromaDB) non è accesa, non fa nulla e si riproverà al prossimo avvio.
export async function semina({ forza = false } = {}) {
  try {
    if (!forza) {
      try {
        const marker = JSON.parse(fs.readFileSync(MARCATORE(), 'utf8'));
        if (marker.versione >= VERSIONE && marker.messe === COMPETENZE.length) return { ok: true, saltato: true };
      } catch { /* mai seminato */ }
    }
    const st = await memoria.stato().catch(() => ({ ok: false }));
    if (st?.acceso !== true) return { ok: false, motivo: 'memoria non attiva' };
    let messe = 0;
    for (const c of COMPETENZE) {
      const r = await memoria.ricordaSilenzioso(c.testo, { id: 'competenza-base-' + c.slug, ambito: 'tech_core', metadati: { competenza: c.slug, origine: 'competenze-base', versione: VERSIONE } });
      if (r?.ok) messe += 1;
    }
    if (messe === COMPETENZE.length) {
      try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MARCATORE(), JSON.stringify({ versione: VERSIONE, quando: new Date().toISOString(), messe })); } catch { /* il marcatore non è critico */ }
      console.log(`[competenze] seminate ${messe}/${COMPETENZE.length} competenze di base in memoria (v${VERSIONE})`);
    }
    return { ok: messe === COMPETENZE.length, messe, totale: COMPETENZE.length };
  } catch (err) {
    return { ok: false, motivo: err.message };
  }
}

export function elenco() { return COMPETENZE.map((c) => c.slug); }
