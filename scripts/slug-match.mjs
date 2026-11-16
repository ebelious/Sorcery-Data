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

/* Every printing slug a card has: the one it shows by default (`sl`) first, then each of
   its printings (`prints[].sl` -- foils, other sets, promos), each once. cards.json gives
   every printing its own slug, and its own file; reading only `sl` left all the others
   with no art, and counted their files as "unmatched". */
function printingSlugs(c) {
  const out = [];
  if (c && c.sl) out.push(c.sl);
  if (c && Array.isArray(c.prints)) {
    for (const p of c.prints) if (p && p.sl && !out.includes(p.sl)) out.push(p.sl);
  }
  return out;
}

/* EVERY printing cards.json lists, as slug -> set code. The set code is the slug's first
   segment ("004-13_treasures_of_britain-b-f" -> "004"), which is also the folder its art
   lives in: images/<set>/<slug>.webp. Used by seed-from-cdn.mjs and prepare-card-images.mjs
   to know what art is wanted. */
export function allPrintings(cards) {
  const wanted = new Map();
  for (const c of cards) {
    for (const sl of printingSlugs(c)) {
      if (!wanted.has(sl)) wanted.set(sl, String(sl).split('-')[0]);
    }
  }
  return wanted;
}

/* Every slug cards.json names, every printing included, for the exact-name check in
   slugForFile: the publisher names files by slug, so a foil file is matched to the foil
   printing directly. */
export function knownSlugSet(cards) {
  const known = new Set();
  for (const c of cards) for (const sl of printingSlugs(c)) known.add(sl);
  return known;
}

/* Every printing slug, indexed by its flattened card name, for files named by hand. The
   default printing comes first in each list, so a plain "Card Name.png" still goes to the
   card's default printing as before; "Card Name foil.png" finds the -f printing. */
export function indexBySlugCore(cards) {
  const byCore = new Map();
  for (const c of cards) {
    for (const sl of printingSlugs(c)) {
      const key = slugCore(sl) || flatten(c.n);
      if (!byCore.has(key)) byCore.set(key, []);
      const list = byCore.get(key);
      if (!list.includes(sl)) list.push(sl);
    }
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
