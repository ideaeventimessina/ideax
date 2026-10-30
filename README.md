# ideax

Un server sul tuo PC che fa girare i modelli AI di **immagini, video e animazioni** che scarichi (Civitai, Hugging Face)
e li mette a disposizione di **tutte le tue applicazioni** con un'unica API.
Niente API a pagamento: niente costi a chiamata, niente attese di servizi esterni, i file restano sul tuo computer.

- **Drag & drop dei modelli**: trascini un `.safetensors` nella pagina e ideax capisce da solo cos'è
  (SD 1.5, SDXL/Pony/Illustrious, Flux, SD3, LoRA, modulo AnimateDiff) e lo collega.
- **Instradamento automatico**: scrivi cosa vuoi; ideax capisce il compito (generare, modificare, animare…),
  sceglie il modello e le LoRA adatte e restituisce il risultato.
- **Cervello locale**: il modello che interpreta i prompt è anch'esso sul tuo PC (un file `.gguf`, oppure Ollama/LM Studio).
  Senza, usa regole integrate.
- **Una API per tutte le app**: `POST /v1/generate`, più un endpoint compatibile con le librerie OpenAI.

```
 le tue app ──►  ideax (Node, porta 7800)  ──►  worker Python (porta 7861): diffusers + llama.cpp sulla GPU
   browser        interfaccia, modelli,      └►  ComfyUI / Automatic1111 / Forge già installati (facoltativi)
                  instradamento, API
```

## Requisiti

- Windows 10/11 a 64 bit (oppure Linux/macOS, vedi sotto)
- Una GPU NVIDIA con driver aggiornato (consigliati 8 GB di VRAM o più; SDXL sta bene con 8–12 GB,
  Flux e i modelli video ne vogliono di più). Senza GPU funziona, ma è molto lento.
- Circa 6 GB liberi per il motore, più lo spazio per i modelli

## Installazione su Windows

1. Scarica **`ideax-setup-X.Y.Z.exe`** dall'ultimo [rilascio](https://github.com/ideaeventimessina/ideax/releases/latest) e aprilo.
   Avanti → Installa. Non servono permessi di amministratore.
2. Apri ideax dal menu Start o dal desktop. Si apre il browser su http://localhost:7800.
3. Nella guida **Primi passi** premi **Installa il motore**: ideax scarica da solo un Python portatile e
   PyTorch nella versione adatta alla tua scheda video (CUDA 12.8 per i driver recenti e le RTX 50, 12.4 o 12.1
   per i driver più vecchi). Una volta sola.
4. Trascina un modello di Civitai nella pagina e crea.

Non serve installare Node.js né Python.

> Windows SmartScreen può avvisare che il programma non è firmato: "Ulteriori informazioni" → "Esegui comunque".
> La finestra nera che si apre con ideax va lasciata aperta: chiudendola ideax si ferma.

### Aggiornamenti

ideax controlla da solo se c'è una versione nuova. Quando c'è, compare **"Aggiorna ora"**: un clic e ideax si chiude,
si aggiorna e si riapre. Puoi controllare anche da **Impostazioni → Programma e aggiornamenti**.

### Dove stanno i file

| Cosa | Dove | Aggiornamenti |
|---|---|---|
| Il programma | `C:\Users\<tu>\AppData\Local\Programs\ideax` | sostituito a ogni aggiornamento |
| I tuoi dati: modelli, creazioni, impostazioni, motore Python | `C:\Users\<tu>\ideax` | mai toccati |

In Impostazioni c'è il pulsante **Apri la cartella dei dati**.
Se usavi la versione portatile, al primo "Aggiorna ora" ideax si installa e continua a usare la vecchia cartella
per i tuoi dati, senza spostare niente.

### Disinstallare

Impostazioni di Windows → **App** → **App installate** → ideax → **Disinstalla**.
Ti chiede se eliminare anche i tuoi dati (modelli e creazioni): scegli No per tenerli.

### Versione portatile

C'è anche `ideax-portatile-windows.zip`: si estrae e si avvia `ideax.exe`, senza installazione.
I dati restano nella stessa cartella.

