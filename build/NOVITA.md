## Come aggiornare
Se hai già ideax installato, premi **Aggiorna ora** quando compare. Altrimenti scarica **ideax-setup-1.2.1.exe** e aprilo.

## Correzioni
- **Flux da Civitai**: caricamento riscritto. Funzionano le versioni FP8 normali (tenute compresse in memoria: circa 12 GB invece di 24) e GGUF, sia dev sia schnell, senza dover accedere al repository protetto di FLUX.1-dev. Dal modello base si scaricano solo VAE ed encoder di testo (circa 10 GB, una volta)
- Le versioni FP8 "scaled" fatte per ComfyUI vengono riconosciute e segnalate, con il consiglio di usare la versione GGUF
- Flux usa da solo il risparmio di memoria sulle schede sotto i 24 GB
- I modelli di immagini (Flux, SDXL, SD 1.5) non possono più essere impostati per fare video: prima la richiesta finiva su un modello che non poteva farla
- Messaggio chiaro quando manca un modello video
- "In memoria" si chiama ora **Modello caricato**; le note informative non sono più colorate come avvisi
