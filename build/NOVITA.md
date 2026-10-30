## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.7.0.exe** e aprilo.

## Novità: sistemi online e decorazioni per il laser
- **Sistemi online** (Collega app): IDEAlab, billpro e gli altri programmi su internet possono usare ideax senza aprire porte sul PC. È ideax che va da loro a prendere il lavoro, lo fa sulla scheda video e rimanda il risultato
- **IDEAlab**: Mathis scrive le bozze con il cervello di ideax (gratis) prima di usare Claude; nell'editor c'è **Decorazione con ideax**
- **Decorazioni per il laser**: descrivi un soggetto e ideax disegna una sagoma da tagliare o un disegno da incidere, poi lo **vettorizza in millimetri**, togliendo le parti più sottili di 3 mm e i varchi troppo stretti
- Vettorizzatore anche nell'API locale: `/v1/laser/decoration` e `/v1/laser/vectorize`
- La prima volta che vettorizza, ideax installa da solo il componente che serve (pochi secondi)

## Come collegare IDEAlab
1. Su Replit, nei Secrets di IDEAlab, aggiungi `IDEAX_KEY` con una frase lunga a caso
2. In ideax: Collega app → Sistemi online → nome IDEAlab, indirizzo di IDEAlab, la stessa chiave → Collega
