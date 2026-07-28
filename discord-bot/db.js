// discord-bot/db.js
//
// No npm install needed for this file — Node's built-in SQLite module
// (node:sqlite) has been part of Node itself since v22.5, and is no
// longer experimental as of v22.13/v23.4.
//
// CHANGES FOR MULTIPLAYER:
// - boards.room_code: a short shareable code a friend can use to join
//   a board they don't own. Nullable — generated on demand via
//   POST /api/boards/:id/invite, not on every board.
// - boards.discord_channel_id: which Discord voice channel this board's
//   buzzer is bound to. Set by the host from a dropdown in the app.
// - board_members: who has access to a board besides the owner, and
//   what they're allowed to do (editor can edit/save, viewer read-only).
//   The owner is NOT duplicated into this table — ownership is still
//   boards.owner_id, board_members is purely for *additional* people.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Resolve relative to THIS file's location, not the process's current
// working directory — otherwise starting the server from a different
// folder (repo root vs. inside discord-bot/) silently creates a second,
// separate jeopardy.db instead of opening the one you already have data in.
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'jeopardy.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_boards_owner ON boards(owner_id);

  CREATE TABLE IF NOT EXISTS board_members (
    board_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'editor', -- 'editor' | 'viewer'
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_members_user ON board_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_members_board ON board_members(board_id);
`);

// --- lightweight migration for DBs created before this update ---
// node:sqlite throws if you ALTER TABLE ADD COLUMN an existing column,
// so probe first via pragma rather than try/catch-and-ignore (which would
// also swallow real errors).
function columnExists(table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r) => r.name === column);
}
if (!columnExists('boards', 'room_code')) {
  db.exec(`ALTER TABLE boards ADD COLUMN room_code TEXT;`);
}
if (!columnExists('boards', 'discord_channel_id')) {
  db.exec(`ALTER TABLE boards ADD COLUMN discord_channel_id TEXT;`);
}
// room_code needs to be unique but SQLite can't add a UNIQUE constraint
// via ALTER TABLE — enforce it with a partial unique index instead
// (partial so multiple NULLs, i.e. boards with no code yet, are allowed).
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_room_code
  ON boards(room_code) WHERE room_code IS NOT NULL;
`);

module.exports = db;