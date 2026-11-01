// Limiti che ideax applica sempre, qualunque modello si usi e qualunque impostazione:
// niente contenuti sessuali con minori (o persone descritte come tali). Vale per chat, Studio, API e sistemi collegati.
const MINOR_WORDS = /\b(bambin[aoie]|ragazzin[aoie]|minorenn[ei]|bimb[aoie]|neonat[aoie]|scolar[aoe]|adolescent[ei]|teen(ager)?s?|child(ren)?|kids?|minors?|underage|loli|shota|preteen|schoolgirls?|schoolboys?)\b/i;
const AGES = /\b(\d{1,2})\s*(anni|years?[\s-]*old|yo|y\.o\.)/gi;
const SEXUAL = /\b(nud[aoie]|nudit[aà]|sess[oi]|sessual\w*|porn\w*|erotic\w*|eroti\w*|nsfw|hentai|explicit|esplicit\w*|naked|nude|sex\w*|topless|lingerie|intim\w*|orgasm\w*|genital\w*)\b/i;

export function blockedReason(text) {
  const t = String(text || '');
  if (!SEXUAL.test(t)) return null;
  const minorAge = [...t.matchAll(AGES)].some((m) => Number(m[1]) < 18);
  if (MINOR_WORDS.test(t) || minorAge) {
    return 'Richiesta rifiutata: ideax non crea mai contenuti sessuali che coinvolgono minori o persone descritte come minori.';
  }
  return null;
}
