# Creare reel con ideax da un altro sistema (es. billpro)

ideax trasforma un piano di scene in un reel verticale pronto per Instagram e TikTok:
voce clonata, immagini, musica di sottofondo, sottotitoli sincronizzati, MP4 1080×1920.

Il sistema che prepara il contenuto (testo, cosa mostrare, didascalia) manda il **piano**;
ideax lo esegue così com'è, senza riscriverlo.

## Indirizzo e autenticazione

- Indirizzo: quello mostrato in ideax → **Collega app** (es. `http://192.168.1.10:7800`).
- Dallo stesso PC non serve nulla. Da un altro computer: intestazione `Authorization: Bearer <chiave>`,
  con una chiave creata in **Collega app → Chiavi API** (una per sistema, es. "billpro").

## Richiesta

`POST /v1/reels`

```json
{
  "plan": {
    "title": "Nuovo menu autunnale",
    "scenes": [
      { "text": "Da oggi il nostro menu autunnale è servito.", "visual": "autumn dishes on a rustic wooden table, warm light" },
      { "text": "", "image": "https://esempio.it/foto-piatto.jpg", "duration": 2 },
      { "text": "Prenota il tuo tavolo al link in bio!", "visual": "cozy restaurant interior with candles" }
    ],
    "music": "warm acoustic guitar, upbeat, 105 BPM",
    "caption": "Il menu autunnale è arrivato",
    "hashtags": ["autunno", "menu", "ristorante"]
  },
  "voice": "Marco",
  "style": "cinematic food photography, shallow depth of field",
  "callback_url": "https://billpro.example/ideax/webhook",
  "metadata": { "cliente": 42, "campagna": "autunno" }
}
```

### Le scene

| Campo | Significato |
|---|---|
| `text` | la frase letta dalla voce in quella scena; vuota = scena muta |
| `visual` | cosa si vede, **meglio in inglese**, concreto (soggetto, ambiente, luce). ideax genera l'immagine verticale |
| `image` | in alternativa a `visual`: un'immagine già pronta (URL, data URI o base64), es. la foto vera del prodotto |
| `duration` | durata minima in secondi (serve alle scene mute; per le altre la durata la decide la voce) |

Consigli per un buon risultato:
- 1–2 frasi brevi per scena; la prima è l'aggancio (domanda, numero, affermazione forte), l'ultima l'invito all'azione.
- Circa 2,5 parole al secondo: un reel da 30 secondi sono ~75 parole in 5–7 scene.
- Uno stile visivo unico in `style`, così tutte le immagini sembrano dello stesso servizio fotografico.
- Niente testo dentro le immagini: i sottotitoli li aggiunge ideax.

### Altri campi

| Campo | Default | Significato |
|---|---|---|
| `voice` | la voce più recente | nome o id della voce clonata; `false` = senza voce, solo sottotitoli |
| `music` | `true` | `true` usa `plan.music`; una stringa la sostituisce; `false` = niente musica |
| `musicVolume` | `0.18` | volume della musica sotto la voce |
| `captions` | `true` | sottotitoli grandi sincronizzati |
| `style` | — | stile visivo aggiunto a tutte le immagini generate |
| `model` | scelto da ideax | modello di immagini da usare (nome o id da `GET /v1/models`) |
| `callback_url` | — | webhook chiamato a reel finito |
| `metadata` | — | dati vostri, restituiti nel risultato e nel webhook |

In alternativa al piano si può mandare solo `script` (il testo intero, ideax lo divide in scene)
oppure solo `prompt` (l'argomento: il cervello di ideax scrive tutto).

## Risposta

Subito `202`:

```json
{ "id": "a1b2c3d4", "status": "queued", "status_url": "http://192.168.1.10:7800/v1/jobs/a1b2c3d4" }
```

Un reel richiede qualche minuto (voce, immagini e musica sulla scheda video). A lavoro finito ideax chiama il
`callback_url` con `{"event": "job.completed", "data": { … }}` (o `job.failed`), firmato in `X-Ideax-Signature`
(HMAC-SHA256 del corpo con il segreto dei webhook, in **Collega app**). Senza webhook: `GET /v1/jobs/{id}`.

Il risultato (`data`) contiene:

```json
{
  "id": "a1b2c3d4",
  "status": "done",
  "title": "Nuovo menu autunnale",
  "results": [
    { "url": "http://…/outputs/a1b2c3d4-reel-9f3e.mp4", "type": "video/mp4", "seconds": 14.2 },
    { "url": "http://…/outputs/a1b2c3d4-reel-9f3e-copertina.png", "type": "image/png", "role": "cover" },
    { "url": "http://…/outputs/a1b2c3d4-reel-9f3e.srt", "type": "application/x-subrip", "role": "subtitles" }
  ],
  "reel": { "title": "…", "caption": "…", "hashtags": ["…"], "scenes": [{ "text": "…", "visual": "…" }], "music": "…" },
  "metadata": { "cliente": 42, "campagna": "autunno" }
}
```

I file si scaricano con la stessa chiave (`Authorization: Bearer …` oppure `?key=…`).
La specifica completa è in `GET /v1/openapi.json`.
