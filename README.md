# Sorcery-Data

Card data and card art for the Sorcery Grimoire app, kept in one place because the two
change together: a new set brings both new rows and new pictures, and a commit that adds
one without the other leaves either a card with no art or art for no card.

```
cards.json                              the card database
images/<set-code>/<printing-slug>.webp  card art, e.g. images/004/004-avalon-b-s.webp
scripts/fetch-cards.js                  builds cards.json from the API
scripts/prepare-card-images.mjs         sorts downloaded art into images/
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

## Setup

Card data needs nothing — it runs as soon as the workflow is committed.

Card art needs a Google Drive API key so the workflow can read the public folder:

1. `console.cloud.google.com` → a project → enable **Google Drive API**
2. **Credentials → Create credentials → API key**
3. Restrict it to the Drive API
4. **Settings → Secrets and variables → Actions** → add `GDRIVE_API_KEY`

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
node scripts/prepare-card-images.mjs ~/Downloads/sorcery-art images --dry
```

## Guards worth knowing about

- **The card count may only grow.** A truncated response can't replace a complete
  `cards.json` with a smaller one; the job fails and the file on disk is left alone.
- **Failures are one line, not a stack trace** — HTTP error, non-JSON body, network
  refused, empty list. Each says what happened and what it did *not* do.
- **Art is never overwritten by the wrong printing.** A file whose finish has no matching
  slug is reported rather than written over another printing — foil art silently replacing
  standard art is worse than having none.
