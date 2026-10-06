// Saves live room state to Supabase (table: game_rooms, see
// migrations/001_game_rooms.sql) and restores it on startup, so a restart
// or redeploy doesn't wipe scores and teams mid-game.
//
// Deliberately non-invasive: handlers keep mutating the in-memory Map as
// before. A timer notices which rooms changed and saves only those, so no
// handler needs to know persistence exists. If Supabase is unreachable or
// the table is missing, the game keeps running purely in memory.

const SAVE_INTERVAL_MS = 5000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000;      // restore / keep rooms active in the last 12h
const PURGE_AFTER_MS = 3 * 24 * 60 * 60 * 1000; // delete rows untouched for 3 days
const TABLE = 'game_rooms';

// Only durable game state. Sockets, timers, live audio/animation state
// (bgm, randomizer, buzzer, skillBusyUntil) are meaningless after a restart.
function serializeRoom(room) {
  if (!room?.board) return null; // nothing worth saving yet
  return {
    board: room.board,
    activeClue: room.activeClue ?? null,
    revealedCats: room.revealedCats ?? null,
    controlDiscordUserId: room.controlDiscordUserId ?? null,
    playerStats: room.playerStats ?? null,
    skillsUsed: room.skillsUsed ?? null,
    skillsGranted: room.skillsGranted ?? null,
    pendingSkillDeltas: room.pendingSkillDeltas ?? null,
    powerupsGranted: room.powerupsGranted ?? null,
    armedPowerups: room.armedPowerups ?? null,
    frozenTeams: room.frozenTeams ?? null,
    pendingDraw: room.pendingDraw ?? null,
    // No socket survives a restart; players come back as "disconnected"
    // and re-attach by discordUserId when they rejoin (joinAsPlayer).
    players: (room.players || []).map((p) => ({ ...p, socketId: null, connected: false })),
  };
}

function reviveRoom(state) {
  const room = {};
  for (const [k, v] of Object.entries(state || {})) if (v !== null && v !== undefined) room[k] = v;
  room.players = Array.isArray(room.players) ? room.players : [];
  room.pendingRemovals = new Map();
  return room;
}

function createRoomPersistence({ supabase, gameRooms, log = console }) {
  const lastSaved = new Map(); // roomCode -> JSON string last written
  let enabled = !!supabase;
  let timer = null;
  let saving = false;
  let lastWarnAt = 0;

  const warn = (msg, err) => {
    if (Date.now() - lastWarnAt < 60_000) return; // don't spam the console
    lastWarnAt = Date.now();
    log.warn(`[roomPersistence] ${msg}`, err?.message || err || '');
  };
  const isMissingTable = (err) => err && (err.code === '42P01' || err.code === 'PGRST205' || /does not exist|schema cache/i.test(err.message || ''));

  async function hydrate() {
    if (!enabled) return 0;
    try {
      const since = new Date(Date.now() - ROOM_TTL_MS).toISOString();
      const { data, error } = await supabase.from(TABLE).select('room_code,state').gte('updated_at', since);
      if (error) throw error;
      let n = 0;
      for (const row of data || []) {
        if (gameRooms.has(row.room_code)) continue;
        gameRooms.set(row.room_code, reviveRoom(row.state));
        lastSaved.set(row.room_code, JSON.stringify(serializeRoom(gameRooms.get(row.room_code))));
        n++;
      }
      supabase.from(TABLE).delete().lt('updated_at', new Date(Date.now() - PURGE_AFTER_MS).toISOString()).then(() => {}, () => {});
      if (n) log.log(`[roomPersistence] restored ${n} room(s) from Supabase`);
      return n;
    } catch (err) {
      if (isMissingTable(err)) { enabled = false; log.warn('[roomPersistence] table game_rooms not found — run migrations/001_game_rooms.sql. Persistence disabled.'); }
      else warn('could not restore rooms (continuing in-memory):', err);
      return 0;
    }
  }

  async function saveChanged() {
    if (!enabled || saving) return 0;
    const rows = [];
    for (const [code, room] of gameRooms) {
      const state = serializeRoom(room);
      if (!state) continue;
      const json = JSON.stringify(state);
      if (lastSaved.get(code) === json) continue;
      rows.push({ code, json, row: { room_code: code, state, updated_at: new Date().toISOString() } });
    }
    if (!rows.length) return 0;
    saving = true;
    try {
      const { error } = await supabase.from(TABLE).upsert(rows.map((r) => r.row), { onConflict: 'room_code' });
      if (error) throw error;
      for (const r of rows) lastSaved.set(r.code, r.json);
      return rows.length;
    } catch (err) {
      if (isMissingTable(err)) { enabled = false; log.warn('[roomPersistence] table game_rooms not found — run migrations/001_game_rooms.sql. Persistence disabled.'); }
      else warn('save failed, will retry:', err);
      return 0;
    } finally { saving = false; }
  }

  // Call when a room code is retired (rotateRoomCode) so the old row doesn't resurrect.
  function forget(code) {
    lastSaved.delete(code);
    if (enabled) supabase.from(TABLE).delete().eq('room_code', code).then(() => {}, () => {});
  }

  function start() {
    if (!enabled || timer) return;
    timer = setInterval(saveChanged, SAVE_INTERVAL_MS);
    timer.unref();
  }

  async function flush() { saving = false; return saveChanged(); }

  return { hydrate, saveChanged, forget, start, flush, ROOM_TTL_MS, get enabled() { return enabled; } };
}

module.exports = { createRoomPersistence, serializeRoom, reviveRoom, ROOM_TTL_MS };
