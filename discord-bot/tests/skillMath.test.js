const test = require('node:test');
const assert = require('node:assert');
const { computeCleaveDeltas } = require('../skillMath');

const opts = { percent: 0.2, maxLoss: 1000 };
const teams = [
  { id: 'a', name: 'Caster', score: 5000 },
  { id: 'b', name: 'Mid', score: 1000 },
  { id: 'c', name: 'Rich', score: 20000 },
  { id: 'd', name: 'Zero', score: 0 },
  { id: 'e', name: 'Negative', score: -400 },
];

test('caster team is never hit', () => {
  assert.ok(!computeCleaveDeltas(teams, 'a', opts).some((d) => d.teamId === 'a'));
});

test('loss is percent of score, rounded', () => {
  const d = computeCleaveDeltas(teams, 'a', opts).find((x) => x.teamId === 'b');
  assert.equal(d.delta, -200);
  const r = computeCleaveDeltas([{ id: 'x', name: 'X', score: 333 }], 'a', opts)[0];
  assert.equal(r.delta, -67); // 66.6 rounds to 67
});

test('loss is capped at maxLoss', () => {
  const d = computeCleaveDeltas(teams, 'a', opts).find((x) => x.teamId === 'c');
  assert.equal(d.delta, -1000);
});

test('zero and negative scores are skipped', () => {
  const ids = computeCleaveDeltas(teams, 'a', opts).map((d) => d.teamId);
  assert.deepEqual(ids, ['b', 'c']);
});

test('loss that rounds to 0 is dropped', () => {
  assert.deepEqual(computeCleaveDeltas([{ id: 'x', name: 'X', score: 2 }], 'a', { percent: 0.1, maxLoss: 500 }), []);
});

test('a team can never be taken below 0', () => {
  const d = computeCleaveDeltas([{ id: 'x', name: 'X', score: 50 }], 'a', { percent: 1.5, maxLoss: 1000 });
  assert.equal(d[0].delta, -50);
});

test('string scores and missing team lists are handled', () => {
  assert.equal(computeCleaveDeltas([{ id: 'x', name: 'X', score: '500' }], 'a', opts)[0].delta, -100);
  assert.deepEqual(computeCleaveDeltas(undefined, 'a', opts), []);
});
