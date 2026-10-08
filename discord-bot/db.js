const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

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
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_boards_room_code
  ON boards(room_code) WHERE room_code IS NOT NULL;
`);

// Shop catalog seed
const seedItems = [
  // Buzz sounds
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
  // Skills
  {
    id: 'skill_domain_expansion',
    name: 'Domain Expansion',
    description: 'Unleash a slash attack, every other team loses 20% of its score (max 1000). 10% chance per spin. One use per win.',
    price: 2000,
    type: 'skill',
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

const syncSkill = db.prepare(`UPDATE shop_items SET description = ?, price = ?, data = ? WHERE id = ?`);
for (const item of seedItems) {
  if (item.type === 'skill') syncSkill.run(item.description, item.price, item.data, item.id);
}

module.exports = db;