# Sistemi online: ideax va a prendere il lavoro

I tuoi programmi su internet (IDEAlab, billpro, il gestionale) non possono chiamare il PC dove gira ideax.
Allora è ideax che passa da loro: chiede "c'è qualcosa per me?", fa il lavoro sulla scheda video e rimanda
il risultato. Il PC esce verso internet come fa il browser: nessuna porta aperta, nessun tunnel.

## Collegare un sistema

In ideax: **Collega app → Sistemi online**: nome, indirizzo pubblico del sistema, chiave
(la stessa del secret `IDEAX_KEY` del sistema). Premi **Prova**. Funziona finché ideax è acceso.

## Il patto (per chi costruisce il lato del sistema)

```
GET  {url}/api/ponte/ideax/lavori?attendi=25&capacita=json,chat,genera,decorazione,vettorizza
     header: x-ideax-key, x-ideax-versione
  →  { "lavori": [ { "id": "…", "tipo": "…", "dati": { … } } ] }   (lavori già presi da ideax)

POST {url}/api/ponte/ideax/lavori/{id}
     { "ok": true, "risultato": { … }, "secondi": 12 }  oppure  { "ok": false, "errore": "…" }
```

- La GET può aspettare fino a `attendi` secondi prima di rispondere vuota (attesa lunga).
- `capacita` dice cosa sa fare ideax adesso: `json` e `chat` solo con un cervello caricato,
  `musica` con il motore musica, `voce` e `reel` con il motore voce.
- Se il sistema non vede ideax da 90 secondi, lo consideri spento e usi il suo motore di riserva.

## I lavori

| tipo | dati | risultato |
|---|---|---|
| `json` | `sistema`, `richiesta`, `schema`, `temperatura`, `maxToken` | l'oggetto JSON secondo lo schema |
| `chat` | `messaggio`, `utente`, `chat_id` | `{ chat_id, risposta, lavori, ricordati }` |
| `genera` | come `POST /v1/generate` | `{ titolo, modello, prompt, risultati: [{ tipo, base64, secondi }] }` |
| `musica` | come `POST /v1/music` | come `genera` |
| `voce` | `testo`, `voice`, `language` | come `genera` |
| `reel` | come `POST /v1/reels` | come `genera` |
| `decorazione` | `tema`, `operazione` (taglio/incisione), `larghezzaMm`, `altezzaMm`, `varianti` | `{ proposte: [{ d, w, h, svg, immagine }] }` |
| `vettorizza` | `immagine` (base64), `larghezzaMm`, `altezzaMm`, `operazione` | `{ d, w, h, svg }` |

Le decorazioni: il modello di immagini (Flux, se c'è) disegna una sagoma nera su bianco, il worker la
vettorizza con vtracer in millimetri. Per il taglio toglie le parti più sottili di 3 mm e chiude i varchi
sotto i 2 mm; per l'incisione tiene i dettagli. Le stesse funzioni sono anche nell'API locale:
`POST /v1/laser/decoration` e `POST /v1/laser/vectorize`.

Esempio completo dal lato del sistema: `PONTE_IDEAX.md` nel repository di IDEAlab.

---

## La farm: ideax capofila + ideax operai (più PC sulla stessa rete)

Lo stesso ponte serve anche fra due ideax. Un PC fa da **capofila** (Collega app → Più PC → "Rendi
questo PC il capofila"): espone esattamente queste rotte, con una **chiave della farm** sua
(`fx_…`). Gli altri PC fanno da **operai**: su ognuno, Collega app → "Collega con una chiave che hai
già" puntato all'indirizzo del capofila sulla rete locale (`http://IP:PORTA`) con quella chiave. Da lì
in poi l'operaio è un sistema come gli altri: interroga `/lavori`, esegue con la pipeline piena e
riporta il risultato. Nessun codice nuovo lato operaio.

Il capofila offre un lavoro agli operai **solo quando la sua GPU è già occupata** e c'è un operaio
online (`lib/farm.js`, `offloadable()` in `server.js`): un lavoro singolo su un sistema libero resta in
locale, come prima. La presa è atomica (un solo processo Node), quindi niente doppioni; se nessuno
prende il lavoro entro `grace` secondi, o se l'operaio cade, il capofila lo rifà da sé — mai perso.

Restano sul capofila i lavori legati ai suoi dati di macchina: voci clonate, gemello e personaggi
(LoRA locali), reel, demo dello schermo. Si distribuiscono solo i lavori che un PC con la stessa
configurazione può fare da solo: immagine/video da testo, fotomontaggio, ingrandimento, musica.
