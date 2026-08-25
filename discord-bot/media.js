// discord-bot/media.js
//
// npm install multer google-auth-library
//
// Mount with: app.use('/api/media', require('./media'));
// Requires supabaseClient.js and auth.js to already be set up.
//
// Unlike the R2 version, the file goes browser -> your server -> Supabase
// (not a direct presigned upload) — simpler to set up since there's no
// bucket CORS policy to configure, at the cost of the file passing
// through your server's bandwidth once.

const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { GoogleAuth } = require('google-auth-library');
const supabase = require('./supabaseClient');
const { requireAuth } = require('./auth');

const execFileAsync = promisify(execFile);

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB — adjust to taste
});

const BUCKET = process.env.SUPABASE_BUCKET || 'jeopardy-media';

function newKey(ownerId, filename) {
  const safeName = (filename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
  const unique = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
  return `${ownerId}/${unique}_${safeName}`;
}

// POST /api/media/upload  (multipart/form-data, field name "file")
// -> { key, publicUrl }
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const key = newKey(req.user.id, req.file.originalname);

  const { error } = await supabase.storage.from(BUCKET).upload(key, req.file.buffer, {
    contentType: req.file.mimetype,
    upsert: false,
  });
  if (error) {
    console.error('Supabase upload error:', error);
    return res.status(500).json({ error: 'Upload failed' });
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(key);
  res.json({ key, publicUrl: data.publicUrl });
});

// DELETE /api/media/*  (key contains slashes)
// Express 5 (path-to-regexp v6+) requires wildcards to be named — bare
// '/*' throws at startup. '/*splat' captures the rest of the path as an
// array of segments in req.params.splat, joined back into the full key.
router.delete('/*splat', async (req, res) => {
  const key = req.params.splat.join('/');
  // Keys are namespaced as `${ownerId}/...` on upload — only the person
  // who uploaded a file can delete it, even if they can see the key
  // through a shared board's clue data.
  if (!key.startsWith(req.user.id + '/')) {
    return res.status(403).json({ error: 'Not allowed' });
  }
  const { error } = await supabase.storage.from(BUCKET).remove([key]);
  if (error) {
    console.error('Supabase delete error:', error);
    return res.status(500).json({ error: 'Delete failed' });
  }
  res.json({ ok: true });
});

const DRIVE_API_KEY = process.env.GOOGLE_DRIVE_API_KEY;
const DRIVE_SERVICE_ACCOUNT_KEY_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH;

