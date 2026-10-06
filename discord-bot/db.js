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
//
// CHANGES FOR END-GAME STATS:
// - saved_games: one row per completed play session of a board. Distinct
//   from `boards` itself (the editable template) — this is a snapshot of
//   how one specific playthrough ended, written once when the host ends
//   the game. final_scores is a JSON blob shaped like:
//     { teams: [{id,name,score}], ranking: [{teamId,rank,score}],
//       playerStats: { [discordUserId]: {username, correct, wrong, teamId} } }
//   Kept as opaque JSON (like boards.data) rather than normalized columns
//   since the shape is still evolving and nothing here needs to be
//   queried/filtered at the SQL level yet — just listed per board.
//
// CHANGES FOR COSMETICS SHOP:
// - player_wallets: one row per Discord user, tracks their coin balance.
//   Coins are earned at game-end (POST /api/boards/:id/games) — 100 per
//   correct answer, +200 bonus for 1st place, +100 for 2nd.
// - shop_items: the catalog of purchasable cosmetics, seeded at startup.
//   type is 'buzz_sound' for now; extend with 'name_color', etc. later.
//   data is a JSON blob with asset/config details specific to each type.
// - player_inventory: which items each player owns + which is equipped.
//   At most one item per type can be equipped at a time (enforced in
//   the buy/equip routes, not at the DB level so it stays flexible).

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

  CREATE TABLE IF NOT EXISTS saved_games (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    host_id TEXT NOT NULL,
    final_scores TEXT NOT NULL,
    played_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_saved_games_board ON saved_games(board_id);

  CREATE TABLE IF NOT EXISTS player_wallets (
    user_id    TEXT PRIMARY KEY,
    coins      INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS shop_items (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       INTEGER NOT NULL,
    type        TEXT NOT NULL,
    data        TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS player_inventory (
    user_id     TEXT NOT NULL,
    item_id     TEXT NOT NULL,
    equipped    INTEGER NOT NULL DEFAULT 0,
    acquired_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, item_id)
  );
  CREATE INDEX IF NOT EXISTS idx_inventory_user ON player_inventory(user_id);
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

// ── Shop catalog seed ──────────────────────────────────────────────────────
// Insert default items only if they don't already exist. Using INSERT OR
// IGNORE so re-running (server restart) is safe and doesn't duplicate rows.
// Add new items here — they'll appear on the next restart automatically.
const seedItems = [
  // ── Buzz sounds ──────────────────────────────────────────────────────────
  // The 'asset' field is a path relative to the server's /api/media/sfx/
  // proxy route (see shop.js). 'synth' items have no file — the client
  // synthesises them from the 'synthParams' config instead, same pattern
  // as boardSfx.js's fallback tones.
  {
    id: 'buzz_airhorn',
    name: 'Air Horn',
    description: 'A classic air horn blast.',
    price: 300,
    type: 'buzz_sound',
    data: JSON.stringify({ asset: 'airhorn.mp3', preview: 'airhorn.mp3' }),
  },
  {
    id: 'buzz_laser',
    name: 'Laser',
    description: 'Futuristic laser zap.',
    price: 300,
    type: 'buzz_sound',
    data: JSON.stringify({ asset: 'laser.mp3', preview: 'laser.mp3' }),
  },
  {
    id: 'buzz_retro',
    name: 'Retro Beep',
    description: '8-bit arcade buzz.',
    price: 200,
    type: 'buzz_sound',
    data: JSON.stringify({ asset: 'retro.mp3', preview: 'retro.mp3' }),
  },
  {
    id: 'buzz_synth_deep',
    name: 'Deep Buzz',
    description: 'Low, heavy synthesised buzz.',
    price: 150,
    type: 'buzz_sound',
    data: JSON.stringify({
      synth: true,
      synthParams: { type: 'square', startHz: 110, endHz: 80, durationMs: 250, volume: 0.25 },
    }),
  },
  {
    id: 'buzz_synth_high',
    name: 'High Ping',
    description: 'Sharp high-pitched ping.',
    price: 150,
    type: 'buzz_sound',
    data: JSON.stringify({
      synth: true,
      synthParams: { type: 'sine', startHz: 880, endHz: 1200, durationMs: 120, volume: 0.2 },
    }),
  },
  // ── Skills ───────────────────────────────────────────────────────────────
  // Skills are UNLOCKED by buying them in the shop (auto-equipped on purchase).
  // Owning one does not let you fire it: during a game the host runs a
  // Power-ups spin and every player with the skill equipped rolls
  // data.grantChance for it. Only a granted skill can be used, once per win; winning it again re-arms it.
  {
    id: 'skill_domain_expansion',
    name: 'Domain Expansion',
    description: 'Unleash a slash attack, every other team loses 20% of its score (max 1000). 10% chance per spin. One use per win.',
    price: 2000,
    type: 'skill',
    // grantChance -> chance (0-1) this skill is granted to its owner on each Power-ups spin
    data: JSON.stringify({ effect: 'cleave', preview: 'domain_expansion', grantChance: 1 }),
  },
];

const insertItem = db.prepare(`
  INSERT OR IGNORE INTO shop_items (id, name, description, price, type, data)
  VALUES (?, ?, ?, ?, ?, ?)
`);
for (const item of seedItems) {
  insertItem.run(item.id, item.name, item.description, item.price, item.type, item.data);
}

// INSERT OR IGNORE never updates an existing row, so DBs created under the
// old Power Pool model would keep their old price/description/data.
// Re-sync the skill fields on every start (owners are unaffected — inventory
// only references the id).
const syncSkill = db.prepare(`UPDATE shop_items SET description = ?, price = ?, data = ? WHERE id = ?`);
for (const item of seedItems) {
  if (item.type === 'skill') syncSkill.run(item.description, item.price, item.data, item.id);
}

module.exports = db;