const test = require('node:test');
const assert = require('node:assert');
const { createRoomPersistence, serializeRoom, reviveRoom } = require('../roomPersistence');

const quiet = { log() {}, warn() {} };
function fakeSupabase({ rows = [], failWith = null } = {}) {
  const store = new Map(rows.map((r) => [r.room_code, r]));
  const calls = { upsert: 0, deleted: [] };
  const ok = (data = null) => Promise.resolve({ data, error: null });
  return {
    store, calls,
    from() {
      return {
        select: () => ({ gte: () => failWith ? Promise.resolve({ data: null, error: failWith }) : ok([...store.values()]) }),
        upsert: (arr) => { calls.upsert++; if (failWith) return Promise.resolve({ error: failWith }); arr.forEach((r) => store.set(r.room_code, r)); return ok(); },
        delete: () => ({ lt: () => ok(), eq: (_c, code) => { calls.deleted.push(code); store.delete(code); return ok(); } }),
      };
    },
  };
}
const liveRoom = () => ({
  board: { data: { teams: [{ id: 't1', name: 'Red', score: 400, discordUserIds: ['u1'] }] }, updatedAt: 5 },
  controlDiscordUserId: 'u1', playerStats: { u1: { correct: 2, wrong: 0 } },
  players: [{ socketId: 'abc', discordUserId: 'u1', teamId: 't1', connected: true }],
  bgm: { playing: true }, buzzer: { live: true, queue: [], activeIndex: -1 }, randomizer: { x: 1 },
  pendingRemovals: new Map([['u1', setTimeout(() => {}, 1)]]),
});

test('serialize keeps durable state, drops sockets/timers/live audio', () => {
  const s = serializeRoom(liveRoom());
  assert.equal(s.board.data.teams[0].score, 400);
  assert.equal(s.players[0].socketId, null);
  assert.equal(s.players[0].connected, false);
  for (const k of ['bgm', 'buzzer', 'randomizer', 'pendingRemovals']) assert.ok(!(k in s), k);
  assert.doesNotThrow(() => JSON.stringify(s));
  assert.equal(serializeRoom({}), null);
});

test('save is incremental: unchanged rooms are not re-written', async () => {
  const sb = fakeSupabase(); const rooms = new Map([['ABC', liveRoom()]]);
  const p = createRoomPersistence({ supabase: sb, gameRooms: rooms, log: quiet });
  assert.equal(await p.saveChanged(), 1);
  assert.equal(await p.saveChanged(), 0);
  rooms.get('ABC').board.data.teams[0].score = 600;
  assert.equal(await p.saveChanged(), 1);
  assert.equal(sb.store.get('ABC').state.board.data.teams[0].score, 600);
});

test('restart: hydrate restores scores and players as disconnected', async () => {
  const sb = fakeSupabase(); const before = new Map([['ABC', liveRoom()]]);
  await createRoomPersistence({ supabase: sb, gameRooms: before, log: quiet }).saveChanged();
  const after = new Map();
  const n = await createRoomPersistence({ supabase: sb, gameRooms: after, log: quiet }).hydrate();
  assert.equal(n, 1);
  const r = after.get('ABC');
  assert.equal(r.board.data.teams[0].score, 400);
  assert.equal(r.controlDiscordUserId, 'u1');
  assert.equal(r.players[0].connected, false);
  assert.ok(r.pendingRemovals instanceof Map);
});

test('missing table disables persistence instead of crashing', async () => {
  const sb = fakeSupabase({ failWith: { code: '42P01', message: 'relation "game_rooms" does not exist' } });
  const p = createRoomPersistence({ supabase: sb, gameRooms: new Map([['A', liveRoom()]]), log: quiet });
  assert.equal(await p.hydrate(), 0);
  assert.equal(p.enabled, false);
  assert.equal(await p.saveChanged(), 0);
});

test('transient error keeps retrying; forget() removes the row', async () => {
  const sb = fakeSupabase({ failWith: { message: 'network down' } });
  const rooms = new Map([['A', liveRoom()]]);
  const p = createRoomPersistence({ supabase: sb, gameRooms: rooms, log: quiet });
  assert.equal(await p.saveChanged(), 0);
  assert.equal(p.enabled, true);
  sb.store.set('A', {}); p.forget('A');
  assert.deepEqual(sb.calls.deleted, ['A']);
});

test('reviveRoom tolerates empty state', () => {
  const r = reviveRoom(null);
  assert.deepEqual(r.players, []);
});
