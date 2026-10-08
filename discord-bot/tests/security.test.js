const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { isBlockedIp, isAllowedMediaType, safeFetch } = require('../safeFetch');
const registerBuzzer = require('../handlers/buzzer');
const registerBoard = require('../handlers/board');
const registerSync = require('../handlers/sync');
const { identityOf, isHostOf } = require('../handlers/guards');

test('private, loopback, link-local and mapped addresses are blocked; public ones are not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.5.5', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', 'not-an-ip']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isBlockedIp(ip), false, ip);
});

test('only media content types are allowed through the proxy', () => {
  for (const t of ['image/png', 'video/mp4', 'audio/mpeg; charset=x', 'application/octet-stream']) assert.equal(isAllowedMediaType(t), true, t);
  for (const t of ['text/html', 'application/json', '', null]) assert.equal(isAllowedMediaType(t), false, String(t));
});

test('safeFetch refuses loopback targets, including via redirect', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    await assert.rejects(() => safeFetch(`http://127.0.0.1:${port}/x`), (e) => e.status === 400);
    await assert.rejects(() => safeFetch(`http://localhost:${port}/x`), (e) => e.status === 400);
    await assert.rejects(() => safeFetch('http://user:pw@example.com/'), (e) => e.status === 400);
    await assert.rejects(() => safeFetch('file:///etc/passwd'), (e) => e.status === 400);
  } finally { srv.close(); }
});

function sock(over = {}) {
  const handlers = {}; const emitted = [];
  return { id: 's1', gameRoomCode: 'ABC', emitted, on: (ev, fn) => { handlers[ev] = fn; }, emit: (...a) => emitted.push(a), to: () => ({ emit() {} }), trigger: (ev, p) => handlers[ev](p), ...over };
}
function ctxFor(room) {
  const sent = [];
  return { sent, gameRooms: new Map([['ABC', room]]), io: { to: () => ({ emit: (ev, p) => sent.push([ev, p]) }) },
    teamOfPlayer: () => null, MAX_ROOM_CODE_LENGTH: 8, broadcastBoard() {}, OPEN_CONTROL: '*', mediaRouter: {}, findClueMediaUrls: () => [], publicFrozen: () => ({}), mergeLivePlayerMemberships() {}, emitControlState() {} };
}

test('buzzer controls are host-only', () => {
  const room = { buzzer: { live: false, queue: [], activeIndex: -1 } };
  const c = ctxFor(room);
  const player = sock({ userId: 'u1' });
  registerBuzzer(player, c);
  player.trigger('armBuzzer', 'ABC');
  assert.equal(room.buzzer.live, false);
  const host = sock({ userId: 'owner', isHost: true });
  registerBuzzer(host, c);
  host.trigger('armBuzzer', 'ABC');
  assert.equal(room.buzzer.live, true);
});

test('buzz is attributed to the verified user; spoofed ids and fake players are ignored', () => {
  const room = { buzzer: { live: true, queue: [], activeIndex: -1 }, players: [{ discordUserId: 'u1', discordUsername: 'Real', teamId: 't1' }, { discordUserId: 'u2', discordUsername: 'Victim', teamId: 't2' }] };
  const c = ctxFor(room);
  const s = sock({ userId: 'u1' });
  registerBuzzer(s, c);
  s.trigger('buzz', { roomCode: 'ABC', player: { id: 'u2', username: 'HACKED' } });
  assert.deepEqual(room.buzzer.queue.map((e) => e.id), ['u1']);
  assert.equal(room.buzzer.queue[0].username, 'Real');
  const stranger = sock({ userId: 'nobody' });
  registerBuzzer(stranger, c);
  stranger.trigger('buzz', { roomCode: 'ABC', player: { id: 'u2' } });
  assert.equal(room.buzzer.queue.length, 1);
  const unverified = sock({ userId: null });
  registerBuzzer(unverified, c);
  unverified.trigger('buzz', { roomCode: 'ABC', player: { id: 'u2' } });
  assert.equal(room.buzzer.queue.length, 1);
});

test('host-only relays (activeClue, bgm) are ignored from non-hosts', () => {
  const room = {};
  const c = ctxFor(room);
  const p = sock({ userId: 'u1' });
  registerBoard(p, c); registerSync(p, c);
  p.trigger('activeClueUpdate', { roomCode: 'ABC', activeClue: { catId: 'x', value: 1 } });
  p.trigger('bgmUpdate', { roomCode: 'ABC', bgm: { url: 'x' } });
  assert.equal(room.activeClue, undefined);
  assert.equal(room.bgm, undefined);
  const h = sock({ userId: 'o', isHost: true });
  registerBoard(h, c);
  h.trigger('activeClueUpdate', { roomCode: 'ABC', activeClue: { catId: 'x', value: 1 } });
  assert.deepEqual(room.activeClue, { catId: 'x', value: 1 });
});

test('identityOf only trusts the claimed id with the explicit escape hatch', () => {
  assert.equal(identityOf({ userId: 'real' }, 'fake'), 'real');
  assert.equal(identityOf({ userId: null }, 'fake'), null);
  process.env.ALLOW_UNVERIFIED_SOCKETS = '1';
  assert.equal(identityOf({ userId: null }, 'fake'), 'fake');
  delete process.env.ALLOW_UNVERIFIED_SOCKETS;
  assert.equal(isHostOf({ isHost: true, gameRoomCode: 'A' }, 'B'), false);
});