// Two auth modes for talking to the Drive API:
//
// 1. API KEY (legacy, still supported as a fallback): anonymous — Google
//    treats this traffic with much less trust, and it's what was getting
//    walled with "Sorry... automated queries" even on a single, first,
//    non-bursty request to the alt=media (file download) endpoint.
//
// 2. SERVICE ACCOUNT (preferred, used automatically when configured):
//    requests are signed as a specific Google identity your project
//    owns, via a short-lived OAuth Bearer token instead of a bare key in
//    the URL. Google treats this as normal authenticated server traffic,
//    not anonymous scraping. Files must be shared directly with the
//    service account's email (found in the downloaded JSON key's
//    `client_email` field) as a Viewer — "Anyone with the link" is no
//    longer required once a file is shared this way.
//
// If GOOGLE_SERVICE_ACCOUNT_KEY_PATH is set, it's used; otherwise this
// falls back to DRIVE_API_KEY exactly as before, so existing setups don't
// break while files are migrated over to being shared with the service
// account one at a time.
let cachedServiceAccountAuth = null;
function getServiceAccountAuth() {
  if (!DRIVE_SERVICE_ACCOUNT_KEY_PATH) return null;
  if (!cachedServiceAccountAuth) {
    cachedServiceAccountAuth = new GoogleAuth({
      keyFile: DRIVE_SERVICE_ACCOUNT_KEY_PATH,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
  }
  return cachedServiceAccountAuth;
}

let cachedDriveToken = null; // { token, expiresAt }

// Returns { Authorization: 'Bearer ...' } when a service account is
// configured, or null when falling back to the API-key-in-URL scheme.
// Tokens are cached and only refreshed a minute before they'd actually
// expire, so this doesn't mint a fresh token on every single request.
async function getDriveAuthHeader() {
  const auth = getServiceAccountAuth();
  if (!auth) return null;

  if (cachedDriveToken && Date.now() < cachedDriveToken.expiresAt - 60_000) {
    return { Authorization: `Bearer ${cachedDriveToken.token}` };
  }

  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  const expiresAt = client.credentials?.expiry_date || Date.now() + 55 * 60 * 1000;
  cachedDriveToken = { token, expiresAt };
  return { Authorization: `Bearer ${token}` };
}

if (DRIVE_SERVICE_ACCOUNT_KEY_PATH) {
  console.log('[media] Google Drive auth: service account (', DRIVE_SERVICE_ACCOUNT_KEY_PATH, ')');
} else if (DRIVE_API_KEY) {
  console.log('[media] Google Drive auth: API key (legacy fallback — consider migrating to a service account, see comments above)');
} else {
  console.warn('[media] Google Drive: no auth configured (set GOOGLE_SERVICE_ACCOUNT_KEY_PATH or GOOGLE_DRIVE_API_KEY)');
}

// Node's built-in fetch (Undici) was consistently getting Google's
// "automated queries" wall on this server while the exact same URL via
// curl succeeded every time — same machine, same network, same request.
// That points to something specific to Undici's TLS fingerprint (Windows
// antivirus doing HTTPS inspection is the usual suspect) rather than the
// IP, the key, or request volume. Since curl demonstrably works here,
// these two helpers shell out to it instead of using fetch() for the
// Drive calls specifically.
//
// NOTE: deliberately NOT using curl's `-f` here (anymore). `-f` makes curl
// exit non-zero on an HTTP error status, which is convenient for turning
// a bad response into a rejected promise — but it also discards the
// response body, and Google's Drive API always puts the actual reason
// (bad key, API disabled, quota, permission, etc.) in a JSON body on 4xx.
// Without `-f` we get the body AND can inspect the status via `-w`, so a
// failure tells you *why* instead of just "curl: (22)".
const CURL_ARGS = ['-sSL', '--max-time', '25'];
const STATUS_SEPARATOR = '\n__HTTP_STATUS__:';

// A board can have several Drive attachments, and multiple clients load
// the same board within moments of each other — without throttling, that
// produces a burst of many concurrent curl processes hitting
// googleapis.com from one IP at once. A sudden concurrent burst from a
// single IP is exactly the pattern Google's abuse detection flags with
// the "Sorry... automated queries" wall, independent of whether each
// individual request is legitimate. This tiny queue caps how many Drive
// requests are in flight at once and adds a small gap between each one
// starting, trading a bit of latency for not looking like a scraper.
const DRIVE_MAX_CONCURRENT = 2;
const DRIVE_MIN_GAP_MS = 200;
let driveActiveCount = 0;
let driveLastStart = 0;
const driveQueue = [];

function runDriveQueue() {
  if (driveActiveCount >= DRIVE_MAX_CONCURRENT || driveQueue.length === 0) return;
  const now = Date.now();
  const wait = Math.max(0, driveLastStart + DRIVE_MIN_GAP_MS - now);
  setTimeout(() => {
    if (driveActiveCount >= DRIVE_MAX_CONCURRENT || driveQueue.length === 0) return;
    const next = driveQueue.shift();
    driveActiveCount++;
    driveLastStart = Date.now();
    next();
    runDriveQueue(); // may still have concurrency headroom for another slot
  }, wait);
}

function scheduleDriveRequest(task) {
  return new Promise((resolve, reject) => {
    driveQueue.push(() => {
      task().then(resolve, reject).finally(() => {
        driveActiveCount--;
        runDriveQueue();
      });
    });
    runDriveQueue();
  });
}

async function curlGet(url, { encoding, headers = {} }) {
  const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  // Throttled: see scheduleDriveRequest above. Every outgoing Drive
  // request — file bytes or metadata — goes through this queue so bursts
  // get spread out instead of firing all at once.
  const { stdout } = await scheduleDriveRequest(() =>
    execFileAsync(
      'curl',
      [...CURL_ARGS, ...headerArgs, '-w', STATUS_SEPARATOR + '%{http_code}', url],
      { encoding: encoding === 'buffer' ? 'buffer' : 'utf8', maxBuffer: 100 * 1024 * 1024 }
    )
  );

  // Buffer and string need slightly different splitting since the marker
  // itself is always ASCII regardless of the body's encoding.
  const full = encoding === 'buffer' ? stdout : Buffer.from(stdout, 'utf8');
  const markerIndex = full.lastIndexOf(STATUS_SEPARATOR);
  if (markerIndex === -1) {
    // Shouldn't happen — -w always appends — but don't crash if it does.
    return { body: encoding === 'buffer' ? full : full.toString('utf8'), status: null };
  }
  const body = full.subarray(0, markerIndex);
  const status = full.subarray(markerIndex + STATUS_SEPARATOR.length).toString('utf8').trim();
  return {
    body: encoding === 'buffer' ? body : body.toString('utf8'),
    status: Number(status) || null,
  };
}

function driveErrorMessage(bodyText, status) {
  try {
    const parsed = JSON.parse(bodyText);
    if (parsed?.error?.message) {
      return `Google Drive API error (${status}): ${parsed.error.message}`;
    }
  } catch {
    // body wasn't JSON — fall through to a generic message below
  }
  return `Google Drive API error (${status}): ${bodyText.slice(0, 300)}`;
}

async function curlGetBuffer(url, headers) {
  const { body, status } = await curlGet(url, { encoding: 'buffer', headers });
  if (status !== null && (status < 200 || status >= 300)) {
    // Buffer body on an error response is the JSON error page as bytes —
    // decode it as text just for the error message.
    throw new Error(driveErrorMessage(body.toString('utf8'), status));
  }
  return body;
}

async function curlGetText(url, headers) {
  const { body, status } = await curlGet(url, { encoding: 'utf8', headers });
  if (status !== null && (status < 200 || status >= 300)) {
    throw new Error(driveErrorMessage(body, status));
  }
  return body;
}

// Builds the Drive API URL + headers for a given path/query, using
// whichever auth mode is configured (service account preferred, API key
// as fallback — see getDriveAuthHeader above).
async function buildDriveRequest(fileId, queryString) {
  const authHeader = await getDriveAuthHeader();
  if (authHeader) {
    return {
      url: `https://www.googleapis.com/drive/v3/files/${fileId}?${queryString}`,
      headers: authHeader,
    };
  }
  if (!DRIVE_API_KEY) {
    const err = new Error('Google Drive support is not configured on the server (no service account or API key).');
    err.status = 500;
    throw err;
  }
  return {
    url: `https://www.googleapis.com/drive/v3/files/${fileId}?${queryString}&key=${DRIVE_API_KEY}`,
    headers: {},
  };
}

/* -------------------------------------------------------------------------
   DRIVE FETCH CACHE + IN-FLIGHT COALESCING
   With N players in a room, everyone's client hits gdrive/:fileId (and
   gdrive/:fileId/meta) for the SAME clue at roughly the same moment a
   host reveals it — that's a burst of near-simultaneous requests to
   Google for one file, which looks exactly like the automated-query
   pattern Google's abuse detection blocks (the "Sorry..." wall), even
   though each individual request is legitimate.
   driveFileCache/driveMetaCache hold the result so only the FIRST request
   for a given fileId ever reaches Google; everyone else within the TTL
   gets served from memory. driveFileInFlight/driveMetaInFlight additionally
   coalesce requests that land while a fetch for that same fileId is still
   in progress, so a burst of N simultaneous first-time requests also only
   produces one real upstream call, not N racing ones.
   ------------------------------------------------------------------------- */
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 min — plenty for a single game session

// Google's Drive API throws a transient "Sorry... automated queries" wall
// when it sees a burst of requests it doesn't like — it clears on its own
// after a short cool-down, it isn't a sign of a bad key or config. Without
// negative caching, every failure immediately opened the door to the next
// request (another reconnecting client, a UI retry, etc.) firing a fresh
// call at Google right away — during a cool-down window that just means
// more requests hitting the wall, which is the opposite of what you want.
// Caching failures for a short, separate (shorter than the success) TTL
// means one bad patch of luck gets absorbed instead of cascading. A
// deliberate manual retry (force=1) skips this cache outright — see
// freshCacheEntry — so a user-initiated retry always gets a real attempt
// instead of reading back the same cached error.
// Was 30s — shortened to 6s. With in-flight coalescing already absorbing
// simultaneous first-time bursts (see block comment above), 30s meant a
// client's own auto-retry (and often a following manual "Retry" click)
// landed well inside the same window and just re-read the same stale
// error without ever reaching Google again. 6s is still enough to stop a
// tight retry loop from hammering the wall, but short enough that a
// deliberate retry a few seconds later gets a real attempt.
const FAILURE_CACHE_TTL_MS = 6 * 1000;

const driveFileCache = new Map(); // fileId -> { buffer, contentType, ts } | { error, status, ts }
const driveFileInFlight = new Map(); // fileId -> Promise
const driveMetaCache = new Map(); // fileId -> { mimeType, name, ts } | { error, status, ts }
const driveMetaInFlight = new Map(); // fileId -> Promise

// `force=true` (from the client's manual Retry button, not the automatic
// first retry) skips this cache read entirely, even if the entry is still
// within its TTL — so a deliberate retry always reaches Google for a
// fresh answer instead of being handed the same cached error (or, in the
// success case, the same content — harmless, but force is meant to mean
// "actually try again").
function freshCacheEntry(cache, fileId, force) {
  if (force) return null;
  const cached = cache.get(fileId);
  if (!cached) return null;
  const ttl = cached.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - cached.ts >= ttl) return null;
  return cached;
}

// Files above this size still get fetched and served to the requester
// (and still benefit from in-flight coalescing while that fetch is in
// progress — see driveFileInFlight/proxyFileInFlight), but the result is
// deliberately NOT written into the long-lived success cache. Jeopardy
// clues are usually short clips/images, but Drive in particular has no
// size limit of its own, so nothing stops a host from attaching a long
// video — without this cap, every large file that's ever been loaded
// would sit fully buffered in RAM for the next 15 minutes (see
// CACHE_TTL_MS) regardless of how big it was. A late-arriving client
// after the in-flight window closes just triggers one more real fetch
// instead of reading a giant buffer back from memory — worse latency for
// that one request, but bounded memory use overall.
const CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

// Wraps cache.set() with the size cap above. Only applies to success
// entries — error entries are tiny (just a message string) and always
// worth caching regardless of how big the file that failed would have
// been, so those always go through a plain cache.set() elsewhere.
function setCappedCacheEntry(cache, key, entry) {
  if (entry.buffer && entry.buffer.length > CACHE_MAX_BYTES) return;
  cache.set(key, entry);
}

// Periodic sweep: freshCacheEntry() above only ever treats a stale entry
// as absent, it never removes it — so without this, every fileId/url
// this server has ever fetched stays in memory for the life of the
// process, whether or not it's still relevant to any game in progress.
// This actually deletes entries once they're past their TTL (using the
// same error-vs-success TTL split as freshCacheEntry), so long-running
// server uptime doesn't mean ever-growing memory from boards that
// finished their game hours or days ago.
const CACHE_SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 min

function sweepCache(cache) {
  const now = Date.now();
  for (const [key, entry] of cache) {
    const ttl = entry.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
    if (now - entry.ts >= ttl) cache.delete(key);
  }
}

async function getDriveFile(fileId, force) {
  const cached = freshCacheEntry(driveFileCache, fileId, force);
  if (cached) {
    if (cached.error) {
      console.warn(`[media] serving cached failure for ${fileId} (age ${Math.round((Date.now() - cached.ts) / 1000)}s) — not retrying Google`);
      throw Object.assign(new Error(cached.error), { status: cached.status });
    }
    return cached;
  }

  if (!force && driveFileInFlight.has(fileId)) return driveFileInFlight.get(fileId);

  const promise = (async () => {
    // Reuses getDriveMeta (cached/coalesced same as this function) to get
    // the real Content-Type, since curl's stdout for the alt=media request
    // is just raw bytes with no headers attached to inspect.
    try {
      const meta = await getDriveMeta(fileId, force);
      const { url, headers } = await buildDriveRequest(fileId, 'alt=media');
      const buffer = await curlGetBuffer(url, headers);
      const entry = { buffer, contentType: meta.mimeType || 'application/octet-stream', ts: Date.now() };
      setCappedCacheEntry(driveFileCache, fileId, entry);
      return entry;
    } catch (e) {
      console.error('[media] gdrive curl fetch failed:', e.message);
      // Surface the real reason (e.g. Google's actual error body via
      // driveErrorMessage) instead of masking it with a generic string —
      // the generic hint is still appended so "share as Anyone with the
      // link" isn't lost as a possible cause, but it's no longer the ONLY
      // thing you see downstream of this.
      const message = `${e.message} (If this persists, also check the file is shared as "Anyone with the link".)`;
      driveFileCache.set(fileId, { error: message, status: 502, ts: Date.now() });
      const err = new Error(message);
      err.status = 502;
      throw err;
    }
  })();

  driveFileInFlight.set(fileId, promise);
  try {
    return await promise;
  } finally {
    driveFileInFlight.delete(fileId);
  }
}

async function getDriveMeta(fileId, force) {
  const cached = freshCacheEntry(driveMetaCache, fileId, force);
  if (cached) {
    if (cached.error) throw Object.assign(new Error(cached.error), { status: cached.status });
    return cached;
  }

  if (!force && driveMetaInFlight.has(fileId)) return driveMetaInFlight.get(fileId);

  const promise = (async () => {
    try {
      const { url, headers } = await buildDriveRequest(fileId, 'fields=mimeType,name');
      const text = await curlGetText(url, headers);
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('[media] gdrive meta returned non-JSON:', text.slice(0, 300));
        throw new Error('Drive metadata response was not valid JSON.');
      }
      const entry = { mimeType: data.mimeType || '', name: data.name || '', ts: Date.now() };
      driveMetaCache.set(fileId, entry);
      return entry;
    } catch (e) {
      console.error('[media] gdrive meta curl fetch failed:', e.message);
      // Same fix as getDriveFile above: keep the real error text instead
      // of collapsing everything down to a generic "fetch failed".
      const message = e.message;
      driveMetaCache.set(fileId, { error: message, status: 502, ts: Date.now() });
      const err = new Error(message);
      err.status = 502;
      throw err;
    }
  })();

  driveMetaInFlight.set(fileId, promise);
  try {
    return await promise;
  } finally {
    driveMetaInFlight.delete(fileId);
  }
}

