// L'ORCHESTRATORE A REGOLE: nei casi chiari il motore lo scelgono queste regole, non il cervello.
// Il cervello resta per i casi ambigui e per le conversazioni. Il perché: un cervello da 8 miliardi di parametri che
// decide da solo sbaglia proprio dove l'errore si vede di più (un'immagine al posto di un racconto, un video al posto
// di una risposta). Le regole sono scritte qui, in un posto solo, e ogni scelta è provata dal banco di prova
// (test/banco.mjs): a ogni versione si controlla che ogni richiesta del banco vada ancora al motore giusto.
//
// decide({ testo, allegati: [{type}], ultima: 'scrittura' | null, puo: Set di capacità installate })
//   → { azione, motivo } oppure null (decide il cervello)

const T = (re) => (s) => re.test(s);

// Le schede dei motori: cosa fa ognuno, quando sceglierlo e cosa gli serve. Le legge anche il cervello (systemPrompt).
export const SCHEDE = {
  scrittura: 'Testi: racconti, barzellette, scene, poesie, lettere, descrizioni, anche per adulti. Il seguito di un testo resta testo.',
  trascrivi: 'Trascrizione di audio o video allegati (Whisper): note vocali, interviste, sottotitoli.',
  vista: 'Domande su una foto allegata (cervello VL): cosa c\'è, chi, quante persone, leggere un testo, giudicare.',
  fotomontaggio: 'Trasformare una foto vera tenendo il volto (Qwen-Image-Edit o Kontext): temi, costumi, sfondi, vestiti.',
  ingrandisci: 'Ingrandire 4 volte una foto per la stampa (4x-UltraSharp).',
  anima: 'Far muovere una foto allegata (Wan 2.2): da foto a video.',
  personaggio: 'Un personaggio (non il gemello) che dice un testo con una voce, con le labbra a tempo.',
  video_gemello: 'Un video dell\'utente stesso che dice un testo (gemello video + voce clonata).',
  video_montato: 'Video montato con più clip, musica e montaggio di Impagino.',
  reel: 'Reel verticale completo: testo, voce, immagini, musica, sottotitoli.',
  musica: 'Musica, basi, jingle, canzoni (ACE-Step).',
  voce: 'Leggere un testo ad alta voce con una voce.',
  video: 'Video da testo (Wan 2.2), partendo da una foto rifinita.',
  immagine: 'Immagini da testo (Flux, SDXL, MOSS; con scritte dentro: Qwen-Image), con pelle e volti rifiniti.',
};

