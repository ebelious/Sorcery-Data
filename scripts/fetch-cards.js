// Builds cards.json from the official Sorcery API.
//
// This replaces scrape-cards.js, which drove a headless browser to curiosa.io and
// intercepted the tRPC responses the page made for itself. There is now a published API,
// so none of that is needed: one request, no browser, no guessing at field names, and
// nothing that breaks the next time the site is restyled.
//
//   https://api.sorcerytcg.com/api/cards
//
// Their guidance, followed here:
//   * "Expect changes" -- fields may move without notice, so every read below is
//     defensive and a card that cannot be understood is skipped rather than half-built.
//   * "Synchronize, don't depend on it live" -- this writes cards.json for the app to
//     load; the app never calls the API itself.
//   * "Host images yourself" -- the API carries no image URLs and their CDN is not to be
//     used, so nothing here fetches art. The app builds its own image paths from the
//     printing slug, exactly as before.
//   * Rate limit is 30 requests a minute. This makes one.
//
// WHERE THE RESULT GOES
// cards.json belongs at the root of https://github.com/ebelious/Sorcery-Data, the same
// repository that holds the card art under images/. They are updated together -- a new set
// brings both new rows and new pictures -- so one commit carries the pair and there is no
// window in which the app has one without the other.
//
// Output shape is UNCHANGED from the scraper's, so index2.html needs no edits:
//   { n, el, t, c, pw, r, s, ss, txt, ar, th, sl, sub, prints }

const fs = require('fs');

const API = process.env.SORCERY_API || 'https://api.sorcerytcg.com/api/cards';
const OUT = 'cards.json';

/* The app's own vocabulary. The API's is capitalised and slightly different, and the app
   has years of saved collections and decks keyed on the lower-case forms, so the mapping
   happens here rather than anywhere near the app. */
const TYPE = { avatar:'avatar', minion:'minion', magic:'magic', aura:'aura', artifact:'artifact', site:'site' };
const RARITY = { ordinary:'ordinary', exceptional:'exceptional', elite:'elite', unique:'unique' };

function lower(v){ return (v == null ? '' : String(v)).toLowerCase(); }

/* "2w 1e" and so on, in the order the app has always written them. */
function threshold(e){
  const out = [];
  [['air','a'], ['earth','e'], ['fire','f'], ['water','w']].forEach(([k, letter]) => {
    const n = Number(e && e[k]);
    if (n > 0) out.push(String(n) + letter);
  });
  return out.join(' ');
}

/* Whichever element the card asks most of. Elementless cards fall back to the declared
   list, and "None" means neutral. Same rule the scraper used, on better data. */
function element(e){
  const counts = { air:Number(e.air)||0, earth:Number(e.earth)||0, fire:Number(e.fire)||0, water:Number(e.water)||0 };
  let best = 'neutral', most = 0;
  Object.keys(counts).forEach(k => { if (counts[k] > most) { most = counts[k]; best = k; } });
  if (best !== 'neutral') return best;
  const first = Array.isArray(e.elements) ? e.elements.find(x => x && x !== 'None') : null;
  return first ? lower(first) : 'neutral';
}

/* The slug the app turns into an image path. Every printing carries one; the standard
   finish is preferred because that is the art the app shows by default, and the earliest
   printing because that is the one most likely to have art on file. */
function imageSlug(printings){
  if (!printings.length) return '';
  const byDate = printings.slice().sort((a, b) => String(a.printedAt||'').localeCompare(String(b.printedAt||'')));
  const standard = byDate.find(p => p && p.meta && p.meta.finish === 'Standard');
  return String((standard || byDate[0]).slug || '');
}

function normalise(card){
  if (!card || !card.name || !card.engine) return null;
  const e = card.engine;
  const printings = Array.isArray(card.printings) ? card.printings.filter(Boolean) : [];

  /* Set names in printing order, deduplicated. */
  const sets = [];
  printings.forEach(p => {
    const nm = p.set && p.set.name;
    if (nm && sets.indexOf(nm) < 0) sets.push(nm);
  });

  /* Artist: from the standard printing where there is one, otherwise any. */
  let artist = '';
  const withArtist = printings.find(p => p.meta && p.meta.finish === 'Standard' && p.meta.artist && p.meta.artist.name)
                  || printings.find(p => p.meta && p.meta.artist && p.meta.artist.name);
  if (withArtist) artist = withArtist.meta.artist.name;

  /* An avatar has no rarity of its own but does have a slot, which is the same vocabulary
     and is what the app's filters expect to find. */
  const rarity = RARITY[lower(e.rarity)] || RARITY[lower(e.slot)] || 'ordinary';

  /* Each printing keeps its OWN slug.
     Only the default printing's slug was carried through before, which quietly made every
     other printing unreachable: a foil has a different slug (-f rather than -s), and
     without it there was no way to name its file, match a downloaded one to it, or work
     out its image address. The information was in the API all along -- it simply was not
     being written down. Everything that wants a printing other than the default depends
     on this one field. */
  const prints = printings.map(p => ({
    sl: p.slug || '',
    set: (p.set && p.set.name) || '',
    finish: (p.meta && p.meta.finish) || 'Standard',
    rarity: rarity,
    img: '',                                   /* the API carries none, by their rules */
    flavor: (p.meta && p.meta.flavor) || '',
    artist: (p.meta && p.meta.artist && p.meta.artist.name) || ''
  }));

  const subtypes = Array.isArray(e.subtypes) ? e.subtypes.slice() : [];
  const cost = (e.cost === undefined || e.cost === null) ? null : Number(e.cost);
  const power = (e.attack === undefined || e.attack === null) ? null : Number(e.attack);

  return {
    n: card.name,
    el: element(e),
    t: TYPE[lower(e.type)] || 'minion',
    c: cost,
    pw: power,
    r: rarity,
    s: sets[0] || '',
    ss: sets,
    txt: e.rules || '',
    ar: artist,
    th: threshold(e),
    sl: imageSlug(printings),
    sub: subtypes.length ? subtypes : undefined,
    prints: prints.length ? prints : undefined
  };
}

