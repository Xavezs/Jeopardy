const test = require('node:test');
const assert = require('node:assert');
const registerSkills = require('../handlers/skills');
const registerBoard = require('../handlers/board');
const registerScoring = require('../handlers/scoring');
const registerRoom = require('../handlers/room');

const SKILL = 'skill_domain_expansion';

function fakeSocket(id, { isHost = false, room = null } = {}) {
  const handlers = {};
  const emitted = [];
  return {
    id, isHost, gameRoomCode: room,
    on: (ev, fn) => { handlers[ev] = fn; },
    emit: (ev, ...a) => emitted.push([ev, ...a]),
    join() {},
    trigger: (ev, payload, ack) => handlers[ev](payload, ack),
    emitted,
  };
}

function makeCtx(overrides = {}) {
  const broadcasts = [];
  const gameRooms = new Map();
  const ctx = {
    CLEAVE_MAX_LOSS: 1000, CLEAVE_PERCENT: 0.2, MAX_ROOM_CODE_LENGTH: 12,
    SKILL_ANIMATION_MS: 30000, SKILL_DOMAIN_EXPANSION: SKILL,
    gameRooms, hasEquippedSkill: () => true,
    io: { to: (code) => ({ emit: (ev, payload) => broadcasts.push([code, ev, payload]) }) },
    emitControlState: () => {}, invalidatedRoomCodes: new Set(), sendRoomState: () => {},
    hostAuth: { canHost: () => ({ ok: true }) }, hostLocks: new Map(), roomCodeExists: () => true,
    ...overrides,
  };
  return { ctx, broadcasts, gameRooms };
}

function seedRoom(gameRooms) {
  gameRooms.set('ABC', {
    players: [{ discordUserId: 'u1', socketId: 'p1', teamId: 't1', discordUsername: 'Ann' }],
    board: { data: { currentRound: 0, rounds: [{ type: 'normal' }], teams: [
      { id: 't1', name: 'Caster', score: 3000 },
      { id: 't2', name: 'Rich', score: 20000 },
      { id: 't3', name: 'Broke', score: 0 },
    ] } },
    skillsGranted: { u1: [SKILL] },
  });
}

test('useSkill computes deltas on the server and records them as pending', () => {
  const { ctx, broadcasts, gameRooms } = makeCtx();
  seedRoom(gameRooms);
  const player = fakeSocket('p1');
  registerSkills(player, ctx);
  player.trigger('useSkill', { roomCode: 'abc', skillId: SKILL, discordUserId: 'u1' });

  const used = broadcasts.find(([, ev]) => ev === 'skillUsed')[2];
  assert.deepEqual(used.deltas, [{ teamId: 't2', teamName: 'Rich', delta: -1000 }]);
  assert.ok(used.eventId);
  assert.deepEqual(gameRooms.get('ABC').pendingSkillDeltas, [{ id: used.eventId, deltas: used.deltas }]);
});

test('a client-supplied damage number is ignored', () => {
  const { ctx, broadcasts, gameRooms } = makeCtx();
  seedRoom(gameRooms);
  const player = fakeSocket('p1');
  registerSkills(player, ctx);
  player.trigger('useSkill', { roomCode: 'ABC', skillId: SKILL, discordUserId: 'u1', deltas: [{ teamId: 't2', delta: -1 }], damage: 1 });
  assert.equal(broadcasts.find(([, ev]) => ev === 'skillUsed')[2].deltas[0].delta, -1000);
});

test('only the host can acknowledge deltas', () => {
  const { ctx, broadcasts, gameRooms } = makeCtx();
  seedRoom(gameRooms);
  const player = fakeSocket('p1');
  registerSkills(player, ctx);
  player.trigger('useSkill', { roomCode: 'ABC', skillId: SKILL, discordUserId: 'u1' });
  const id = broadcasts.find(([, ev]) => ev === 'skillUsed')[2].eventId;

  player.trigger('skillDeltasApplied', { roomCode: 'ABC', eventId: id });
  assert.equal(gameRooms.get('ABC').pendingSkillDeltas.length, 1);

  const host = fakeSocket('h1', { isHost: true, room: 'ABC' });
  registerSkills(host, ctx);
  host.trigger('skillDeltasApplied', { roomCode: 'ABC', eventId: id });
  assert.equal(gameRooms.get('ABC').pendingSkillDeltas.length, 0);
});

test('a joining host is sent unacknowledged deltas; a joining player is not', () => {
  const { ctx, gameRooms } = makeCtx();
  seedRoom(gameRooms);
  gameRooms.get('ABC').pendingSkillDeltas = [{ id: 'e1', deltas: [{ teamId: 't2', delta: -5 }] }];

  const host = fakeSocket('h1');
  registerRoom(host, ctx);
  host.trigger('joinRoom', { roomCode: 'ABC', role: 'host' });
  assert.deepEqual(host.emitted.find(([ev]) => ev === 'skillDeltasPending')[1], [{ id: 'e1', deltas: [{ teamId: 't2', delta: -5 }] }]);

  const guest = fakeSocket('g1');
  registerRoom(guest, ctx);
  guest.trigger('joinRoom', 'ABC');
  assert.ok(!guest.emitted.some(([ev]) => ev === 'skillDeltasPending'));
});

test('hostSetControl is host-only', () => {
  const { ctx, gameRooms } = makeCtx();
  seedRoom(gameRooms);
  const intruder = fakeSocket('x1', { room: 'ABC' });
  registerBoard(intruder, ctx);
  intruder.trigger('hostSetControl', { roomCode: 'ABC', discordUserId: 'u1' });
  assert.equal(gameRooms.get('ABC').controlDiscordUserId, undefined);
  assert.ok(intruder.emitted.some(([ev]) => ev === 'errorMsg'));

  const host = fakeSocket('h1', { isHost: true, room: 'ABC' });
  registerBoard(host, ctx);
  host.trigger('hostSetControl', { roomCode: 'ABC', discordUserId: 'u1' });
  assert.equal(gameRooms.get('ABC').controlDiscordUserId, 'u1');
});

test('judgeAnswer is host-only', () => {
  const { ctx, gameRooms } = makeCtx();
  seedRoom(gameRooms);
  const intruder = fakeSocket('x1', { room: 'ABC' });
  registerScoring(intruder, ctx);
  intruder.trigger('judgeAnswer', { roomCode: 'ABC', discordUserId: 'u1', correct: true });
  assert.equal(gameRooms.get('ABC').playerStats, undefined);
  assert.ok(intruder.emitted.some(([ev]) => ev === 'errorMsg'));
});
