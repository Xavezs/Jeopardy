// Rules: one use per WIN
const test = require('node:test');
const assert = require('node:assert');
const registerSkills = require('../handlers/skills');
const registerPowerups = require('../handlers/powerups');

const SKILL = 'skill_domain_expansion';

function fakeSocket(id, { isHost = false, room = null } = {}) {
  const handlers = {}; const emitted = [];
  return { id, isHost, gameRoomCode: room, emitted,
    on: (ev, fn) => { handlers[ev] = fn; },
    emit: (ev, ...a) => emitted.push([ev, ...a]),
    trigger: (ev, payload) => { let out; handlers[ev](payload, (r) => { out = r; }); return out; } };
}

function setup({ equipped = ['u1', 'u2', 'u3'] } = {}) {
  const gameRooms = new Map();
  gameRooms.set('ABC', {
    players: [
      { discordUserId: 'u1', socketId: 'p1', teamId: 't1', connected: true },
      { discordUserId: 'u2', socketId: 'p2', teamId: 't2', connected: true },
      { discordUserId: 'u3', socketId: 'p3', teamId: 't3', connected: true },
    ],
    board: { data: { currentRound: 0, rounds: [{ type: 'normal' }], teams: [
      { id: 't1', name: 'A', score: 1000 }, { id: 't2', name: 'B', score: 1000 }, { id: 't3', name: 'C', score: 1000 },
    ] } },
  });
  const ctx = {
    CLEAVE_MAX_LOSS: 1000, CLEAVE_PERCENT: 0.2, MAX_ROOM_CODE_LENGTH: 12,
    SKILL_ANIMATION_MS: 30000, SKILL_DOMAIN_EXPANSION: SKILL, POWERUP_KINDS: [],
    gameRooms,
    hasEquippedSkill: (uid) => equipped.includes(uid),
    getEquippedSkills: (uid) => (equipped.includes(uid) ? [{ id: SKILL, name: 'Domain Expansion', grantChance: 1 }] : []),
    io: { to: () => ({ emit() {}, except: () => ({ emit() {} }) }) },
    broadcastGrants() {}, broadcastPowerupState() {},
  };
  const host = fakeSocket('h', { isHost: true, room: 'ABC' });
  registerPowerups(host, ctx);
  const sockets = {};
  for (const [uid, sid] of [['u1', 'p1'], ['u2', 'p2'], ['u3', 'p3']]) {
    sockets[uid] = fakeSocket(sid); registerSkills(sockets[uid], ctx);
  }
  const spinAndApply = () => { const r = host.trigger('hostPowerDraw', { roomCode: 'ABC' }); host.trigger('hostPowerApply', { roomCode: 'ABC' }); return r; };
  const use = (uid) => { sockets[uid].trigger('useSkill', { roomCode: 'ABC', skillId: SKILL, discordUserId: uid }); return sockets[uid].emitted.splice(0); };
  const spinOnly = () => host.trigger('hostPowerDraw', { roomCode: 'ABC' });
  return { gameRooms, spinAndApply, spinOnly, use, room: () => gameRooms.get('ABC') };
}

test("another player's use does not block mine (after the animation ends)", () => {
  const s = setup();
  s.spinAndApply();
  assert.ok(!s.use('u1').some(([ev]) => ev === 'errorMsg'));
  s.room().skillBusyUntil = 0; // 30s cutscene finished
  assert.ok(!s.use('u2').some(([ev]) => ev === 'errorMsg'));
  assert.deepEqual(s.room().skillsUsed, { u1: [SKILL], u2: [SKILL] });
});

test('while the cutscene plays, a second use is refused (not consumed)', () => {
  const s = setup();
  s.spinAndApply();
  s.use('u1');
  const second = s.use('u2');
  assert.ok(second.some(([ev]) => ev === 'errorMsg'));
  assert.equal(s.room().skillsUsed.u2, undefined);
});

test('the same player cannot use it twice without winning it again', () => {
  const s = setup();
  s.spinAndApply();
  s.use('u1'); s.room().skillBusyUntil = 0;
  assert.ok(s.use('u1').some(([ev, msg]) => ev === 'errorMsg' && /already used/.test(msg)));
});

test('a player holding an unused skill does not roll again', () => {
  const s = setup({ equipped: ['u1'] });
  assert.equal(s.spinAndApply().winners.length, 1);   // u1 wins
  assert.equal(s.spinAndApply().winners.length, 0);
  assert.deepEqual(s.room().skillsGranted, { u1: [SKILL] });
});

test('after using it, a later spin can give it to the same player again', () => {
  const s = setup({ equipped: ['u1'] });
  s.spinAndApply();
  s.use('u1'); s.room().skillBusyUntil = 0;
  assert.deepEqual(s.room().skillsUsed, { u1: [SKILL] });
  assert.ok(s.use('u1').some(([ev]) => ev === 'errorMsg'));        // spent: refused
  assert.equal(s.spinAndApply().winners.length, 1);               // rolls again and wins
  assert.deepEqual(s.room().skillsUsed, { u1: [] });              // re-armed
  s.room().skillBusyUntil = 0;
  assert.ok(!s.use('u1').some(([ev]) => ev === 'errorMsg'));
  assert.deepEqual(s.room().skillsUsed, { u1: [SKILL] });
});

test('a spin alone does not re-arm anyone; only Apply does', () => {
  const s = setup({ equipped: ['u1'] });
  s.spinAndApply(); s.use('u1'); s.room().skillBusyUntil = 0;
  assert.equal(s.spinOnly().winners.length, 1);                   // preview shows a win...
  assert.deepEqual(s.room().skillsUsed, { u1: [SKILL] });         // ...but nothing changed yet
  assert.ok(s.use('u1').some(([ev]) => ev === 'errorMsg'));       // still spent
});

test('a later spin grants it to players who did not have it yet', () => {
  const s = setup();
  s.room().skillsGranted = { u1: [SKILL] };            // only u1 granted so far
  const r = s.spinAndApply();
  assert.deepEqual(r.winners.map((w) => w.discordUserId).sort(), ['u2', 'u3']);
});
