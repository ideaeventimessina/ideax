## Come aggiornare
Se hai già ideax installato, premi **Aggiorna ora** quando compare. Altrimenti scarica **ideax-setup-1.2.0.exe** e aprilo.

## Novità: ideax si collega ai vostri sistemi
- **Chiavi API**: una per ogni sistema (gestionale, sito, app…), create e revocate da *Collega app*. Dagli altri computer servono, da questo PC no
- **Webhook**: con `callback_url` ideax chiama il vostro sistema a lavoro finito, con firma HMAC per verificarne l'origine
- **Invio di file in multipart**, come fanno quasi tutti i sistemi, oltre al JSON
- **Archivio via API**: elenco, ricerca, dettaglio ed eliminazione delle creazioni
- **metadata**: dati vostri (es. numero d'ordine) che tornano nel risultato, nel webhook e nell'archivio
- **Stato del servizio** (`/v1/health`) e **specifica OpenAPI** (`/v1/openapi.json`) per Postman e simili
- Client JavaScript e Python aggiornati, esempi pronti anche per PHP
- Nell'interfaccia: pulsante per eliminare una creazione
