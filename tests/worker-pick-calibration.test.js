'use strict';

// Regression coverage for GET /api/picks/stats's calibration + overlay-
// betting sections (v2.49.54).
//
// Why this exists: a backtest confirmed the composite-weight refit was a
// real, modest improvement, but the honest follow-up question was "how do
// we actually get better results" -- the answer isn't just "pick more
// winners than the market" (a very high bar), it's whether the model's
// stated probabilities are TRUSTWORTHY (calibration) and whether betting
// specifically when the model disagrees with the market by a real margin
// (overlay) is profitable, tracked as its own live, ongoing metric rather
// than a one-off backtest number. Invokes the REAL worker.js fetch handler
// against a fake in-memory ENGINE_ACCURACY KV, same pattern as
// tests/worker-pick-stats.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WORKER_URL = 'file://' + path.join(__dirname, '..', 'worker.js');

function makeFakeKv() {
  const map = new Map();
  return {
    _map: map,
    async put(key, value, opts) {
      map.set(key, { value, metadata: (opts && opts.metadata) || null });
    },
    async get(key, type) {
      const entry = map.get(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry.value) : entry.value;
    },
    async list(opts) {
      const prefix = (opts && opts.prefix) || '';
      const keys = Array.from(map.keys())
        .filter(k => k.startsWith(prefix))
        .map(k => ({ name: k, metadata: map.get(k).metadata }));
      return { keys };
    },
  };
}

async function callPickStats(env, query) {
  const worker = (await import(WORKER_URL)).default;
  const request = new Request('https://fake.test/api/picks/stats' + (query || ''), { method: 'GET' });
  const res = await worker.fetch(request, env, {});
  return res.json();
}

async function seedPick(kv, { track = 'SAR', date = '2026-07-13', race, pp, engine, prob, ml, amount = 2, won, payout }) {
  const key = `pick:${track}:${date}:${race}:${engine}:${pp}`;
  await kv.put(key, JSON.stringify({ engine, amount, prob, ml, betType: 'Win', betTag: 'best' }), { metadata: { engine } });
  await kv.put(`outcome:${track}:${date}:${race}:${engine}:${pp}`, JSON.stringify({ won, payout, position: won ? 1 : 2 }));
}

test('calibration: buckets by the pick\'s own stored prob, computes predicted vs. empirical hit rate', async () => {
  const kv = makeFakeKv();
  // Two picks both at prob=0.75 (bucket 7, range 70-80%): one wins, one loses -> empirical 50%.
  await seedPick(kv, { race: 1, pp: 3, engine: 'v2', prob: 0.75, ml: '1/1', won: true, payout: 4 });
  await seedPick(kv, { race: 2, pp: 5, engine: 'v2', prob: 0.75, ml: '1/1', won: false, payout: 0 });

  const body = await callPickStats({ ENGINE_ACCURACY: kv });
  const cal = body.engines.v2.calibration;
  assert.equal(cal.length, 10, 'always 10 deciles, even empty ones');
  const bucket7 = cal[7];
  assert.equal(bucket7.n, 2);
  assert.ok(Math.abs(bucket7.avgPredicted - 0.75) < 1e-9);
  assert.ok(Math.abs(bucket7.empirical - 0.5) < 1e-9, '1 win of 2 = 50% empirical');
  assert.ok(Math.abs(bucket7.absError - 0.25) < 1e-9, '|75% predicted - 50% empirical| = 25pp');
  // Every other bucket must exist and be empty, not undefined/missing.
  assert.equal(cal[0].n, 0);
  assert.equal(cal[0].avgPredicted, null);
});

test('calibration: picks with no stored prob (e.g. baseline_ml/crowd, never scored) are excluded, not crashed on', async () => {
  const kv = makeFakeKv();
  await seedPick(kv, { race: 1, pp: 2, engine: 'baseline_ml', prob: null, ml: '2/1', won: true, payout: 6 });
  const body = await callPickStats({ ENGINE_ACCURACY: kv });
  const cal = body.engines.baseline_ml.calibration;
  assert.ok(cal.every(b => b.n === 0), 'no bucket should have picked up the prob-less pick');
});

test('overlay: a pick where model prob meaningfully exceeds market-implied prob lands in the qualifying bucket', async () => {
  const kv = makeFakeKv();
  // ml "3/1" -> implied prob = 1/(3+1) = 0.25. prob 0.40 -> overlay = 0.15 > 0.08 threshold.
  await seedPick(kv, { race: 1, pp: 4, engine: 'v2', prob: 0.40, ml: '3/1', won: true, payout: 8 });
  const body = await callPickStats({ ENGINE_ACCURACY: kv });
  const overlay = body.engines.v2.overlay;
  assert.equal(overlay.qualifying.settled, 1);
  assert.equal(overlay.qualifying.wins, 1);
  assert.equal(overlay.qualifying.winRate, 1);
  assert.equal(overlay.nonQualifying.settled, 0);
});

test('overlay: a pick where model prob is close to market-implied prob lands in the non-qualifying bucket', async () => {
  const kv = makeFakeKv();
  // ml "3/1" -> implied 0.25. prob 0.30 -> overlay = 0.05, below the 0.08 threshold.
  await seedPick(kv, { race: 1, pp: 6, engine: 'v2', prob: 0.30, ml: '3/1', won: false, payout: 0 });
  const body = await callPickStats({ ENGINE_ACCURACY: kv });
  const overlay = body.engines.v2.overlay;
  assert.equal(overlay.qualifying.settled, 0);
  assert.equal(overlay.nonQualifying.settled, 1);
});

test('overlay: an unparseable morning line is excluded from overlay tracking without throwing', async () => {
  const kv = makeFakeKv();
  await seedPick(kv, { race: 1, pp: 1, engine: 'v2', prob: 0.5, ml: 'SCR', won: false, payout: 0 });
  const body = await callPickStats({ ENGINE_ACCURACY: kv });
  const overlay = body.engines.v2.overlay;
  assert.equal(overlay.qualifying.settled, 0);
  assert.equal(overlay.nonQualifying.settled, 0);
  // But the pick must still count toward ordinary settled/wins totals -- an
  // overlay/calibration gap must never silently drop a real settle.
  assert.equal(body.engines.v2.settled, 1);
});

test('overlay ROI: computes real profit/loss against the flat reference stake for qualifying bets', async () => {
  const kv = makeFakeKv();
  // Two qualifying overlay bets, $2 each: one wins paying $10, one loses.
  await seedPick(kv, { race: 1, pp: 1, engine: 'v2', prob: 0.5, ml: '4/1', won: true, payout: 10 });
  await seedPick(kv, { race: 2, pp: 2, engine: 'v2', prob: 0.5, ml: '4/1', won: false, payout: 0 });
  const body = await callPickStats({ ENGINE_ACCURACY: kv });
  const q = body.engines.v2.overlay.qualifying;
  assert.equal(q.settled, 2);
  assert.equal(q.totalStake, 4);
  assert.equal(q.totalReturn, 10);
  assert.ok(Math.abs(q.roi - 1.5) < 1e-9, '(10-4)/4 = 150% ROI');
});
