export const toni = {
  naturale: { velocita: 0.96, pausa: 175 },
  calma: { velocita: 0.90, pausa: 235 },
  vivace: { velocita: 1.12, pausa: 80 },
  narrativa: { velocita: 0.94, pausa: 260 },
};

export function tonoRichiesto(testo) {
  const valore = testo.match(/\btono\s+(calmo|pacato|rassicurante|vivace|energico|narrativo|naturale)\b/i)?.[1]?.toLowerCase();
  return { calmo:'calma', pacato:'calma', rassicurante:'calma', vivace:'vivace', energico:'vivace', narrativo:'narrativa', naturale:'naturale' }[valore];
}

export function segmentiVoce(testo, tono = 'naturale') {
  const profilo = toni[tono] || toni.naturale;
  const pulito = String(testo).replace(/\x60{3}[\s\S]*?\x60{3}/g, ' Blocco di codice. ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*#\x60]/g, '');
  const segmentatore = new Intl.Segmenter('it', { granularity: 'sentence' });
  const blocchi = pulito.split(/(\[\s*pausa(?:\s+lunga)?\s*\]|\n\s*\n)/i);
  const segmenti = [];
  for (const blocco of blocchi) {
    if (/^\[\s*pausa/i.test(blocco) || /^\n\s*\n$/.test(blocco)) {
      const ultimo = segmenti.at(-1);
      if (ultimo) ultimo.pausa = Math.max(ultimo.pausa, /lunga/i.test(blocco) ? 780 : 460);
      continue;
    }
    const frasi = [...segmentatore.segment(blocco)].flatMap(({ segment }) => segment.split(/(?<=;)\s*|\n+/));
    for (const frase of frasi) {
      let resto = frase.trim();
      while (resto) {
        const limite = segmenti.length ? 175 : 110;
        const finestra = resto.slice(0, limite + 1);
        const spazio = finestra.lastIndexOf(' ');
        const punto = Math.max(finestra.lastIndexOf(','), finestra.lastIndexOf(':'));
        const fine = resto.length <= limite ? resto.length : punto >= 45 ? punto + 1 : spazio > 0 ? spazio : limite;
        const input = resto.slice(0, fine).trim();
        resto = resto.slice(fine).trimStart();
        if (!/[\p{L}\p{N}]/u.test(input)) continue;
        const enfasi = /[!?…]$/.test(input);
        segmenti.push({
          input,
          velocita: profilo.velocita * (/[!?]$/.test(input) && tono === 'vivace' ? 1.06 : /[?…]$/.test(input) ? 0.94 : /[,;:]$/.test(input) ? 0.98 : 1),
          pausa: Math.round(profilo.pausa * (enfasi ? 1.6 : /[,;:]$/.test(input) ? 0.65 : /[.]$/.test(input) ? 1 : 0.45)),
        });
      }
    }
  }
  return segmenti;
}