async function main(){
  console.log('Fetching ' + API);
  /* The request itself can fail before there is any response to inspect -- DNS, a refused
     connection, a timeout. Same treatment as every other failure here: one line saying so,
     and cards.json left exactly as it was. */
  let res;
  try {
    res = await fetch(API, { headers: { 'Accept': 'application/json' } });
  } catch (e) {
    console.error('Could not reach the API (' + e.message + ') -- leaving ' + OUT + ' untouched.');
    process.exit(1);
  }
  if (!res.ok) {
    console.error('API returned HTTP ' + res.status + ' -- leaving ' + OUT + ' untouched.');
    process.exit(1);
  }
  /* A body that is not JSON at all -- an error page, a redirect landing somewhere else --
     throws here rather than parsing, and a stack trace is no use to whoever reads the job
     log at 3am. Say what happened and leave the file alone. */
  let raw;
  try {
    raw = await res.json();
  } catch (e) {
    console.error('The response was not JSON (' + e.message + ') -- leaving ' + OUT + ' untouched.');
    process.exit(1);
  }
  if (!Array.isArray(raw)) {
    console.error('Expected a JSON array of cards, got ' + typeof raw + ' -- leaving ' + OUT + ' untouched.');
    process.exit(1);
  }
  console.log('API returned ' + raw.length + ' cards.');

  const cards = [];
  let skipped = 0;
  raw.forEach(c => {
    const out = normalise(c);
    if (out) cards.push(out); else skipped++;
  });
  if (skipped) console.warn(skipped + ' entries could not be read and were skipped.');
  console.log('Normalised ' + cards.length + ' cards.');

  if (!cards.length) {
    console.error('Nothing usable came back -- leaving ' + OUT + ' untouched.');
    process.exit(1);
  }

  /* The same guard the scraper had, and worth keeping even against an official source:
     the count should only ever grow. A partial response, a truncated read or a bad day at
     their end would otherwise replace a complete file with a smaller one, and the app
     would quietly lose cards. Refuse, fail the job, leave what is on disk alone. */
  let had = 0;
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      had = Array.isArray(prev.cards) ? prev.cards.length : 0;
    } catch (e) {
      console.warn('Could not read the existing ' + OUT + ', continuing without a baseline: ' + e.message);
    }
  }
  if (had > 0 && cards.length < had) {
    console.error(
      'Refusing to overwrite ' + OUT + ': this run has ' + cards.length + ' cards, fewer than the ' +
      had + ' already on file. Investigate before re-running.'
    );
    process.exit(1);
  }

  cards.sort((a, b) => a.n.localeCompare(b.n));

  /* "Compare each response with your previous import" -- their words, and worth doing for
     our own sake too. The comparison ignores the timestamp, because that changes on every
     run and would otherwise make every run look like a change: a commit an hour, each one
     touching a multi-megabyte file, for a database that moves a few times a year.
     Nothing changed means nothing written and nothing committed. */
  if (fs.existsSync(OUT)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (JSON.stringify(prev.cards) === JSON.stringify(cards)) {
        console.log('No change since the last import (' + cards.length + ' cards). Leaving ' + OUT + ' alone.');
        /* A marker the workflow reads, so it can skip the commit without parsing this log. */
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=false\n');
        return;
      }
    } catch (e) { /* unreadable: fall through and write a good one */ }
  }

  fs.writeFileSync(OUT, JSON.stringify({ updated: new Date().toISOString(), total: cards.length, cards }, null, 2));
  console.log('Wrote ' + OUT + ' (' + cards.length + ' cards' + (had ? ', was ' + had : '') + ').');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
}

if (require.main === module) {
  main().catch(e => { console.error('Unhandled error:', e); process.exit(1); });
}
module.exports = { normalise, threshold, element, imageSlug };
