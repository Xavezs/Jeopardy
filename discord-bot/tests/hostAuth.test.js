const test = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');
const { DatabaseSync } = require('node:sqlite');
const { createHostAuth, signTicket } = require('../hostAuth');
const registerRoom = require('../handlers/room');

const SECRET = 'test-secret';
const COOKIE = 'jeopardy_session';
const quiet = { error() {}, warn() {}, log() {} };

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE boards (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, room_code TEXT);
    CREATE TABLE board_members (board_id TEXT, user_id TEXT, role TEXT);
    INSERT INTO boards VALUES ('b1', 'owner1', 'ROOM1');
    INSERT INTO board_members VALUES ('b1', 'editor1', 'editor');
    INSERT INTO board_members VALUES ('b1', 'viewer1', 'viewer');
  `);
  return db;
}
const auth = (extra = {}) => createHostAuth({ db: makeDb(), jwt, secret: SECRET, cookieName: COOKIE, log: quiet, ...extra });
const sock = (cookie) => ({ handshake: { headers: cookie ? { cookie } : {} } });
const ticketFor = (id) => signTicket(jwt, SECRET, id);
const session = (id) => `${COOKIE}=${jwt.sign({ id }, SECRET)}`;

test('board owner with a valid ticket may host', () => {
  assert.equal(auth().canHost(sock(), 'ROOM1', ticketFor('owner1')).ok, true);
});

test('room code match is case-insensitive', () => {
  assert.equal(auth().canHost(sock(), 'room1', ticketFor('owner1')).ok, true);
});

test('by default only the owner may host: editors and viewers are refused', () => {
  assert.equal(auth().canHost(sock(), 'ROOM1', ticketFor('editor1')).ok, false);
  assert.equal(auth().canHost(sock(), 'ROOM1', ticketFor('viewer1')).ok, false);
});

test('editors may host only when allowEditorHost is on', () => {
  assert.equal(auth({ allowEditorHost: true }).canHost(sock(), 'ROOM1', ticketFor('editor1')).ok, true);
  assert.equal(auth({ allowEditorHost: true }).canHost(sock(), 'ROOM1', ticketFor('viewer1')).ok, false);
});

test('a logged-in stranger cannot host someone else\'s room', () => {
  const v = auth().canHost(sock(), 'ROOM1', ticketFor('stranger'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /not an owner or editor/);
});

test('no ticket and no cookie: refused', () => {
  const v = auth().canHost(sock(), 'ROOM1', undefined);
  assert.equal(v.ok, false);
  assert.match(v.reason, /not logged in/);
});

test('a room code that is not a board code is refused', () => {
  const v = auth().canHost(sock(), 'MADEUP', ticketFor('owner1'));
  assert.equal(v.ok, false);
  assert.match(v.reason, /does not belong/);
});

test('the login cookie works as a fallback when there is no ticket', () => {
  assert.equal(auth().canHost(sock(session('owner1')), 'ROOM1').ok, true);
  assert.equal(auth().canHost(sock(session('stranger')), 'ROOM1').ok, false);
});

test('forged, expired and wrong-secret tokens are refused', () => {
  const a = auth();
  assert.equal(a.canHost(sock(), 'ROOM1', 'garbage').ok, false);
  assert.equal(a.canHost(sock(), 'ROOM1', signTicket(jwt, 'other-secret', 'owner1')).ok, false);
  const expired = jwt.sign({ id: 'owner1', purpose: 'socket' }, 'x', { expiresIn: -10 });
  assert.equal(a.canHost(sock(), 'ROOM1', expired).ok, false);
});

test('a login cookie cannot be passed off as a ticket, nor a ticket as a cookie', () => {
  const a = auth();
  const cookieToken = jwt.sign({ id: 'owner1' }, SECRET);
  assert.equal(a.canHost(sock(), 'ROOM1', cookieToken).ok, false);            // session JWT as ticket
  assert.equal(a.canHost(sock(`${COOKIE}=${ticketFor('owner1')}`), 'ROOM1').ok, false); // ticket as cookie
});

test('ALLOW_UNVERIFIED_HOST escape hatch lets anyone host', () => {
  assert.equal(auth({ allowUnverified: true }).canHost(sock(), 'ANY', undefined).ok, true);
});

function fakeSocket(handshake) {
  const handlers = {}; const emitted = [];
  return { id: 's1', isHost: false, handshake: handshake || { headers: {} }, emitted,
    on: (ev, fn) => { handlers[ev] = fn; }, emit: (ev, ...a) => emitted.push([ev, ...a]),
    join() {}, leave() {}, trigger: (ev, p, ack) => handlers[ev](p, ack) };
}
function joinCtx(hostAuth) {
  return { MAX_ROOM_CODE_LENGTH: 12, gameRooms: new Map(), invalidatedRoomCodes: new Set(), sendRoomState() {}, hostAuth, hostLocks: new Map(), roomCodeExists: () => true, io: { sockets: { sockets: new Map() } } };
}

test('joinRoom: a forged host claim is refused but still joins as a viewer', () => {
  const s = fakeSocket();
  registerRoom(s, joinCtx(auth()));
  s.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host' });
  assert.equal(s.isHost, false);
  assert.equal(s.gameRoomCode, 'ROOM1');
  assert.ok(s.emitted.some(([ev]) => ev === 'errorMsg'));
});

test('joinRoom: a verified owner becomes host', () => {
  const s = fakeSocket();
  registerRoom(s, joinCtx(auth()));
  s.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host', ticket: ticketFor('owner1') });
  assert.equal(s.isHost, true);
  assert.ok(!s.emitted.some(([ev]) => ev === 'errorMsg'));
});

test('joinRoom: a plain room-code join never changes host status', () => {
  const s = fakeSocket();
  registerRoom(s, joinCtx(auth()));
  s.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host', ticket: ticketFor('owner1') });
  s.trigger('joinRoom', 'ROOM1');
  assert.equal(s.isHost, true);
});

test('joinRoom: host status does not carry over to a different room', () => {
  const s = fakeSocket();
  registerRoom(s, joinCtx(auth()));
  s.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host', ticket: ticketFor('owner1') });
  assert.equal(s.isHost, true);
  s.trigger('joinRoom', 'OTHER');
  assert.equal(s.isHost, false);
});

test('joinRoom: a second user cannot take over a live host; the same user can', () => {
  const ctx = joinCtx(auth({ allowEditorHost: true }));
  const sockets = new Map();
  ctx.io = { sockets: { sockets } };
  const a = fakeSocket(); a.id = 'a'; sockets.set('a', a);
  const b = fakeSocket(); b.id = 'b'; sockets.set('b', b);
  const c = fakeSocket(); c.id = 'c'; sockets.set('c', c);
  for (const s of [a, b, c]) registerRoom(s, ctx);
  a.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host', ticket: ticketFor('owner1') });
  assert.equal(a.isHost, true);
  a.gameRoomCode = 'ROOM1';
  b.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host', ticket: ticketFor('editor1') });
  assert.equal(b.isHost, false);
  assert.ok(b.emitted.some(([ev, m]) => ev === 'errorMsg' && /already has a host/.test(m)));
  c.trigger('joinRoom', { roomCode: 'ROOM1', role: 'host', ticket: ticketFor('owner1') });
  assert.equal(c.isHost, true);
  assert.equal(a.isHost, false);
});
