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
import { indexBySlugCore, slugForFile, knownSlugSet, allPrintings } from './slug-match.mjs';

const [, , SRC, REPO, ...flags] = process.argv;
const DRY = flags.includes('--dry');

if (!SRC || !REPO) {
  console.error('usage: node prepare-card-images.mjs <downloaded-folder> <repo-folder> [--dry]');
  process.exit(1);
}
if (!fs.existsSync(SRC)) { console.error('downloaded-folder does not exist: ' + SRC); process.exit(1); }
/* The destination is only needed when something is actually being written. Requiring it up
   front meant a dry run -- the very thing you do before committing to anything -- failed
   unless you had already made the folder it promises not to touch. */
if (!DRY && !fs.existsSync(REPO)) {
  fs.mkdirSync(REPO, { recursive: true });
  console.log('Created ' + REPO);
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
/* EVERY printing, not just the one each card shows by default.
   Counting only defaults was why a folder full of foils came back as eleven hundred
   "unmatched" files: they are not unmatched, they are printings this list never asked
   about. The shared matcher was taught about them; this count was not. */
const wanted = allPrintings(cards);   // slug -> set code
const defaults = cards.filter(c => c.sl).length;
console.log('cards.json asks for ' + wanted.size + ' images (' + defaults +
            ' cards, ' + (wanted.size - defaults) + ' further printings).');
if (wanted.size === defaults) {
  console.warn('');
  console.warn('  No alternate printings are listed. If foils are expected, cards.json was');
  console.warn('  built before printing slugs were carried through -- re-run fetch-cards.js.');
  console.warn('');
}

/* Matching a file to a printing lives in slug-match.mjs, so that this, the seeder and the
   downloader cannot drift apart -- see the note at the top of that file. */
const byCore = indexBySlugCore(cards);
const known = knownSlugSet(cards);

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

const plan = [];                   // { from, to, slug }
const unmatched = [];
for (const file of files) {
  const slug = slugForFile(path.basename(file), byCore, known);
  /* null means either no card of that name, or a finish with no slug of its own -- a foil
     with no foil printing recorded. slug-match refuses to fit that to another printing,
     because writing foil art over standard art is worse than having none. */
  if (!slug) { unmatched.push(file); continue; }
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