// Pulls a Drive fileId out of the various share-link shapes Google hands
// out (`/file/d/<id>/...`, `?id=<id>`, `/d/<id>/...`). Intentionally
// permissive/best-effort — this is only used for the prewarm below, so a
// missed match just means no prewarm happens (falling back to the normal
// on-demand fetch when a client actually requests it), never a hard error.
function extractDriveFileId(url) {
  if (typeof url !== 'string') return null;
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /[?&]id=([a-zA-Z0-9_-]+)/,
    /\/d\/([a-zA-Z0-9_-]+)/,
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

// Fire-and-forget: kicks off the same cached/coalesced/queued fetch the
// gdrive proxy route uses, but BEFORE any client actually requests the
// file — called from bot-server.js's selectClue handler the moment a clue
// is picked, so the Drive round-trip happens while the host's ClueModal
// is still opening instead of after every player's <video>/<audio> tag
// requests it. By the time players actually hit /api/media/gdrive/:fileId,
// getDriveFile's own cache (see driveFileCache above) serves them straight
// from memory. Errors are swallowed here on purpose — the real
// /api/media/gdrive/:fileId route still runs (and still surfaces a proper
// error to the client) if this prewarm attempt fails or a fileId can't be
// extracted at all; this is purely a latency optimization, never a
// dependency.
function prewarmDriveMedia(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) return;
  getDriveFile(fileId).catch((e) => {
    console.warn('[media] prewarm failed for', fileId, '-', e.message);
  });
}


