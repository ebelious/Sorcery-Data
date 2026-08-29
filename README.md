# Sorcery-Data

Card data and card art for the Sorcery Grimoire app, kept in one place because the two
change together: a new set brings both new rows and new pictures, and a commit that adds
one without the other leaves either a card with no art or art for no card.

```
cards.json                              the card database
images/<set-code>/<printing-slug>.webp  card art, e.g. images/004/004-avalon-b-s.webp
scripts/fetch-cards.js                  builds cards.json from the API
scripts/slug-match.mjs                  how a file is matched to a printing (shared)
scripts/import-existing-images.mjs      seeds images/ from art the app already has
scripts/fetch-card-images.mjs           downloads the public art folder
scripts/prepare-card-images.mjs         sorts that download into images/
.github/workflows/                      the two syncs below
```

Served over **GitHub Pages** (Settings → Pages → deploy from `main`). Until Pages is
enabled the app falls back to its own placeholders rather than breaking, so nothing is
urgent, but no art will appear.

## The two syncs

| | Source | When | Commits |
|---|---|---|---|
| **Card data** | `api.sorcerytcg.com/api/cards` | every 6h, and on demand | only when the data actually changed |
| **Card art** | the publisher's public Drive folder | monthly, and on demand | only genuinely new or changed files |

They run on different clocks on purpose. The database is one small request, so polling it
often costs nothing. The art is the whole folder — a gigabyte or more — and only appears
when a set is released, so a monthly run catches it within weeks and the manual trigger
catches it the same day.

## Following the publisher's guidance

Their terms are quoted in full at the top of each script. In short:

- **"Expect changes."** Every field is read defensively and a card that can't be understood
  is skipped rather than half-built.
- **"Synchronize, don't depend on it live."** The app never calls the API. It reads
  `cards.json` from here, and the sync compares each response with the previous import and
  writes nothing when they match.
- **"Host images yourself."** Their private CDN is never used. Art is downloaded from the
  public folder, converted, and served from this repository.

The API is rate limited to 30 requests a minute. The data sync makes **one** per run.

## Seeding it the first time

**Do this before letting the Drive sync loose.** The app's native build already carries
every released card under `card-images/{set}/{slug}.webp` — the same layout, the same
naming, the same slugs this repository wants. Copying that in takes seconds; downloading
the same three thousand files from Drive takes hours of throttled runs and puts a needless
load on somebody else's server.

```bash
node scripts/fetch-cards.js
node scripts/import-existing-images.mjs ../Sorcery-Grimoir/card-images images --dry
node scripts/import-existing-images.mjs ../Sorcery-Grimoir/card-images images
git add cards.json images && git commit -m "Seed card data and art" && git push
```

The dry run reports what it matched, what it could not place, and which printings have no
art locally — those last ones are what the Drive sync will pick up.

Afterwards the sync genuinely is only a check for updates: it reads what is already in
`images/`, skips every file it finds there, and downloads nothing but art for cards that
did not exist when you seeded.

## Setup

Card data needs nothing — it runs as soon as the workflow is committed.

Card art needs a Google Drive API key so the workflow can read the public folder:

1. `console.cloud.google.com` → a project → enable **Google Drive API**
2. **Credentials → Create credentials → API key**
3. Restrict it to the Drive API
4. **Settings → Secrets and variables → Actions** → add `GDRIVE_API_KEY`

**Application restrictions must be "None".** This is the step that catches people out: a
key restricted to "Websites (HTTP referrers)" can never work from a build runner, because a
server request carries no referrer to check, and Google refuses it with *"API key not
valid"* every time. The **API restriction** to Drive is the one that keeps the key safe,
and that one should stay.

A plain key is enough because the folder is public. There is no account to authorise, and
the workflow can reach nothing private.

## Running the art sync by hand

**Actions → Sync card images → Run workflow.** Tick **dry run** first: it matches every
downloaded file against `cards.json` and reports what it could place, what it couldn't, and
which printings have no art — without writing anything. Worth doing after a set release, in
case the publisher has changed how files are named.

Locally:

```bash
node scripts/fetch-cards.js

GDRIVE_API_KEY=... node scripts/fetch-card-images.mjs \
  17IrJkRGmIU9fDSTU2JQEU9JlFzb5liLJ .drive-cache
node scripts/prepare-card-images.mjs .drive-cache images --dry
```

The download keeps a manifest of what it already has, so only genuinely new or replaced
art is fetched on later runs. It reads the folder through Drive's REST API with the key
alone -- **not** rclone, whose Drive backend authenticates by OAuth and only by OAuth, and
which therefore fails with `empty token found` no matter what key it is given.

## Guards worth knowing about

- **The card count may only grow.** A truncated response can't replace a complete
  `cards.json` with a smaller one; the job fails and the file on disk is left alone.
- **Failures are one line, not a stack trace** — HTTP error, non-JSON body, network
  refused, empty list. Each says what happened and what it did *not* do.
- **Art is never overwritten by the wrong printing.** A file whose finish has no matching
  slug is reported rather than written over another printing — foil art silently replacing
  standard art is worse than having none.
