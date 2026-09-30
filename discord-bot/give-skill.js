const db = require('./db');
const [userId, itemId = 'skill_domain_expansion'] = process.argv.slice(2);
if (!userId) { console.log('Usage: node give-skill.js <discordUserId> [itemId]'); process.exit(1); }
db.prepare(
  `INSERT INTO player_inventory (user_id, item_id, equipped, acquired_at)
   VALUES (?, ?, 1, ?)
   ON CONFLICT(user_id, item_id) DO UPDATE SET equipped = 1`
).run(userId, itemId, Date.now());
console.log(`Gave ${itemId} to ${userId} (equipped)`);