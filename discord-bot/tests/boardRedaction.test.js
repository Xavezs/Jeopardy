const test = require('node:test');
const assert = require('node:assert');
const { redactBoardData, createBoardEmitters } = require('../boardRedaction');
const registerScoring = require('../handlers/scoring');

function finalRound(over = {}) {
  return {
    type: 'final', phase: 'wager', category: 'Space',
    clue: { question: 'Q?', answer: 'Neptune', answerMediaUrl: 'ref:a', answerMediaType: 'image', mediaUrl: 'ref:q' },
    wagers: { t1: 100, t2: 200, t3: 300 },
    answers: { t1: 'a1', t2: 'a2', t3: 'a3' },
    revealedTeamIds: [], currentRevealTeamIds: [], revealStage: 'hidden', results: {},
    ...over,
  };
}
const dataWith = (rd) => ({ currentRound: 0, rounds: [rd], teams: [{ id: 't1' }, { id: 't2' }, { id: 't3' }] });

test('before the reveal a player only sees their own wager/answer and no correct answer', () => {
  const out = redactBoardData(dataWith(finalRound()), ['t1']).rounds[0];
  assert.deepStrictEqual(out.wagers, { t1: 100 });
  assert.deepStrictEqual(out.answers, { t1: 'a1' });
  assert.strictEqual(out.clue.answer, undefined);
  assert.strictEqual(out.clue.answerMediaUrl, undefined);
  assert.strictEqual(out.clue.question, 'Q?');
  assert.strictEqual(out.clue.mediaUrl, 'ref:q');
});

test('a viewer with no team sees no wagers or answers', () => {
  const out = redactBoardData(dataWith(finalRound()), []).rounds[0];
  assert.deepStrictEqual(out.wagers, {});
  assert.deepStrictEqual(out.answers, {});
});

test('reveal stages unlock the batch on screen step by step', () => {
  const base = { phase: 'reveal', currentRevealTeamIds: ['t2'] };
  let rd = redactBoardData(dataWith(finalRound({ ...base, revealStage: 'hidden' })), ['t1']).rounds[0];
  assert.deepStrictEqual(rd.wagers, { t1: 100 });
  assert.strictEqual(rd.clue.answer, undefined);

  rd = redactBoardData(dataWith(finalRound({ ...base, revealStage: 'wager' })), ['t1']).rounds[0];
  assert.deepStrictEqual(rd.wagers, { t1: 100, t2: 200 });
  assert.deepStrictEqual(rd.answers, { t1: 'a1' });
  assert.strictEqual(rd.clue.answer, undefined);

  rd = redactBoardData(dataWith(finalRound({ ...base, revealStage: 'answer' })), ['t1']).rounds[0];
  assert.deepStrictEqual(rd.answers, { t1: 'a1', t2: 'a2' });
  assert.strictEqual(rd.clue.answer, 'Neptune');
  assert.strictEqual(rd.clue.answerMediaUrl, 'ref:a');
});

test('judged teams stay visible and keep the correct answer visible between batches', () => {
  const rd = redactBoardData(dataWith(finalRound({
    phase: 'reveal', revealStage: 'hidden', revealedTeamIds: ['t3'], currentRevealTeamIds: [], results: { t3: true },
  })), ['t1']).rounds[0];
  assert.deepStrictEqual(rd.wagers, { t1: 100, t3: 300 });
  assert.deepStrictEqual(rd.answers, { t1: 'a1', t3: 'a3' });
  assert.strictEqual(rd.clue.answer, 'Neptune');
});

test('done phase reveals everything; a non-current final round stays redacted', () => {
  const done = redactBoardData(dataWith(finalRound({ phase: 'done', revealedTeamIds: ['t1', 't2', 't3'] })), []).rounds[0];
  assert.strictEqual(done.clue.answer, 'Neptune');
  assert.deepStrictEqual(done.wagers, { t1: 100, t2: 200, t3: 300 });

  const data = { currentRound: 0, rounds: [{ type: 'normal' }, finalRound({ phase: 'done', revealedTeamIds: ['t1'] })] };
  const later = redactBoardData(data, ['t1']).rounds[1];
  assert.strictEqual(later.clue.answer, undefined);
});

