// Turns a folder of card art downloaded from the publisher's public image folder into the
// layout the app expects, ready to commit to the images repository.
//
// WHY THIS EXISTS
// The card API's terms are explicit on two points: images are not in the API, and their
// private CDN may not be used to serve them. Released art is to be downloaded from the
// public folder and hosted by whoever is using it. So: download that folder by hand (it is
// a Google Drive share, which cannot be scripted), point this at it, and it produces the
// tree the app reads:
//
//     Sorcery-Data/images/<set-code>/<printing-slug>.webp
//                                       e.g. images/004/004-avalon-b-s.webp
//
// The app builds exactly that path from the `sl` field in cards.json, so once this has run
// and the result is committed, nothing else needs changing.
//
// WHERE THINGS LIVE
//     source art   https://drive.google.com/drive/folders/17IrJkRGmIU9fDSTU2JQEU9JlFzb5liLJ
//                  (the publisher's public folder -- a Drive share, so it is downloaded
//                   by hand; there is no scriptable link)
//     destination  https://github.com/ebelious/Sorcery-Data  ->  images/<set>/<slug>.webp
//                  served over GitHub Pages, alongside cards.json in the same repository
//
// USAGE
//     node prepare-card-images.mjs <downloaded-folder> path/to/Sorcery-Data/images [--dry]
//
// Pass the images/ subfolder, not the repository root -- cards.json sits at the root and
// the app expects art one level down from it.
//
// It never deletes anything and never overwrites a file that is already correct, so it is
// safe to re-run after each new set: only genuinely new art is written.
//
// WEBP
// Conversion needs `sharp` (npm i sharp). Worth it: the full art set is well over a
// gigabyte as PNG and a fraction of that as webp, which matters for a git repository and
// for every reader who opens the card grid. Without sharp the script still reports what it
// found and what is missing, but writes nothing.

import fs from 'node:fs';
import path from 'node:path';

const [, , SRC, REPO, ...flags] = process.argv;
const DRY = flags.includes('--dry');

if (!SRC || !REPO) {
  console.error('usage: node prepare-card-images.mjs <downloaded-folder> <repo-folder> [--dry]');
  process.exit(1);
}
for (const [label, dir] of [['downloaded-folder', SRC], ['repo-folder', REPO]]) {
  if (!fs.existsSync(dir)) { console.error(label + ' does not exist: ' + dir); process.exit(1); }
}

/* cards.json is the authority on what art is wanted and what each file must be called.
   Built by fetch-cards.js from the API; every printing carries its own slug. */
const CARDS_FILE = process.env.CARDS_FILE || 'cards.json';
if (!fs.existsSync(CARDS_FILE)) {
  console.error('Could not find ' + CARDS_FILE + ' -- run fetch-cards.js first.');
  process.exit(1);
}
const cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || [];

/* Every printing slug the app might ask for. A card's `sl` is the one it shows by default;
   `prints` covers the others, whose slugs follow the same shape. */
const wanted = new Map();          // slug -> { set, name }
for (const c of cards) {
  if (c.sl) wanted.set(c.sl, { set: String(c.sl).split('-')[0], name: c.n });
}
console.log('cards.json asks for ' + wanted.size + ' images.');

/* Match a downloaded file to a slug by NAME, not by position or order.
   Files come out of the shared folder named all sorts of ways, so the comparison is made
   on a flattened form -- lower case, everything that is not a letter or digit removed --
   which survives spaces, punctuation, apostrophes and accents differing between the two
   sides. A slug like "004-13_treasures_of_britain-b-s" flattens the same way its file
   does once the set code and finish suffix are stripped off. */
function flatten(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}
function slugCore(slug) {
  const parts = String(slug).split('-');
  return flatten(parts.slice(1, parts.length - 2).join('-') || parts[1] || '');
}

const byCore = new Map();          // flattened card name -> [slug, ...]
for (const [slug, meta] of wanted) {
  const key = slugCore(slug) || flatten(meta.name);
  if (!byCore.has(key)) byCore.set(key, []);
  byCore.get(key).push(slug);
}

/* Walk the download, including subfolders -- the shared folder is usually split by set. */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(png|jpe?g|webp)$/i.test(e.name)) out.push(p);
  }
  return out;
}
const files = walk(SRC);
console.log('Found ' + files.length + ' image files under ' + SRC);

/* A file whose name contains "foil" belongs to the foil printing, and so on. The suffix on
   a slug says which finish it is: -s standard, -f foil, -rf rainbow. */
function finishOf(name) {
  const n = name.toLowerCase();
  if (/rainbow/.test(n)) return 'rf';
  if (/foil/.test(n)) return 'f';
  return 's';
}

const plan = [];                   // { from, to, slug }
const unmatched = [];
for (const file of files) {
  const base = path.basename(file).replace(/\.(png|jpe?g|webp)$/i, '');
  const key = flatten(base.replace(/foil|rainbow|standard/gi, ''));
  const candidates = byCore.get(key);
  if (!candidates || !candidates.length) { unmatched.push(file); continue; }
  const want = finishOf(base);
  let slug = candidates.find(s => s.endsWith('-' + want));
  /* No slug for this finish. Falling back to whatever else matched the NAME was wrong:
     a foil file would be written over the standard art, because cards.json carries only
     the default printing's slug and both flatten to the same card. Silently swapping one
     printing's art for another's is worse than having none, so it is left out and
     reported instead. */
  if (!slug) {
    if (want !== 's') { unmatched.push(file); continue; }
    slug = candidates[0];
  }
  const set = String(slug).split('-')[0];
  plan.push({ from: file, to: path.join(REPO, set, slug + '.webp'), slug });
}

/* Report before doing anything, so a bad match is caught before it is committed. */
const matched = new Set(plan.map(p => p.slug));
const missing = [...wanted.keys()].filter(s => !matched.has(s));
console.log('');
console.log('  matched   ' + plan.length + ' files to a printing');
console.log('  unmatched ' + unmatched.length + ' files (not in cards.json -- probably not released, or named unusually)');
console.log('  missing   ' + missing.length + ' printings have no art in the download');
if (missing.length) {
  console.log('  first few missing: ' + missing.slice(0, 8).join(', '));
}
if (unmatched.length) {
  console.log('  first few unmatched: ' + unmatched.slice(0, 5).map(f => path.basename(f)).join(', '));
}

if (DRY) { console.log('\n--dry given: nothing written.'); process.exit(0); }

let sharp = null;
try { sharp = (await import('sharp')).default; }
catch (e) {
  console.error('\nsharp is not installed, so nothing can be converted. Install it with:');
  console.error('    npm i sharp');
  console.error('Re-run afterwards, or pass --dry to see the matching without writing.');
  process.exit(1);
}

let written = 0, skipped = 0, failed = 0;
for (const item of plan) {
  try {
    /* Already there and newer than the source: leave it. Re-running after a new set should
       cost only the new set. */
    if (fs.existsSync(item.to)) {
      const a = fs.statSync(item.to).mtimeMs, b = fs.statSync(item.from).mtimeMs;
      if (a >= b) { skipped++; continue; }
    }
    fs.mkdirSync(path.dirname(item.to), { recursive: true });
    await sharp(item.from).webp({ quality: 82 }).toFile(item.to);
    written++;
    if (written % 100 === 0) console.log('  ... ' + written + ' written');
  } catch (e) {
    failed++;
    console.warn('  could not convert ' + path.basename(item.from) + ': ' + e.message);
  }
}
console.log('');
console.log('Done. ' + written + ' written, ' + skipped + ' already current, ' + failed + ' failed.');
console.log('Commit Sorcery-Data and the app will serve from it.');
