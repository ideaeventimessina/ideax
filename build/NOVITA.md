## Come aggiornare
Premi **Aggiorna ora** in IDEAX, oppure scarica **ideax-setup-1.27.48.exe**.

## Le app online non restano più sveglie 24 ore su 24 (risparmio grosso)
- Prima ideax teneva aperta una richiesta su ogni app collegata **in continuazione**: in autoscale le app non scendevano mai a zero e il database restava sempre acceso — centinaia di $ al mese. Ora ideax **non interroga più a vuoto**: apre **una sola connessione in uscita** verso un canale gratuito (ntfy.sh) e aspetta. Quando un'app ha un lavoro è **l'app** a svegliare ideax; ideax prende il lavoro, lo consegna e **torna in silenzio**. A riposo: **zero richieste**, database sospeso. Nessuna porta aperta sul PC. Richiede un piccolo aggiornamento lato app (documentato in `docs/ponte-ideax.md`); finché un'app non è aggiornata usa la sua riserva, senza rompersi.

## Bill e reel
- La presenza di segnaposto o menu in una scena fotografica non avvia il motore per le scritte. Qwen-Image resta disponibile se il brief chiede parole specifiche.
- Bill usa il motore fotografico per i brief senza scritte e dà più tempo alla verifica visiva.
- I cinque controlli per il lancio di un sito sono mostrati con schermate della stessa demo. Il worker verifica il piano e il montaggio prima della consegna.
- Le immagini per Bill superano il controllo tecnico e la verifica del brief prima della consegna. Se il primo risultato è scartato, IDEAX prova a rigenerarlo una volta.
- I reel rigenerano le scene rumorose e, con Cervello visivo disponibile, quelle fuori copione. Il montaggio verifica durata e decodifica audio e video prima di pubblicare il file tra i risultati.

## "Anima questa foto" ora fa il video (non una seconda immagine)
- Chiedendo di animare una foto appena generata usciva **una nuova immagine**: il motore a regole riconosceva "anima" solo su una foto **allegata**, e con una foto generata prima la parola "foto" faceva partire una creazione. Ora "anima questa foto", "muovila", "falla muovere", "fai un video di questa", "mettila in video" partono dall'**ultima immagine della chat** con foto→video. Il video nuovo da testo ("fai un video di una donna che balla") resta distinto.

## Immagini SDXL
- I checkpoint in cartella con scheduler EDM e curva beta incompatibile usano DPM++ Karras. Verificato con CyberRealistic Pony, Lustify e Pony Realism.
- Su Windows il motore può spostare in RAM i componenti SDXL inattivi per ridurre la pressione sulla memoria video.

## Operatore
- Pipeline e Orchestratore riprendono i lavori di codice dal checkpoint dopo il riavvio.
- L’Orchestratore esegue fino a due task indipendenti per volta, ciascuno sul suo file.
- La Pipeline ritenta le risposte malformate, consulta la documentazione tecnica su errori supportati e conserva i casi superati con la soluzione.

## Contenuti per adulti più forti e più fedeli
- L'esplicito usciva "soft" per due motivi tecnici, ora corretti: (1) il riconoscimento del contenuto adulto **non capiva vari termini** (slang italiano compreso), quindi non instradava sul modello esplicito né metteva i tag giusti — ora il vocabolario è molto più ampio; (2) ai modelli **Pony** mancava il tag di rating (`rating_explicit`) e ai **realistici** il `uncensored`: senza, l'immagine resta attenuata. Ora ideax li aggiunge **solo** quando la richiesta è adulta (le immagini normali non cambiano). Perché funzioni serve un **checkpoint esplicito** installato (in Modelli: Lustify realistico, oppure CyberRealistic Pony) e, per la pelle vera, un modello realistico; il contenuto lo mettono il prompt e le LoRA.

## Regia
- Dopo il passaggio alla Console, la Regia ripristina la chat della scheda con risposte, anteprime e lavori in corso.
- Lo stato del progetto viene letto dai risultati salvati. Il collaudo delle anteprime rileva anche i cambiamenti dei controlli e dei canvas statici.

## Riparazione dei giochi nella Regia
- «Non funziona» dopo una creazione interattiva ripara il progetto della stessa chat. Dopo il collaudo la Regia riapre la finestra.
- Snake integrato viene collaudato per movimento, punti, game over e riavvio.

## Tris nella Regia
- «Crea il gioco del tris contro la CPU» avvia il gioco integrato. Chromium prova la risposta della CPU, la vittoria e il riavvio prima di mostrare «Apri» nella Regia.

## Ritorno dalla Giungla in WebGL
- La missione usa Three.js con terreno texturizzato, ombre, personaggi articolati e movimento continuo. Il tasto V alterna prima e terza persona.
- Chromium verifica l’attivazione di WebGL, il movimento, tutti i 100 incontri, il soccorso e il riavvio. Solo a collaudo riuscito compare «Apri» in Regia e il gioco viene salvato in Code.

## Avvio da Code
- «Apri» avvia i progetti locali registrati quando il loro server è spento e apre la pagina appena risponde. I server avviati da IDEAX si chiudono insieme a IDEAX.

## Progetti Code e missioni
- Code riunisce le anteprime della Regia, i giochi in archivio e le nuove bozze web. I collegamenti ai progetti locali si possono aggiungere nei dati di IDEAX.
- I link alle sezioni delle bozze web scorrono all’interno dell’anteprima.
- Per «Ritorno dalla Giungla», IDEAX corregge la regola di vittoria, verifica tutte le transizioni e gioca in Chromium fino al soccorso. «Apri» appare dopo la vittoria e il riavvio verificati.

