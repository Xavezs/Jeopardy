const test = require('node:test');
const assert = require('node:assert');
process.env.SESSION_SECRET = 'guest-test-secret-0123456789';
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');
const { createHostAuth, signTicket, isGuestId, guestNameFor } = require('../hostAuth');
const { requireAccount, COOKIE_NAME, SESSION_SECRET } = require('../auth');
const registerRoom = require('../handlers/room');

const quiet = { error() {}, warn() {}, log() {} };
const GUEST = 'guest_0123456789abcdef01234567';

function makeAuth(boardOwner = 'owner1') {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, room_code TEXT);
    CREATE TABLE board_members (board_id TEXT, user_id TEXT, role TEXT);
    INSERT INTO boards VALUES ('b1', '${boardOwner}', 'ROOM1');`);
  return createHostAuth({ db, jwt, secret: SESSION_SECRET, cookieName: COOKIE_NAME, log: quiet });
}
const sock = (extra = {}) => ({ handshake: { headers: {} }, ...extra });

test('guest ids are recognised by prefix only; names are stable and server-derived', () => {
  assert.equal(isGuestId(GUEST), true);
  for (const id of ['123456789012345678', 'mock_user_123', '', null, undefined, 42]) assert.equal(isGuestId(id), false, String(id));
  assert.equal(guestNameFor(GUEST), guestNameFor(GUEST));
  assert.match(guestNameFor(GUEST), /^Guest-\d{4}$/);
});

test('ticket carries the platform claim; unknown platforms are dropped; forged tickets are refused', () => {
  const a = makeAuth();
  assert.deepEqual(a.identityFor(sock(), signTicket(jwt, SESSION_SECRET, GUEST, 'web')), { id: GUEST, platform: 'web' });
  assert.deepEqual(a.identityFor(sock(), signTicket(jwt, SESSION_SECRET, '111', 'activity')), { id: '111', platform: 'activity' });
  assert.equal(a.identityFor(sock(), signTicket(jwt, SESSION_SECRET, '111', 'admin')).platform, null);
  assert.equal(a.identityFor(sock(), signTicket(jwt, SESSION_SECRET, '111')).platform, null);
  assert.equal(a.identityFor(sock(), signTicket(jwt, 'other-secret', GUEST, 'web')), null);
  assert.equal(a.userIdFor(sock(), signTicket(jwt, SESSION_SECRET, '111', 'web')), '111');
});

test('a guest can never host, even if a board somehow lists the guest id as owner', () => {
  const a = makeAuth(GUEST);
  const v = a.canHost(sock(), 'ROOM1', signTicket(jwt, SESSION_SECRET, GUEST, 'web'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /guests cannot host/);
});

function run(mw, cookieToken) {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, clearCookie() {} };
  const req = { cookies: cookieToken ? { [COOKIE_NAME]: cookieToken } : {}, get: () => undefined };
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

test('requireAccount: no session 401, guest 403, real account passes', () => {
  assert.equal(run(requireAccount).res.code, 401);
  const guest = run(requireAccount, jwt.sign({ id: GUEST, username: 'Guest-1', src: 'web' }, SESSION_SECRET));
  assert.equal(guest.res.code, 403);
  assert.equal(guest.nexted, false);
  const real = run(requireAccount, jwt.sign({ id: '123456789012345678', username: 'x', src: 'activity' }, SESSION_SECRET));
  assert.equal(real.nexted, true);
});

function fakeSocket(extra) {
  const handlers = {}; const emitted = [];
  return { id: 's1', isHost: false, handshake: { headers: {} }, emitted, on: (ev, fn) => { handlers[ev] = fn; },
    emit: (ev, ...a) => emitted.push([ev, ...a]), join() {}, leave() {}, trigger: (ev, p, ack) => handlers[ev](p, ack), ...extra };
}
function roomCtx() {
  return { MAX_ROOM_CODE_LENGTH: 8, MAX_TEAM_NAME_LENGTH: 24, DISCONNECT_GRACE_MS: 1000, gameRooms: new Map(), invalidatedRoomCodes: new Set(),
    sendRoomState() {}, broadcastBoard() {}, detachFromTeamIfAbandoned() {}, buildVoiceMemberList: () => [], roomPersistence: {}, hostLocks: new Map(),
    watchersByChannel: new Map(), roomCodeExists: () => true, hostAuth: makeAuth(), io: { to: () => ({ emit() {} }), sockets: { sockets: new Map() } } };
}

test('joinAsPlayer: guest name and avatar come from the server, platform from the session', () => {
  const ctx = roomCtx();
  const s = fakeSocket({ userId: GUEST, platform: 'web' });
  registerRoom(s, ctx);
  s.trigger('joinAsPlayer', { roomCode: 'ROOM1', teamName: 'Team A',
    discordUser: { id: '999', username: 'Discord Admin', avatarUrl: 'https://cdn.discordapp.com/avatars/1/a.png' } });
  const p = ctx.gameRooms.get('ROOM1').players[0];
  assert.equal(p.discordUserId, GUEST);
  assert.equal(p.discordUsername, guestNameFor(GUEST));
  assert.equal(p.discordAvatarUrl, null);
  assert.equal(p.platform, 'web');
});

test('joinAsPlayer: a Discord Activity player keeps their name/avatar and is tagged activity', () => {
  const ctx = roomCtx();
  const s = fakeSocket({ userId: '111', platform: 'activity' });
  registerRoom(s, ctx);
  s.trigger('joinAsPlayer', { roomCode: 'ROOM1', teamName: 'Team A',
    discordUser: { username: 'Real', avatarUrl: 'https://cdn.discordapp.com/avatars/111/a.png' } });
  const p = ctx.gameRooms.get('ROOM1').players[0];
  assert.equal(p.discordUsername, 'Real');
  assert.equal(p.discordAvatarUrl, 'https://cdn.discordapp.com/avatars/111/a.png');
  assert.equal(p.platform, 'activity');
});

test('watchVoiceChannel is ignored for guests', () => {
  const ctx = roomCtx();
  const s = fakeSocket({ userId: GUEST, platform: 'web' });
  registerRoom(s, ctx);
  s.trigger('watchVoiceChannel', '12345');
  assert.equal(ctx.watchersByChannel.size, 0);
  const real = fakeSocket({ id: 's2', userId: '111' });
  registerRoom(real, ctx);
  real.trigger('watchVoiceChannel', '12345');
  assert.equal(ctx.watchersByChannel.size, 1);
});
