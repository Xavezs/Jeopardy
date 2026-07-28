// discord-bot/media.js
//
// npm install multer
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
const supabase = require('./supabaseClient');
const { requireAuth } = require('./auth');

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

module.exports = router;
module.exports.deleteMediaForBoardData = deleteMediaForBoardData;

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