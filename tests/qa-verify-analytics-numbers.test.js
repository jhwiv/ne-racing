'use strict';

// Unit coverage for the pure recomputation logic in
// scripts/qa/verify_analytics_numbers.js -- the independent cross-check
// tool for the Analytics tab's numbers. Doesn't hit the network (that part
// is exercised by actually running the script against the real worker,
// see docs/ANALYTICS_QA.md); this just locks down the arithmetic itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recomputeFromHistory, almostEqual } = require('../scripts/qa/verify_analytics_numbers');

test('recomputeFromHistory: basic wins/losses/ROI arithmetic', () => {
  const picks = [
    { settled: true, won: true, amount: 2, payout: 8.4, betType: 'Win' },
    { settled: true, won: false, amount: 2, payout: 0, betType: 'Win' },
    { settled: true, won: false, amount: 2, payout: 0, betType: 'Win' },
    { settled: false, won: null, amount: 2, payout: null, betType: 'Win' }, // pending, must be excluded
  ];
  const r = recomputeFromHistory(picks);
  assert.equal(r.picksLogged, 4);
  assert.equal(r.settled, 3, 'pending pick must not count as settled');
  assert.equal(r.wins, 1);
  assert.equal(r.losses, 2);
  assert.equal(r.totalStake, 6);
  assert.equal(r.totalReturn, 8.4);
  assert.ok(almostEqual(r.roi, (8.4 - 6) / 6));
  assert.ok(almostEqual(r.winRate, 1 / 3));
});

test('recomputeFromHistory: byBetType breaks out Exacta Box separately from Win', () => {
  const picks = [
    { settled: true, won: true, amount: 2, payout: 6, betType: 'Win' },
    { settled: true, won: false, amount: 4, payout: 0, betType: 'Exacta Box' },
  ];
  const r = recomputeFromHistory(picks);
  assert.equal(r.byBetType.Win.settled, 1);
  assert.equal(r.byBetType.Win.wins, 1);
  assert.equal(r.byBetType['Exacta Box'].settled, 1);
  assert.equal(r.byBetType['Exacta Box'].wins, 0);
  assert.equal(r.byBetType['Exacta Box'].roi, -1);
});

test('recomputeFromHistory: zero settled picks yields null winRate/roi, not NaN or a crash', () => {
  const r = recomputeFromHistory([{ settled: false, won: null, amount: 2, payout: null, betType: 'Win' }]);
  assert.equal(r.settled, 0);
  assert.equal(r.winRate, null);
  assert.equal(r.roi, null);
});

test('almostEqual: tolerates float rounding, catches real discrepancies', () => {
  assert.ok(almostEqual(0.301, 0.3011));
  assert.ok(almostEqual(null, null));
  assert.ok(!almostEqual(0.301, 0.29));
  assert.ok(!almostEqual(null, 0.3));
});
