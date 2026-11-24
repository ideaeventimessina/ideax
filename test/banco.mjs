// BANCO DI PROVA DELL'ORCHESTRATORE: richieste vere con il motore giusto accanto. Gira a ogni build: se una scelta
// cambia, la release non esce. Chi aggiunge una regola aggiunge qui le richieste che la provano.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../lib/decidi.js';
import { contaFollower, profiloRichiesto } from '../lib/follower.js';

const img = [{ type: 'image/jpeg' }];
const aud = [{ type: 'audio/ogg' }];
const vid = [{ type: 'video/mp4' }];

const CASI = [
  ['Genera solo codice JavaScript: scrivi una funzione per classificare un’immagine o un video', [], null, 'codice'],
  ['Implementa una funzione Python che normalizza i nomi dei file video', [], null, 'codice'],
  ['Write a JavaScript function that detects a video MIME type', [], null, 'codice'],
  ['Genera un codice QR per un invito', [], null, 'immagine'],
  // testo
  ['raccontami una barzelletta', [], null, 'scrittura'],
  ['raccontami una scena erotica', [], null, 'scrittura'],
  ['scrivi un brevissimo racconto erotico con 2 donne ed un uomo', [], null, 'scrittura'],
  ['scrivimi una poesia per mia madre', [], null, 'scrittura'],
  ['più breve ed esplicito', [], 'scrittura', 'scrittura'],
  ['voglio che sei più breve ed esplicito, parla di cazzo vagina figa', [], 'scrittura', 'scrittura'],
  ['continua', [], 'scrittura', 'scrittura'],
  ['scrivi una lettera di auguri per un matrimonio', [], null, 'scrittura'],
  ['raccontami una storia della buonanotte', [], null, 'scrittura'],
  ['scrivi il testo di un discorso per i 18 anni', [], null, 'scrittura'],
  // conversazione: decide il cervello
  ['che ne pensi del mare', [], null, null],
  ['come posso fare squirtare la mia ragazza', [], null, null],
  ['ciao come stai', [], null, null],
  ['quali sono le mie aziende?', [], null, null],
  ['ricordati che mia figlia si chiama Giulia', [], null, null],
  // immagini
  ['fammi una foto del mare al tramonto', [], null, 'immagine'],
  ['crea un\'immagine di un gatto astronauta', [], null, 'immagine'],
  ['genera un ritratto di una donna in abito rosso', [], null, 'immagine'],
  ['crea una locandina con scritto "Festa di Giulia 18 anni"', [], null, 'immagine'],
  ['fammi un invito per il matrimonio di Anna e Marco', [], null, 'immagine'],
  ['disegna un logo per una pizzeria', [], null, 'immagine'],
  ['vorrei uno sfondo per il telefono con le montagne', [], null, 'immagine'],
  // foto allegata
  ['trasforma questa persona in una fata', img, null, 'fotomontaggio'],
  ['mettila in costume da bagno su una spiaggia', img, null, 'fotomontaggio'],
  ['cambia lo sfondo con una spiaggia', img, null, 'fotomontaggio'],
  ['togli la persona dietro', img, null, 'fotomontaggio'],
  ['rendila in stile anime', img, null, 'fotomontaggio'],
  ['vestilo da astronauta', img, null, 'fotomontaggio'],
  ['ingrandisci questa foto per la stampa', img, null, 'ingrandisci'],
  ['aumenta la risoluzione', img, null, 'ingrandisci'],
  ['falla muovere', img, null, 'anima'],
  ['animala con i capelli al vento', img, null, 'anima'],
  ['fanne un video', img, null, 'anima'],
  ['cosa c\'è in questa foto?', img, null, 'vista'],
  ['quante persone ci sono?', img, null, 'vista'],
  ['descrivi questa immagine', img, null, 'vista'],
  ['leggi il testo nella foto', img, null, 'vista'],
  ['', img, null, 'vista'],
  // audio
  ['', aud, null, 'trascrivi'],
  ['trascrivi questo vocale', aud, null, 'trascrivi'],
  ['cosa dice?', aud, null, 'trascrivi'],
  ['fammi i sottotitoli', vid, null, 'trascrivi'],
  // persone che parlano
  ['fammi un video di me che dico buongiorno a tutti', [], null, 'video_gemello'],
  ['un personaggio che dice "benvenuti alla festa"', [], null, 'personaggio'],
  ['crea una presentatrice bionda che annuncia gli sposi', [], null, 'personaggio'],
  ['un avatar che legga le offerte della settimana', [], null, 'personaggio'],
  // demo di un sito
  ['registra una demo del sito pianifico', [], null, 'demo'],
  ['fammi un video dimostrativo del gestionale', [], null, 'demo'],
  ['registra lo schermo mentre usi la app', [], null, 'demo'],
  // video e montaggi
  ['crea un video di una ragazza che cammina sulla spiaggia', [], null, 'video'],
  ['genera una clip di un drone sopra Messina', [], null, 'video'],
  ['fammi un video montato della giornata in laboratorio', [], null, 'video_montato'],
  ['prepara un montaggio con 6 clip della festa', [], null, 'video_montato'],
  ['fammi un reel su 3 errori dei ristoranti', [], null, 'reel'],
  // musica e voce
  ['crea una musica lo-fi rilassante', [], null, 'musica'],
  ['componi un jingle per la radio', [], null, 'musica'],
  ['fammi una canzone per il compleanno di Luca', [], null, 'musica'],
  ['leggimi questo testo: buongiorno a tutti', [], null, 'voce'],
  ['leggilo con la voce di Nicola', [], null, 'voce'],
];