// CSP allowlist, and the actual file bytes get served from a
// googleusercontent.com redirect target that isn't fixed per-file, so a
// static URL Mapping can't just point at it directly.
//
// Uses the Drive API v3 (alt=media) rather than the old uc?export=download
// share link — that link now shows Google's "can't scan this file for
// viruses" interstitial for essentially any file fetched without the
// owner's own login, not just large ones, so it isn't reliable enough to
// build on.
//
// AUTH: prefers a service account (GOOGLE_SERVICE_ACCOUNT_KEY_PATH in
// .env, pointing at a downloaded JSON key) over a bare API key
// (GOOGLE_DRIVE_API_KEY) — see getServiceAccountAuth()/getDriveAuthHeader()
// above for why: anonymous API-key traffic to alt=media was tripping
// Google's "Sorry... automated queries" wall even on a single, non-bursty
// request, which authenticated service-account traffic doesn't. With a
// service account, files must be shared directly with its client_email as
// a Viewer (found in the downloaded JSON key) rather than "Anyone with the
// link"; the API key path still requires "Anyone with the link" -> Viewer
// as before. See getDriveFile() above for the caching/coalescing this
// route relies on, and the throttling queue further up for spreading out
// bursts from boards with several attachments.
//
// Buffers the whole file rather than piping the stream — simpler, and fine
// at this size since CustomVideoPlayer/CustomAudioPlayer already fetch()
// the whole thing into a blob client-side instead of letting <video>/<audio>
// stream it natively, so there's no Range support to preserve either way.
//
// Inherits requireAuth from router.use() above, same as every other route
// in this file — anyone who can open the board can load its attachments.
router.get('/gdrive/:fileId', async (req, res) => {
  const { fileId } = req.params;
  // ?force=1 comes from the client's manual "Retry" button (see
  // CustomVideoPlayer/CustomAudioPlayer/ClueMediaImage) — it means skip
  // driveFileCache entirely, even a fresh negative-cache entry, and
  // actually try Google again. The client's own automatic first retry
  // does NOT set this, so a normal transient blip still benefits from
  // in-flight coalescing instead of doubling up requests to Google.
  const force = req.query.force === '1';
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return res.status(400).send('Invalid file id');
  }
  if (!DRIVE_API_KEY && !DRIVE_SERVICE_ACCOUNT_KEY_PATH) {
    console.error('[media] gdrive proxy called but no Drive auth is configured (GOOGLE_SERVICE_ACCOUNT_KEY_PATH or GOOGLE_DRIVE_API_KEY)');
    return res.status(500).send('Google Drive support is not configured on the server');
  }

  try {
    const { buffer, contentType } = await getDriveFile(fileId, force);
    res.set('Content-Type', contentType);
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (err) {
    console.error('[media] gdrive proxy failed:', err);
    res.status(err.status || 502).send(err.message || 'Failed to load Google Drive file');
  }
});

