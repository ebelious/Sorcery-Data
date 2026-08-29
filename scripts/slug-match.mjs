// How a file on disk is matched to a printing, in one place.
//
// Three scripts need to agree on this: the one that seeds the repository from art the app
// already has, the one that downloads new art, and the one that sorts a download into
// place. When each had its own copy they drifted, and a drift here is silent -- art simply
// stops matching and cards go blank, with nothing in any log to say why.

/* Lower case, accents folded away, everything that is not a letter or digit removed.
   Filenames and slugs disagree about spaces, hyphens, underscores, apostrophes and
   accents; they agree about the letters. "Baba Yaga's Hut" and "baba_yagas_hut" both
   flatten to "babayagashut". */
export function flatten(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

/* The card part of a printing slug, with the set code and the product/finish suffixes
   stripped: "004-13_treasures_of_britain-b-s" -> "13treasuresofbritain". */
export function slugCore(slug) {
  const parts = String(slug).split('-');
  return flatten(parts.slice(1, parts.length - 2).join('-') || parts[1] || '');
}

/* Which printing a file is, from its name. The suffix on a slug says the same thing:
   -s standard, -f foil, -rf rainbow foil. */
export function finishOf(name) {
  const n = String(name).toLowerCase();
  if (/rainbow/.test(n)) return 'rf';
  if (/foil/.test(n)) return 'f';
  return 's';
}

/* A filename with its extension and any finish word taken off, flattened ready to compare
   against slugCore(). */
export function fileKey(filename) {
  const base = String(filename).replace(/\.(png|jpe?g|webp)$/i, '');
  return flatten(base.replace(/foil|rainbow|standard/gi, ''));
}

/* Every printing slug cards.json mentions, indexed by its flattened card name. */
/* Every slug cards.json names, for the exact-name check above. */
export function knownSlugSet(cards) {
  return new Set(cards.filter(c => c.sl).map(c => c.sl));
}

export function indexBySlugCore(cards) {
  const byCore = new Map();
  for (const c of cards) {
    if (!c.sl) continue;
    const key = slugCore(c.sl) || flatten(c.n);
    if (!byCore.has(key)) byCore.set(key, []);
    byCore.get(key).push(c.sl);
  }
  return byCore;
}

/* The slug a file belongs to, or null.
   A file whose finish has no slug of its own is deliberately NOT fitted to another
   printing: writing foil art over standard art is worse than having none, and it is the
   kind of mistake nobody notices until they are looking at the wrong picture. */
export function slugForFile(filename, byCore, knownSlugs) {
  /* The publisher names their files BY SLUG -- "006-brand_new_card-b-s.png" -- so the
     answer is usually sitting right there. Flattening such a name and looking it up by
     card would never match, because the flattened form carries the set code and the
     finish suffix that slugCore() strips off: "006brandnewcardbs" against "brandnewcard".
     Try the plain name first; fall back to matching by card for anything named by hand. */
  const bare = String(filename).replace(/\.(png|jpe?g|webp)$/i, '');
  if (knownSlugs && knownSlugs.has(bare)) return bare;
  const candidates = byCore.get(fileKey(filename));
  if (!candidates || !candidates.length) return null;
  const want = finishOf(filename);
  const exact = candidates.find(s => s.endsWith('-' + want));
  if (exact) return exact;
  return want === 's' ? candidates[0] : null;
}
