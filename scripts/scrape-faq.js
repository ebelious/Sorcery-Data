// Builds faq.json from the per-card FAQs on sorcerytcg.com.
//
// WHERE THE DATA ACTUALLY IS
// The site no longer has a /faqs page, and there are no per-card pages either -- the card
// grid opens each card in place, so there is nothing to visit and nothing to crawl. But
// /cards ships the WHOLE FAQ database with the page: 753 Sanity documents of _type "faq",
// sitting in the Next.js flight payload inside the served HTML. One request gets all of it.
//
// Worth establishing before writing anything. The first attempt at this script walked
// eleven hundred card pages in a browser -- far slower, and aimed at pages that do not
// exist.
//
// SHAPE OF THE SOURCE
//   { _id, _type:"faq", question:[block], answer:[block], cards:["swap", ...], _updatedAt }
// question and answer are Sanity portable text. `cards` is a list of card SLUGS, and 57 of
// the 753 entries apply to more than one card.
//
// SHAPE OF THE OUTPUT -- unchanged from what the app already reads:
//   { updated, total, faq: [ { card, q, a, id, segments } ] }
// One row per card per entry, so a FAQ covering three cards appears under each. 753 entries
// across their card lists expand to 835 rows, which is exactly what the app holds today --
// this reproduces the existing file rather than replacing it with something else.
//
// `card` is the card's NAME, not its slug, because that is what the FAQ panel groups by.
// cards.json supplies the mapping.
//
// `id` is the Sanity _id, which is what the app already uses. Rows sharing an entry share
// its id, exactly as they do now.
//
// USAGE
//   node scrape-faq.js                 write faq.json
//   node scrape-faq.js --dry           report what it found, write nothing
//   node scrape-faq.js --browser       force the browser path (see below)
//
// Plain HTTP first: the payload is in the served bytes, and a browser is a large thing to
// require for one GET. If that stops working -- they move to client-side hydration, or
// fetch the FAQ after load -- it falls back to Playwright on its own, and --browser forces
// it. Playwright is only require()d on that path, so the plain route needs nothing
// installed.

const fs = require('fs');

const PAGE       = process.env.FAQ_PAGE  || 'https://sorcerytcg.com/cards';
const CARDS_FILE = process.env.FAQ_CARDS || 'cards.json';
const OUT_FILE   = process.env.FAQ_OUT   || 'faq.json';

const argv    = process.argv.slice(2);
const DRY     = argv.includes('--dry');
const BROWSER = argv.includes('--browser');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ── Getting the page ────────────────────────────────────────────────────── */

async function fetchPlain() {
  const res = await fetch(PAGE, { headers: { 'Accept': 'text/html', 'User-Agent': UA } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

async function fetchRendered() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
    return await page.content();
  } finally {
    await browser.close();
  }
}

/* ── Digging the documents out of the flight payload ─────────────────────────
   The payload arrives as forty-odd self.__next_f.push([1,"..."]) calls whose string
   arguments are one long escaped document split at arbitrary points -- a record can and
   does straddle two pushes. So every push is unescaped and joined back into one string
   before anything is looked for in it. */

function flightBlob(html) {
  const parts = [];
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    /* The argument is a JSON string literal. Wrapping it in quotes and letting JSON.parse
       unescape it handles \n, \" and \uXXXX properly -- hand-rolled unescaping gets
       surrogate pairs wrong, and there are accented card names in here. */
    try { parts.push(JSON.parse('"' + m[1] + '"')); } catch (e) { /* skip a malformed row */ }
  }
  return parts.join('');
}

/* The array starting at a given '[', found by balancing brackets while ignoring anything
   inside a string. A regex cannot do this -- the answers contain brackets. */
function sliceArray(s, open) {
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[') depth++;
    else if (c === ']') { depth--; if (depth === 0) return s.slice(open, i + 1); }
  }
  return null;
}

function faqDocs(blob) {
  /* Anchored on the type marker, not on a row number: the payload labels this row "1a",
     which is a position and will not survive the page gaining a section. */
  const marker = blob.indexOf('"_type":"faq"');
  if (marker < 0) return [];
  let open = blob.lastIndexOf('[{', marker);
  while (open > 0) {
    const text = sliceArray(blob, open);
    if (text) {
      try {
        const arr = JSON.parse(text);
        if (Array.isArray(arr) && arr.some(x => x && x._type === 'faq')) {
          return arr.filter(x => x && x._type === 'faq');
        }
      } catch (e) { /* not this one */ }
    }
    open = blob.lastIndexOf('[{', open - 1);
  }
  return [];
}

/* ── Portable text -> the app's own shape ────────────────────────────────────
   The app draws answers from `segments` and falls back to the plain `a` string, so both
   are produced: segments keep the emphasis and the bullets, `a` is what search matches
   against. */

