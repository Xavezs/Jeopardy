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
    id: 'vineboom',
    name: 'Vineboom',
    description: 'Vineboom Sound Effect',
    price: 300,
    type: 'buzz_sound',
    data: JSON.stringify({ asset: 'vine-boom.mp3', preview: 'vine-boom.mp3' }),
  },
  {
    id: 'FAHHH',
    name: '🗣️FAHHH!',
    description: 'FAHHH Sound Effect',
    price: 200,
    type: 'buzz_sound',
    data: JSON.stringify({ asset: 'fahhh.mp3', preview: 'fahhh.mp3' }),
  },
  // Skills
  {
    id: 'skill_domain_expansion',
    name: 'Domain Expansion',
    description: 'Unleash a slash attack, every other team loses 20% of its score (max 1000). 10% chance per spin.',
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

const syncBuzzSound = db.prepare(`UPDATE shop_items SET name = ?, description = ?, price = ?, type = ?, data = ? WHERE id = ?`);
for (const item of seedItems) {
  if (item.type === 'buzz_sound') {
    syncBuzzSound.run(item.name, item.description, item.price, item.type, item.data, item.id);
  }
}

db.exec('BEGIN');
try {
  const legacyItem = db.prepare('SELECT id FROM shop_items WHERE id = ?').get('buzz_airhorn');
  if (legacyItem) {
    db.prepare(`
      INSERT INTO player_inventory (user_id, item_id, equipped, acquired_at)
      SELECT user_id, 'vineboom', equipped, acquired_at
      FROM player_inventory
      WHERE item_id = 'buzz_airhorn'
      ON CONFLICT(user_id, item_id) DO UPDATE SET
        equipped = MAX(player_inventory.equipped, excluded.equipped),
        acquired_at = MIN(player_inventory.acquired_at, excluded.acquired_at)
    `).run();
    db.prepare('DELETE FROM player_inventory WHERE item_id = ?').run('buzz_airhorn');
    db.prepare('DELETE FROM shop_items WHERE id = ?').run('buzz_airhorn');
  }

  db.prepare(`
    DELETE FROM player_inventory
    WHERE item_id IN (
      SELECT id FROM shop_items
      WHERE type = 'buzz_sound' AND id NOT IN ('vineboom', 'FAHHH')
    )
  `).run();
  db.prepare(`
    DELETE FROM shop_items
    WHERE type = 'buzz_sound' AND id NOT IN ('vineboom', 'FAHHH')
  `).run();

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  throw err;
}

module.exports = db;