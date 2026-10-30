## Come aggiornare
Premi **Aggiorna ora** in ideax, oppure scarica **ideax-setup-1.3.3.exe** e aprilo.

## Correzioni
- **Motore voce**: si fermava al caricamento con "PerthImplicitWatermarker … not callable". La libreria della filigrana audio usa due librerie (pyyaml e pkg_resources) senza dichiararle: ora vengono installate
- Se la filigrana non si carica comunque, il motore lo scrive nel registro e prosegue invece di bloccarsi
- Dopo l'aggiornamento premi **Riprova l'installazione** nella pagina Voce: i file già scaricati vengono riutilizzati
