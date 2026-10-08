const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { GoogleAuth } = require('google-auth-library');
const supabase = require('./supabaseClient');
const { requireAuth } = require('./auth');
const { safeFetch, isAllowedMediaType } = require('./safeFetch');

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
router.delete('/*splat', async (req, res) => {
  const key = req.params.splat.join('/');
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

let cachedDriveToken = null;

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

const CURL_ARGS = ['-sSL', '--max-time', '25'];
const STATUS_SEPARATOR = '\n__HTTP_STATUS__:';

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
    runDriveQueue();
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
  // Throttled: see scheduleDriveRequest above
  const { stdout } = await scheduleDriveRequest(() =>
    execFileAsync(
      'curl',
      [...CURL_ARGS, ...headerArgs, '-w', STATUS_SEPARATOR + '%{http_code}', url],
      { encoding: encoding === 'buffer' ? 'buffer' : 'utf8', maxBuffer: 100 * 1024 * 1024 }
    )
  );

  const full = encoding === 'buffer' ? stdout : Buffer.from(stdout, 'utf8');
  const markerIndex = full.lastIndexOf(STATUS_SEPARATOR);
  if (markerIndex === -1) {
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
  }
  return `Google Drive API error (${status}): ${bodyText.slice(0, 300)}`;
}

async function curlGetBuffer(url, headers) {
  const { body, status } = await curlGet(url, { encoding: 'buffer', headers });
  if (status !== null && (status < 200 || status >= 300)) {
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

// DRIVE FETCH CACHE + IN-FLIGHT COALESCING
const CACHE_TTL_MS = 15 * 60 * 1000;

const FAILURE_CACHE_TTL_MS = 6 * 1000;

const driveFileCache = new Map();
const driveFileInFlight = new Map(); // fileId -> Promise
const driveMetaCache = new Map();
const driveMetaInFlight = new Map(); // fileId -> Promise

function freshCacheEntry(cache, fileId, force) {
  if (force) return null;
  const cached = cache.get(fileId);
  if (!cached) return null;
  const ttl = cached.error ? FAILURE_CACHE_TTL_MS : CACHE_TTL_MS;
  if (Date.now() - cached.ts >= ttl) return null;
  return cached;
}

const CACHE_MAX_BYTES = 20 * 1024 * 1024; // 20 MB

// Wraps cache.set() with the size cap above
function setCappedCacheEntry(cache, key, entry) {
  if (entry.buffer && entry.buffer.length > CACHE_MAX_BYTES) return;
  cache.set(key, entry);
}

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
    try {
      const meta = await getDriveMeta(fileId, force);
      const { url, headers } = await buildDriveRequest(fileId, 'alt=media');
      const buffer = await curlGetBuffer(url, headers);
      const entry = { buffer, contentType: meta.mimeType || 'application/octet-stream', ts: Date.now() };
      setCappedCacheEntry(driveFileCache, fileId, entry);
      return entry;
    } catch (e) {
      console.error('[media] gdrive curl fetch failed:', e.message);
      // Surface the real reason (e.g
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

function prewarmDriveMedia(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) return;
  getDriveFile(fileId).catch((e) => {
    console.warn('[media] prewarm failed for', fileId, '-', e.message);
  });
}

function prewarmProxyMedia(url) {
  getProxiedMedia(url).catch((e) => {
    console.warn('[media] proxy prewarm failed for', url, '-', e.message);
  });
}

function prewarmAllBoardMedia(boardData) {
  const rounds = boardData?.rounds || [];
  for (const round of rounds) {
    if (round.type === 'final') continue;
    for (const cat of round.categories || []) {
      for (const clue of Object.values(cat.clues || {})) {
        for (const url of [clue.mediaUrl, clue.answerMediaUrl]) {
          if (!url) continue;
          if (/youtu\.?be/i.test(url)) continue; // iframe embed, never proxied/warmable
          if (url.startsWith('media:')) continue;
          if (extractDriveFileId(url)) {
            prewarmDriveMedia(url);
          } else if (/^https?:\/\//i.test(url)) {
            prewarmProxyMedia(url);
          }
        }
      }
    }
  }
}



router.get('/gdrive/:fileId', async (req, res) => {
  const { fileId } = req.params;
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

// GENERIC PROXY CACHE + IN-FLIGHT COALESCING
const proxyFileCache = new Map();
const proxyFileInFlight = new Map(); // url -> Promise

const PROXY_FETCH_TIMEOUT_MS = 25 * 1000;
const PROXY_MAX_BYTES = 100 * 1024 * 1024;

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
      const upstream = await safeFetch(url, { timeoutMs: PROXY_FETCH_TIMEOUT_MS, maxBytes: PROXY_MAX_BYTES });
      if (upstream.status < 200 || upstream.status >= 300) {
        const message = `Upstream error: ${upstream.status}`;
        proxyFileCache.set(url, { error: message, status: upstream.status, ts: Date.now() });
        const err = new Error(message);
        err.status = upstream.status;
        throw err;
      }
      const contentType = upstream.contentType || 'application/octet-stream';
      if (!isAllowedMediaType(contentType)) {
        throw Object.assign(new Error('Not a media file'), { status: 415 });
      }
      const buffer = upstream.buffer;
      const entry = { buffer, contentType, ts: Date.now() };
      setCappedCacheEntry(proxyFileCache, url, entry);
      return entry;
    } catch (e) {
      if (e.status) throw e;
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
router.get('/proxy', async (req, res) => {
  const { url } = req.query;
  const force = req.query.force === '1';
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
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
  const { error } = await supabase.storage.from(BUCKET).remove([...keys]);
  if (error) {
    console.error('Supabase bulk delete error (board cleanup):', error);
  }
}

setInterval(() => {
  sweepCache(driveFileCache);
  sweepCache(driveMetaCache);
  sweepCache(proxyFileCache);
}, CACHE_SWEEP_INTERVAL_MS).unref();

module.exports = router;
module.exports.deleteMediaForBoardData = deleteMediaForBoardData;
module.exports.prewarmDriveMedia = prewarmDriveMedia;
module.exports.prewarmAllBoardMedia = prewarmAllBoardMedia;

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
  const refMap = new Map();
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