for (const [testo, allegati, ultima, atteso] of CASI) {
  test(`${atteso ?? 'cervello'} ← "${testo || '(solo allegato)'}"${allegati.length ? ` + ${allegati[0].type}` : ''}${ultima ? ' (dopo un testo)' : ''}`, () => {
    assert.equal(decide({ testo, allegati, ultima })?.azione ?? null, atteso);
  });
}

test('un motore non installato non si sceglie: decide il cervello', () => {
  assert.equal(decide({ testo: 'ingrandisci', allegati: img, puo: new Set(['vista']) }), null);
  assert.equal(decide({ testo: 'ingrandisci', allegati: img, puo: new Set(['ingrandisci']) }).azione, 'ingrandisci');
});

test('un personaggio salvato chiarisce il formato anche dopo una risposta di scrittura', () => {
  const contesto = { personaggioSalvato: 'Anita', ultima: 'scrittura' };
  assert.equal(decide({ ...contesto, testo: 'Fammi Anita sul balcone' }).azione, 'chiarisci_personaggio');
  assert.equal(decide({ ...contesto, testo: 'Genera un’immagine di Anita sul balcone' }).azione, 'immagine');
  assert.equal(decide({ ...contesto, testo: 'Scrivi un racconto di Anita' }).azione, 'scrittura');
  assert.equal(decide({ testo: 'Fammi Anita sul balcone' }), null);
  assert.equal(decide({ testo: 'OK CREA BABBO NATALE CON UNA SCIARPA', ultima: 'immagine' }).azione, 'immagine');
  assert.equal(decide({ testo: 'OK CREA BABBO NATALE CON UNA SCIARPA' }), null);
  assert.equal(decide({ testo: 'OK CREA UN VIDEO DI BABBO NATALE', ultima: 'immagine' }).azione, 'video');
  for (const testo of ['Più luce calda', 'Stavolta con la neve', 'Rendila più luminosa', 'Perfetto, ora fammi una variante', 'Rifammi Babbo Natale con la neve']) {
    assert.equal(decide({ testo, ultima: 'immagine' })?.azione, 'immagine');
    assert.equal(decide({ testo }), null);
  }
  assert.equal(decide({ testo: 'Con quale modello?', ultima: 'immagine' }), null);
  assert.equal(decide({ testo: 'MI FAI A BABBO NATALE CON UNA SCIARPA' })?.azione, 'immagine');
  assert.equal(decide({ testo: 'Mi fai un preventivo con tre opzioni?' }), null);
  assert.equal(decide({ testo: 'Crea i sette nani seduti', ultima: 'scrittura' })?.azione, 'immagine');
  assert.equal(decide({ testo: 'Crea una storia su sette nani seduti', ultima: 'immagine' })?.azione, 'scrittura');
});

test('un testo per un servizio fotografico o un reel resta un testo', () => {
  assert.equal(decide({ testo: 'Scrivi tre idee per un servizio fotografico glamour' }).azione, 'scrittura');
  assert.equal(decide({ testo: 'Scrivi il copione di un reel per un negozio' }).azione, 'scrittura');
  assert.equal(decide({ testo: 'Genera un reel per un negozio' }).azione, 'reel');
});

test('la ricerca follower riconosce la richiesta e somma solo i profili verificabili', async () => {
  assert.equal(profiloRichiesto('conta tutti i follower di ideaeventi che trovi su tutti i social'), 'ideaeventi');
  assert.equal(profiloRichiesto('crea una pagina per contare i follower di ideaeventi'), null);
  const leggi = async (url) => {
    if (url === 'https://www.ideaeventi.com/') return '<script type="application/ld+json">{"sameAs":["https://www.instagram.com/ideaeventi4.0"]}</script>';
    if (url === 'https://www.instagram.com/ideaeventi4.0') return '<meta property="og:description" content="1,234 Followers, 900 Following">';
    if (url === 'https://www.youtube.com/@ideaeventi4.0') return '<title>IDEAeventi 4.0 - YouTube</title>{"accessibilityLabel":"171 iscritti"}';
    throw new Error('Richiesta inattesa');
  };
  const cerca = async () => ({ risultati: [{ url: 'https://facebook.com/altro-profilo', titolo: '10K Followers' }] });
  const report = await contaFollower('ideaeventi', cerca, leggi);
  assert.match(report, /Instagram — 1\.234/);
  assert.match(report, /YouTube — 171/);
  assert.match(report, /1\.405 su 2 piattaforme/);
  assert.doesNotMatch(report, /altro-profilo/);
});
test('Studio instrada una foto da animare invece di ritoccarla', async () => {
  const { studioPhotoMotion } = await import('../lib/router.js');
  const prompt = 'Anima questa foto: camera ferma, 3 secondi';
  assert.deepEqual(studioPhotoMotion({ prompt, task: 'image_edit', attachments: img }), {
    task: 'image_to_video', params: { seconds: 3, veloce: true },
  });
  assert.equal(studioPhotoMotion({ prompt: 'Cambia lo sfondo in questa foto', task: 'image_edit', attachments: img }), null);
});
