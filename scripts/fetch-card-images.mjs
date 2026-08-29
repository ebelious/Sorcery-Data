// Downloads the publisher's public card-art folder using the Google Drive REST API.
//
// WHY NOT RCLONE
// rclone's drive backend authenticates by OAuth and only by OAuth. Handing it an api_key
// does not make it skip that, so it fails before it ever looks at the folder:
//
//     CRITICAL: failed when making oauth client: empty token found
//
// There is no token because there is no account -- the folder is public and nothing here
// should need one. Drive's REST API reads publicly-shared files with an API key alone, so
// this talks to it directly. No OAuth, no consent screen, no refresh tokens to expire.
//
// USAGE
//     GDRIVE_API_KEY=... node fetch-card-images.mjs <folder-id> <output-folder>
//
// It keeps a small manifest beside the download and skips files whose checksum it already
// has, so the first run costs a gigabyte and every run after it costs almost nothing.

import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.GDRIVE_API_KEY;
const [, , FOLDER_ID, OUT] = process.argv;

if (!KEY) { console.error('GDRIVE_API_KEY is not set.'); process.exit(1); }
if (!FOLDER_ID || !OUT) {
  console.error('usage: GDRIVE_API_KEY=... node fetch-card-images.mjs <folder-id> <output-folder>');
  process.exit(1);
}

const API = 'https://www.googleapis.com/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

/* Drive answers 403 for "too fast" as well as for "not allowed", and the two are told
   apart only by the reason inside the body. Backing off and retrying is right for the
   first and pointless for the second, so they are separated here rather than retrying
   blindly on every 403. */
async function call(url, tries = 5) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt === tries) throw new Error('network: ' + e.message);
      await wait(attempt);
      continue;
    }
    if (res.ok) return res;

    let body = '';
    try { body = await res.text(); } catch (e) {}
    const transient = res.status === 429 || res.status >= 500 ||
      (res.status === 403 && /rateLimit|userRateLimit|quotaExceeded|backendError/i.test(body));

    if (!transient) {
      /* 404 on a folder that plainly exists nearly always means it is not actually shared
         with "anyone with the link", which is worth saying outright -- the raw status is
         not much of a clue. */
      const hint = res.status === 404
        ? ' (is the folder shared with "anyone with the link"?)'
        : res.status === 403
          ? ' (is the API key restricted to the Drive API, and the Drive API enabled?)'
          : '';
      throw new Error('HTTP ' + res.status + hint + ' ' + body.slice(0, 200));
    }
    if (attempt === tries) throw new Error('HTTP ' + res.status + ' after ' + tries + ' tries');
    await wait(attempt);
  }
}
function wait(attempt) {
  const ms = Math.min(30000, 500 * Math.pow(2, attempt)) + Math.floor(Math.random() * 400);
  return new Promise(r => setTimeout(r, ms));
}

/* Every file under the folder, following subfolders -- the share is usually split by set.
   Paged, because a folder of this size arrives in several thousand-file batches and only
   taking the first page would quietly download a fraction of the art. */
async function listAll(folderId, trail = '') {
  const found = [];
  let pageToken = '';
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      key: KEY,
      fields: 'nextPageToken, files(id,name,mimeType,size,md5Checksum)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true'
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await call(API + '?' + params);
    const page = await res.json();
    for (const f of (page.files || [])) {
      if (f.mimeType === FOLDER_MIME) {
        found.push(...await listAll(f.id, path.join(trail, f.name)));
      } else if (/\.(png|jpe?g|webp)$/i.test(f.name)) {
        found.push({ id: f.id, name: f.name, dir: trail, md5: f.md5Checksum || '', size: Number(f.size || 0) });
      }
    }
    pageToken = page.nextPageToken || '';
  } while (pageToken);
  return found;
}

async function download(file, dest) {
  const params = new URLSearchParams({ alt: 'media', key: KEY, supportsAllDrives: 'true' });
  const res = await call(API + '/' + file.id + '?' + params);
  const buf = Buffer.from(await res.arrayBuffer());
  /* Drive hands back an HTML error page with a 200 in some failure modes. A few bytes
     starting with '<' is not a PNG, and writing it would leave a file that looks present
     and renders as nothing. */
  if (buf.length < 100 || buf[0] === 0x3c /* '<' */) {
    throw new Error('response was not an image (' + buf.length + ' bytes)');
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const manifestPath = path.join(OUT, '.manifest.json');
  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {}
  }

  console.log('Listing the folder...');
  const files = await listAll(FOLDER_ID);
  console.log('Found ' + files.length + ' image files.');
  if (!files.length) {
    console.error('Nothing to download. Either the folder is empty or it is not public.');
    process.exit(1);
  }

  let got = 0, skipped = 0, failed = 0, bytes = 0;
  for (const f of files) {
    const dest = path.join(OUT, f.dir, f.name);
    const known = manifest[f.id];
    /* Unchanged since last time AND still on disk: leave it. The checksum comes from
       Drive, so this notices a file that was replaced under the same name. */
    if (known && known.md5 && f.md5 && known.md5 === f.md5 && fs.existsSync(dest)) { skipped++; continue; }
    try {
      bytes += await download(f, dest);
      manifest[f.id] = { name: f.name, md5: f.md5, size: f.size };
      got++;
      if (got % 50 === 0) console.log('  ... ' + got + ' downloaded');
    } catch (e) {
      failed++;
      console.warn('  could not fetch ' + f.name + ': ' + e.message);
    }
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log('');
  console.log('Downloaded ' + got + ' (' + (bytes / 1048576).toFixed(1) + ' MB), ' +
              skipped + ' already current, ' + failed + ' failed.');

  /* A handful of failures out of a thousand is a bad connection and the next run will
     pick them up. Losing most of them means something is actually wrong, and carrying on
     to the sorting step would commit a half-empty set of art. */
  if (failed && failed > files.length * 0.1) {
    console.error('Too many failures to trust this run; stopping before anything is sorted.');
    process.exit(1);
  }
}

main().catch(e => { console.error('Failed: ' + e.message); process.exit(1); });