/* The CMS marks up two kinds of reference inside otherwise ordinary text, neither of which
   a reader should ever see as written:
       [[Card Name]]     another card
       ((Keyword))       a codex keyword, e.g. ((Sacrifice))
       ))Keyword((       the same thing with the brackets the wrong way round

   The third is not a guess. 27 keywords in the live data are written that way -- "either
   ))moving(( to another zone" -- against 34 written the right way round, and the app treats
   both as keywords today. Matching only the tidy form would leave the stray brackets
   showing in a quarter of them.

   Both come out as the bare word here, and are split into runs of their own further down so
   the app can draw them differently from the prose around them. */
function unlink(text) {
  return String(text || '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\(\(([^)]+)\)\)/g, '$1')
    .replace(/\)\)([^(]+)\(\(/g, '$1');
}

function blockText(block) {
  if (!block || block._type !== 'block') return '';   /* a grid has no words in it */
  return unlink((block.children || []).map(c => c.text || '').join(''));
}

/* Joined as written. An earlier version collapsed runs of spaces, which looked like tidying
   and was not: the answers use a double space after a full stop, and squeezing it changed
   77 of the 835 answers the app already holds. The text belongs to whoever wrote it. */
/* A grid contributes no words but still contributes a line break, leaving the blank line the
   app already has where the diagram sits. Dropping it closed a gap the reader can see. */
function plain(blocks) {
  return (blocks || []).map(blockText).join('\n').trim();
}

/* One segment per block, runs carrying the marks -- five answers use emphasis, and
   flattening them loses the distinction between "it does not go to your hand" and the rest
   of its sentence.

   A bullet is written into the TEXT as "• ", not carried as a flag beside it. The app
   renders segments[].text as it stands and knows nothing about a bullet field, so a flag
   would have silently dropped the bullet from all 67 list answers -- they would have run
   together as unbroken paragraphs. Verified against the 835 rows the app already holds. */
function segments(blocks) {
  return (blocks || []).map(b => {
    /* Not every node is prose. Five answers carry a damageGrid -- the little board diagram
       that shows where a minion can step to -- and the app stores those as a table segment
       rather than as words. Rendered as text they come out as a meaningless run of single
       letters, which is what the diagram is there to avoid. */
    if (b && b._type === 'damageGrid') {
      const rows = ((b.grid && b.grid.rows) || []).map(r => (r.cells || []).slice());
      return rows.length ? { t: 'tbl', rows: rows } : null;
    }
    const runs = [];
    (b.children || []).forEach(c => {
      const marks = Array.isArray(c.marks) ? c.marks : [];
      const style = {
        bold: marks.indexOf('strong') >= 0,
        italic: marks.indexOf('em') >= 0,
        /* A link is a key into markDefs rather than a named style, so anything that is not
           a known style mark is one. */
        link: marks.some(m => m !== 'strong' && m !== 'em' && m !== 'underline' && m !== 'code')
      };
      /* Each reference becomes a run of its OWN, which is how the app already stores them
         and what lets it draw a reference differently from the prose around it. Folding a
         marker into its surrounding run would flatten every reference in the file into
         ordinary text.
         The two kinds are stored differently, and that is the app's convention, not a
         choice made here: a card carries `cardRef` and no style keys; a codex keyword is an
         ordinary run with `link` true. Verified against all 1,247 runs the app holds. */
      /* An empty span still becomes a run. One answer has a trailing empty span and the app
         keeps it; dropping it as noise is tidier and produces a file that does not match
         what is already there, which is the one thing this must not do. */
      if (!c.text) { runs.push(Object.assign({ text: '' }, style)); return; }
      String(c.text || '').split(/(\[\[[^\]]+\]\]|\(\([^)]+\)\)|\)\)[^(]+\(\()/).forEach(piece => {
        if (!piece) return;
        const card = piece.match(/^\[\[([^\]]+)\]\]$/);
        if (card) { runs.push({ text: card[1], cardRef: card[1] }); return; }
        const kw = piece.match(/^\(\(([^)]+)\)\)$/) || piece.match(/^\)\)([^(]+)\(\($/);
        if (kw) { runs.push({ text: kw[1], bold: style.bold, italic: style.italic, link: true }); return; }
        runs.push(Object.assign({ text: piece }, style));
      });
    });
    const bullet = b.listItem === 'bullet' ? '\u2022 ' : '';
    if (bullet && runs.length) runs[0] = Object.assign({}, runs[0], { text: bullet + runs[0].text });
    /* The segment's own text is trimmed; its runs are not. That asymmetry is the app's, and
       it is deliberate there: `text` is what gets displayed and searched, while the runs
       have to join back into the original spacing or the emphasis lands a character off.
       Verified against all 835 rows. */
    return { t: 'p', text: (bullet + blockText(b)).trim(), runs: runs };
  }).filter(s => s && (s.t === 'tbl' || s.text.trim() !== ''));
}

