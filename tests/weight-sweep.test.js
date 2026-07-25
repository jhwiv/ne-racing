'use strict';

// Regression coverage for scripts/backtest/weight_sweep.js -- the tool that
// searches alternative v2 composite-score weight vectors against real
// historical races and reports whether any beats DEFAULT_V2_WEIGHTS on
// HOLDOUT log-loss (never in-sample, to avoid reporting curve-fit noise as
// a real finding).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mulberry32, randomWeights, perturb, evaluate, FACTORS } = require('../scripts/backtest/weight_sweep');

test('mulberry32 is deterministic for a given seed', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const seqA = [a(), a(), a()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  seqA.forEach(v => { assert.ok(v >= 0 && v < 1); });
});

test('randomWeights always sums to 1 and covers all 6 factors', () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 50; i++) {
    const w = randomWeights(rng);
    assert.deepEqual(Object.keys(w).sort(), FACTORS.slice().sort());
    const sum = FACTORS.reduce((s, f) => s + w[f], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum was ${sum}`);
    FACTORS.forEach(f => assert.ok(w[f] >= 0));
  }
});

test('perturb stays on the simplex (sums to 1, all non-negative) regardless of maxDelta', () => {
  const rng = mulberry32(3);
  const base = { speed: 0.35, class: 0.20, pace: 0.15, tj: 0.15, bias: 0.10, fresh: 0.05 };
  for (let i = 0; i < 50; i++) {
    const w = perturb(base, rng, 0.3);
    const sum = FACTORS.reduce((s, f) => s + w[f], 0);
    assert.ok(Math.abs(sum - 1) < 1e-9, `sum was ${sum}`);
    FACTORS.forEach(f => assert.ok(w[f] >= 0, `${f} went negative: ${w[f]}`));
  }
});

function makeRace({ date, horses, winnerPp, winPayout }) {
  return {
    id: `TST-${date}-R1`, track: 'TST', date, num: 1, type: 'ALW',
    horses,
    results: { finish_positions: [{ pp: winnerPp, position: 1, win_payout: winPayout }] },
  };
}

test('evaluate() gives a perfect scorer (all weight where the winner is strongest) a lower log-loss than a uniform-ish scorer', () => {
  // Horse 1 dominates every sub-score; horse 2 is mediocre everywhere.
  const horses = [
    { pp: 1, name: 'Strong', speedFigs: [95, 96, 97], runningStyle: 'E', jockeyPct: 25, trainerPct: 25, lastClass: 'ALW' },
    { pp: 2, name: 'Weak', speedFigs: [45, 46, 47], runningStyle: 'S', jockeyPct: 5, trainerPct: 5, lastClass: 'ALW' },
  ];
  const races = [makeRace({ date: '2026-01-01', horses, winnerPp: 1, winPayout: 4.2 })];

  // Weight entirely on speed (where horse 1's advantage is largest and clean)
  // vs. weight entirely on bias (a wash here, no bias context supplied).
  const speedHeavy = { speed: 1, class: 0, pace: 0, tj: 0, bias: 0, fresh: 0 };
  const biasHeavy   = { speed: 0, class: 0, pace: 0, tj: 0, bias: 1, fresh: 0 };

  const rSpeed = evaluate(races, speedHeavy);
  const rBias = evaluate(races, biasHeavy);
  assert.equal(rSpeed.n, 1);
  assert.equal(rBias.n, 1);
  assert.ok(rSpeed.log_loss_mean < rBias.log_loss_mean,
    `expected speed-heavy weights (log-loss=${rSpeed.log_loss_mean}) to beat bias-heavy (log-loss=${rBias.log_loss_mean}) ` +
    'when the winner\'s real advantage is entirely in speed');
  assert.equal(rSpeed.top1_rate, 1);
});

test('evaluate() returns n=0 and null means when no race is measurable', () => {
  const r = evaluate([], { speed: 0.35, class: 0.20, pace: 0.15, tj: 0.15, bias: 0.10, fresh: 0.05 });
  assert.equal(r.n, 0);
  assert.equal(r.log_loss_mean, null);
  assert.equal(r.top1_rate, null);
});
