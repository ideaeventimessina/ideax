# Il cervello di ideax: memoria, chat e addestramento rapido

ideax conversa con te come un collaboratore che ti conosce. Tutto gira sul tuo PC:

- **Ricordi** (`data/cervello/memoria.json`): frasi brevi su di te, divise per categoria (chi sei, lavoro, progetti, persone,
  gusti, come comunicare, regole). Valgono in **tutte** le chat. Si vedono, correggono e cancellano in *Cervello → Cosa so di te*.
- **Chat** (`data/cervello/chat/`): ogni conversazione è un file. Una chat può cercare e leggere le altre.
- **Strumenti**: creazioni (immagini, video, animazioni, voce, musica, reel), GitHub, altre chat, maestri.

## Insegnargli in fretta

1. **Intervista**: *Cervello → Inizia l'intervista*. ideax ti fa una domanda alla volta e si segna le risposte.
2. **Testi**: incolla o allega appunti, profili, documenti, l'esportazione della memoria di un altro assistente. Il cervello ne estrae i fatti.
3. **Da un altro cervello (es. Axel)**: ideax gli fa una serie di domande su di te e salva le risposte come ricordi.
   La conversazione completa resta nella chat "Lezione da Axel". Poi, in qualsiasi chat, ideax può chiedere ad Axel quello che non sa.

## Collegare Axel

In *Cervello → Impara da Axel → Collega un cervello* scegli uno dei due modi.

**Compatibile chat/completions** (il formato di OpenAI, usato da quasi tutti i servizi e dai server locali):

- Indirizzo: la base dell'API, es. `https://api.tuoservizio.it/v1` (ideax chiama `<indirizzo>/chat/completions`)
- Modello: il nome del modello o dell'assistente
- Chiave: la chiave API, se serve (inviata come `Authorization: Bearer …`)

**Webhook semplice**: un indirizzo che riceve in POST

```json
{ "message": "Chi è la persona che segui?", "question": "…", "from": "ideax", "system": "…" }
```

e risponde con uno di questi campi: `reply`, `answer`, `text`, `message`, `output`.

Premi **Prova** per verificare il collegamento, poi **Impara da Axel**.

## Dalle tue app (es. billpro)

```bash
# Parlare con ideax (ripassa chat_id per continuare)
curl http://localhost:7800/v1/chat -H 'Content-Type: application/json' -d '{"message":"Preparami tre idee per il post di domani"}'

# Passargli quello che il tuo sistema sa già
curl http://localhost:7800/v1/memory/import -H 'Content-Type: application/json' -d '{"text":"…","source":"billpro"}'
```

Compatibile OpenAI: le app che usano `chat/completions` possono usare ideax come modello cambiando solo `base_url`
in `http://<pc>:7800/v1` (con `user` la conversazione continua nella stessa chat).

## GitHub

In *Cervello → GitHub* incolla un token (fine-grained, con i permessi *Contents*, *Issues*, *Pull requests* sui repository che vuoi).
Senza **Permetti modifiche** ideax può solo cercare, leggere e scaricare (in `data/repository`). Con le modifiche attive
può fare commit, creare rami, issue e pull request, ma solo quando glielo chiedi.
