const express = require('express');
const db = require('./db');
const { requireAuth } = require('./auth');

const router = express.Router();
router.use(requireAuth);

// Helpers

function getWallet(userId) {
  const row = db.prepare('SELECT coins FROM player_wallets WHERE user_id = ?').get(userId);
  return row ? row.coins : 0;
}

function itemRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    price: row.price,
    type: row.type,
    data: JSON.parse(row.data || '{}'),
  };
}

// Routes

// GET /api/shop/wallet
router.get('/wallet', (req, res) => {
  res.json({ coins: getWallet(req.user.id) });
});

// GET /api/shop/catalog
router.get('/catalog', (req, res) => {
  const items = db.prepare('SELECT * FROM shop_items ORDER BY type, price').all();
  const owned = db.prepare(
    'SELECT item_id, equipped FROM player_inventory WHERE user_id = ?'
  ).all(req.user.id);
  const ownedMap = new Map(owned.map((r) => [r.item_id, r.equipped === 1]));

  res.json({
    coins: getWallet(req.user.id),
    items: items.map((row) => ({
      ...itemRow(row),
      owned: ownedMap.has(row.id),
      equipped: ownedMap.get(row.id) ?? false,
    })),
  });
});

// GET /api/shop/loadout
router.get('/loadout', (req, res) => {
  const rows = db
    .prepare(
      `SELECT i.*, inv.equipped FROM shop_items i
       JOIN player_inventory inv ON inv.item_id = i.id
       WHERE inv.user_id = ? AND inv.equipped = 1`
    )
    .all(req.user.id);

  const loadout = {};
  for (const row of rows) {
    loadout[row.type] = itemRow(row);
  }
  res.json(loadout);
});

router.post('/buy', (req, res) => {
  const { itemId } = req.body;
  if (!itemId) return res.status(400).json({ error: 'itemId required' });

  const item = db.prepare('SELECT * FROM shop_items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  // Already owned?
  const alreadyOwned = db
    .prepare('SELECT 1 FROM player_inventory WHERE user_id = ? AND item_id = ?')
    .get(req.user.id, itemId);
  if (alreadyOwned) return res.status(409).json({ error: 'Already owned' });

  const coins = getWallet(req.user.id);
  if (coins < item.price) return res.status(402).json({ error: 'Not enough coins' });

  const now = Date.now();

  db.prepare(
    `INSERT INTO player_wallets (user_id, coins, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET coins = coins - ?, updated_at = ?`
  ).run(req.user.id, -item.price, now, item.price, now);

  const autoEquip = item.type === 'skill';
  if (autoEquip) {
    db.prepare(
      `UPDATE player_inventory SET equipped = 0
       WHERE user_id = ? AND item_id IN (SELECT id FROM shop_items WHERE type = ?)`
    ).run(req.user.id, item.type);
  }
  db.prepare(
    `INSERT INTO player_inventory (user_id, item_id, equipped, acquired_at) VALUES (?, ?, ?, ?)`
  ).run(req.user.id, itemId, autoEquip ? 1 : 0, now);

  res.json({ ok: true, coins: getWallet(req.user.id), itemId, equipped: autoEquip });
});

router.post('/equip', (req, res) => {
  const { itemId, equipped } = req.body;
  if (!itemId || equipped === undefined) {
    return res.status(400).json({ error: 'itemId and equipped required' });
  }

  const owned = db
    .prepare('SELECT 1 FROM player_inventory WHERE user_id = ? AND item_id = ?')
    .get(req.user.id, itemId);
  if (!owned) return res.status(403).json({ error: 'Item not owned' });

  const item = db.prepare('SELECT type FROM shop_items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  if (equipped) {
    db.prepare(
      `UPDATE player_inventory SET equipped = 0
       WHERE user_id = ? AND item_id IN (
         SELECT id FROM shop_items WHERE type = ?
       )`
    ).run(req.user.id, item.type);
  }

  db.prepare(
    `UPDATE player_inventory SET equipped = ? WHERE user_id = ? AND item_id = ?`
  ).run(equipped ? 1 : 0, req.user.id, itemId);

  res.json({ ok: true, itemId, equipped: !!equipped });
});

module.exports = router;