// GET /api/media/gdrive/:fileId/meta
// Returns just { mimeType, name } via the Drive API's metadata endpoint
// (no alt=media, so this doesn't download the file body at all). Used by
// ClueModal to know upfront whether a Drive link is an image/video/audio
// file, instead of guessing image -> video -> audio and stopping at
// whichever happens to load first (which is how an audio file was ending
// up silently playable inside the video player skin — <video> will often
// play audio-only bytes just fine, so the guess-and-check never got to
// actually trying the audio player).
router.get('/gdrive/:fileId/meta', async (req, res) => {
  const { fileId } = req.params;
  const force = req.query.force === '1';
  if (!/^[a-zA-Z0-9_-]+$/.test(fileId)) {
    return res.status(400).json({ error: 'Invalid file id' });
  }
  if (!DRIVE_API_KEY && !DRIVE_SERVICE_ACCOUNT_KEY_PATH) {
    return res.status(500).json({ error: 'Google Drive support is not configured on the server' });
  }

  try {
    const { mimeType, name } = await getDriveMeta(fileId, force);
    res.json({ mimeType, name });
  } catch (err) {
    console.error('[media] gdrive meta proxy failed:', err);
    res.status(err.status || 502).json({ error: err.message || 'Failed to load Google Drive file metadata' });
  }
});

