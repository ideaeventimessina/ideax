// Limiti che ideax applica sempre, qualunque modello si usi e qualunque impostazione:
// niente contenuti sessuali con minori (o persone descritte come tali). Vale per chat, Studio, API e sistemi collegati.
const MINOR_WORDS = /\b(bambin[aoie]|ragazzin[aoie]|minorenn[ei]|bimb[aoie]|neonat[aoie]|scolar[aoe]|adolescent[ei]|teen(ager)?s?|child(ren)?|kids?|minors?|underage|loli|shota|preteen|schoolgirls?|schoolboys?|liceal[ei]|jailbait)\b/i;
const AGES = /\b(\d{1,2})\s*(anni|years?[\s-]*old|yo|y\.o\.)/gi;
const SEXUAL = /\b(nud[aoie]|nudit[aà]|sess[oi]|sessual\w*|porn\w*|erotic\w*|eroti\w*|nsfw|hentai|explicit|esplicit\w*|naked|nude|sex\w*|topless|lingerie|intim\w*|orgasm\w*|genital\w*)\b/i;

export function blockedReason(text) {
  const t = String(text || '');
  if (!SEXUAL.test(t)) return null;
  const minorAge = [...t.matchAll(AGES)].some((m) => Number(m[1]) < 18) || /\b([1-9]|1[0-7])\s*-?\s*enn[ei]\b|\b(dodic|tredic|quattordic|quindic|sedic|diciassett)enn[ei]\b/i.test(t);
  if (MINOR_WORDS.test(t) || minorAge) {
    return 'Richiesta rifiutata: ideax non crea mai contenuti sessuali che coinvolgono minori o persone descritte come minori.';
  }
  return null;
}

// Divise, uniformi e costumi da studentessa in una scena per adulti sono ammessi (college, università, gioco di
// ruolo): perché il modello non disegni visi da ragazzina, al prompt si aggiunge che sono adulte, e ai difetti da
// evitare tutto ciò che sembra giovane.
const UNIFORM = /\b(divis[ae]|uniform[ei]?|uniforms?|college|universitari[ae]|studentess[ae]|student[ei]?|cheerleader|gonnellin[ao] a quadri|plaid skirt)\b/i;
export function adultGuard(prompt, negative = '') {
  const t = String(prompt || '');
  if (!SEXUAL.test(t) || !UNIFORM.test(t)) return { prompt: t, negative };
  return {
    prompt: `${t}, adult women over 25 years old, mature adult faces and bodies`,
    negative: [negative, 'child, teen, young-looking, childlike face, petite, flat chest, school child'].filter(Boolean).join(', '),
  };
}