const IMG = (a) => a.some((x) => x.type?.startsWith('image/'));
const AUDIO = (a) => a.some((x) => /^(audio|video)\//.test(x.type || ''));

const is = {
  trascrivi: T(/\b(trascriv\w*|trascrizion\w*|cosa dice|che dice|sottotitol\w*|metti(lo)? per iscritto|scrivi (quello|cosa) che dice)\b/i),
  ingrandisci: T(/\b(ingrandisc\w*|ingrandiment\w*|aumenta (la )?risoluzione|alta risoluzione|upscal\w*|per la stampa|più nitid\w*|4k|8k)\b/i),
  anima: T(/\b(anima\w*|fall[ao] muovere|fai muovere|muover\w*|in movimento|video|clip|gif)\b/i),
  modifica: T(/\b(trasform\w*|mettil[aoie]|metti(mi|ci|gli|le)?\b|fall[aoie]\b|fammel[aoe]|cambia\w*|rendil[aoie]|rendi\b|aggiungi\w*|togli\w*|rimuovi\w*|cancella\w*|vesti\w*|sostituisc\w*|come se|in stile|versione|ritocc\w*|modific\w*|sfondo|travestit\w*|costume|diventa|vestito da|vestita da)\b/i),
  // Una modifica vera (non solo "falla…", che vale anche per "falla muovere")
  modificaForte: T(/\b(trasform\w*|cambia\w*|aggiungi\w*|togli\w*|rimuovi\w*|cancella\w*|vesti\w*|sostituisc\w*|in stile|ritocc\w*|modific\w*|sfondo|travestit\w*|costume|diventa|vestit[oa] da)\b/i),
  domanda: T(/\?\s*$|^\s*(chi|cosa|che cosa|quant[aieo]|qual[ei]?|dove|quando|perch[eé]|com['e]|descriv\w*|analizz\w*|leggi\b|leggimi cosa|conta\b|dimmi|spiega\w*|riconosc\w*|identific\w*|valuta|giudica|che ne pensi)/i),
  personaggio: T(/\b(personaggio|avatar|presentator[ei]|presentatrice|testimonial|influencer|attore|attrice|speaker|annunciat\w*)\b/i),
  parla: T(/\b(parl\w*|dic[ae]\b|dica|dice|dicono|racconti|legga|pronunci\w*|annunci\w*|saluti|recit\w*)\b/i),
  gemello: T(/\b(video (di|con) me|io che (dico|parlo)|il mio gemello|me stesso che|me che (dico|parlo))\b/i),
  montato: T(/\b(video montat\w*|montaggio|più clip|catena di clip|impagino)\b/i),
  reel: T(/\breel\b/i),
  musica: T(/\b(musica|canzon\w*|basi?\b|jingle|brano|melodia|colonna sonora)\b/i),
  voce: T(/\b(leggi(lo|la)? con (la )?voce|leggimi\b|fammi sentire|ad alta voce|con la voce di|voce di \w+ che legge)\b/i),
  video: T(/\b(video|clip|filmato|animazione)\b/i),
  immagine: T(/\b(immagin\w*|foto\w*|ritratt\w*|disegn\w*|illustra\w*|locandin\w*|poster|volantin\w*|copertin\w*|invit[oi]|logo|sfondo|wallpaper|banner|sticker|adesiv\w*|cartolin\w*|render\w*)\b/i),
  crea: T(/\b(crea\w*|genera\w*|compon\w*|fa(mmi|i|cci)\b|disegna\w*|realizza\w*|produci|prepara\w*|voglio|vorrei|mi serve)\b/i),
  scrittura: T(/\b(raccont\w*|scrivi\w*|scrivimi|stori[ae]|novella|poesi[ae]|descrivimi una scena|dialogo|fantasia|monologo|lettera|barzellett\w*|filastrocc\w*|testo di|discorso)\b/i),
};

export function decide({ testo = '', allegati = [], ultima = null, puo = null } = {}) {
  const t = String(testo).trim();
  const can = (x) => !puo || puo.has(x);
  const ok = (azione, motivo) => (can(azione) ? { azione, motivo } : null);

  // Allegati: chi c'è allegato decide la famiglia
  if (AUDIO(allegati) && !IMG(allegati) && (!t || is.trascrivi(t))) return ok('trascrivi', 'audio o video allegato da trascrivere');
  if (IMG(allegati)) {
    if (is.ingrandisci(t)) return ok('ingrandisci', 'foto allegata da ingrandire');
    if (is.anima(t) && !is.modificaForte(t)) return ok('anima', 'foto allegata da far muovere');
    if (is.modifica(t)) return ok('fotomontaggio', 'foto allegata da trasformare');
    if (!t || is.domanda(t)) return ok('vista', 'domanda su una foto allegata');
    return null;
  }

  // Video con persone che parlano
  if (is.gemello(t)) return ok('video_gemello', 'video dell\'utente che parla');
  if (is.personaggio(t) && is.parla(t)) return ok('personaggio', 'un personaggio che parla');
  if (is.montato(t)) return ok('video_montato', 'video montato con più clip');
  if (is.reel(t)) return ok('reel', 'reel completo');

  // Testi: il seguito di un testo resta testo; le richieste di scrittura vanno allo scrittore
  const media = is.immagine(t) || is.video(t) || is.musica(t) || is.voce(t);
  if (ultima === 'scrittura' && !media) return ok('scrittura', 'seguito di un testo');
  if (is.scrittura(t) && !media) return ok('scrittura', 'richiesta di un testo');

  // Creazioni esplicite
  if (is.voce(t)) return ok('voce', 'testo da leggere ad alta voce');
  if (is.musica(t) && (is.crea(t) || /^\s*(una|un|della)\b/i.test(t))) return ok('musica', 'musica da comporre');
  if (is.video(t) && is.crea(t)) return ok('video', 'video da creare');
  if (is.immagine(t) && is.crea(t)) return ok('immagine', 'immagine da creare');
  return null;
}
