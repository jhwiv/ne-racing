'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../scripts/backtest/metrics');
const S = require('../scripts/lib/scoring');
const { evaluateVersion, evaluateBaseline, winnerOf } = require('../scripts/backtest/run');

function syntheticRace(winnerPp, payout) {
  // 5-horse field; horse with pp=1 has best speed figs.
  const horses = [
    { id: 'A', pp: 1, name: 'Alpha',   speedFigs: [85, 86, 88], runningStyle: 'EP', jockeyPct: 20, trainerPct: 18, lastClass: 'ALW', ml: '5-2' },
    { id: 'B', pp: 2, name: 'Bravo',   speedFigs: [75, 76, 74], runningStyle: 'P',  jockeyPct: 15, trainerPct: 15, lastClass: 'ALW', ml: '4-1' },
    { id: 'C', pp: 3, name: 'Charlie', speedFigs: [65, 66, 68], runningStyle: 'S',  jockeyPct: 12, trainerPct: 12, lastClass: 'ALW', ml: '6-1' },
    { id: 'D', pp: 4, name: 'Delta',   speedFigs: [55, 56, 58], runningStyle: 'E',  jockeyPct: 10, trainerPct: 10, lastClass: 'CLM', ml: '10-1' },
    { id: 'E', pp: 5, name: 'Echo',    speedFigs: [50, 48, 52], runningStyle: 'SS', jockeyPct: 8,  trainerPct: 6,  lastClass: 'CLM', ml: '15-1' },
  ];
  return {
    id: `T-20260101-R${winnerPp}`, track: 'TST', date: '2026-01-01', num: winnerPp,
    type: 'ALW',
    horses,
    results: {
      finish_positions: [
        { pp: winnerPp, position: 1, win_payout: payout || 6.40 },
      ],
    },
  };
}

// ── Metrics primitives ───────────────────────────────────────────────────────
test('logLossRace: perfect prediction → ~0', () => {
  const scored = [{ horse: { pp: 1 }, modelProb: 1 }];
  const ll = M.logLossRace(scored, 1);
  assert.ok(ll < 1e-3, `expected ~0, got ${ll}`);
});

test('logLossRace: very wrong prediction → large positive', () => {
  const scored = [{ horse: { pp: 1 }, modelProb: 0.001 }];
  const ll = M.logLossRace(scored, 1);
  assert.ok(ll > 5);
});

test('logLossRace: winner not in scored set returns null', () => {
  const scored = [{ horse: { pp: 2 }, modelProb: 0.5 }];
  assert.equal(M.logLossRace(scored, 99), null);
});

test('brierRace: perfect prediction → ~0', () => {
  const scored = [
    { horse: { pp: 1 }, modelProb: 1 },
    { horse: { pp: 2 }, modelProb: 0 },
    { horse: { pp: 3 }, modelProb: 0 },
  ];
  assert.ok(M.brierRace(scored, 1) < 1e-9);
});

test('brierRace: maximally wrong → 2', () => {
  const scored = [
    { horse: { pp: 1 }, modelProb: 0 },
    { horse: { pp: 2 }, modelProb: 1 },
  ];
  // (0-1)^2 + (1-0)^2 = 2
  assert.equal(M.brierRace(scored, 1), 2);
});

test('top1Hit & topKHit', () => {
  const scored = [
    { horse: { pp: 7 } }, { horse: { pp: 3 } }, { horse: { pp: 1 } },
  ];
  assert.equal(M.top1Hit(scored, 7), 1);
  assert.equal(M.top1Hit(scored, 3), 0);
  assert.equal(M.topKHit(scored, 1, 3), 1);
  assert.equal(M.topKHit(scored, 4, 3), 0);
});

