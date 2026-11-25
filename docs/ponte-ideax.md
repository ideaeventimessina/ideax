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

- La GET risponde SUBITO con la coda (`attendi=0`): dalla sveglia push (sotto) ideax non usa più l'attesa lunga.
- `capacita` dice cosa sa fare ideax adesso: `json` e `chat` solo con un cervello caricato,
  `musica` con il motore musica, `voce` e `reel` con il motore voce.

## La sveglia push: le app non vengono più interrogate a vuoto (dal 2026-11)

Prima ideax teneva aperta `GET /lavori?attendi=25` 24/7 su ogni app: in autoscale le app non scendevano
mai a zero e il database non si sospendeva (centinaia di $/mese). Ora ideax **non interroga più a vuoto**:
apre UNA sola connessione in uscita verso un canale gratuito (**ntfy.sh**) e aspetta. Quando un'app ha un
lavoro, è l'**app** a pubblicare una "sveglia"; ideax la riceve e solo allora fa `GET /lavori?attendi=0` su
quell'app, svuota la coda, consegna i risultati e torna in silenzio. A riposo: zero richieste, database
sospeso. Il canale porta solo un ping; i dati del lavoro restano sul ponte autenticato (`x-ideax-key`).

**Cosa cambia lato app (da applicare in ogni app):**

1. **Il topic** si ricava dalla chiave, uguale sui due lati, segreto come la chiave:
   `topic = "ideax-" + sha256(IDEAX_KEY esadecimale)[primi 32 caratteri]`.
2. **Pubblica una sveglia quando metti in coda un lavoro per ideax** (fire-and-forget, non bloccante):
   `POST https://ntfy.sh/<topic>` con corpo `"job"`. (Base configurabile: se ideax usa `IDEAX_NTFY_BASE`,
   l'app deve usare lo stesso host.)
3. **Disponibilità senza heartbeat** — sostituisci "ideax visto negli ultimi 90s" (`segnaContatto`) con
   **sveglia-e-attendi**: metti il lavoro in coda → pubblica la sveglia → aspetta un breve istante (≈3 s) che
   il lavoro risulti **preso** (la `GET /lavori` di ideax lo marca già come preso). Se non viene preso entro
   3 s → ideax è spento/occupato: usa la **riserva (OpenAI)**. Se viene preso → aspetta il risultato su
   `POST /lavori/{id}` fino al timeout del tipo di lavoro; se non arriva → riserva. Così l'app sa se ideax è
   disponibile **al momento del lavoro**, senza tenersi sveglia tra un lavoro e l'altro.
4. **`GET /lavori?attendi=0` deve rispondere subito**: niente ciclo di attesa che interroga il database ogni
   1,5 s. Il ramo di attesa lunga (`attendi>0`) non viene più chiamato da ideax e si può togliere.
5. **`capacita`**: memorizza l'ultimo `capacita=` ricevuto su `GET /lavori` (con un TTL ragionevole) e usalo
   per decidere se un tipo di lavoro conviene mandarlo a ideax; se non lo conosci, prova comunque (sveglia-e-
   attendi) e in caso di timeout usa la riserva.

**Ordine di applicazione:** quando ideax passa alla sveglia, finché un'app non è aggiornata vedrà ideax come
"spento" (non riceve più i poll) e userà la riserva OpenAI per quei lavori — funziona, costa solo di più su
quell'app, mentre il costo grosso (hosting + database sempre svegli) sparisce subito. Aggiorna le app una
alla volta, con calma.

## I lavori

| tipo | dati | risultato |
|---|---|---|
| `json` | `sistema`, `richiesta`, `schema`, `temperatura`, `maxToken` | l'oggetto JSON secondo lo schema |
| `chat` | `messaggio`, `utente`, `chat_id`, `soloLettura` | `{ chat_id, risposta, lavori, ricordati }` |
| `genera` | come `POST /v1/generate` | `{ titolo, modello, prompt, risultati: [{ tipo, base64, secondi }] }` |
| `musica` | come `POST /v1/music` | come `genera` |
| `voce` | `testo`, `voice`, `language` | come `genera` |
| `reel` | come `POST /v1/reels` | come `genera` |
| `decorazione` | `tema`, `operazione` (taglio/incisione), `larghezzaMm`, `altezzaMm`, `varianti` | `{ proposte: [{ d, w, h, svg, immagine }] }` |
| `vettorizza` | `immagine` (base64), `larghezzaMm`, `altezzaMm`, `operazione` | `{ d, w, h, svg }` |

`soloLettura: true` nei dati di `chat`: il cervello non vede e non può usare gli strumenti che scrivono su
GitHub (`github_scrivi_file`, `github_crea_ramo`, `github_crea_issue`, `github_commenta`, `github_crea_pr`),
anche se in ideax "Permetti modifiche" è acceso. Jarvis lo manda sempre. Senza il campo vale l'impostazione
di ideax, come per la chat locale.

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

Per un lavoro `video`, `dati.veloce: true` preferisce Wan 5B, se installato e abilitato, e usa le dimensioni di anteprima.
Per il lip-sync via `POST /v1/twin/talk`, `veloce: true` usa 8 passi. In alternativa `steps` accetta da 4 a 50 passi. Senza opzioni valgono 20 passi.

### Montatore Impagino sullo stesso PC

IDEAX cerca il blueprint `/montatore` sulle porte locali 8765 e 8080. Per una porta diversa imposta `IDEAX_MONTATORE_URL` all'avvio di IDEAX. Il montatore autonomo si avvia con `python -m montatore.webapp --port 8765`. Per il montatore locale IDEAX legge la password dal file `~/.montatore/web_password`.

Per montare da due a dodici MP4 già prodotti da IDEAX, invia a `POST /v1/catena` un `prompt` come titolo e `clip_urls` con i relativi percorsi `/outputs/…mp4`. Imposta `audio_originale: true` per la sequenza con l'audio delle clip. Con `draft_capcut: false` chiedi soltanto l'MP4. L'endpoint restituisce l'ID del lavoro e lo stato si legge da `GET /v1/jobs/{id}`.