/* -------------------------------------------------------------------------
   GENERIC PROXY CACHE + IN-FLIGHT COALESCING
   Same problem as the Drive fetch cache above, for arbitrary third-party
   image/video/audio URLs (imgur, a news CDN, a personal image host, etc.)
   pasted directly as a clue's media link: with N players in a room,
   everyone's client hits /api/media/proxy?url=<same URL> within moments
   of each other the instant a host opens a clue.

   Unlike the gdrive route above, this one had ZERO caching or
   coalescing until now — every client's request went straight upstream
   with no dedup at all, so a burst of N simultaneous requests produced N
   separate upstream fetches. If the source host is slow, rate-limits
   bursts, or just blips on any one of those N attempts, that one
   client's image comes back blank while everyone else's loads fine —
   and since nothing here shared the result, closing and reopening the
   clue is just a fresh, independent attempt that isn't racing N-1
   siblings anymore, which is why it "works the second time" even though
   nothing about the link itself changed.

   Reuses freshCacheEntry/CACHE_TTL_MS/FAILURE_CACHE_TTL_MS from the
   Drive cache above — same tradeoffs apply here.
   ------------------------------------------------------------------------- */
const proxyFileCache = new Map(); // url -> { buffer, contentType, ts } | { error, status, ts }
const proxyFileInFlight = new Map(); // url -> Promise

