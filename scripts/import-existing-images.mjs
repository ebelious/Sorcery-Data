// Seeds the images repository from card art the app already holds, instead of downloading
// it all over again.
//
// WHY THIS IS WORTH DOING
// The native build already carries every released card under card-images/{set}/{slug}.webp,
// put there by download-images.mjs at build time. That is the same layout, the same naming
// and the same slugs the repository wants -- so the whole set is already sitting on disk in
// finished form. Downloading three thousand files from Drive to arrive at files we already
// have is a great deal of traffic, several hours of throttled runs, and a needless load on
// somebody else's server.
//
// Seed from what is there, commit it once, and the Drive sync from then on only ever
// fetches art for cards that did not exist at seeding time.
//
// USAGE
//     node import-existing-images.mjs <existing-card-images-folder> <repo-images-folder>
//     node import-existing-images.mjs ../Sorcery-Grimoir/card-images images
//
// Add --dry to see what it would do. Nothing is ever deleted, and a file already in place
// and identical is left alone, so it is safe to run more than once.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { indexBySlugCore, slugForFile } from './slug-match.mjs';

const [, , SRC, DEST, ...flags] = process.argv;
const DRY = flags.includes('--dry');

if (!SRC || !DEST) {
  console.error('usage: node import-existing-images.mjs <existing-card-images-folder> <repo-images-folder> [--dry]');
  process.exit(1);
}
if (!fs.existsSync(SRC)) { console.error('No such folder: ' + SRC); process.exit(1); }

const CARDS_FILE = process.env.CARDS_FILE || 'cards.json';
if (!fs.existsSync(CARDS_FILE)) {
  console.error('Could not find ' + CARDS_FILE + ' -- run fetch-cards.js first.');
  process.exit(1);
}
const cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || [];
const byCore = indexBySlugCore(cards);
const wanted = new Set(cards.filter(c => c.sl).map(c => c.sl));
console.log('cards.json asks for ' + wanted.size + ' images.');

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

/* The bundled art is already named by slug, so the filename usually IS the answer. Falling
   back to matching by card name covers anything named differently -- an older build, or
   art pulled from somewhere else. */
function slugFor(file) {
  const base = path.basename(file).replace(/\.(png|jpe?g|webp)$/i, '');
  if (wanted.has(base)) return base;
  return slugForFile(path.basename(file), byCore);
}

const plan = [];
const unmatched = [];
for (const file of files) {
  const slug = slugFor(file);
  if (!slug) { unmatched.push(file); continue; }
  const set = String(slug).split('-')[0];
  plan.push({ from: file, to: path.join(DEST, set, slug + '.webp'), slug, webp: /\.webp$/i.test(file) });
}

const have = new Set(plan.map(p => p.slug));
const missing = [...wanted].filter(s => !have.has(s));
const needConvert = plan.filter(p => !p.webp).length;

console.log('');
console.log('  matched     ' + plan.length + ' files to a printing');
console.log('  unmatched   ' + unmatched.length + ' files (not in cards.json)');
console.log('  still to get ' + missing.length + ' printings have no art here -- the Drive sync will fetch these');
if (needConvert) console.log('  to convert  ' + needConvert + ' are not webp yet');
if (missing.length) console.log('  e.g. missing: ' + missing.slice(0, 6).join(', '));
if (unmatched.length) console.log('  e.g. unmatched: ' + unmatched.slice(0, 4).map(f => path.basename(f)).join(', '));

if (DRY) { console.log('\n--dry given: nothing written.'); process.exit(0); }

let sharp = null;
if (needConvert) {
  try { sharp = (await import('sharp')).default; }
  catch (e) {
    console.error('\n' + needConvert + ' files need converting to webp and sharp is not installed:');
    console.error('    npm i sharp');
    process.exit(1);
  }
}

const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

let copied = 0, converted = 0, same = 0, failed = 0;
for (const item of plan) {
  try {
    fs.mkdirSync(path.dirname(item.to), { recursive: true });
    if (item.webp) {
      /* Already webp: a straight copy, and only when it would actually change something.
         Comparing contents rather than timestamps keeps the git history honest -- copying
         identical bytes over the top would show up as a changed file in every commit. */
      if (fs.existsSync(item.to) && sha(item.to) === sha(item.from)) { same++; continue; }
      fs.copyFileSync(item.from, item.to);
      copied++;
    } else {
      if (fs.existsSync(item.to)) { same++; continue; }
      await sharp(item.from).webp({ quality: 82 }).toFile(item.to);
      converted++;
    }
    if ((copied + converted) % 200 === 0) console.log('  ... ' + (copied + converted) + ' written');
  } catch (e) {
    failed++;
    console.warn('  could not place ' + path.basename(item.from) + ': ' + e.message);
  }
}

console.log('');
console.log('Done. ' + copied + ' copied, ' + converted + ' converted, ' + same + ' already identical, ' + failed + ' failed.');
console.log('');
console.log('Commit ' + DEST + '. From here the Drive sync only fetches art for cards that');
console.log('were not in this set -- it skips anything already present.');
