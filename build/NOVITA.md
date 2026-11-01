## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.8.9.exe** e aprilo.

## Correzione: download dei modelli dei gemelli
- Risolto "WinError 123 … .lock": su Windows la libreria Python di Hugging Face può creare file con nomi non validi. Ora FLUX.1-dev (Gemello foto) e i modelli di LatentSync (Gemello video) li scarica ideax stesso, in cartelle normali
- Il download mostra quanti GB mancano e, se si interrompe, riprende dal punto in cui si era fermato