test('input is not mutated and boards without a final round are returned as-is', () => {
  const data = dataWith(finalRound());
  redactBoardData(data, ['t1']);
  assert.strictEqual(data.rounds[0].clue.answer, 'Neptune');
  assert.deepStrictEqual(data.rounds[0].wagers, { t1: 100, t2: 200, t3: 300 });
  const plain = { currentRound: 0, rounds: [{ type: 'normal' }] };
  assert.deepStrictEqual(redactBoardData(plain, ['t1']), plain);
});

test('broadcastBoard sends the host the full board and players their own redacted copy', () => {
  const sent = {};
  const mk = (id, isHost) => ({ id, isHost, emit: (ev, payload) => { sent[id] = [ev, payload]; } });
  const sockets = new Map([['h', mk('h', true)], ['p1', mk('p1', false)], ['p2', mk('p2', false)], ['x', mk('x', false)]]);
  const io = { sockets: { adapter: { rooms: new Map([['ABC', new Set(['h', 'p1', 'p2', 'x'])]]) }, sockets } };
  const room = {
    players: [{ socketId: 'p1', teamId: 't1', discordUserId: 'u1' }, { socketId: 'p2', teamId: 't2', discordUserId: 'u2' }],
    board: { data: dataWith(finalRound()), updatedAt: 1 },
  };
  const playerOfSocket = (r, id) => r.players.find((p) => p.socketId === id) || null;
  const { broadcastBoard } = createBoardEmitters({ io, playerOfSocket });

  broadcastBoard('ABC', room, { exceptSocketId: 'x' });
  assert.strictEqual(sent.x, undefined);
  assert.strictEqual(sent.h[1], room.board);
  assert.strictEqual(sent.h[1].data.rounds[0].clue.answer, 'Neptune');
  assert.deepStrictEqual(sent.p1[1].data.rounds[0].wagers, { t1: 100 });
  assert.deepStrictEqual(sent.p2[1].data.rounds[0].wagers, { t2: 200 });
  assert.strictEqual(sent.p1[1].data.rounds[0].clue.answer, undefined);
  assert.strictEqual(room.board.data.rounds[0].clue.answer, 'Neptune'); // server copy untouched
});

function scoringHarness(rd, players) {
  const handlers = {};
  const emitted = [];
  const relayed = [];
  const hostSocket = { id: 'host', isHost: true, gameRoomCode: 'ABC' };
  const sockets = new Map([['host', hostSocket]]);
  const room = { players, board: { data: { currentRound: 0, rounds: [rd], teams: [] } } };
  const socket = { id: 's', userId: 'u1', gameRoomCode: 'ABC', on: (ev, fn) => { handlers[ev] = fn; }, emit: (...a) => emitted.push(a) };
  registerScoring(socket, {
    MAX_ROOM_CODE_LENGTH: 12, OPEN_CONTROL: '*', emitControlState() {},
    hostLocks: new Map([['ABC', { userId: 'host-user', socketId: 'host' }]]),
    gameRooms: new Map([['ABC', room]]),
    io: {
      sockets: { sockets },
      to: (target) => ({ emit: (ev, payload) => relayed.push([target, ev, payload]) }),
    },
    currentRound: (r) => r.board.data.rounds[0],
    teamOfPlayer: (r, uid) => r.players.find((p) => p.discordUserId === uid)?.teamId || null,
  });
  return { handlers, emitted, relayed, hostSocket };
}
const PLAYERS = [{ discordUserId: 'u1', teamId: 't1' }];

test('server sends final wagers only to the host, only during wager phase, and only once per team', () => {
  const ok = scoringHarness(finalRound({ phase: 'wager', wagers: {}, answers: {} }), PLAYERS);
  ok.handlers.submitFinalWager({ roomCode: 'abc', amount: 50, discordUserId: 'u1' });
  assert.deepStrictEqual(ok.relayed, [['host', 'finalWagerSubmitted', { discordUserId: 'u1', amount: 50 }]]);

  const late = scoringHarness(finalRound({ phase: 'clue', wagers: {}, answers: {} }), PLAYERS);
  late.handlers.submitFinalWager({ roomCode: 'ABC', amount: 50, discordUserId: 'u1' });
  assert.strictEqual(late.relayed.length, 0);

  const dup = scoringHarness(finalRound({ phase: 'wager', wagers: { t1: 10 }, answers: {} }), PLAYERS);
  dup.handlers.submitFinalWager({ roomCode: 'ABC', amount: 99, discordUserId: 'u1' });
  assert.strictEqual(dup.relayed.length, 0);
  assert.strictEqual(dup.emitted[0][0], 'errorMsg');
});

