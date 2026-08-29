// A ONE-TIME, LOCAL seed of card art, run on your own machine.
//
// READ THIS FIRST
// The publisher's guidance says their private CDN may not be used to serve images, and
// that released art should be taken from their public folder. This script uses the CDN.
// It exists as a bridge, not as the way things work:
//
//   * The app already hydrates from that CDN on EVERY first launch, for every install.
//     One download here is far less traffic for them than the status quo, and it is what
//     lets that per-install hydration stop -- once images/ is committed, installs read
//     from your repository instead and the CDN is never touched again.
//   * It is deliberately slow and single-threaded. There is no hurry: it runs once,
//     unattended, on your laptop.
//   * The proper route stays in place. sync-card-images.yml pulls from the public folder
//     and will keep images/ current from here on; this only fills the hole so you are not
//     waiting a day before you can ship.
//
// If you would rather not use the CDN at all, delete this file and let the workflow do it
// -- six or seven resumable runs, done overnight, no decision required.
//
// USAGE
//     node scripts/seed-from-cdn.mjs images
//     node scripts/seed-from-cdn.mjs images --dry
//
// Resumable: anything already in images/ is skipped, so stopping it with ctrl-C and
// starting it again later costs nothing.

import fs from 'node:fs';
import path from 'node:path';
import { allPrintings } from './slug-match.mjs';

const [, , DEST = 'images', ...flags] = process.argv;
const DRY = flags.includes('--dry');

/* The base the app used before the move, and the same path shape: <base>/<set>/<slug>.webp
   where the set is the first segment of the slug. */
const BASE = process.env.CDN_BASE || 'https://images.sorcerycard.io/images/';

const CARDS_FILE = process.env.CARDS_FILE || 'cards.json';
if (!fs.existsSync(CARDS_FILE)) {
  console.error('Could not find ' + CARDS_FILE + ' -- run fetch-cards.js first.');
  process.exit(1);
}
const cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || [];

/* EVERY printing, not just the one each card shows by default. Foils, alternate art,
   promos -- each has its own slug and therefore its own file, and asking only for the
   default left every other version with no art at all. */
const wanted = allPrintings(cards);       // slug -> set code
const defaults = cards.filter(c => c.sl).length;
console.log(wanted.size + ' printings in ' + CARDS_FILE +
            ' (' + defaults + ' cards, ' + (wanted.size - defaults) + ' further printings).');

const todo = [...wanted].filter(([slug, set]) => !fs.existsSync(path.join(DEST, set, slug + '.webp')));
console.log((wanted.size - todo.length) + ' already in ' + DEST + ', ' + todo.length + ' to fetch.');

if (!todo.length) { console.log('Nothing to do.'); process.exit(0); }
if (DRY) {
  console.log('\n--dry given. First few that would be fetched:');
  todo.slice(0, 5).forEach(([slug, set]) => console.log('  ' + BASE + set + '/' + slug + '.webp'));
  process.exit(0);
}

/* Deliberately gentle: one at a time, a pause between each. Three thousand images at this
   rate is a bit over half an hour -- which is nothing for something run once, and is the
   difference between a polite trickle and a hammering. */
const PACE = Number(process.env.CDN_PACE_MS || 600);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function grab(url, tries = 4) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        /* An error page served with a 200 is not an image. Writing it would leave a file
           that looks present and renders as nothing, which is worse than a gap. */
        if (buf.length < 200) throw new Error('too small to be art (' + buf.length + ' bytes)');
        return buf;
      }
      /* A printing the CDN simply does not have. Not an error worth retrying -- some
         printings have no art anywhere. */
      if (res.status === 404) return null;
      if (attempt === tries) throw new Error('HTTP ' + res.status);
    } catch (e) {
      if (attempt === tries) throw e;
    }
    await sleep(Math.min(20000, 1000 * Math.pow(2, attempt)));
  }
}

let got = 0, absent = 0, failed = 0, bytes = 0;
const started = Date.now();

for (const [slug, set] of todo) {
  const url = BASE + set + '/' + slug + '.webp';
  const dest = path.join(DEST, set, slug + '.webp');
  try {
    const buf = await grab(url);
    if (!buf) { absent++; }
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      got++; bytes += buf.length;
    }
  } catch (e) {
    failed++;
    console.warn('  ' + slug + ': ' + e.message);
    /* Run after run of the same failure means something has changed at their end, not that
       these particular cards are unlucky. Stop and let a person look. */
    if (failed > 25 && failed > got) {
      console.error('\nToo many failures in a row -- stopping. What has been fetched is kept,');
      console.error('so fixing the cause and running again continues from here.');
      break;
    }
  }
  if ((got + absent + failed) % 100 === 0) {
    const done = got + absent + failed;
    const perSec = done / ((Date.now() - started) / 1000);
    const left = Math.round((todo.length - done) / perSec / 60);
    console.log('  ' + done + '/' + todo.length + '  (' + (bytes / 1048576).toFixed(0) + ' MB, ~' + left + ' min left)');
  }
  await sleep(PACE);
}

console.log('');
console.log('Fetched ' + got + ' (' + (bytes / 1048576).toFixed(1) + ' MB), ' +
            absent + ' not on the CDN, ' + failed + ' failed.');
console.log('');
console.log('Next: commit ' + DEST + ', then let sync-card-images.yml keep it current from');
console.log('the public folder. This script should not need running again.');