## Anteprime nella Regia
- Le richieste di giochi e app interattive generano anteprime web. Dopo una prova del pulsante principale in Chromium, «Apri» mostra il risultato in una finestra dentro la Regia.
- Per giocare a un titolo già collaudato, scrivi «Apri» seguito dal titolo. Puoi anche chiedere «Apri l’ultimo gioco».

## Regia e GitHub
- Le richieste esplicite di lettura usano GitHub anche dopo una risposta di scrittura. Se manca il repository o il file, IDEAX chiede il link e riporta gli errori del collegamento.
- La ricerca delle memorie GitHub usa anche la descrizione del repository e può aprire l’indice delle memorie.

## Giochi di guida
- In Operatore, «Gioco di guida 3D collaudato» genera frontend e backend e usa Regista web per provare la partita in Chromium. IDEAX rimanda al modello gli errori di collaudo e salva i giochi che superano le prove in «Giochi collaudati».
- I giochi archiviati si possono riaprire e scaricare anche dopo un riavvio di IDEAX.

## Operatore
- Per le richieste di gioco puoi scegliere vista 3D o 2D, stile, difficoltà e modalità prima di avviare il lavoro.
- La Pipeline può eseguire casi JSON per una funzione JavaScript in isolamento. Usa gli esiti dei test per correggere il codice e salva nella memoria tecnica soltanto i candidati che superano il collaudo. I file privi di test restano disponibili come codice generato.

## Voce, musica e reel
- La scelta «Immagini generate · veloce» usa SDXL locale per creare un’immagine per scena. IDEAX la seleziona anche in automatico per i reel a elenco illustrati se è disponibile un modello adatto. Ogni punto ha la sua scena, con voce pacata, sottotitoli sincronizzati e sottofondo discreto.
- I reel a elenco in stile cartoon possono usare schede illustrate coerenti con il copione, sottotitoli più leggibili e un sottofondo discreto. I modelli di immagini restano selezionabili.
- La lettura in Regia dà più respiro ai paragrafi. Inserisci [pausa] o [pausa lunga] per aggiungere una pausa senza pronunciare il marcatore.
- La voce della Regia legge per frasi e prepara la successiva durante la riproduzione. Il controllo Tono modifica ritmo e pause, con profili naturale, calmo, vivace e narrativo.
- Il sottofondo veloce del reel parte senza caricare il pianificatore musicale. Le opzioni di composizione completa restano disponibili.
- Per le voci sintetiche della libreria senza impostazioni di clonazione personalizzate, il reel può usare direttamente la voce originale su CPU.
- Le anteprime Wan con compito già selezionato partono senza una riscrittura del comando. Il lip-sync veloce usa un percorso di inferenza più leggero.
- I reel rispettano la durata selezionata. Voce e sottotitoli seguono la stessa linea temporale e il montaggio verticale usa 24 fotogrammi al secondo.
- Sulle GPU da 16 GB IDEAX lascia più spazio alle immagini SDXL quando il cervello ha un contesto lungo, per evitare di rallentare con la memoria condivisa.
- I reel che chiedono un elenco numerato verificano che il copione contenga tutti i punti prima di registrare la voce e generare le immagini.
- Le letture e i reel completano la sintesi anche con «Tieni la voce pronta» attivo.
- ACE-Step riusa i pesi già installati e su Windows usa il backend PyTorch per il pianificatore. Il sottofondo dei reel usa la generazione strumentale rapida.
- Sulle schede NVIDIA fino a 16 GB, la scelta automatica del reel preferisce un SDXL locale adatto, quando disponibile. La scelta esplicita del modello resta disponibile.
- In Regia i sottotitoli sono scaricabili dal risultato.
- Chiedendo un’anteprima video in Regia si attiva il profilo veloce. Wan 5B usa 8 passi, con la qualità standard e i passi espliciti ancora selezionabili.
- Le demo web aprono subito l’indirizzo indicato. Il copione automatico usa le altre pagine solo se sono state fornite.
- Il Gemello video pronuncia la battuta indicata nella richiesta. Con «modalità veloce» usa 6 passi lip-sync. I video e gli audio di partenza funzionano anche da percorsi con spazi.

## Memoria e addestramento
- L’Operatore valida JavaScript nella cartella di progetto scelta, anche dall’app Windows, senza eseguire il codice generato.
- «Ricorda che» salva subito il dato. La generazione di codice consulta i ricordi pertinenti anche in una chat nuova.
- Il Gemello riusa la LoRA pronta quando carichi le stesse foto con lo stesso nome. Se manca il risultato, può riprendere dai checkpoint compatibili invece di ricostruire il dataset.

## Montaggio con Impagino
- IDEAX rileva il montatore locale con il prefisso corretto e si autentica con la password del montatore.
- L'API della Catena può riutilizzare gli MP4 già prodotti da IDEAX e conservare l'audio originale delle clip.
- L'MP4 viene scaricato dal montatore e torna tra i risultati di IDEAX. Stato, timeout e problemi di autenticazione sono visibili.

## Addestramento SDXL
- Il Gemello mette in cache gli embedding delle didascalie e libera gli encoder di testo dalla GPU dopo la preparazione, aumentando il margine di VRAM durante l'addestramento.

## Personaggi in Regia
- Se nomini un personaggio salvato e il formato è ambiguo, IDEAX chiede se vuoi un’immagine o un video. Puoi rispondere con il solo formato per avviare la richiesta originale.

## Ricerca nell’Operatore
- Le richieste di conteggio follower cercano dati pubblici e mostrano conteggi, fonti e piattaforme senza un valore verificabile, anche con l’Orchestratore attivo. Quando i dati sono disponibili solo per alcuni social, il totale è parziale.