test('server sends final answers only to the host during clue/answer phases; first submission wins', () => {
  for (const phase of ['clue', 'answer']) {
    const h = scoringHarness(finalRound({ phase, wagers: {}, answers: {} }), PLAYERS);
    h.handlers.submitFinalAnswer({ roomCode: 'ABC', answer: 'Mars', discordUserId: 'u1' });
    assert.deepStrictEqual(h.relayed, [['host', 'finalAnswerSubmitted', { discordUserId: 'u1', answer: 'Mars' }]], phase);
  }
  for (const phase of ['wager', 'reveal', 'done']) {
    const h = scoringHarness(finalRound({ phase, wagers: {}, answers: {} }), PLAYERS);
    h.handlers.submitFinalAnswer({ roomCode: 'ABC', answer: 'Mars', discordUserId: 'u1' });
    assert.strictEqual(h.relayed.length, 0, phase);
  }
  const dup = scoringHarness(finalRound({ phase: 'clue', wagers: {}, answers: { t1: 'first' } }), PLAYERS);
  dup.handlers.submitFinalAnswer({ roomCode: 'ABC', answer: 'second', discordUserId: 'u1' });
  assert.strictEqual(dup.relayed.length, 0);
});

const normalRound = () => ({
  type: 'normal',
  categories: [{ id: 'c1', clues: { 100: { question: 'Q1', answer: 'A1', answerMediaUrl: 'm1' }, 200: { question: 'Q2', answer: 'A2' } } }],
});

test('normal rounds: answers are stripped for non-hosts unless that clue is open and revealed', () => {
  const data = { currentRound: 0, rounds: [normalRound()], teams: [] };
  const hidden = redactBoardData(data, [], null).rounds[0].categories[0].clues;
  assert.strictEqual(hidden[100].answer, undefined);
  assert.strictEqual(hidden[100].answerMediaUrl, undefined);
  assert.strictEqual(hidden[100].question, 'Q1');
  const open = redactBoardData(data, [], { catId: 'c1', value: 100, revealed: false }).rounds[0].categories[0].clues;
  assert.strictEqual(open[100].answer, undefined);
  const revealed = redactBoardData(data, [], { catId: 'c1', value: 100, revealed: true }).rounds[0].categories[0].clues;
  assert.strictEqual(revealed[100].answer, 'A1');
  assert.strictEqual(revealed[200].answer, undefined); // only the open clue
  assert.strictEqual(data.rounds[0].categories[0].clues[100].answer, 'A1'); // input untouched
});

test('final handlers ignore a spoofed discordUserId and use the verified one', () => {
  const h = scoringHarness(finalRound({ phase: 'wager', wagers: {}, answers: {} }), [{ discordUserId: 'u1', teamId: 't1' }, { discordUserId: 'u2', teamId: 't2' }]);
  h.handlers.submitFinalWager({ roomCode: 'ABC', amount: 50, discordUserId: 'u2' }); // socket is u1
  assert.deepStrictEqual(h.relayed, [['host', 'finalWagerSubmitted', { discordUserId: 'u1', amount: 50 }]]);
});

test('final submissions are not sent when the host lock is missing or stale', () => {
  const h = scoringHarness(finalRound({ phase: 'wager', wagers: {}, answers: {} }), PLAYERS);
  h.hostSocket.gameRoomCode = 'OTHER';
  h.handlers.submitFinalWager({ roomCode: 'ABC', amount: 50, discordUserId: 'u1' });
  assert.strictEqual(h.relayed.length, 0);
});

test('a socket that never joined the room cannot submit for it', () => {
  const h = scoringHarness(finalRound({ phase: 'wager', wagers: {}, answers: {} }), PLAYERS);
  const room = null; void room;
  h.handlers.submitFinalWager({ roomCode: 'ZZZ', amount: 50, discordUserId: 'u1' });
  assert.strictEqual(h.relayed.length, 0);
});
