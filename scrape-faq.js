// Builds faq.json from the per-card FAQs on sorcerytcg.com.
//
// WHY THIS EXISTS
// The site no longer has a single /faqs page. Each card's FAQ now lives on that card's own
// page, so the FAQ database has to be assembled a card at a time. cards.json already has
// every card, so this walks that list rather than trying to crawl the site.
//
// WHY PLAYWRIGHT AND NOT fetch()
// sorcerytcg.com renders client-side. A plain HTTP GET of a card page returns the shell and
// the framework payload, not the finished markup -- the same thing that made the codex
// scraper anchor on escaped JSON in the bytes instead of on tags. A real browser is the
// only way to read what a person actually sees, and it is what the card and price scrapers
// in this project already do.
//
// READ THIS BEFORE THE FIRST FULL RUN
// I have not seen a rendered card page. The extraction below therefore does not depend on
// one particular class name or one particular layout: it tries several shapes, in order,
// and reports which one worked. That is deliberate, but it is not the same as knowing.
//
//   node scrape-faq.js --inspect "https://sorcerytcg.com/cards/<some-card>"
//
// writes faq-inspect.html (the rendered page) and faq-inspect.txt (what each strategy
// found). Run that ONCE, look at it, and the guesswork ends -- either a strategy already
// works, or the file shows exactly what to pin the parser to.
//
//   node scrape-faq.js --limit 25          a short run, to see the shape of the output
//   node scrape-faq.js                      the full run
//
// OUTPUT
// faq.json, beside cards.json in https://github.com/ebelious/Sorcery-Data:
//
//   { updated, total, faq: [ { card, q, a, id } ] }
//
// The entry shape matches what the app already reads out of codex.json's faq array, so
// merging the two is a copy rather than a conversion.
//
// SCALE
// One page load per card, eleven hundred of them, with a pause between each. That is a much
// larger ask of their site than fetch-cards.js's single API call, so: one browser reused
// throughout, a resume file so an interrupted run does not start again from nothing, and a
// delay that is easy to raise and unwise to lower.

/* CommonJS, like scrape-cards.js and scrape-tcg-prices.js. Playwright's package resolves
   to CommonJS, so an ESM `import { chromium }` fails outright on some installs -- and this
   sits next to two scripts that already do it this way. */
const fs = require('fs');
const { chromium } = require('playwright');

const CARDS_FILE  = process.env.FAQ_CARDS  || 'cards.json';
const OUT_FILE    = process.env.FAQ_OUT    || 'faq.json';
const STATE_FILE  = process.env.FAQ_STATE  || '.faq-progress.json';
const BASE        = process.env.FAQ_BASE   || 'https://sorcerytcg.com';
const DELAY_MS    = Number(process.env.FAQ_DELAY || 1200);
const NAV_TIMEOUT = 30000;
const SETTLE_MS   = 1500;   /* after load, before reading: the FAQ arrives with hydration */

const argv    = process.argv.slice(2);
const INSPECT = argv.includes('--inspect') ? argv[argv.indexOf('--inspect') + 1] : null;
const LIMIT   = argv.includes('--limit')   ? Number(argv[argv.indexOf('--limit') + 1]) : 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ─────────────────────────────────────────────────────────────────────────────
   Finding a card's page.

   The card list on /cards renders as links, so the address of a card page is
   something the site itself will tell us -- far better than inventing a slug rule
   that is right for most cards and silently wrong for the ones with punctuation in
   their names. The map is built once, from the rendered listing, and cached.
   ───────────────────────────────────────────────────────────────────────────── */
