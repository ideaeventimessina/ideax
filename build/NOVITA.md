## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.25.5.exe** e aprilo.

## Ti avvisa quando conviene accendere gli altri PC
- Se hai più lavori in coda e stai usando un solo PC, ideax te lo dice nello Studio: "Hai N lavori in coda — accendi gli altri PC e la coda si svuota molto più in fretta". Compare solo quando serve davvero (una coda, non un lavoro singolo) e solo se gli altri PC non sono già al lavoro

## Regia "fare soldi": la demo NAVIGA il sito vero (non genera un video a caso)
- Un contenuto del piano che fa vedere l'app (interfaccia, navigazione, come funziona) ora diventa una **registrazione dello schermo del sito vero** (Regista web), non un video generato da zero con Wan. È ciò che serve a un piano di business — e ciò che la macchina sa fare davvero bene
- E se serve un video generato, Wan 2.2 14B non muore più con "allega l'immagine di partenza": ideax gli crea la foto di partenza da solo, come già faceva col 5B

## Decorazioni laser: il taglio segue la sagoma anche su fondo grigio
- Il modello di immagini non sempre fa il fondo bianco puro: spesso lo dipinge grigio o crema sfumato. Il vettorizzatore prendeva tutto ciò che non era bianco come parte del pezzo, e il taglio diventava il quadrato dell'immagine invece della sagoma (es. un cuore nero su grigio 220)
- Ora il colore del fondo si misura sul bordo dell'immagine e nel pezzo entra solo ciò che è nettamente più scuro: cuore su grigio, su bianco e su crema danno tutti e tre il contorno del cuore

## Decorazioni laser: scelgono un SDXL pulito
- Tra i modelli che hai, le decorazioni preferiscono un SDXL generico (es. realityvision) a uno specializzato in anime/espliciti (es. Pony, che senza i suoi tag rende sporco)

## Decorazioni laser: veloci (una sagoma in secondi, non minuti)
- Una decorazione (es. un cuore) faceva tre generazioni pesanti: il disegno + due giri di rifinitura di pelle e volti (24-30 passi ciascuno) su Flux-dev che sui 16 GB sborda sulla CPU. Per una sagoma piatta è tutto sprecato: ci metteva minuti, a volte andava in timeout e all'app non arrivava nulla
- Ora le decorazioni **non rifiniscono** (una sagoma non ha pelle né volti) e **non partono più da Flux-dev**: usano il modello più veloce che hai (Flux schnell, poi SDXL, poi SD 1.5). Risultato in secondi, e appare sia nell'app sia nelle Creazioni di ideax
- E durante la rifinitura (per le foto vere) la barra non resta più ferma su "20 di 20": mostra la fase ("Rifinisco la pelle…", "Rifinisco i volti")

## Correzione: "Proponi business" (e i piani) non si rompe più sul JSON
- Il cervello locale ogni tanto sbagliava una virgola nel piano e usciva un errore "Expected ',' or ']'…". Ora ideax ripara da solo i difetti comuni (virgole, risposte troncate) e, se non basta, rigenera una volta a temperatura 0: vale per "Proponi business", i piani di guadagno e ogni altra risposta strutturata

## Base fotoreale con un clic
- In **Modelli** c'è "**Scarica la base**": prende *Realistic Vision 6.0* (SD 1.5, ~2,1 GB, uso libero) e la mette nella libreria. Lo stile Fotoreale si accende da solo. Così hai il profilo fotoreale (ritratti, matrimoni, adulto) senza passare da Civitai per il checkpoint

## Voce: "Tieni la voce pronta" + memoria dei 16 GB
- Nella pagina **Voce** un interruttore **Tieni la voce pronta**: tiene il modello caricato, così la prima lettura (anche "ciao") parte subito invece di aspettare i ~3 GB
- E una gestione della memoria video: chi usa la scheda libera prima gli altri motori (le immagini liberano la voce e viceversa), così i 16 GB non vanno più in conflitto — è anche ciò che causava i blocchi da memoria esaurita. Con "voce pronta" attivo, dopo le immagini la voce si riscalda da sola