// 25s to match the Drive curl calls' --max-time above — a bare fetch()
// has no timeout by default, so without this a hung upstream host could
// leave a request (and everyone coalesced onto it) dangling far longer
// than the client's own 45s giving up would suggest.
const PROXY_FETCH_TIMEOUT_MS = 25 * 1000;

async function getProxiedMedia(url, force) {
  const cached = freshCacheEntry(proxyFileCache, url, force);
  if (cached) {
    if (cached.error) {
      console.warn(`[media] serving cached failure for proxy url (age ${Math.round((Date.now() - cached.ts) / 1000)}s) — not retrying upstream: ${url}`);
      throw Object.assign(new Error(cached.error), { status: cached.status });
    }
    return cached;
  }

  if (!force && proxyFileInFlight.has(url)) return proxyFileInFlight.get(url);

  const promise = (async () => {
    try {
      const upstream = await fetch(url, { signal: AbortSignal.timeout(PROXY_FETCH_TIMEOUT_MS) });
      if (!upstream.ok) {
        const message = `Upstream error: ${upstream.status}`;
        proxyFileCache.set(url, { error: message, status: upstream.status, ts: Date.now() });
        const err = new Error(message);
        err.status = upstream.status;
        throw err;
      }
      const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
      const buffer = Buffer.from(await upstream.arrayBuffer());
      const entry = { buffer, contentType, ts: Date.now() };
      setCappedCacheEntry(proxyFileCache, url, entry);
      return entry;
    } catch (e) {
      // Already classified (upstream responded, just not with 2xx) and
      // already cached above — just propagate as-is, don't re-log/re-cache.
      if (e.status) throw e;
      // A genuine network-level failure (DNS, connection refused, our
      // own timeout above, etc.) — no upstream status to preserve.
      console.error('[media] proxy fetch failed:', e.message, 'url=' + url);
      const message = 'Failed to fetch media';
      proxyFileCache.set(url, { error: message, status: 502, ts: Date.now() });
      const err = new Error(message);
      err.status = 502;
      throw err;
    }
  })();

  proxyFileInFlight.set(url, promise);
  try {
    return await promise;
  } finally {
    proxyFileInFlight.delete(url);
  }
}

// GET /api/media/proxy?url=<encoded>
// Proxies an arbitrary external image/video/audio URL through our own
// server so it loads same-origin. Inside a Discord Activity, img-src /
// media-src / connect-src only allow 'self', discordsays.com, and a
// couple of discordapp.com/media.discordapp.net hosts — any other domain
// (a news CDN, imgur, etc.) gets blocked at the CSP layer before it ever
// produces a normal network error. That's what was pushing ClueModal's
// image -> video -> audio fallback cascade all the way down to the audio
// player: every attempt (img tag, video tag, audio tag, and the blob
// prefetch fetch()) was being refused by the same CSP directives, not
// actually failing to load.
//
// See getProxiedMedia above for the caching/coalescing this route relies
// on to survive N players' clients all requesting the same clue's image
// within the same moment.
router.get('/proxy', async (req, res) => {
  const { url } = req.query;
  // ?force=1 comes from the client's manual "Retry" button, same
  // convention as /gdrive/:fileId above — skips the cache (even a fresh
  // negative entry) and makes a real attempt.
  const force = req.query.force === '1';
  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).send('Invalid url');
  }
  try {
    const { buffer, contentType } = await getProxiedMedia(url, force);
    res.set('Content-Type', contentType);
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (err) {
    console.error('[media] proxy fetch failed:', err.message);
    res.status(err.status || 502).send(err.message || 'Failed to fetch media');
  }
});

