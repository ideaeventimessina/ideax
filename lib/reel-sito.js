const controlli = [
  ['menu', /\bmenu\s+mobil\w*/i, 'Apri il menu da telefono e controlla che ogni voce sia facile da toccare.'],
  ['contrasto', /\bcontrasto\b/i, 'Misura il contrasto tra testo e sfondo, per mantenere leggibili anche le scritte piccole.'],
  ['contatti', /\bmodul\w*\s+(?:di\s+)?contatt\w*/i, 'Invia il modulo contatti e verifica che il messaggio arrivi davvero.'],
  ['velocita', /\bvelocit[aà](?!\w)/i, 'Misura il caricamento su rete mobile e alleggerisci le immagini più pesanti.'],
  ['link', /\blink\s+(?:rott\w*|interrott\w*)/i, 'Cerca i link rotti e correggi gli indirizzi che riportano un errore.'],
];

export function pianoControlliSito(tema, punti) {
  if (punti !== 5 || !/\b(?:sito|website|pagina web)\b/i.test(tema)) return null;
  const trovati = controlli.map(([id, regola, frase]) => ({ id, ordine: tema.search(regola), frase }));
  if (trovati.some(({ ordine }) => ordine < 0)) return null;
  return {
    title: 'Cinque controlli prima di pubblicare un sito',
    scenes: trovati.sort((a, b) => a.ordine - b.ordine).map(({ id, frase }, i) => ({
      text: (i + 1) + '. ' + frase, controlloSito: id, duration: 0,
    })),
    music: 'Sottofondo strumentale calmo',
  };
}