## Pulsante "Libera la GPU"
- Se qualcosa si incastra e tiene occupata la scheda video, un clic su **Libera la GPU** annulla ogni lavoro appeso, ferma i motori e riavvia il worker pulito. Lo trovi in **Impostazioni → Motore** (sempre) e nello Studio quando un lavoro è "in fila"

## Regia in diretta: vedi i lavori delle app mentre nascono
- Quando arriva un lavoro da una tua app (IDEAlab, Bill, IDEAeventi…), ideax ti porta **da solo allo Studio** e te lo fa vedere costruire in tempo reale
- Leggi il **prompt arrivato** e da **quale app**, vedi il **modello scelto** e come ha interpretato la richiesta, e segui i **passi** del motore uno per uno con l'avanzamento
- Non ti ruba la scena: se stai già guardando un altro lavoro, aspetta che finisca. I lavori che lanci tu dallo Studio restano come prima

## Voce più veloce (anche solo per "ciao")
- L'impronta della voce (ricavata dal campione di 8-10 s) veniva **ricalcolata a ogni frase e a ogni chiamata**: era il grosso del tempo, anche per una parola. Ora si calcola **una volta sola** e si riusa finché resti sulla stessa voce — le letture brevi diventano molto più rapide
- Resta il caricamento del modello (~3 GB) quando il motore voce è stato spento da fermo (dopo 10 minuti di inattività libera la scheda video per le immagini): la prima lettura dopo una pausa è più lenta, le successive no

## Correzione: un lavoro bloccato non resta più appeso per sempre
- Se il motore immagini si inchioda (memoria esaurita, modello incastrato) la richiesta restava appesa all'infinito: il lavoro non consegnava né risultato né errore, e teneva occupata la GPU (le app, es. IDEAlab, aspettavano a vuoto). Ora c'è un tetto di tempo (20 min per le immagini, 45 per i video): oltre quello il lavoro **fallisce con un messaggio chiaro** invece di restare muto
- Il pulsante **Annulla** ora interrompe davvero la richiesta in volo al motore e **libera la GPU** (prima su un worker bloccato non serviva a niente)

## Nuovo stile "Fotoreale (pelle vera)"
- Un nuovo stile che mette i tag giusti per la pelle vera (quello che trasforma una base SD1.5/SDXL realistica da "plastica" a fotografia): pori, luce naturale, grana, e un negativo forte contro il look finto. Vale per ritratti, matrimoni e per i profili adulti
- Si accende **da solo** sulle basi realistiche (epiCRealism, Realistic Vision, CyberRealistic, Juggernaut… o qualunque nome con "realistic/photoreal"). Lo puoi anche scegliere a mano su qualunque checkpoint da Modelli → (apri il modello) → Stile
- Per un profilo pronto: metti una base SD1.5 realistica (priorità alta) + le tue LoRA con **peso ~0,7**, **"sempre attiva"** e le **parole chiave** della LoRA: così i grilletti si scrivono da soli a ogni generazione e non li digiti più

## Correzione: VAE di Video Wan 2.2 14B
- Il file del VAE si scaricava col nome sbagliato (`wan2.1_vae` invece di `wan_2.1_vae`), così l'installazione del motore 14B finiva con "Dopo il download manca wan2.1_vae.safetensors". Ora il nome è giusto: reinstalla **Video Wan 2.2 14B** da Modelli → Motori e scarica solo il VAE mancante (~250 MB, i modelli grossi già scaricati non si riscaricano)