## Installazione su Linux / macOS (dal codice)

Serve [Node.js](https://nodejs.org) 18+ e [Python](https://python.org) 3.10–3.12.

```bash
./install.sh
```

```bash
./start.sh
```

## Pubblicare una nuova versione

1. Aumenta `version` in `package.json` (es. `1.2.0`) e scrivi le novità in `build/NOVITA.md`.
2. Fai il commit e il push su `main`.

GitHub Actions vede la nuova versione, costruisce `ideax-setup-1.2.0.exe` e la versione portatile e li pubblica
in un nuovo rilascio `v1.2.0` ([.github/workflows/release.yml](.github/workflows/release.yml)).
Gli ideax installati lo vedono e propongono "Aggiorna ora". Si può avviare anche a mano dalla scheda Actions.

Gli aggiornamenti leggono i rilasci di GitHub senza password, quindi **il repository deve essere pubblico**
(oppure i rilasci vanno pubblicati in un repository pubblico separato, da indicare in
Impostazioni → Programma e aggiornamenti → Opzioni avanzate).

Per costruire tutto in locale (serve NSIS, `apt install nsis` su Linux):

```bash
npm install
```

```bash
npm run build:exe
```

> La prima volta che usi un checkpoint singolo, diffusers scarica una sola volta i file di configurazione
> (pochi MB, gratuiti) da Hugging Face. Per i checkpoint Flux che contengono solo il "transformer" scarica una volta
> anche VAE ed encoder di testo dal modello base `black-forest-labs/FLUX.1-schnell` (cambiabile con `IDEAX_FLUX_BASE`).
> Dopo, tutto funziona offline.

## Collegare i modelli

Vai su **Modelli** e trascina i file. Vengono copiati in `models/` e smistati in sottocartelle:

| Cosa scarichi | Diventa | Serve a |
|---|---|---|
| Checkpoint SD 1.5, SDXL, Pony, Illustrious, Flux, SD3 | Modello | generare e modificare immagini |
| LoRA | LoRA | applicare uno stile/personaggio ai modelli della stessa architettura |
| Motion module AnimateDiff (es. `mm_sd_v15_v2`) | Modulo di movimento | dare ai modelli SD 1.5 la capacità di fare animazioni/GIF |
| Modello `.gguf` (es. Qwen2.5 3B/7B Instruct) | Cervello | interpretare i prompt |
| Cartelle diffusers (con `model_index.json`), es. modelli video Wan, LTX, CogVideoX, Stable Video Diffusion | Modello | video da testo, da immagine, animazioni |

Hai già i modelli in Automatic1111 o ComfyUI? In **Impostazioni → Altre cartelle di modelli** aggiungi quelle cartelle:
ideax li usa dove sono, senza copiarli.

Per ogni modello puoi impostare (pulsante **Modifica**):
- **descrizione** e **priorità**: aiutano a scegliere tra modelli che fanno la stessa cosa (es. "realistico", "anime");
- per le **LoRA**: le parole chiave (trigger). Quando compaiono nel prompt la LoRA si attiva da sola; oppure "sempre attiva";
- **parametri predefiniti**, ad esempio `{"num_inference_steps": 30, "guidance_scale": 6, "width": 832, "height": 1216}`.

## Il cervello (facoltativo ma consigliato)

Il cervello legge il prompt, sceglie modello e LoRA e lo riscrive nel formato che il modello capisce meglio.
Ci sono due modi per tenerlo in locale:

1. **File `.gguf`** trascinato in ideax. Va installato llama.cpp nel worker, una volta sola:

   ```bash
   pip install llama-cpp-python --extra-index-url https://abetlen.github.io/llama-cpp-python/whl/cu124
   ```

   Un modello piccolo come *Qwen2.5-3B-Instruct Q4_K_M* (circa 2 GB) basta e lascia VRAM ai modelli di immagini.
   Se la VRAM è poca: `IDEAX_LLM_GPU_LAYERS=0` lo fa girare sulla CPU.
2. **Ollama o LM Studio** già installati: in Impostazioni scegli "Server locale" e indica il modello (es. `qwen2.5:7b`).

Se il cervello non c'è o non risponde, ideax usa le regole integrate (parole chiave in italiano e inglese + allegati).

### Conversare con ideax

Lo **Studio** si apre su una chat: ideax parla con te, si ricorda di te in tutte le chat (pagina **Cervello → Cosa so di te**)
e usa i suoi strumenti: crea immagini, video, voce, musica e reel, cerca nelle altre chat, legge, scarica e (se lo permetti)
modifica i tuoi repository GitHub, e fa domande ad altri cervelli collegati (es. Axel).
Per conversare bene serve un modello più grande di quello per il solo instradamento: consigliato **Qwen3 14B Q4_K_M** (circa 9 GB)
oppure **Qwen3 8B** (circa 5 GB). Con 16 GB di scheda video il cervello si scarica quando crei immagini o video e si ricarica alla chat dopo.

Addestramento rapido (pagina Cervello): intervista, testi e documenti da cui imparare, lezione da un altro cervello.
Come collegare Axel: [docs/cervello.md](docs/cervello.md). I dati stanno in `data/cervello` (ricordi e chat) e `data/repository` (repository scaricati).

## Collegare le app e i vostri sistemi

Tutti i sistemi usano lo stesso indirizzo. La pagina **Collega app** mostra l'indirizzo giusto, gli esempi pronti
e la gestione di chiavi e webhook. La specifica completa è in `/v1/openapi.json` (si importa in Postman, Insomnia, Swagger).

### Autenticazione

- **Dallo stesso PC** non serve nulla.
- **Da altri computer o server**: attiva *Impostazioni → Accesso dalla rete locale*, riavvia ideax e crea una
  **chiave API** per ogni sistema in *Collega app* (la chiave si vede una volta sola; si può revocare quando vuoi).
  Va inviata come `Authorization: Bearer <chiave>`, oppure `X-API-Key: <chiave>`, oppure `?key=<chiave>` (comodo per scaricare i file).

### Generare

```bash
curl http://192.168.1.10:7800/v1/generate \
  -H "Authorization: Bearer ideax_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Logo minimal di una volpe arancione", "params": {"aspect": "1:1", "seed": 42}}'
```

Con un file da modificare o animare (multipart, come la maggior parte dei sistemi):

```bash
curl http://192.168.1.10:7800/v1/generate \
  -H "Authorization: Bearer ideax_sk_..." \
  -F prompt="Metti questa foto su una spiaggia al tramonto" \
  -F files=@foto.jpg \
  -F 'metadata={"ordine": "A-17"}'
```

Campi di `POST /v1/generate`:

| Campo | Significato |
|---|---|
| `prompt` | cosa vuoi, in italiano o inglese (obbligatorio) |
| `task` | `image_generate`, `image_edit`, `image_to_video`, `video_generate`, `video_edit`, `animation`. Se manca lo decide ideax |
| `model` | id o nome di un modello (`GET /v1/models`). Se manca lo sceglie ideax |
| `params` | parametri per il modello: `aspect` (es. `"16:9"`), `seed`, `num_inference_steps`, `width`, `height`, `num_frames`, `fps`… |
| `attachments` | in JSON: `[{"url": …}]`, `[{"dataUrl": …}]` o `[{"base64": …, "type": "image/png"}]`. In multipart: i file |
| `metadata` | dati vostri (es. id ordine): tornano nel lavoro, nel webhook e nell'archivio |
| `callback_url` | webhook da chiamare a lavoro finito; con il webhook la risposta è immediata |
| `wait` | `true` (predefinito): la risposta arriva a lavoro finito. `false`: risposta subito con l'`id` |
| `inline` | `true`: i file arrivano dentro la risposta, in base64 |

### Webhook

Con `callback_url` ideax risponde subito (`202` con `id` e `status_url`) e, a lavoro finito, invia un `POST` JSON:

```json
{ "event": "job.completed", "created": 1793360000, "data": { "id": "…", "status": "done", "results": [{ "url": "…", "type": "image/png" }], "metadata": { "ordine": "A-17" } } }
```

Eventi: `job.completed`, `job.failed`, `job.cancelled` (e `ping` per le prove). Ogni chiamata ha l'intestazione
`X-Ideax-Signature: sha256=<HMAC-SHA256 del corpo>` calcolata con il *segreto dei webhook* (in Collega app):
verificatela per essere sicuri che arrivi da ideax. Se il vostro server non risponde, ideax riprova 3 volte.

### Tutti gli endpoint

| Endpoint | Cosa fa |
|---|---|
| `POST /v1/generate` | crea un lavoro |
| `GET /v1/jobs/:id` | stato, avanzamento e risultati |
| `POST /v1/jobs/:id/cancel` | annulla |
| `GET /v1/creations` | archivio: `type` (image, video, animation), `q` (ricerca), `limit`, `offset` |
| `GET /v1/creations/:id` | una creazione (`?inline=true` per i file in base64) |
| `DELETE /v1/creations/:id` | elimina una creazione e i suoi file |
| `GET /v1/models` | modelli disponibili e compiti |
| `GET /v1/health` | stato del servizio per il monitoraggio (senza chiave) |
| `GET /v1/openapi.json` | specifica OpenAPI 3 |
| `POST /v1/images/generations` | compatibile OpenAI: le app che usano la libreria OpenAI funzionano cambiando solo `base_url` |

Client pronti: [`clients/ideax.js`](clients/ideax.js) e [`clients/ideax.py`](clients/ideax.py), con invio di file,
archivio e verifica della firma dei webhook.

```python
from ideax import Ideax
ai = Ideax("http://192.168.1.10:7800", "ideax_sk_...")
job = ai.generate("Anima questa foto, le foglie si muovono", files=["foto.jpg"], metadata={"prodotto": 123})
ai.download(job, "risultati/")
```

### Voce clonata

Pagina **Voce**: registri 15–30 secondi dal microfono (o carichi un file) e crei la tua voce; poi qualsiasi testo
viene letto con quella voce. Motore: Chatterbox Multilingual (licenza MIT, 23 lingue, italiano compreso), installato
con un clic. Si può clonare solo la propria voce o quella di chi ha dato il permesso: ideax registra il consenso.

```bash
curl http://192.168.1.10:7800/v1/speech \
  -H "Authorization: Bearer ideax_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"text": "Ciao a tutti! Oggi vi presento il nuovo prodotto.", "voice": "Marco"}'
```

| Endpoint | Cosa fa |
|---|---|
| `GET /v1/voices` | voci disponibili |
| `POST /v1/voices` | crea una voce (multipart: `name`, `language`, `consent=true`, `file`) |
| `PATCH` / `DELETE /v1/voices/:id` | rinomina, valori predefiniti, eliminazione |
| `POST /v1/speech` | legge un testo: `text`, `voice`, `language`, `format`, `exaggeration`, `cfg_weight`, `seed`, più `wait`, `callback_url`, `metadata` |
| `POST /v1/audio/speech` | compatibile OpenAI TTS: risponde direttamente con l'MP3 |

### Musica

Pagina **Musica**: descrivi il brano (genere, strumenti, atmosfera, BPM), scegli la durata e se lo vuoi strumentale o
cantato (con il tuo testo, oppure scritto dal motore). Motore: ACE-Step 1.5 (licenza MIT), installato con un clic
nella versione ufficiale. Dallo Studio basta scrivere, per esempio, "fammi una base lo-fi di 30 secondi".

```bash
curl http://192.168.1.10:7800/v1/music \
  -H "Authorization: Bearer ideax_sk_..." \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Corporate motivazionale, chitarra acustica e archi, 110 BPM", "duration": 30}'
```

Campi di `POST /v1/music`: `prompt`, `duration` (10–600 s), `instrumental`, `lyrics`, `language`, `bpm`, `key`, `seed`,
`quality` (`high` o `fast`), più `wait`, `callback_url`, `metadata`. Prima di comporre ideax libera la scheda video
(la musica ne usa molta); gli altri motori si riaccendono da soli quando servono.

Richiede il driver NVIDIA 570 o più recente (CUDA 12.8).

### Reel

Pagina **Reel**: scrivi l'argomento (o il testo completo) e ideax crea un reel verticale 1080×1920 con la tua voce
clonata, un'immagine per scena con movimento lento, musica di sottofondo sotto la voce e sottotitoli grandi
sincronizzati. In più: copertina, sottotitoli `.srt`, didascalia e hashtag. Dallo Studio: "fammi un reel su…".

Da un altro sistema (es. billpro) si manda il **piano** già pronto, con le scene e anche foto vere:
vedi [docs/integrazione-reel.md](docs/integrazione-reel.md).

### Motori

In **Impostazioni → Motori** ogni funzione pesante (voce, e in arrivo musica, gemello foto e video) si installa con un
clic: ideax crea un ambiente Python separato con [uv](https://github.com/astral-sh/uv), scarica modello e librerie e lo
prova. I motori si accendono quando servono e si spengono dopo 10 minuti di inattività per liberare la scheda video.
Tutto resta nella cartella dei dati (`runtime/engines`). Per i modelli protetti di Hugging Face inserisci il tuo token
in Impostazioni.

### Dai server su internet

ideax gira sul tuo PC. Se un vostro sistema sta su un server in internet, il modo più semplice e sicuro è una rete
privata come [Tailscale](https://tailscale.com) (installata sul PC e sul server: il server vede ideax come se fosse
nella stessa rete) oppure un tunnel come Cloudflare Tunnel. Non aprite la porta 7800 sul router.

## Compiti

| Compito | Quando viene scelto |
|---|---|
| Genera immagine | prompt senza allegati |
| Modifica immagine | immagine allegata + richiesta di cambiarla (img2img sui checkpoint, o modelli di editing) |
| Animazione / GIF | "anima", "gif", "loop", "movimento"… (checkpoint SD 1.5 + modulo AnimateDiff, o modelli video) |
| Da immagine a video | immagine allegata + "video" (SVD, Wan/LTX/CogVideoX image-to-video, o un workflow ComfyUI) |
| Genera video | "video", "clip", "filmato"… senza allegati |
| Modifica video | video allegato |

Se manca un modello per il compito esatto, ideax usa il più vicino (es. "video" → animazione).
Dallo Studio puoi anche forzare modello e compito.

## ComfyUI e Automatic1111/Forge

Se li usi già, collegali in **Modelli → Server locali esterni**:
- **ComfyUI**: esporta il workflow con *Save (API Format)* e incollalo; sostituisci il testo del prompt con `{{prompt}}`,
  il negativo con `{{negative_prompt}}`, il seed con `{{seed}}` e il nome file del nodo LoadImage con `{{image}}`.
  Così puoi usare qualunque workflow (video Wan, upscaler, inpainting…) come un modello di ideax.
- **Automatic1111 / Forge / SD.Next**: avviali con `--api` (porta 7860 di default).

## Variabili d'ambiente

| Variabile | Default | Significato |
|---|---|---|
| `PORT` | 7800 | porta di ideax |
| `HOST` | 127.0.0.1 | `0.0.0.0` per la rete locale |
| `IDEAX_TOKEN` | — | token richiesto alle richieste da altri dispositivi |
| `IDEAX_WORKER_PORT` | 7861 | porta del worker |
| `IDEAX_OFFLOAD` | auto | `on` per GPU con poca VRAM (più lento, usa la RAM), `off` per tenere tutto in VRAM |
| `IDEAX_FLUX_BASE` | black-forest-labs/FLUX.1-schnell | base per i Flux "solo transformer" |
| `IDEAX_LLM_GPU_LAYERS` | -1 | strati del cervello sulla GPU (0 = CPU) |
| `IDEAX_DEMO` | — | `1` = il worker genera immagini finte, per provare senza GPU |

## Cartelle

- `models/`: i tuoi modelli (non vanno nel repository)
- `outputs/`: i risultati
- `data/`: impostazioni, personalizzazioni dei modelli, server collegati, cronologia
