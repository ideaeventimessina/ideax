## Come aggiornare
Se hai già ideax installato, premi **Aggiorna ora** quando compare. Altrimenti scarica **ideax-setup-1.3.0.exe** e aprilo.

## Novità: la tua voce clonata
- Nuova pagina **Voce**: registri 15–30 secondi dal microfono (o carichi un file) e crei la tua voce. Poi qualsiasi testo viene letto con quella voce, in 23 lingue, italiano compreso
- Motore **Chatterbox Multilingual** (Resemble AI, licenza MIT, uso commerciale consentito), tutto sul tuo PC
- Regolazioni di espressività e ritmo, seme per letture ripetibili, MP3 o WAV
- Consenso obbligatorio e registrato per ogni voce clonata
- API per i tuoi sistemi: `/v1/voices`, `/v1/speech` (con webhook e metadata) e `/v1/audio/speech` compatibile OpenAI
- Gli audio compaiono nelle creazioni, con il filtro **Audio**

## Novità: gestore dei motori
- **Impostazioni → Motori**: ogni funzione pesante si installa con un clic, in un ambiente separato. ideax scarica da solo Python, librerie e modello, poi lo prova
- I motori si accendono quando servono e si spengono dopo 10 minuti di inattività, per lasciare la scheda video alle immagini
- Voce e immagini condividono la stessa fila di lavori sulla GPU
- **Token Hugging Face** in Impostazioni, per i modelli protetti come Flux dev e Stable Video Diffusion
- In arrivo nello stesso catalogo: musica, gemello foto, gemello video