// ── exactaBoxHit: the model's top-2-by-score pair vs. real top-2 finishers ──
test('exactaBoxHit: hits when the model\'s top-2 land 1st/2nd in the SAME order', () => {
  const scored = [{ horse: { pp: 1 } }, { horse: { pp: 2 } }, { horse: { pp: 3 } }];
  const race = { results: { finish_positions: [
    { pp: 1, position: 1 }, { pp: 2, position: 2 },
  ] } };
  assert.equal(M.exactaBoxHit(scored, race), 1);
});

test('exactaBoxHit: hits when the model\'s top-2 land 1st/2nd in the OPPOSITE order (a box doesn\'t care)', () => {
  const scored = [{ horse: { pp: 1 } }, { horse: { pp: 2 } }, { horse: { pp: 3 } }];
  const race = { results: { finish_positions: [
    { pp: 2, position: 1 }, { pp: 1, position: 2 },
  ] } };
  assert.equal(M.exactaBoxHit(scored, race), 1);
});

test('exactaBoxHit: misses when either named horse is outside the real top-2', () => {
  const scored = [{ horse: { pp: 1 } }, { horse: { pp: 2 } }, { horse: { pp: 3 } }];
  const race = { results: { finish_positions: [
    { pp: 3, position: 1 }, { pp: 1, position: 2 }, // pp 2 (model's #2) finished off the board
  ] } };
  assert.equal(M.exactaBoxHit(scored, race), 0);
});

test('exactaBoxHit: unmeasurable (null) without a known 2nd-place finisher', () => {
  const scored = [{ horse: { pp: 1 } }, { horse: { pp: 2 } }];
  const race = { results: { finish_positions: [{ pp: 1, position: 1 }] } }; // winner only, no 2nd
  assert.equal(M.exactaBoxHit(scored, race), null);
});

test('exactaBoxHit: unmeasurable (null) with fewer than 2 scored horses', () => {
  const race = { results: { finish_positions: [{ pp: 1, position: 1 }, { pp: 2, position: 2 }] } };
  assert.equal(M.exactaBoxHit([{ horse: { pp: 1 } }], race), null);
});

test('flatTopPickROI: top pick wins → payout-2', () => {
  const scored = [{ horse: { pp: 1 } }];
  const race = { results: { finish_positions: [{ pp: 1, position: 1, win_payout: 6.40 }] } };
  assert.ok(Math.abs(M.flatTopPickROI(scored, race) - 4.40) < 1e-9);
});

test('flatTopPickROI: top pick loses → -2', () => {
  const scored = [{ horse: { pp: 2 } }];
  const race = { results: { finish_positions: [{ pp: 1, position: 1, win_payout: 6.40 }] } };
  assert.equal(M.flatTopPickROI(scored, race), -2);
});

test('calibrationBuckets: monotone predictions assign to right deciles', () => {
  const predictions = [
    { prob: 0.05, y: 0 }, { prob: 0.15, y: 0 }, { prob: 0.25, y: 1 },
    { prob: 0.95, y: 1 },
  ];
  const buckets = M.calibrationBuckets(predictions);
  assert.equal(buckets[0].n, 1); // 0.05 → bucket 0
  assert.equal(buckets[1].n, 1); // 0.15 → bucket 1
  assert.equal(buckets[9].n, 1); // 0.95 → bucket 9
});

// ── winnerOf helper ──────────────────────────────────────────────────────────
test('winnerOf: returns pp of position 1 row, null otherwise', () => {
  assert.equal(winnerOf(syntheticRace(3)), 3);
  assert.equal(winnerOf({ id: 'X' }), null);
  assert.equal(winnerOf({ id: 'X', results: {} }), null);
});