## Più PC che lavorano insieme (farm)
- Hai altri PC con la stessa scheda video? Falli lavorare insieme. In **Collega app → Più PC** rendi un PC il **capofila**: tiene la coda e, quando è occupato, manda i lavori in più agli altri PC (gli **operai**)
- Sugli altri PC non si installa niente di nuovo: li colleghi al capofila come un'app qualsiasi ("Collega con una chiave che hai già", indirizzo del capofila sulla rete + chiave della farm)
- Tre PC fanno **tre lavori insieme**, non uno in un terzo: utile quando la Regia sforna tanti contenuti. Un lavoro singolo su un PC libero resta dov'è, come prima
- Si distribuiscono immagine/video da testo, fotomontaggio, ingrandimento e musica. Restano sul capofila i lavori legati ai suoi dati (voci, gemello, personaggi, reel, demo dello schermo)
- Mai un doppione e mai un lavoro perso: se nessuno lo prende, o un PC si spegne a metà, lo rifà il capofila

## Decorazioni per IDEAlab
- Le immagini lunghe non si interrompono più a 5 minuti: ideax aspetta il motore immagini quanto serve (fino a 15 minuti). Prima una decorazione con Flux su una scheda lenta finiva con "Non riesco a contattare 127.0.0.1:7861"

## Regia esegue i piani
- Nel piano per fare soldi c'è **▶ Crea i contenuti con ideax**: ideax produce da solo i contenuti del piano (reel, immagini, video, demo del sito). I passi su Bill e a tuo carico restano da fare a mano
- I contenuti avviati si vedono nel piano e finiscono nell'archivio creazioni man mano che sono pronti

## Video Wan 2.2 14B (sperimentale)
- Nuovo motore **Video Wan 2.2 14B** (Modelli → Motori, circa 34 GB): video più dettagliati e con più movimento del 5B, da una foto. È dove sono fatte la maggior parte delle LoRA per Wan
- Due modelli esperti + acceleratore Lightning a 4 passi. Pesante per una scheda da 16 GB (fp8): può essere lento, da provare sulla tua scheda
- Le LoRA per Wan 14B vanno in models\loras e vengono usate nel video

## Regista web: ideax registra i tuoi siti
- Nuovo motore **Regista web** (Modelli → Motori): ideax apre un browser vero sulle tue pagine, fa login e **registra lo schermo** per i video dimostrativi dei tuoi software
- Gli accessi (indirizzo, utente, password) si salvano in **Collega app → Accessi ai miei siti**: restano sul PC, non escono mai, non finiscono nel video
- In Studio: **"registra una demo di Pianifico"**. Il cervello scrive il copione (cosa mostrare, con quali sottotitoli), ideax fa il login e registra. Con "con la voce" lo monta anche in un reel
- La prima volta scarica il browser (circa 150 MB)

## Regia: fai soldi con ogni progetto
- Ogni progetto nella pagina **Regia** ha il tasto **💰 Fai soldi con questo**: ideax studia quel software e scrive il piano per portarlo a rendimento
- Il piano dice: come si guadagna, il prezzo, il mercato, il ricavo stimato e quando arriva il primo incasso
- **Contenuti da produrre** (reel, immagini, video, anche video da una registrazione dello schermo che carichi), con quale strumento; **social** su cui essere (collegabili con Bill); **campagne adv** con piattaforma, pubblico e budget; i **passi** concreti, ognuno con lo strumento (ideax, Bill, un tuo progetto, o tu)
- Vale per Pianifico, Foglie del Destino, Prof e tutti gli altri

## Personaggi inventati
- Nella pagina **Gemello** → **Personaggi inventati**: crei un volto che non esiste e ideax lo tiene sempre uguale
- Come funziona: ideax genera la faccia da una descrizione, la ripete in tante pose con Fotomontaggio Qwen (che tiene il volto), e addestra la sua LoRA (serve il motore Gemello foto e Fotomontaggio Qwen). Una volta sola, circa 1–2 ore
- Poi basta scrivere il suo nome in Studio e torna identico, in foto e video
- Nessuna persona reale: niente consenso, e per i contenuti per adulti spunta "Personaggio per adulti". Diventa un personaggio ricorrente per social o contenuti per adulti
- Resta il solo limite sui minori

