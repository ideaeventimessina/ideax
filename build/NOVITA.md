## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.8.0.exe** e aprilo.

## Il cervello ora parte davvero
- Risolto "Per usare un cervello .gguf installa llama-cpp-python": il cervello .gguf ora gira con **llama.cpp ufficiale**, che ideax scarica da solo al primo messaggio in chat (versione per schede NVIDIA, circa 300–600 MB, una volta sola). Niente pacchetti da compilare, e supporta i modelli nuovi come Qwen3
- Quando crei immagini o video il cervello si spegne per lasciare tutta la scheda video, e si riaccende alla chat successiva

## Novità: il tuo gemello
- Nuova pagina **Gemello**
- **Gemello foto**: carichi 15–30 tue foto, ideax impara il tuo viso (ai-toolkit + FLUX.1-dev, una volta, circa 1–2 ore). Poi in Studio basta scrivere "una foto di me al mare" e usa il tuo viso da solo
- **Gemello video**: registri una volta un video di te che parli; poi ogni testo diventa un video tuo con la tua **voce clonata** e le labbra a tempo (LatentSync 1.5)
- Anche dalla chat: "fammi un video in cui dico…"
- Si installano con un clic dalla pagina Gemello. Il gemello foto richiede il driver NVIDIA 580 o più recente e il token di Hugging Face con la licenza di FLUX.1-dev accettata

## Decorazioni per il laser più belle
- Non più sagome nere: ideax disegna un'illustrazione vera e la trasforma in un **pezzo pronto**: il contorno da tagliare e i dettagli da incidere, già in millimetri
- In IDEAlab ogni proposta si vede **come sarà nel materiale**, accanto al disegno di partenza