## Video e Gemello
- Wan 5B e 14B sono entrambi selezionabili. La modalità veloce preferisce il 5B, con dimensioni di anteprima più contenute.
- Wan 14B usa il nodo compatibile con il suo VAE e il condizionamento della foto nei due passaggi.
- Il lip-sync salva correttamente anche in percorsi con spazi. L'API del Gemello video offre una modalità a 8 passi, con avanzamento distinto tra allineamento, generazione e ricomposizione.
- Gli avvii concorrenti dell'addestramento si escludono. Su Windows l'addestratore usa il processo principale per il dataset con latenti in cache.

## Sistemi collegati
- Un ponte che risponde subito con una coda vuota viene interrogato al massimo una volta al secondo. Gli errori di consegna finali sono registrati nello stato del sistema.

## Codice e chiamate concorrenti
- Le richieste esplicite di codice restano nella chat anche se citano immagini o video.
- Studio Code controlla la sintassi del JavaScript inline e ritenta quando la prima pagina contiene un errore di sintassi.
- Le chiamate simultanee condividono l'avvio del modello. Quando il worker richiede la GPU in esclusiva, aspetta le risposte in corso prima di prenderla.

## API diretta
- Con `prompt_mode: "literal"`, `model` e `task` espliciti, IDEAX invia al motore il prompt preparato dal chiamante.
- L'API musicale inoltra il numero di iterazioni richiesto ad ACE-Step.

## Flux su GPU con poca VRAM
- Flux carica sulla GPU gruppi di blocchi alla volta quando è attivo l'offload. Anche l'encoder T5 trasferisce piccoli gruppi di pesi, così il primo passo non deve fare spazio all'intero componente.
- La Regia mostra quando Flux sta preparando la prima iterazione e poi il numero di passi completati.

## Regia · Modalità Dio
- Il logo IDEAX rimane al centro. L'orizzonte si anima e il portale si illumina quando scrivi.
- La risposta compare sopra il portale. I risultati multimediali restano legati al comando nella cronologia.
- Il pannello **Voce e allegati** contiene microfono, scelta della voce e caricamento dei file.
- Se l'invio viene rifiutato, la Regia mostra l'errore e riabilita il campo.

## Il volto del gemello torna: nomini "Marzia", esce Marzia
- Chiedendo "Marzia che prende un caffè al bar" usciva una donna qualsiasi: il cervello, traducendo il prompt in inglese, **perdeva il nome** e così la LoRA del volto non si agganciava. Ora: (1) una **rete di sicurezza** rimette il nome del gemello/personaggio nel prompt se il cervello lo perde — presa dalla tua richiesta originale; (2) il cervello è istruito a **tenere il nome esatto** e a descrivere **fedelmente** luogo e azione; (3) il gemello SDXL ora usa sempre la **base pulita** (file-singolo realistica), non la prima che capita, quindi niente rumore né stile "cartoon". Il volto si aggancia solo se il nome resta nel prompt: ora ci resta.

## Un cervello più forte (e senza filtri): Qwen3 14B
- L'8B andava in **loop** (ripeteva la stessa frase), **non usava gli strumenti** e si inventava le risposte. Il problema era alla base: modello troppo debole. In **Cervello → Scarica** ora c'è, in cima, **«Qwen3 14B senza censure · CONSIGLIATO»** (~9 GB, entra nei 16 GB): molto migliore con gli strumenti (cerca sul web, legge le pagine, usa le capacità imparate), non va in loop, ottimo italiano, senza filtri. Scaricalo e impostalo come cervello principale; per «vedere» le immagini tieni acceso anche Qwen3-VL. *Trovato e verificato sul vero Hugging Face, non a memoria.*

## Corretto il LOOP (la frase che si ripeteva all'infinito)
- `llama-server` partiva **senza penalità di ripetizione** (default 1.0), così i modelli piccoli ripetevano la stessa riga all'infinito — la barzelletta che non finiva mai. Ora parte con `--repeat-penalty 1.1` (e lo passa a ogni richiesta): vale per **qualunque** modello.

## La guardia «prima cerca» ora copre anche il meteo
- Oltre a follower/recensioni/numeri sui social, la regola che **obbliga ideax a cercare** invece di inventare ora scatta anche su **meteo e previsioni** (es. «che tempo fa a Messina»): cerca il dato, e se non lo trova lo dice, invece di rimandarti a un'app.

## Basta risposte inventate: sui dati online ideax CERCA, non immagina
- Alla domanda "quanti follower ha … sui social" il cervello locale a volte si **inventava** un'identità o un numero (es. "è un sistema legacy di gestione contabile"). Ora c'è una **guardia**: quando la domanda chiede un dato online (follower, iscritti, recensioni, numeri sui social o su Google), ideax è **obbligato a cercarlo** (cerca_web → leggi_pagina_dinamica) invece di rispondere a memoria, e se non lo trova **lo dice** invece di inventarlo. Più una regola dura: non inventare mai identità, numeri o descrizioni di aziende, account o progetti. *Provato dal vivo: una risposta inventata viene soppressa e sostituita da una ricerca + una risposta onesta.*

## Autopotenziamento: provato navigando dentro ideax, nel browser
- Ho fatto girare ideax e **navigato la Regia in un browser vero**: il flusso completo funziona — il cancello **«Attiva e vai»**, poi **«Mi sono aggiornato: ora posso usare …»** con i risultati — senza errori. Sistemata una sbavatura di testo (ora il nome della capacità resta intero e corretto).

