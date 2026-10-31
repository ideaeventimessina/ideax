## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.8.1.exe** e aprilo.

## Correzioni
- **Stable Video Diffusion si sistema da solo**: il file singolo scaricato da Civitai/Hugging Face non basta al motore immagini. Con il tuo token di Hugging Face ideax scarica la versione completa (circa 4,5 GB, mezza precisione) e la mette al suo posto; parte da sola all'avvio, oppure dal pulsante **Sistemalo ora** sulla scheda del modello. Se Hugging Face chiede di accettare la licenza, la scheda ti dice dove
- SVD lavora a 25 fotogrammi rispettando l'orientamento della foto (anche verticale per i reel), con la memoria della scheda sotto i 16 GB
- **I motori sono anche nella pagina Modelli**: cervello (llama.cpp), voce, musica, gemello foto e gemello video, con stato e installazione
- Il cervello usa la scheda video in automatico secondo la memoria libera; avviso se il file .gguf è troppo grande per 16 GB
