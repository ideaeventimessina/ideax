## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.11.0.exe** e aprilo.

## Correzione: il cervello non si blocca più
- Se il cervello di riserva non riesce a partire (per esempio un modello troppo grande per la scheda), ideax continua con il cervello principale invece di fermarsi
- In automatico come riserva si usano solo cervelli fino a 13 GB; più grandi si possono ancora scegliere a mano
- Quando un cervello non parte, il messaggio dice il motivo vero: modello non supportato, memoria insufficiente, oppure l'errore preciso

## Novità: MOSS-Image
- Nuovo motore **MOSS-Image** (pagina Modelli → Motori): ideax installa ComfyUI e scarica MOSS-Image già preparato per una scheda da 16 GB (circa 30 GB in tutto)
- Compare tra i modelli come "MOSS-Image" e segue alla lettera prompt lunghi e dettagliati
- Le **LoRA fatte per Moss** (es. Mystic XXX) vengono riconosciute da sole e applicate quando usi MOSS-Image