## Nuovi motori
- **Trascrizione** (Whisper large-v3-turbo): allega un vocale o un video e ideax lo trascrive; con "sottotitoli" anche con i tempi. Il modello (1,6 GB) si scarica da solo la prima volta
- **Vista**: allega una foto e chiedi cosa c'è, quante persone, cosa dice un testo. Usa il tuo Qwen3-VL: il file della vista (circa 1 GB) si scarica da solo
- **Immagini con testo (Qwen-Image)**: inviti, locandine, copertine, menu con le scritte giuste. Modelli → Motori → Installa (circa 22 GB; meno se hai già il Fotomontaggio Qwen)
- **Ingrandimento 4×** per la stampa (4x-UltraSharp, 67 MB): allega una foto e scrivi "ingrandisci"
- **Personaggio parlante**: "un personaggio che dice …": foto (o la crei), video con Wan, voce dalla Libreria voci e labbra a tempo
- **LoRA per Wan**: le LoRA fatte per Wan nella cartella loras vengono riconosciute e usate nei video

## Orchestratore
- Nei casi chiari il motore lo scelgono regole fisse (foto + "trasforma" = fotomontaggio, vocale = trascrizione, "racconta" = scrittore…), il cervello decide solo il resto
- Ogni versione passa da un banco di prova di 57 richieste vere: se una va al motore sbagliato, la versione non esce
- Il cervello conosce la scheda di ogni motore

## Limiti
- Divise e uniformi (college, università, gioco di ruolo) sono ammesse nelle scene per adulti: ideax aggiunge da solo che sono adulte
- Resta un solo blocco: niente contenuti sessuali con minori

## Il racconto continua
- Il seguito di un testo ("più breve", "più esplicito", "continua") resta un testo e lo scrive il cervello scrittore
- Immagini, video e musica partono solo quando li chiedi davvero: niente più immagini a caso al posto di una risposta

## Fotomontaggio e scontorno
- Due nuovi motori in Modelli → Motori (usano il ComfyUI di MOSS-Image):
  - **Fotomontaggio Qwen** (Qwen-Image-Edit-2509 con Lightning 8 passi, circa 30 GB): trasforma una foto vera tenendo il volto, fino a 3 immagini insieme (foto + stile)
  - **Fotomontaggio Kontext** (FLUX.1 Kontext dev, circa 18 GB, uso privato): modifiche fedelissime al volto
- In Studio basta allegare una foto e scrivere cosa cambiare: ideax usa Qwen, oppure Kontext se Qwen non c'è
- **Scontorno** con BiRefNet (lo stesso modello di fal), sul tuo PC: si prepara da solo al primo uso
- I sistemi collegati (es. IDEAphoto Suite) possono chiedere a ideax "fotomontaggio" e "scontorno"

## Cervello scrittore: niente più rifiuti
- Racconti, barzellette, scene e testi per adulti li scrive un **cervello scrittore** fatto per scrivere senza filtri (Llama 3.1 8B Lexi), indipendente dal cervello principale
- Se non c'è e il cervello principale rifiuta, ideax lo **scarica da solo** (circa 5 GB, una volta sola) e appena è pronto **rifà la tua richiesta**: la risposta arriva nella stessa chat
- Un rifiuto non ti arriva più: al suo posto risponde il cervello scrittore

## Meno rifiuti, niente code inutili
- Se il cervello rifiuta un testo, ideax riprova da solo con l'inizio della risposta già scritto (il modello continua invece di bloccarsi), poi con il cervello di riserva
- Nuovi cervelli consigliati per scrivere senza filtri: **Llama 3.1 8B Lexi · scrittura libera** e **Mistral Nemo 12B senza censure** (Cervello → Cervelli veloci senza censure)
- Tolte anche le frasi in fondo tipo "Se vuoi un'altra, basta chiedere"

## Solo risposte
- ideax risponde e basta: niente premesse ("Ok, capisco", "Visto che hai attivato…"), niente commenti su filtri, impostazioni o regole, niente spiegazioni su cosa sta per fare. Le frasi di contorno vengono tolte anche se il cervello le scrive

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
