// discord-bot/boards.js
//
// Board storage, now shared instead of single-owner.
//
// ACCESS MODEL:
// - owner_id on the board = full control (rename, invite, delete, duplicate)
// - board_members = everyone else with access. role is 'editor' (can view
//   + save changes) or 'viewer' (read-only). Owner is never duplicated
//   into this table.
//
// NEW ROUTES:
// - POST /api/boards/:id/invite  -> { roomCode }  (owner only; generates
//   the code the first time it's called, reuses it after that)
// - POST /api/boards/join        -> { roomCode } in body -> joins caller
//   as an editor, returns the full board
// - PUT  /api/boards/:id/channel -> { discordChannelId } (owner only;
//   binds this board's buzzer to a Discord voice channel so /buzz from
//   that channel feeds the same room as the web Buzz button)
// - POST /api/boards/:id/games   -> { finalScores } (editor+; snapshot of
//   one completed playthrough — see saved_games in db.js)
// - GET  /api/boards/:id/games   -> list of past playthroughs for this
//   board, most recent first (viewer+)

const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');
const { deleteMediaForBoardData, duplicateMediaForBoardData } = require('./media');

const router = express.Router();
router.use(requireAuth); // every route below needs a logged-in user

function newId() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function newGameId() {
  return 'game_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

// Short, easy-to-read-aloud room codes: no ambiguous chars (0/O, 1/I).
function newRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function metaFromRow(row, viewerId) {
  const data = JSON.parse(row.data);
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Final Jeopardy rounds (type: "final") have no .categories grid at
    // all — guard against that instead of assuming every round is a
    // normal category×value grid, or this crashes (500) the moment any
    // board has been migrated to include one.
    categoryCount: data.rounds.reduce((sum, r) => sum + (r.categories ? r.categories.length : 0), 0),
    roundCount: data.rounds.length,
    teamCount: data.teams.length,
    isOwner: row.owner_id === viewerId,
    roomCode: row.owner_id === viewerId ? row.room_code || null : undefined,
  };
}

function fullFromRow(row, viewerId) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    data: JSON.parse(row.data),
    discordChannelId: row.discord_channel_id || null,
    isOwner: row.owner_id === viewerId,
    // Only the owner needs to see/share the code from inside the board itself.
    roomCode: row.owner_id === viewerId ? row.room_code || null : undefined,
  };
}

function gameFromRow(row) {
  return {
    id: row.id,
    boardId: row.board_id,
    hostId: row.host_id,
    playedAt: row.played_at,
    finalScores: JSON.parse(row.final_scores),
  };
}

// role: 'owner' | 'editor' | 'viewer' | null (no access)
function getRole(boardId, userId) {
  const board = db.prepare('SELECT owner_id FROM boards WHERE id = ?').get(boardId);
  if (!board) return null;
  if (board.owner_id === userId) return 'owner';
  const member = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(boardId, userId);
  return member ? member.role : null;
}

function requireRole(minRole) {
  const rank = { viewer: 0, editor: 1, owner: 2 };
  return (req, res, next) => {
    const role = getRole(req.params.id, req.user.id);
    if (!role || rank[role] < rank[minRole]) {
      return res.status(role ? 403 : 404).json({ error: role ? 'Not allowed' : 'Not found' });
    }
    req.boardRole = role;
    next();
  };
}