// ── End-to-end on synthetic races ───────────────────────────────────────────
test('evaluateVersion: produces summary metrics on synthetic data', () => {
  // 10 races. The clear favorite (pp=1) wins 5 of them, others split.
  const races = [];
  for (let i = 0; i < 5; i++) races.push(syntheticRace(1, 6.40));
  for (let i = 0; i < 3; i++) races.push(syntheticRace(2, 9.20));
  for (let i = 0; i < 2; i++) races.push(syntheticRace(3, 12.40));
  // Make IDs unique so dedup wouldn't matter (but loadCorpus isn't used here).
  races.forEach((r, idx) => { r.id = `T-2026-R${idx}`; });

  const out = evaluateVersion('v2', races);
  assert.equal(out.summary.races_scored, 10);
  assert.equal(out.summary.races_measurable, 10);
  assert.ok(out.summary.log_loss_mean != null);
  assert.ok(out.summary.brier_mean != null);
  assert.equal(out.summary.top1_rate, 0.5, 'pp=1 wins 5/10 → top-1 rate 50%');
  assert.ok(out.summary.top3_rate >= out.summary.top1_rate, 'top-3 should ≥ top-1');
});

test('evaluateVersion: exacta_box_rate/exacta_n stay null/0 on plain winner-only results (the historical status quo)', () => {
  // syntheticRace() only ever sets a position-1 winner -- exactly the shape
  // every result source in this repo produced before this metric existed.
  const races = [syntheticRace(1), syntheticRace(2), syntheticRace(3)];
  races.forEach((r, i) => { r.id = `E-${i}`; });
  const out = evaluateVersion('v2', races);
  assert.equal(out.summary.exacta_n, 0, 'no race here has a known 2nd-place finisher, so the metric must report zero measurable races');
  assert.equal(out.summary.exacta_box_rate, null);
});

test('evaluateVersion: exacta_box_rate reflects real box hits once 2nd-place data exists', () => {
  const race = syntheticRace(1); // pp=1 (Alpha) has the best speed figs -> model's #1
  race.id = 'F-0';
  // Model's #2-by-score in this 5-horse field is pp=2 (Bravo, next-best figs).
  // Give it a real 2nd-place finish so the box (pp 1 + pp 2) hits.
  race.results.finish_positions.push({ pp: 2, position: 2 });
  const out = evaluateVersion('v2', [race]);
  assert.equal(out.summary.exacta_n, 1);
  assert.equal(out.summary.exacta_box_rate, 1);
});

test('evaluateVersion: degrades gracefully without results', () => {
  const races = [{
    id: 'X', track: 'TST', date: '2026-01-01', num: 1, type: 'ALW',
    horses: [
      { pp: 1, name: 'A', speedFigs: [70, 70, 70], runningStyle: 'E', jockeyPct: 15, trainerPct: 15, lastClass: 'ALW', ml: '3-1' },
      { pp: 2, name: 'B', speedFigs: [60, 60, 60], runningStyle: 'S', jockeyPct: 10, trainerPct: 10, lastClass: 'ALW', ml: '8-1' },
    ],
  }];
  const out = evaluateVersion('v2', races);
  assert.equal(out.summary.races_scored, 1);
  assert.equal(out.summary.races_measurable, 0);
  assert.equal(out.summary.log_loss_mean, null);
  assert.equal(out.summary.top1_rate, null);
});

test('evaluateBaseline: ML favorite hit rate matches simple expectation', () => {
  // 4 races, ML favorite (pp=1 at 5-2) wins 2 of them.
  const races = [
    syntheticRace(1), syntheticRace(1), syntheticRace(2), syntheticRace(3),
  ];
  races.forEach((r, i) => { r.id = `B-${i}`; });
  const b = evaluateBaseline(races);
  assert.equal(b.summary.races_measurable, 4);
  assert.equal(b.summary.top1_rate, 0.5);
  assert.ok(b.summary.log_loss_mean > 0);
});

test('v1 vs v2 produce different log-loss on same races', () => {
  const races = [syntheticRace(1), syntheticRace(2), syntheticRace(3)];
  races.forEach((r, i) => { r.id = `D-${i}`; });
  const v1 = evaluateVersion('v1', races);
  const v2 = evaluateVersion('v2', races);
  // They should produce different numbers (different probability normalization).
  assert.notEqual(v1.summary.log_loss_mean, v2.summary.log_loss_mean);
});