## Velocità: la chat non ricarica più il cervello per una battuta
- Con "nessun filtro" attivo, per scrivere ideax provava **per primo il cervello scrittore** — spesso un modello DIVERSO da quello già acceso: `llama-server` lo **ricaricava da zero** (~5 GB), decine di secondi, anche per una barzelletta. Ora usa **prima il cervello già acceso** e passa allo scrittore **solo se il principale rifiuta** davvero. Le risposte normali sono molto più rapide.

## Rumore nel generatore immagini: ora si DIAGNOSTICA in una riga
- Il motore ha già quattro difese contro il rumore colorato di SDXL (bf16 dove la scheda lo regge, VAE "fp16-safe", force_upcast, niente ripiego silenzioso sulle cartelle). Se il rumore resta, è un **percorso preciso**: ora a ogni caricamento il log del motore scrive una riga **DIAGNOSI** con modello, dtype e stato del VAE, e **urla** se trova la combinazione a rischio (SDXL in fp16 senza force_upcast). Così si ripara la causa, invece di inseguirla.

## Regia: la chat ora SCORRE, e le risposte brevi restano brevi
- **La chat non si scrollava**: un testo lungo riempiva lo schermo e la cima diventava irraggiungibile (un difetto noto di layout: i messaggi erano ancorati in basso in un modo che taglia l'alto). Corretto: ora i messaggi stanno in basso quando sono pochi e la chat **scorre** quando sono tanti.
- **Una barzelletta non diventa più un racconto lungo**: il cervello generava fino a 2500 parole anche per una battuta — lento *e* fuori misura. Ora il tetto di default è più basso (risposte **più corte e più veloci**) e il cervello è istruto ad **adattare la lunghezza alla richiesta**: breve se chiedi una cosa breve, lungo solo se chiedi esplicitamente un racconto o un articolo.

## Correzione: niente più "request exceeds the available context size"
- Con tutti gli strumenti (compresi quelli imparati) e un po' di conversazione, la richiesta superava la finestra da 8k e il cervello la **rifiutava**. Ora la finestra è di nuovo **16k** (sicura), la cronologia inviata è più snella, e se mai dovesse succedere di nuovo il messaggio è **in italiano e dice cosa fare** (apri una chat nuova, o alza `IDEAX_LLM_CTX`) invece dell'errore tecnico in inglese.
- ideax ora è istruito a **rispondere sempre in italiano**, anche quando legge ricerche o pagine in un'altra lingua: le traduce.

## Quando non sa fare una cosa, ideax IMPARA (e non ti rimanda a farla tu)
- Prima, se chiedevi qualcosa che gli strumenti non coprivano, il cervello spesso rispondeva "fallo tu". Ora **no**: ideax **studia** come si fa (memoria + web), **scrive da sé** il codice della capacità mancante, ti dice *"mi aggiorno, torno tra poco"*, ti chiede **un solo tocco** di conferma — *"Attiva e vai"* — e appena confermi *"mi sono aggiornato, ora posso"* ed **esegue dando i risultati**. Tutto nella Regia, con la voce.
- **Niente riavvio, niente contesto perso**: la capacità nuova (una "skill") si attiva **a caldo** mentre ideax gira. Una volta imparata, la volta dopo la **richiama da sola** invece di re-impararla — è l'auto-apprendimento che si accumula.
- **Due paletti non negoziabili**: (1) **un tocco di conferma** prima di attivare qualsiasi capacità nuova — ideax non si auto-modifica in silenzio; (2) **tutto in locale**: la skill vive sul tuo PC e **non viene spedita agli altri utenti**. Ne resta una copia in `proposte-self/` così, con una revisione a mano e un normale aggiornamento, un domani può entrare nel programma di tutti — ma è una scelta deliberata, non automatica.
- Le skill sono **isolate** (girano in un processo Python a parte), validate nella sintassi prima di salvarle, senza pagamenti e senza toccare i tuoi file.

## I numeri e i dati dalle pagine "vere" (Google Maps, schede attività, Instagram)
- `apri_pagina` legge l'HTML grezzo e **non vede** quello che il JavaScript costruisce dopo (il numero di recensioni su Google, un profilo Instagram…). Ora c'è **leggi_pagina_dinamica**: ideax apre quell'indirizzo in un **browser vero**, esegue il JavaScript e **legge il dato tu** invece di dirti di guardarlo. (Serve il motore Regista web installato.)

## La voce della Regia ora è veloce (Kokoro diretto)
- Prima il parlato usava Chatterbox, che per parlare **scaricava i 12 GB del modello immagini** dalla scheda e ci metteva 10 secondi. Ora la Regia legge **direttamente con Kokoro** (gira sulla CPU, non tocca la scheda video): risposta in un paio di secondi, e non rallenta nemmeno la generazione dopo.
- Voce **femminile italiana (Sara)** di default; nel menu sotto la barra scegli fra le voci donna della libreria.

## Regia: vedi cosa fa mentre lavora (e scegli la voce)
- Mentre ideax lavora, la Regia ora mostra **dal vivo**: un **timer**, cosa sta facendo ("Sto pensando…", "Cerco…", "Creo…"), la **lista dei passi** uno dopo l'altro (quello in corso gira), e la **risposta che cresce** man mano. Come seguire il lavoro passo per passo.
- **Scegli-voce**: sotto la barra c'è il menu delle voci installate; la Regia parte già su una **voce femminile** (preferendo una sintetica, più rapida), ma puoi cambiarla con un tocco. Niente più voce scelta a caso.
- Nota onesta: la **qualità delle risposte** è quella del cervello locale (Qwen3-VL-8B sul tuo PC) — se a volte "inventa", è il modello, non un bug della Regia. La velocità e la fedeltà del cervello sono il capitolo a parte su cui stiamo lavorando (tutto in locale).

## Più veloce, tutto in locale: il cervello non si riaccende a ogni immagine
- Prima di ogni immagine ideax spegneva il cervello per liberare la scheda, e alla chat successiva lo **ricaricava da zero** (secondi persi, ogni volta). Ora lo **tiene acceso** quando il modello immagine ci sta accanto (SDXL sui 16 GB); lo spegne solo quando non c'è spazio (Flux). Risultato: nel flusso "chiedo → crea → chiedo" la risposta arriva molto prima. Valvola di sicurezza `IDEAX_BRAIN_ALWAYS_FREE=1` se una generazione dovesse sforare.
- La finestra di contesto del cervello scende da 16k a **8k**: meno memoria occupata (più spazio per tenerlo acceso) ed elaborazione del prompt più rapida. Si rialza con `IDEAX_LLM_CTX`.
- Niente API esterne: tutta la velocità viene da come usiamo la **tua** scheda.

## Regia: la voce ora parla, è una donna, ed è più veloce
- La Regia ora sceglie da sola una **voce femminile** fra quelle installate, preferendo una **sintetica (Kokoro)** che è molto più rapida di una voce clonata.
- Il browser blocca l'audio automatico finché non c'è un tuo gesto: ora al primo tocco (invio o microfono) l'audio si **sblocca**, così la voce parte. Se proprio non parte, la Regia **lo dice** invece di restare muta.

## La Regia: una barra sola a cui parli (anche a voce)
- Nuova schermata **Regia** (link in alto a sinistra, o apri `/regia.html`): una barra unica al centro. Scrivi o **parli** (🎙 microfono → trascrizione), ideax capisce cosa serve e l'output **appare lì** — testo, immagini, video. Se gli servono dati te li chiede nella stessa barra.
- **Ti risponde parlando** (🔊, si può zittire): la risposta esce anche a voce (serve il motore Voce installato; se manca, resta il testo).
- **"+"** per trascinare una **foto/video di riferimento** (per il volto, lo stile, una scena da cui partire).
- La **rotella ⚙** porta a tutto il resto (Studio, motori, gemello, sistemi collegati, discussioni): niente è sparito, è solo dietro l'ingranaggio. La Regia è la nuova casa; il cockpit completo resta com'è.

## La memoria ora si LEGGE: ideax parte da ciò che sa
- Il brain, prima di rispondere o di risolvere un task, **cerca nella memoria** cose simili già imparate e ci parte. È l'anello che chiude l'auto-apprendimento: la Pipeline dell'Operatore scrive le soluzioni riuscite E legge quelle vecchie prima di scriverne una nuova (impara dai propri fix).
- I ricordi entrano come **riferimento, non come ordini**: ideax è istruito a ignorare qualsiasi comando contenuto in un ricordo. È il paletto che serve quando, col Seeker, la memoria si riempirà anche di roba presa dal web.

## Memoria eterna: ideax comincia ad accumulare conoscenza (Pilastro 1)
- Un database vettoriale **LOCALE** (ChromaDB, sul tuo PC — niente cloud) dove ideax archivia ciò che impara e lo ritrova per **significato**, non per parola esatta. Due collezioni separate: **tech_core** (snippet, fix, pattern di codice) e **creative_assets** (prompt, stili, configurazioni di modelli). Il motore sceglie la collezione dal contesto.
- **Si auto-apprende:** ogni soluzione scritta e validata dalla Pipeline dell'Operatore finisce da sola in memoria (tech_core). Un problema simile, domani, la ritrova senza richiederla. Si spegne con `memoria.auto=false`.
- Gli embedding li calcola un modello locale (all-MiniLM, ~80 MB): la conoscenza non esce di casa, costo zero. Si installa da solo al primo uso. Se non è disponibile, ideax lavora lo stesso e lo dice (non si blocca).

## Modelli per adulti a FILE SINGOLO: niente più neve
- I modelli espliciti "a un clic" ora si scaricano come **file singolo** `.safetensors` dalle fonti giuste (Lustify, Pony Realism con VAE, CyberRealistic Pony dal repo ufficiale), **non più come cartelle** John6666: i file singoli si caricano in modo pulito, senza il bug del rumore.
- Scaricando la versione nuova, ideax **rimuove da solo la vecchia cartella rotta** con lo stesso nome: recuperi 6-7 GB a modello senza fare niente.
- **BigLust** è stato tolto dalla lista a un clic (non ha una versione a file singolo affidabile, ed era il più stilizzato): se ce l'hai installato e vuoi lo spazio, premi **Elimina** sulla sua scheda in Modelli.

## Basta neve: non sceglie più da solo un modello che fa rumore
- I modelli SDXL **a cartella** (big-lust, cyberrealistic-pony, lustify, pony-realism) su alcune macchine escono RUMORE. Ora la generazione **non li sceglie più da sola** se c'è un SDXL file-singolo pulito (es. realityvision): la scelta automatica li penalizza E il guardiano corregge il cervello se prova a sceglierne uno. Per un viso/gemello non esplicito esce pulito, senza che tu debba disattivare niente.
- Per i contenuti espliciti quei modelli restano la scelta (il realistico pulito rifiuta l'esplicito): se lì esce rumore, la cura è la versione **a file singolo** (.safetensors da Civitai) dello stesso modello.
- E se una cartella diffusers non si carica in modo sicuro, ora ideax **dà un errore chiaro** invece di consegnare neve in silenzio (prima un ripiego nascosto rimetteva il bug del rumore).

## Traccia del preventivo: si legge per cosa è ogni lavoro
- Ogni lavoro che arriva da un sistema collegato (IDEAlab…) ora porta e **mostra** il suo riferimento — es. "preventivo-42/riga-7" — in "Collega app" e nei log. Così, invece di fidarti che il legame tenga, **lo leggi** a ogni immagine generata. Se un lavoro non porta il riferimento, il campo resta vuoto: anche quel vuoto dice che quel sistema non lo manda ancora.

## Il volto resta LO STESSO: FaceID per gemelli e personaggi
- Una LoRA cattura l'aria di un volto ma non lo blocca: a ogni scena ne esce uno "simile ma non lui". **FaceID** chiude il buco — prende le foto di riferimento del personaggio e **impone il volto** alla generazione, così resta identico in venti scene diverse. Si accende da solo quando generi con un gemello o un personaggio su un modello SDXL; vedi "Blocco il volto (FaceID)" durante la generazione.
- **Regola di sicurezza:** su un **viso reale** (gemello) FaceID si **spegne** se il contenuto è esplicito. Su un **personaggio inventato** resta sempre acceso — è la strada giusta per i contenuti per adulti (nessuna persona reale).
- Usa **insightface** (lo stesso del Gemello video): se non c'è, prova a installarlo da solo alla prima generazione; se non riesce, genera con la sola LoRA e lo dice (non si blocca mai). Il modello FaceID si scarica una volta al primo uso.
- Forza della somiglianza regolabile con la variabile `faceidScale` (0.65 di base).

## Gemello: su schede da 16 GB si addestra su SDXL (FLUX non ci entra)
- **Il motore si sceglie dalla scheda.** FLUX dà la somiglianza migliore ma in addestramento il suo picco di memoria sfora i 16 GB e si pianta prima ancora di cominciare. Ora, sotto i ~20 GB, il gemello si addestra su **SDXL** — molto più leggero, ci sta comodo sui 16 GB anche con più monitor accesi, e con tante tue foto la somiglianza è ottima. Su schede grandi (24 GB+) resta FLUX.
- La **base SDXL** la sceglie fra i tuoi modelli, preferendo un realistico (es. RealVisXL, Juggernaut) ed evitando quelli stilizzati. Se non ne hai nessuno, te lo dice invece di piantarsi. Puoi forzare il motore con la variabile `IDEAX_TWIN_ARCH=flux|sdxl`.
- Si vede sempre quale motore e quale base sono partiti ("motore SDXL · base …").

## Gemello: il cane da guardia copre anche il caricamento (passo 0)
- La versione prima si attivava solo durante l'addestramento vero; uno stallo nel **caricamento del modello** (passo 0), prima dei passi, restava muto. Ora anche lì: se il modello non dà segni per 10 minuti, l'addestramento si ferma e ti dice perché (di solito memoria), invece di restare fermo per ore.
- E la scritta non dice più "scarica FLUX.1-dev" quando in realtà lo **carica dal disco**: i 30 GB si scaricano una volta sola all'installazione, non a ogni gemello.

## Gemello: non resta più fermo per ore in silenzio, e ti dice perché
- **Cane da guardia sull'addestramento.** Su una scheda da 16 GB, FLUX in addestramento può restare a corto di memoria e strisciare (un passo da secondi diventa minuti): prima la barra restava ferma per ore senza un errore. Ora, se i passi sono troppo lenti o la barra è congelata, l'addestramento **si ferma da solo entro ~20 minuti** e ti dice cosa fare, invece di farti perdere la notte.
- **Si vede quale motore è partito:** "motore FLUX" per il gemello foto (il tuo viso, con consenso), "motore SDXL · base …" per i personaggi inventati. Non lo indovini più.
- **Avviso prima di partire:** se uno schermo è acceso sulla scheda che addestra, un banco in cima a Gemello te lo dice e suggerisce di ridurre a un solo monitor per le ~2 ore dell'addestramento (più monitor accesi, più memoria tolta al calcolo). Avvisa, non blocca.

## Orchestratore: Target Router, anteprima progetti, zip, cartella scelta da te
- L'Orchestratore ora **classifica** l'obiettivo: EXTERNAL (uno strumento isolato, in `tools/`), PROJECT (app/sito completo, in `progetti/`), SELF (una PROPOSTA di modifica da rivedere, in `proposte-self/` — **non** tocca il codice vivo di ideax).
- Per i PROJECT: **anteprima locale** (ideax li serve a `/progetti/<nome>/`) e **scarica lo zip** del progetto.
- **Percorso dinamico:** puoi indicare una **cartella di destinazione** tua (anche fuori dal workspace); i file restano **dentro** quella cartella. La base la scegli tu: il modello scrive solo nomi relativi, non percorsi assoluti suoi.

## Operatore: Orchestratore (obiettivo grande → sotto-task automatici)
- Nuova spunta "Orchestratore": scrivi un obiettivo generale, ideax lo **scompone in sotto-task tecnici atomici** (normalizzando i termini generici in istruzioni precise: cosa, in quale file, come) e li **esegue uno alla volta** con la Pipeline — ogni task viene scritto e validato PRIMA di passare al successivo.
- Se un task fallisce, si ferma lì e te lo dice (non va avanti alla cieca). Come sempre: cartella di lavoro confinata, niente push automatico.

## Pipeline: iniezione a marcatore e validazione PRIMA di salvare
- Nuova azione "inserisci" nella modalità Pipeline: aggiunge codice **subito dopo una riga-marcatore** (es. `// [MODULO_START]`), **senza cancellare** il resto del file — il modo per aggiungere una funzione a un file esistente.
- La sintassi ora si controlla **prima** della scrittura definitiva: il nuovo contenuto va in un file temporaneo, si valida, e **solo se è buono** prende il posto del file vero. Così un'iniezione sbagliata non sporca il file che modifichi; se è rotta, il modello riceve l'errore e corregge da solo.
- Resta vero il resto: il controllo è di **sintassi, non di correttezza**, e il commit/push su GitHub **non è automatico** (si conferma a mano).

## Operatore: modalità Pipeline (codice in JSON, senza chiacchiere)
- Nuova spunta nell'Operatore: un comando → un file. Il modello risponde **solo in JSON** (file, azione, codice, commit_msg), ideax scrive il file nella cartella di lavoro, **controlla la sintassi** (py_compile per .py, node --check per .js) e, se è sbagliata, **si ri-prompta da solo** per correggere — senza che tu intervenga.
- **Il commit/push su GitHub NON è automatico**, per scelta: è un'azione verso l'esterno (e il repo di ideax, a ogni push, spedisce un .exe agli utenti), e il controllo di sintassi dice "compila", non "è giusto". Quindi si conferma a mano. Tutto il resto è silenzioso come deve.

## Operatore: ora GUARDA la pagina (non indovina da una lista)
- Se hai un cervello che vede (Qwen3-VL, dalla pagina Cervello), l'Operatore fa uno **screenshot** a ogni passo e decide dove cliccare **guardando** la pagina — come una persona. Molto più affidabile sulle pagine dinamiche.
- Un passo browser che fallisce non ferma più tutto: l'errore torna al cervello, che riprova o conclude. In semi-autonoma anche clic e compilazioni partono da soli (il pagamento resta sempre bloccato).
- Onesto: serve il cervello VL installato ed è pesante su 16 GB (lento). Vede e clicca meglio di prima, ma un modello locale piccolo non è un modello di frontiera; per quella qualità il cervello va puntato a un'API esterna (Cervello → Server), con i dati che però escono dal PC.

## Scarica LoRA da Civitai (anche di movimento per i video Wan)
- In **Modelli** c'è "Scarica una LoRA da Civitai": incolli il link, metti la tua chiave API, e il file va nella cartella loras (lo scanner riconosce anche l'architettura: una LoRA Wan si accende sul video). Spunta "per adulti" e si accende da sola sui contenuti espliciti compatibili.

## Se il PC si impalla quando parte una generazione
- Succede quando l'unica scheda (la 4080) fa **sia lo schermo sia il modello**: un lavoro pesante blocca il desktop. Se hai la **grafica integrata** sulla scheda madre, collega il **monitor alla presa della scheda madre** (non alla 4080) e attiva l'integrata nel BIOS: così la 4080 resta solo per l'IA e lo schermo non si blocca più (e la 4080 guadagna ~1 GB di memoria libera).

## Ricerca web: ora il cervello apre le pagine, non cerca a vuoto
- Prima, a "quante recensioni ha X", ripeteva la stessa ricerca e si arrendeva. Ora dopo aver cercato **apre la pagina più adatta** per leggere il dato, e non ripete la stessa ricerca.
- Chiaro il limite: un numero che sta su **Google Maps o Instagram** (pagine fatte col JavaScript) la lettura pagina non lo vede — per quello serve il browser vero dell'**Operatore**, o il sito ufficiale dell'attività.

## Due schede video: ora lavorano in parallelo
- Se hai due schede NVIDIA, le immagini stanno su una scheda e i lavori pesanti (addestramento, video, voce, musica) sull'altra: così puoi **generare mentre addestri**, senza che si rubino la scheda. Con una scheda sola non cambia niente.
- In **Impostazioni** sotto "Motore pronto" ora vedi **tutte** le schede e chi fa cosa (prima ne vedevi una sola: era il worker immagini, è normale).

## Flux Q8: la qualità di Flux, leggera (12,5 GB invece di 24)
- In **Modelli** c'è "Flux Q8": un clic e lo scarichi. Sta in una scheda da 16 GB e resta caricato mentre genera, quindi è veloce. Pubblico, niente chiavi.

## Il cervello ora va online (ricerca web)
- Nella **chat** il cervello può **cercare su internet** e **aprire pagine** per leggerle. Prima, a "cerca pagine di organizzatori eventi", provava GitHub (l'unica ricerca che aveva) e falliva. Ora cerca davvero sul web. (Instagram e le pagine tutte-JavaScript restano fuori: lì serve il browser vero dell'Operatore.)

## Nuova pagina "Operatore"
- Gli dai un obiettivo; scrive ed esegue codice sul tuo PC e ora **naviga un browser vero** (apre pagine, clicca, estrae dati), guidato dal cervello. Ti risponde nella pagina.
- Ogni azione con effetti **chiede il tuo sì**. C'è una **modalità semi-autonoma**: le correzioni del codice partono da sole (si ferma dopo 3 tentativi falliti), ma clic, compilazioni e pagamento chiedono sempre conferma.
- **Il pagamento non è mai automatico:** l'Operatore arriva al checkout e si ferma — paghi tu.

## Nuova pagina "Code"
- Nello Studio, accanto a *Conversa* e *Crea direttamente*, c'è **Code**: descrivi una pagina web, il cervello la genera, la vedi in **anteprima** e la **pubblichi** (ideax la serve sul PC / in rete locale).

---
# Versioni precedenti

## Decorazioni laser: sagome piene e nere, non cuori di linee storte
- Il tema ora si traduce sempre in inglese prima di disegnare: "cuore sagoma semplice nero" arrivava al modello in italiano, che SDXL non capisce
- Le decorazioni non prendono più lo stile "fotoreale" del modello (con realityvision aggiungeva "raw photo, DSLR, pelle" e vietava "illustration"): usano lo stile normale. Nuovo parametro `prompt_style` per imporre lo stile a un singolo lavoro
- Il prompt chiede una sagoma nera piena tipo stencil, e vieta contorni, legno e foto
- Se il disegno esce fatto di sole linee (meno della metà pieno), ideax ne genera un altro una volta e tiene il migliore
- Una sagoma piena non ha più un livello "da incidere" grande quanto tutto il pezzo (avrebbe bruciato tutto l'interno); i dettagli veri restano

## Decorazioni laser: l'anteprima arriva sempre a IDEAlab
- Con le decorazioni fatte da SDXL l'editor di IDEAlab riceveva il taglio giusto ma l'immagine vuota: l'anteprima era il PNG intero e IDEAlab la scartava
- Ora ideax manda un'anteprima JPEG leggera (768 px, qualche decina di KB), sempre nel formato che IDEAlab accetta

## Video già fatto: messaggio chiaro (usa il montatore)
- Se alleghi un video chiedendo di modificarlo, ideax non lo fa col motore immagini (quelli generano o animano una foto, non rieditano un video). Ora lo dice chiaro e ti manda dove serve: il montatore (Studio → Video montato) per tagliare, montare, musica e titoli

## Server cloud pronto con un clic (per immagini velocissime e video)
- In Modelli c'è "☁ Server cloud pronto (SDXL)": apre il collegamento a un ComfyUI cloud (RunPod) già compilato col workflow esplicito SDXL (Pony Realism). Ti resta solo da incollare l'indirizzo della GPU. Da lì le immagini girano in 2-4 secondi, senza censura (è il tuo server)

## "Crea personaggio da questo volto"
- Generi un viso che ti piace nello Studio → premi "✧ Crea personaggio" sulla creazione: ideax blocca QUEL volto come personaggio coerente (prima partiva da una descrizione e inventava un volto nuovo). Da lì la stessa faccia torna in tutte le creazioni
- Se lo marchi "per adulti" lo addestra su SDXL (per i modelli espliciti). L'addestramento resta lungo (1-2 ore): per coerenza immediata senza training c'è la via IP-Adapter sul server cloud

## Personaggi inventati su SDXL (per contenuti espliciti coerenti)
- Un personaggio inventato (volto e corpo generati da zero, nessuna persona reale) marcato "adulti" ora si addestra su SDXL: la sua LoRA si combina con i modelli espliciti (Pony Realism…), così hai la STESSA persona inventata in scene esplicite, coerente scatto dopo scatto. È la pipeline giusta per OnlySans senza il rischio del volto reale
- Serve un modello esplicito SDXL installato (Modelli → Modelli per adulti) come base. L'addestramento SDXL su 16 GB è nuovo e dura 1-2 ore: la prima volta potrebbe servire un ritocco guardando il registro

## Modelli per adulti con un clic (OnlyFans)
- In Modelli c'è "Modelli per adulti": scarichi con un clic Pony Realism, CyberRealistic Pony o BigLust — SDXL base Pony addestrati sul realismo, che sanno fare gli atti espliciti e girano puliti (VAE incluso, niente rumore). ~7 GB l'uno, una volta sola
- Per l'esplicito realistico (foto, OnlyFans) usa questi, non realityvision (che fa nudo ma non gli atti): dagli priorità alta in Modelli e ideax li userà. E GENERA da testo, non modificare una foto

## Adulto: la LoRA giusta si accende da sola
- Quando chiedi un contenuto esplicito (generato da testo), ideax ora accende da solo la LoRA "per adulti" compatibile col modello (es. MysticXXX con realityvision): non devi più attivarla a mano ogni volta. Per i prompt normali resta spenta
- Puoi anche segnare qualunque LoRA come "adulto" (campo adultLora). La LoRA deve essere della stessa architettura del modello (SDXL con un SDXL): se non scatta, controlla l'architettura della LoRA in Modelli

## I modelli lavorano GREZZI (niente ritocco automatico)
- Prima ogni immagine passava da un ritocco automatico di volti e pelle: due generazioni extra + un ingrandimento, su TUTTO. Lento e invadente. Ora è SPENTO di default: il modello genera grezzo, a risoluzione nativa, veloce. (Resta accendibile a richiesta)
- Nota onesta: i filtri di contenuto bloccano solo i minori e non toccano i tuoi prompt — il rumore grigio di SDXL era un bug del VAE (vedi sopra), non un filtro

## Correzione DEFINITIVA: immagini SDXL (Pony, realityvision…) a rumore
- Se SDXL usciva ancora "a poltiglia" anche dopo l'aggiornamento, ora è risolto alla radice: il VAE difettoso viene sostituito con quello ufficiale "fp16-safe" (si scarica una volta, ~300 MB), che in fp16 non va in overflow. Vale per Pony e tutti gli SDXL
- IMPORTANTE: dopo l'aggiornamento **riavvia il worker** (Impostazioni → Motore → Riavvia il worker, o "Libera la GPU"): il modello va ricaricato perché la correzione faccia effetto

## Correzione: immagini SDXL (Pony, realityvision…) non escono più "a rumore"
- Il VAE di SDXL in fp16 andava in overflow e invece dell'immagine decodificava una poltiglia di colore (rumore verde-grigio al posto del soggetto): è un difetto noto di SDXL. Ora il VAE lavora in fp32 nella decodifica e l'immagine esce giusta. Riguarda i modelli SDXL e SD3; Flux e SD 1.5 non ne soffrivano

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