// GET /api/boards — boards you own OR were added to (matches old getIndex() shape)
router.get('/', (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT b.* FROM boards b
       LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
       WHERE b.owner_id = ? OR m.user_id = ?`
    )
    .all(req.user.id, req.user.id, req.user.id);
  res.json(rows.map((r) => metaFromRow(r, req.user.id)));
});

// GET /api/boards/:id
router.get('/:id', requireRole('viewer'), (req, res) => {
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  res.json(fullFromRow(row, req.user.id));
});

// POST /api/boards — create
router.post('/', (req, res) => {
  const { name, data } = req.body;
  const id = newId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO boards (id, owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.id, name, JSON.stringify(data), now, now);
  res.json({ id, name, createdAt: now, updatedAt: now, data, isOwner: true, roomCode: null });
});

// PUT /api/boards/:id — save (owner or editor)
router.put('/:id', requireRole('editor'), (req, res) => {
  const { name, data } = req.body;
  const now = Date.now();
  db.prepare('UPDATE boards SET name = ?, data = ?, updated_at = ? WHERE id = ?').run(
    name,
    JSON.stringify(data),
    now,
    req.params.id
  );
  res.json({ ok: true, updatedAt: now });
});

// DELETE /api/boards/:id — owner only
router.delete('/:id', requireRole('owner'), async (req, res) => {
  const row = db.prepare('SELECT data FROM boards WHERE id = ?').get(req.params.id);
  if (row) {
    try {
      await deleteMediaForBoardData(JSON.parse(row.data));
    } catch (e) {
      // Don't let a storage-side hiccup stop the board itself from being
      // deleted — worst case a file lingers in Supabase, which is far
      // better than the user being stuck unable to delete their board.
      console.error('Media cleanup failed for board', req.params.id, e);
    }
  }
  db.prepare('DELETE FROM boards WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM board_members WHERE board_id = ?').run(req.params.id);
  db.prepare('DELETE FROM saved_games WHERE board_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/boards/:id/duplicate — owner or editor can duplicate; copy is owned by whoever duplicates it
router.post('/:id/duplicate', requireRole('viewer'), async (req, res) => {
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  const { name } = req.body;
  const id = newId();
  const now = Date.now();
  const data = JSON.parse(row.data);
  try {
    // Give the duplicate its own copies of any attached files, so deleting
    // the original board later doesn't take the duplicate's media with it.
    await duplicateMediaForBoardData(data, req.user.id);
  } catch (e) {
    console.error('Media duplication failed for board', req.params.id, e);
    // Fall back to the duplicate sharing the original's files rather than
    // failing the whole duplicate action.
  }
  db.prepare(
    'INSERT INTO boards (id, owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.id, name, JSON.stringify(data), now, now);
  res.json({ id, name, createdAt: now, updatedAt: now, data, isOwner: true, roomCode: null });
});

// POST /api/boards/:id/invite — owner only. Generates the room code the
// first time, returns the existing one on subsequent calls (so re-clicking
// "invite" in the UI doesn't invalidate a code you already shared).
router.post('/:id/invite', requireRole('owner'), (req, res) => {
  const row = db.prepare('SELECT room_code FROM boards WHERE id = ?').get(req.params.id);
  let code = row.room_code;
  if (!code) {
    // Extremely unlikely to collide at 33^6, but guard anyway.
    do {
      code = newRoomCode();
    } while (db.prepare('SELECT 1 FROM boards WHERE room_code = ?').get(code));
    db.prepare('UPDATE boards SET room_code = ? WHERE id = ?').run(code, req.params.id);
  }
  res.json({ roomCode: code });
});

// POST /api/boards/:id/rotate-invite — owner only. Replaces the existing
// room code when the host needs to invalidate a compromised or broken code.
router.post('/:id/rotate-invite', requireRole('owner'), (req, res) => {
  let code;
  do {
    code = newRoomCode();
  } while (db.prepare('SELECT 1 FROM boards WHERE room_code = ?').get(code));
  db.prepare('UPDATE boards SET room_code = ? WHERE id = ?').run(code, req.params.id);
  res.json({ roomCode: code });
});

// POST /api/boards/join — { roomCode } -> joins caller as editor
router.post('/join', (req, res) => {
  const { roomCode } = req.body;
  if (!roomCode) return res.status(400).json({ error: 'roomCode required' });
  const row = db.prepare('SELECT * FROM boards WHERE room_code = ?').get(roomCode.trim().toUpperCase());
  if (!row) return res.status(404).json({ error: 'No board with that room code' });

  if (row.owner_id !== req.user.id) {
    db.prepare(
      `INSERT INTO board_members (board_id, user_id, role, joined_at)
       VALUES (?, ?, 'editor', ?)
       ON CONFLICT(board_id, user_id) DO NOTHING`
    ).run(row.id, req.user.id, Date.now());
  }
  res.json(fullFromRow(row, req.user.id));
});

// PUT /api/boards/:id/channel — owner only. Binds this board to a Discord
// voice channel so /buzz from players sitting in that channel feeds the
// same buzzer queue as the web Buzz button. Pass null to unbind.
router.put('/:id/channel', requireRole('owner'), (req, res) => {
  const { discordChannelId } = req.body;
  db.prepare('UPDATE boards SET discord_channel_id = ? WHERE id = ?').run(discordChannelId || null, req.params.id);
  res.json({ ok: true, discordChannelId: discordChannelId || null });
});

// POST /api/boards/:id/games — editor or owner. Called once, when the
// host ends the game — writes a snapshot of that playthrough (final team
// scores + ranking + per-player correct/wrong stats). Distinct from PUT
// /:id above, which saves the editable board template, not a play result.
// req.user.id is trusted as host_id (whoever is authenticated and has
// edit access is the one who ran the session, not necessarily the
// board's original owner — a friend with editor access can host too).
router.post('/:id/games', requireRole('editor'), (req, res) => {
  const { finalScores } = req.body;
  if (!finalScores || typeof finalScores !== 'object') {
    return res.status(400).json({ error: 'finalScores required' });
  }
  const id = newGameId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO saved_games (id, board_id, host_id, final_scores, played_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, req.params.id, req.user.id, JSON.stringify(finalScores), now);
  res.json({ id, boardId: req.params.id, hostId: req.user.id, playedAt: now, finalScores });
});

// GET /api/boards/:id/games — viewer+. Most recent playthrough first, so
// a leaderboard/history UI doesn't have to re-sort client-side.
router.get('/:id/games', requireRole('viewer'), (req, res) => {
  const rows = db
    .prepare('SELECT * FROM saved_games WHERE board_id = ? ORDER BY played_at DESC')
    .all(req.params.id);
  res.json(rows.map(gameFromRow));
});

module.exports = router;