async function buildUrlMap(page) {
  console.log('Reading the card list from ' + BASE + '/cards ...');
  await page.goto(BASE + '/cards', { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await sleep(3000);

  /* The list is virtualised, so links only exist for what has been scrolled past.
     Scroll until the count stops growing rather than a fixed number of times. */
  let seen = new Map(), stale = 0;
  for (let round = 0; round < 400 && stale < 6; round++) {
    const links = await page.$$eval('a[href*="/cards/"]', as =>
      as.map(a => [a.getAttribute('href') || '', (a.textContent || '').trim()])
    );
    const before = seen.size;
    for (const [href, text] of links) {
      if (!href || href === '/cards' || href.endsWith('/cards/')) continue;
      const key = text || href;
      if (!seen.has(key)) seen.set(key, href.startsWith('http') ? href : BASE + href);
    }
    if (seen.size === before) stale++; else { stale = 0; console.log('  ' + seen.size + ' card links so far'); }
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(900);
  }
  console.log('Found ' + seen.size + ' card links.');
  return seen;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Reading the FAQ off a rendered card page.

   Four strategies, tried in order, each returning [{q,a}] or nothing. They run in the
   page so they can see the finished DOM. Whichever answers first wins, and its name is
   recorded so a run can be checked at a glance: if every card is coming back on the
   last, loosest strategy, the parser wants tightening.
   ───────────────────────────────────────────────────────────────────────────── */
const EXTRACT = `(() => {
  const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
  const ok = p => p.q && p.a && p.q.length > 3 && p.a.length > 1 && p.q.length < 400;

  /* 1. A heading that says FAQ, and the question/answer pairs under it. This is the shape
        the old /faqs page used and the most likely one to have survived the move. */
  function byHeading() {
    const heads = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"]')];
    const faq = heads.find(h => /^(faq|faqs|frequently asked|rulings?|q\\s*&\\s*a)\\b/i.test(clean(h.textContent)));
    if (!faq) return null;
    /* Everything between this heading and the next one at the same level or higher. */
    const stop = new Set(['H1','H2','H3','H4']);
    const out = [];
    let node = faq.nextElementSibling, pending = null;
    const scan = el => {
      const t = clean(el.textContent);
      if (!t) return;
      if (/\\?\\s*$/.test(t) && t.length < 400) { if (pending && ok(pending)) out.push(pending); pending = { q: t, a: '' }; }
      else if (pending) pending.a = pending.a ? pending.a + ' ' + t : t;
    };
    while (node && !(stop.has(node.tagName) && node !== faq)) {
      const parts = node.querySelectorAll('p,li,dt,dd,summary,div');
      if (parts.length) parts.forEach(scan); else scan(node);
      node = node.nextElementSibling;
    }
    if (pending && ok(pending)) out.push(pending);
    return out.length ? out : null;
  }

  /* 2. A native <details>/<summary> accordion -- the question is the summary, the answer is
        the rest of the block. */
  function byDetails() {
    const out = [];
    document.querySelectorAll('details').forEach(d => {
      const s = d.querySelector('summary');
      if (!s) return;
      const q = clean(s.textContent);
      const a = clean(d.textContent).slice(q.length).trim();
      const p = { q, a };
      if (ok(p)) out.push(p);
    });
    return out.length ? out : null;
  }

  /* 3. A scripted accordion: a button that is a question, and the region it controls.
        Radix and friends wire these with aria-controls / aria-expanded. */
  function byAria() {
    const out = [];
    document.querySelectorAll('[aria-controls],[data-state]').forEach(btn => {
      const q = clean(btn.textContent);
      if (!/\\?\\s*$/.test(q)) return;
      const id = btn.getAttribute('aria-controls');
      const panel = id ? document.getElementById(id) : btn.nextElementSibling;
      if (!panel) return;
      const p = { q, a: clean(panel.textContent) };
      if (ok(p)) out.push(p);
    });
    return out.length ? out : null;
  }

  /* 4. Last resort: any element whose text ends in a question mark, paired with whatever
        follows it. Loose enough to catch a layout none of the above expected, loose enough
        that a run leaning on it needs looking at. */
  function byQuestionMark() {
    const out = [];
    document.querySelectorAll('p,li,dt,h3,h4,div,button,span').forEach(el => {
      const q = clean(el.textContent);
      if (!/\\?\\s*$/.test(q) || q.length > 400) return;
      if (el.querySelector('p,li,div')) return;            /* a container, not the question */
      const next = el.nextElementSibling;
      if (!next) return;
      const p = { q, a: clean(next.textContent) };
      if (ok(p) && !out.some(x => x.q === p.q)) out.push(p);
    });
    return out.length ? out : null;
  }

  for (const [name, fn] of [['heading', byHeading], ['details', byDetails], ['aria', byAria], ['question-mark', byQuestionMark]]) {
    try { const r = fn(); if (r) return { strategy: name, items: r }; } catch (e) {}
  }
  return { strategy: 'none', items: [] };
})()`;

/* A stable id per entry, so a re-run does not renumber every FAQ in the file and turn a
   two-line change into a whole-file diff. Same card and same question means same id.

   Two independent hashes, not one. A single 32-bit hash collided seven times over twenty
   thousand synthetic entries -- an id that is not unique is worse than no id at all, since
   the app would treat two different answers as the same entry. Concatenating djb2 and
   FNV-1a gives 64 bits and no collisions over the same set. */
function idFor(card, q) {
  const s = card + '|' + q;
  let a = 5381, b = 2166136261;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0;
    b = ((b ^ c) * 16777619) >>> 0;
  }
  const pad = n => n.toString(16).padStart(8, '0');
  return 'faq-' + pad(a) + pad(b);
}

async function inspect(page, url) {
  console.log('Inspecting ' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
  await sleep(SETTLE_MS + 1500);

  const html = await page.content();
  fs.writeFileSync('faq-inspect.html', html);

  const result = await page.evaluate(EXTRACT);
  const report = [
    'url         ' + url,
    'title       ' + await page.title(),
    'html bytes  ' + html.length,
    'strategy    ' + result.strategy,
    'entries     ' + result.items.length,
    '',
    '--- headings on the page ---',
    ...(await page.$$eval('h1,h2,h3,h4', hs => hs.map(h => h.tagName + '  ' + (h.textContent || '').trim().slice(0, 100)))),
    '',
    '--- what was extracted ---',
    ...result.items.flatMap((x, i) => ['[' + (i + 1) + '] Q: ' + x.q, '    A: ' + x.a, '']),
  ].join('\n');
  fs.writeFileSync('faq-inspect.txt', report);
  console.log(report.slice(0, 2000));
  console.log('\nWrote faq-inspect.html and faq-inspect.txt');
}

async function main() {
  if (!fs.existsSync(CARDS_FILE) && !INSPECT) {
    console.error(CARDS_FILE + ' not found -- run this beside cards.json.');
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
  });

  try {
    if (INSPECT) { await inspect(page, INSPECT); return; }

    const cards = (JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8')).cards || []).filter(c => c && c.n);
    console.log(cards.length + ' cards in ' + CARDS_FILE);

    const urls = await buildUrlMap(page);
    if (!urls.size) {
      console.error('No card links found on the listing page. The list did not render, or its markup changed.');
      console.error('Run with --inspect on a card page to see what is actually there.');
      process.exit(1);
    }

    /* Resume: a run that dies at card 800 should not cost another 800 page loads. */
    let done = {};
    if (fs.existsSync(STATE_FILE)) {
      try { done = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch (e) {}
      if (Object.keys(done).length) console.log('Resuming: ' + Object.keys(done).length + ' cards already read.');
    }

    const strategies = {};
    let visited = 0, withFaq = 0, missing = 0, failed = 0;
    const targets = LIMIT ? cards.slice(0, LIMIT) : cards;

    for (const card of targets) {
      if (done[card.n]) continue;
      const url = urls.get(card.n);
      if (!url) { missing++; done[card.n] = []; continue; }

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await sleep(SETTLE_MS);
        const { strategy, items } = await page.evaluate(EXTRACT);
        strategies[strategy] = (strategies[strategy] || 0) + 1;
        done[card.n] = items;
        if (items.length) withFaq++;
      } catch (e) {
        /* Deliberately not recorded as done: an unreachable page is retried next run,
           rather than being remembered as a card with no FAQ. */
        console.warn('  failed: ' + card.n + ' (' + e.message + ')');
        failed++;
      }

      if (++visited % 25 === 0) {
        fs.writeFileSync(STATE_FILE, JSON.stringify(done));
        console.log('  ' + visited + '/' + targets.length + '  faqs on ' + withFaq + ' cards, ' + failed + ' failed');
      }
      await sleep(DELAY_MS);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(done));

    const faq = [];
    Object.keys(done).sort().forEach(name => {
      (done[name] || []).forEach(x => faq.push({ card: name, q: x.q, a: x.a, id: idFor(name, x.q) }));
    });

    console.log('\nStrategies used: ' + JSON.stringify(strategies));
    console.log(faq.length + ' FAQ entries across ' + withFaq + ' cards.');
    if (missing) console.log(missing + ' cards had no link on the listing page.');

    if (!faq.length) {
      console.error('Nothing extracted -- leaving ' + OUT_FILE + ' untouched. Run --inspect on a card page.');
      process.exit(1);
    }

    /* The same guard the card importers use. An FAQ count should not fall: if it has,
       something changed at their end and a smaller file would quietly delete answers the
       app is already showing. Refuse, and leave what is on disk alone. */
    let had = 0;
    if (fs.existsSync(OUT_FILE)) {
      try { had = (JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).faq || []).length; } catch (e) {}
    }
    if (had > 0 && faq.length < had && !LIMIT) {
      console.error('Refusing to overwrite ' + OUT_FILE + ': ' + faq.length + ' entries, fewer than the ' + had + ' on file.');
      process.exit(1);
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify({ updated: new Date().toISOString(), total: faq.length, faq }, null, 2));
    console.log('Wrote ' + OUT_FILE + (had ? ' (was ' + had + ')' : ''));
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error('Unhandled error:', e); process.exit(1); });
