## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.13.2.exe** e aprilo.

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