/* ── Slug -> card name ───────────────────────────────────────────────────────
   `cards` holds slug cores: "swap", "king_arthur". cards.json holds full printing slugs:
   "004-13_treasures_of_britain-b-s". Strip the set code and the product/finish suffixes and
   the two agree. */

function slugCore(slug) {
  const parts = String(slug || '').split('-');
  if (parts.length < 3) return String(slug || '').toLowerCase();
  return parts.slice(1, -2).join('-').toLowerCase();
}

function nameIndex(cards) {
  const byCore = new Map();
  cards.forEach(c => {
    if (!c || !c.n) return;
    const core = slugCore(c.sl);
    if (core && !byCore.has(core)) byCore.set(core, c.n);
    /* The name flattened the same way too, so an entry naming a card whose slug is missing
       from cards.json still resolves. */
    const flat = c.n.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
    if (flat && !byCore.has(flat)) byCore.set(flat, c.n);
  });
  return byCore;
}

function resolve(index, slug) {
  const s = String(slug || '').toLowerCase();
  return index.get(s) || index.get(s.replace(/[^a-z0-9]/g, '')) || null;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main() {
  if (!fs.existsSync(CARDS_FILE)) {
    console.error(CARDS_FILE + ' not found -- run this beside cards.json, or set FAQ_CARDS.');
    process.exit(1);
  }
  const cards = (JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || []).filter(Boolean);
  const index = nameIndex(cards);
  console.log(cards.length + ' cards known.');

  let html = null;
  if (!BROWSER) {
    try {
      console.log('Fetching ' + PAGE);
      html = await fetchPlain();
      if (html.indexOf('_type\\":\\"faq') < 0 && html.indexOf('"_type":"faq') < 0) {
        console.log('The FAQ payload is not in the served bytes; rendering the page instead.');
        html = null;
      }
    } catch (e) {
      console.log('Plain fetch failed (' + e.message + '); rendering the page instead.');
    }
  }
  if (!html) html = await fetchRendered();
  console.log('Page is ' + html.length + ' bytes.');

  const docs = faqDocs(flightBlob(html));
  console.log(docs.length + ' FAQ documents found.');
  if (!docs.length) {
    console.error('No FAQ documents in the payload. The page changed -- leaving ' + OUT_FILE + ' untouched.');
    process.exit(1);
  }

  const faq = [];
  const unresolved = new Set();
  docs.forEach(d => {
    const q = plain(d.question);
    const a = plain(d.answer);
    if (!q || !a) return;
    /* A diagram belonging to the QUESTION is carried into the answer's segments, ahead of
       the words. Three questions have one -- "all the empty boxes are void and the letters
       are sites" is meaningless without the grid it refers to -- and the app has nowhere
       else to draw it, since `q` is a plain string. This is where it already keeps them. */
    const qGrids = segments((d.question || []).filter(b => b && b._type !== 'block'));
    const segs = qGrids.concat(segments(d.answer));
    (Array.isArray(d.cards) ? d.cards : []).forEach(slug => {
      const name = resolve(index, slug);
      if (!name) { unresolved.add(slug); return; }
      faq.push({ card: name, q: q, a: a, id: d._id, segments: segs });
    });
  });

  faq.sort((x, y) => x.card.localeCompare(y.card) || x.q.localeCompare(y.q));
  console.log(faq.length + ' rows across ' + new Set(faq.map(f => f.card)).size + ' cards.');
  if (unresolved.size) {
    console.warn(unresolved.size + ' card slugs matched nothing in ' + CARDS_FILE + ':');
    console.warn('  ' + [...unresolved].slice(0, 20).join(', '));
  }

  if (DRY) { console.log('--dry: nothing written.'); return; }

  /* The same guard the card importer uses. A count that falls means something changed at
     their end, and a smaller file would quietly delete answers the app is already showing.
     Refuse, and leave what is on disk alone. */
  let had = 0;
  if (fs.existsSync(OUT_FILE)) {
    try { had = (JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).faq || []).length; } catch (e) {}
  }
  if (had > 0 && faq.length < had) {
    console.error('Refusing to overwrite ' + OUT_FILE + ': ' + faq.length + ' rows, fewer than the ' + had + ' on file.');
    process.exit(1);
  }

  /* Nothing changed means nothing written, so a scheduled run does not commit a new
     timestamp over an unchanged file every time it runs. */
  if (fs.existsSync(OUT_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      if (JSON.stringify(prev.faq) === JSON.stringify(faq)) {
        console.log('No change since the last run. Leaving ' + OUT_FILE + ' alone.');
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=false\n');
        return;
      }
    } catch (e) { /* unreadable: write a good one */ }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), total: faq.length, faq }, null, 2));
  console.log('Wrote ' + OUT_FILE + (had ? ' (was ' + had + ')' : ''));
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changed=true\n');
}

if (require.main === module) {
  main().catch(e => { console.error('Unhandled error:', e); process.exit(1); });
}
module.exports = { flightBlob, faqDocs, segments, plain, slugCore, nameIndex, resolve };
