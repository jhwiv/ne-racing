'use strict';

// Regression coverage for scripts/lib/pick_settlement.js -- mirrors the
// exact grading rules index.html's settleEnginePicksForRace() uses (see
// tests/pick-selection-and-bet-eval-regressions.test.js's v2.49.22 tests
// and app.html/index.html's own v2.49.34 Exacta-Box grading), so headless
// settlement produces identical verdicts to what the live client computes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gradePick } = require('../scripts/lib/pick_settlement');

test('gradePick: Win-type pick wins when its pp finished 1st, real win payout', () => {
  const raceResult = { finish_positions: [
    { pp: 3, position: 1, win_payout: 6.4 },
    { pp: 5, position: 2 },
  ] };
  const result = gradePick({ pp: 3 }, raceResult);
  assert.deepEqual(result, { position: 1, won: true, payout: 6.4, betType: 'Win' });
});

test('gradePick: Win-type pick loses when its pp finished 2nd, payout 0 (never the winner\'s payout)', () => {
  const raceResult = { finish_positions: [
    { pp: 3, position: 1, win_payout: 6.4 },
    { pp: 5, position: 2 },
  ] };
  const result = gradePick({ pp: 5 }, raceResult);
  assert.deepEqual(result, { position: 2, won: false, payout: 0, betType: 'Win' });
});

test('gradePick: Exacta Box wins when both named horses land top-2 in EITHER order', () => {
  const raceResult = {
    finish_positions: [{ pp: 7, position: 1 }, { pp: 4, position: 2 }, { pp: 9, position: 3 }],
    exotics: [{ type: 'exacta', payout: 22.4 }],
  };
  // Named horse (pp 4) finished 2nd, partner (pp 7) finished 1st -- still a hit, order doesn't matter for a box.
  const result = gradePick({ pp: 4, partnerPp: 7 }, raceResult);
  assert.deepEqual(result, { position: 2, won: true, payout: 22.4, betType: 'Exacta Box' });
});

test('gradePick: Exacta Box loses when the partner isn\'t in the top-2, even if the named horse won outright', () => {
  const raceResult = {
    finish_positions: [{ pp: 4, position: 1, win_payout: 5.2 }, { pp: 9, position: 2 }, { pp: 7, position: 3 }],
    exotics: [{ type: 'exacta', payout: 30 }],
  };
  const result = gradePick({ pp: 4, partnerPp: 7 }, raceResult);
  assert.deepEqual(result, { position: 1, won: false, payout: 0, betType: 'Exacta Box' });
});

test('gradePick v2.49.41: grades a confirmed LOSS (not null) when the named horse finished out of the recorded spots -- the race is official, so absence means it didn\'t win', () => {
  const raceResult = { finish_positions: [{ pp: 1, position: 1, win_payout: 5.0 }, { pp: 2, position: 2 }] };
  const result = gradePick({ pp: 9 }, raceResult);
  assert.deepEqual(result, { position: null, won: false, payout: 0, betType: 'Win' });
});

test('gradePick v2.49.41: Exacta Box also grades a confirmed LOSS (not null) when the named horse never even appears in the result', () => {
  const raceResult = { finish_positions: [{ pp: 1, position: 1, win_payout: 5.0 }, { pp: 2, position: 2 }] };
  const result = gradePick({ pp: 9, partnerPp: 2 }, raceResult);
  assert.deepEqual(result, { position: null, won: false, payout: 0, betType: 'Exacta Box' });
});

test('gradePick: returns null when there is no result at all yet', () => {
  assert.equal(gradePick({ pp: 1 }, null), null);
  assert.equal(gradePick({ pp: 1 }, { finish_positions: [] }), null);
});
