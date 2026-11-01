## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.8.4.exe** e aprilo.

## Correzione: il cervello parte
- Risolto "Nella release di llama.cpp non trovo un pacchetto adatto a questo PC": l'ultima release di llama.cpp (v0.8.0) contiene solo codice, senza i programmi per Windows. Ora ideax cerca la release più recente che ha la versione per la tua scheda NVIDIA (CUDA 12, oppure CUDA 13 con driver 580+, altrimenti Vulkan) e la scarica da sola al primo messaggio in chat
