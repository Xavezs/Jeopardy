const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');
const { deleteMediaForBoardData, duplicateMediaForBoardData } = require('./media');

const router = express.Router();
router.use(requireAuth);

function newId() {
  return 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function newGameId() {
  return 'game_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

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

// GET /api/boards
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

// POST /api/boards
router.post('/', (req, res) => {
  const { name, data } = req.body;
  const id = newId();
  const now = Date.now();
  db.prepare(
    'INSERT INTO boards (id, owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.id, name, JSON.stringify(data), now, now);
  res.json({ id, name, createdAt: now, updatedAt: now, data, isOwner: true, roomCode: null });
});

// PUT /api/boards/:id
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

// DELETE /api/boards/:id
router.delete('/:id', requireRole('owner'), async (req, res) => {
  const row = db.prepare('SELECT data FROM boards WHERE id = ?').get(req.params.id);
  if (row) {
    try {
      await deleteMediaForBoardData(JSON.parse(row.data));
    } catch (e) {
      console.error('Media cleanup failed for board', req.params.id, e);
    }
  }
  db.prepare('DELETE FROM boards WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM board_members WHERE board_id = ?').run(req.params.id);
  db.prepare('DELETE FROM saved_games WHERE board_id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/boards/:id/duplicate
router.post('/:id/duplicate', requireRole('viewer'), async (req, res) => {
  const row = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  const { name } = req.body;
  const id = newId();
  const now = Date.now();
  const data = JSON.parse(row.data);
  try {
    await duplicateMediaForBoardData(data, req.user.id);
  } catch (e) {
    console.error('Media duplication failed for board', req.params.id, e);
  }
  db.prepare(
    'INSERT INTO boards (id, owner_id, name, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.id, name, JSON.stringify(data), now, now);
  res.json({ id, name, createdAt: now, updatedAt: now, data, isOwner: true, roomCode: null });
});

// POST /api/boards/:id/invite
router.post('/:id/invite', requireRole('owner'), (req, res) => {
  const row = db.prepare('SELECT room_code FROM boards WHERE id = ?').get(req.params.id);
  let code = row.room_code;
  if (!code) {
    do {
      code = newRoomCode();
    } while (db.prepare('SELECT 1 FROM boards WHERE room_code = ?').get(code));
    db.prepare('UPDATE boards SET room_code = ? WHERE id = ?').run(code, req.params.id);
  }
  res.json({ roomCode: code });
});

// POST /api/boards/:id/rotate-invite
router.post('/:id/rotate-invite', requireRole('owner'), (req, res) => {
  let code;
  do {
    code = newRoomCode();
  } while (db.prepare('SELECT 1 FROM boards WHERE room_code = ?').get(code));
  db.prepare('UPDATE boards SET room_code = ? WHERE id = ?').run(code, req.params.id);
  res.json({ roomCode: code });
});

// POST /api/boards/join
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

// PUT /api/boards/:id/channel
router.put('/:id/channel', requireRole('owner'), (req, res) => {
  const { discordChannelId } = req.body;
  db.prepare('UPDATE boards SET discord_channel_id = ? WHERE id = ?').run(discordChannelId || null, req.params.id);
  res.json({ ok: true, discordChannelId: discordChannelId || null });
});

// POST /api/boards/:id/games
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

  // Credit player wallets
  const ranking = Array.isArray(finalScores.ranking) ? finalScores.ranking : [];
  const rankByTeam = new Map(ranking.map((r) => [r.teamId, r.rank]));

  const creditStmt = db.prepare(`
    INSERT INTO player_wallets (user_id, coins, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      coins = coins + excluded.coins,
      updated_at = excluded.updated_at
  `);

  for (const [userId, stats] of Object.entries(finalScores.playerStats || {})) {
    if (!userId || userId.startsWith('p_')) continue; // skip non-Discord ids
    let earned = (stats.correct || 0) * 100;
    const rank = stats.teamId ? rankByTeam.get(stats.teamId) : null;
    if (rank === 1) earned += 200;
    else if (rank === 2) earned += 100;
    if (earned > 0) creditStmt.run(userId, earned, now);
  }

  res.json({ id, boardId: req.params.id, hostId: req.user.id, playedAt: now, finalScores });
});

// GET /api/boards/:id/games
router.get('/:id/games', requireRole('viewer'), (req, res) => {
  const rows = db
    .prepare('SELECT * FROM saved_games WHERE board_id = ? ORDER BY played_at DESC')
    .all(req.params.id);
  res.json(rows.map(gameFromRow));
});

module.exports = router;