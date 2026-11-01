## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.15.3.exe** e aprilo.

## Correzione: niente più falsi rifiuti
- Una barzelletta o un racconto con dentro "non posso" veniva scambiato per un rifiuto del cervello e sostituito da un messaggio sui filtri. Ora conta come rifiuto solo una risposta che rifiuta davvero la richiesta

## Aggiornamenti e ponti più chiari
- ideax controlla le nuove versioni ogni 30 minuti (prima ogni 6 ore) e anche quando torni sulla sua finestra
- In Collega app ogni riga dice esattamente cosa manca: l'app online senza il ponte (su Replit: Git → Pull, poi Republish), la chiave mancante nei Secrets, o una chiave diversa da quella di ideax

## Video più veloci
- Le catene di clip lavorano in due fasi: prima tutte le foto, poi tutte le animazioni. La scheda video cambia modello una volta sola invece che a ogni clip
- Nuova opzione **Veloce (bozza)** nel "Video montato con Impagino": clip da 3 secondi a risoluzione più bassa e con meno passi, per provare un'idea prima della versione finale

## Ponti con Bill e Impagino
- In Collega app ora si possono collegare anche Bill e Impagino (dopo il loro aggiornamento): scrivi l'indirizzo, Crea ponte, e la chiave va nei loro Secrets come IDEAX_KEY

## Video veri con Wan 2.2
- Nuovo motore **Video Wan 2.2** (Modelli → Motori → Installa, circa 18 GB): video da testo o da una foto, 720p a 24 fotogrammi al secondo, fino a 5 secondi a clip, con movimento naturale. Licenza Apache 2.0, uso commerciale consentito
- Usa il ComfyUI già installato con MOSS-Image: niente programmi in più
- Quando c'è, diventa il motore video principale (prima di Stable Video Diffusion)
- Per volti perfetti ogni video parte da una foto creata e rifinita (pelle e volti, e il tuo gemello se lo nomini), che Wan anima mantenendo la stessa persona
- Le catene di clip per Impagino usano Wan: clip da 4 secondi, molto più vive

## Correzione importante: ideax non si apriva
- Dalla 1.13.0 ideax.exe si chiudeva subito all'avvio, senza mostrare nulla (un errore nel codice della Libreria voci). Corretto
- Da ora ogni versione viene avviata per prova prima di essere pubblicata: se non resta accesa, non esce

## Video montati con Impagino
- Nuova sezione nella pagina **Reel**: "Video montato con Impagino". Scrivi l'idea, scegli quante clip (4-12) e il formato
- ideax progetta le scene, crea una clip per ognuna (foto rifinita con pelle e volti, poi animata), compone la musica e passa tutto al **montatore di Impagino** acceso sullo stesso PC
- Impagino monta sul ritmo della musica con rallenty, colore e titoli, e scrive anche il **progetto CapCut** da ritoccare a mano. Il video montato torna in ideax
- Se il montatore è spento, clip e musica restano pronte in una cartella da aprire con Impagino
- Si può chiedere anche a voce, in Studio o tramite Jarvis: "fammi un video montato di…"

## MOSS-Image: pelle e volti
- Anche le immagini di MOSS-Image passano dalla rifinitura: la pelle la ripassa MOSS stesso (con le tue LoRA, compresa Mystic), poi i volti e la grana li rifinisce il miglior modello realistico installato
- Se la scheda video non regge l'ingrandimento, ideax rifà l'immagine senza, invece di fermarsi

## Video
- I video partono da una foto già rifinita (pelle e volti), quindi anche le clip hanno volti e dettagli puliti

## Pelle e dettagli realistici
- Ogni immagine viene ingrandita (1,5 volte, 2 volte con i modelli SD 1.5) e ripassata dallo stesso modello con un tocco leggero: pori, peli sottili, tessuti e luci diventano nitidi e naturali, la composizione resta identica
- Una grana fotografica leggerissima toglie l'effetto "plastica" tipico delle immagini fatte con l'IA
- Poi arriva la rifinitura dei volti, sull'immagine già ingrandita
- Ogni immagine richiede circa il 40% di tempo in più. Le immagini escono più grandi (es. 1792×1216 invece di 1216×832)

## Volti perfetti
- Ogni immagine con persone passa da una rifinitura automatica dei volti: ideax trova ogni viso, lo ridisegna ad alta risoluzione con lo stesso modello (e le stesse LoRA, quindi il gemello resta lui) e lo rimette al suo posto con i bordi sfumati
- Risolve i volti deformati nelle scene a figura intera o con più persone, dove il viso è piccolo
- Funziona con i modelli SDXL, SD 1.5 e Flux. La prima volta scarica un piccolo rilevatore di volti (meno di 1 MB)

## Racconti e testi: risponde e basta
- "Raccontami…", "scrivi…", "una storia…", "descrivi…": ideax scrive direttamente il testo, senza premesse né spiegazioni, e non lo trasforma più in un'immagine
- Con "nessun filtro" attivo, se il cervello principale rifiuta ideax riprova con quello di riserva
- Se rifiutano tutti e due non vedi più risposte contraddittorie: ideax ti dice quale cervello ha ancora i filtri e come sostituirlo in un tasto (Cervello → Cervelli veloci senza censure)

## Libreria voci per i tuoi personaggi
- Nella pagina **Voce** c'è la **Libreria voci**: 25 voci di uomini e donne (italiane come Sara e Nicola, e poi inglesi, britanniche, spagnole, francesi, brasiliane), con filtro Donne/Uomini
- Premi **Aggiungi**: ideax la prepara e la mette tra le tue voci, pronta per letture, reel e personaggi dei video. La prima volta scarica il modello (circa 340 MB), poi ogni voce è pronta in pochi secondi
- **Crea un personaggio nuovo** mescolando due voci (es. 60% Bella + 40% Emma) e dagli un nome
- Sono voci sintetiche con licenza libera (Kokoro, Apache-2.0): non appartengono a nessuna persona reale, quindi nessun consenso da raccogliere
- Il cervello conosce genere e carattere di ogni voce e sceglie quella adatta al personaggio

## Collega app in un tasto
- Scrivi l'indirizzo dell'app (es. idealab.replit.app) e premi **Crea ponte**: ideax sceglie il nome, crea la chiave e si mette in ascolto da solo
- Tu copi la chiave nei **Secrets** dell'app come `IDEAX_KEY` e la ripubblichi: appena la chiave è attiva, ideax si collega da solo e la vedi "Collegato"
- Le opzioni tecniche (API, chiavi, webhook, esempi) sono raccolte in "Per sviluppatori"

## Video anche senza immagine
- "Crea un video di…" funziona anche senza una foto di partenza: se il motore video anima solo foto (Stable Video Diffusion), ideax prima crea l'immagine dal testo e poi la anima. Insieme al video trovi anche la foto di partenza
- Corretto l'errore "missing 1 required positional argument: 'image'"

## Domande e risposte
- Le domande ("come posso…", "cosa…", "perché…") ricevono una risposta a parole, completa e pratica, anche sugli argomenti per adulti: non si trasformano più in un video o in un'immagine