const MEDIA_REF_PREFIX = 'media:';

// Walks a board's clue data (rounds -> categories -> clues) and deletes
// every attached Supabase Storage file in one batched call. Used when a
// whole board is deleted, so its attachments don't outlive it as orphaned
// files. Best-effort: logs failures but never throws — a storage hiccup
// shouldn't block deleting the board record itself.
async function deleteMediaForBoardData(data) {
  const keys = new Set();
  for (const round of data?.rounds || []) {
    for (const cat of round.categories || []) {
      for (const clue of Object.values(cat.clues || {})) {
        for (const field of [clue.mediaUrl, clue.answerMediaUrl]) {
          if (typeof field === 'string' && field.startsWith(MEDIA_REF_PREFIX)) {
            keys.add(field.slice(MEDIA_REF_PREFIX.length));
          }
        }
      }
    }
  }
  if (keys.size === 0) return;
  // Note: this deletes regardless of which user's ownerId prefix is on
  // the key, unlike the single-file DELETE route above — deleting the
  // whole board is an owner action, so all of its attachments go with it
  // even if a collaborator uploaded some of them.
  const { error } = await supabase.storage.from(BUCKET).remove([...keys]);
  if (error) {
    console.error('Supabase bulk delete error (board cleanup):', error);
  }
}

// Runs every 5 min for the life of the process, actually evicting stale
// entries from every media cache instead of just letting them sit there
// forever (see sweepCache above). driveMetaCache is included even though
// its entries are tiny (no buffer, just a mimeType/name string) — no
// harm in keeping it tidy too. .unref() so this interval alone doesn't
// keep the Node process alive if everything else has already shut down.
setInterval(() => {
  sweepCache(driveFileCache);
  sweepCache(driveMetaCache);
  sweepCache(proxyFileCache);
}, CACHE_SWEEP_INTERVAL_MS).unref();

module.exports = router;
module.exports.deleteMediaForBoardData = deleteMediaForBoardData;
module.exports.prewarmDriveMedia = prewarmDriveMedia;

// Copies every Supabase Storage file attached to a board's clue data into
// new keys namespaced under `newOwnerId`, and rewrites the clue refs to
// point at the copies. Used when duplicating a board, so the duplicate
// owns its own files — otherwise deleting the original later would wipe
// out files the duplicate still points at.
//
// Best-effort per file: if a copy fails, that one ref is left pointing at
// the original file (duplicate still works, just isn't fully independent
// for that one attachment) rather than failing the whole duplicate.
async function duplicateMediaForBoardData(data, newOwnerId) {
  const oldKeys = new Set();
  for (const round of data?.rounds || []) {
    for (const cat of round.categories || []) {
      for (const clue of Object.values(cat.clues || {})) {
        for (const field of [clue.mediaUrl, clue.answerMediaUrl]) {
          if (typeof field === 'string' && field.startsWith(MEDIA_REF_PREFIX)) {
            oldKeys.add(field.slice(MEDIA_REF_PREFIX.length));
          }
        }
      }
    }
  }
  if (oldKeys.size === 0) return data;

  const path = require('path');
  const refMap = new Map(); // oldKey -> newKey, only populated on successful copy
  for (const oldKey of oldKeys) {
    const destKey = newKey(newOwnerId, path.basename(oldKey));
    const { error } = await supabase.storage.from(BUCKET).copy(oldKey, destKey);
    if (error) {
      console.error('Supabase copy error (duplicate board):', oldKey, error);
      continue;
    }
    refMap.set(oldKey, destKey);
  }
  if (refMap.size === 0) return data;

  for (const round of data.rounds || []) {
    for (const cat of round.categories || []) {
      for (const clue of Object.values(cat.clues || {})) {
        for (const field of ['mediaUrl', 'answerMediaUrl']) {
          const val = clue[field];
          if (typeof val === 'string' && val.startsWith(MEDIA_REF_PREFIX)) {
            const oldKey = val.slice(MEDIA_REF_PREFIX.length);
            if (refMap.has(oldKey)) {
              clue[field] = MEDIA_REF_PREFIX + refMap.get(oldKey);
            }
          }
        }
      }
    }
  }
  return data;
}

module.exports.duplicateMediaForBoardData = duplicateMediaForBoardData;