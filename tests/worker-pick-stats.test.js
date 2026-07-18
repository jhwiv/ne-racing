'use strict';

// Regression coverage for GET /api/picks/stats's byBetType breakdown
// (v2.49.36). Invokes the REAL worker.js fetch handler (dynamic import,
// since worker.js is an ES module with no other test harness in this repo)
// against a fake in-memory ENGINE_ACCURACY KV, rather than re-implementing
// the aggregation logic in the test and asserting against itself.
//
// Why this exists: Value Play's Exacta Box outcomes and Best Bet/Action
// Bet's Win-type outcomes were previously pooled into the same per-engine
// bucket, so this endpoint could never answer "is the exacta box heuristic
// itself beating chance" -- only "how did this engine do overall," which
// conflates two very different bet shapes with very different expected
// hit rates.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WORKER_URL = 'file://' + path.join(__dirname, '..', 'worker.js');

function makeFakeKv() {
  const map = new Map(); // key -> { value, metadata }
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

test('GET /api/picks/stats breaks out settled results by betType within each engine', async () => {
  const kv = makeFakeKv();
  // Two v2 picks: one Best Bet (Win) that won, one Value Play (Exacta Box) that lost.
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:3', JSON.stringify({ won: true, payout: 6.4, betType: 'Win', position: 1 }));

  await kv.put('pick:SAR:2026-07-13:2:v2:5', JSON.stringify({ engine: 'v2', amount: 4, betType: 'Exacta Box', partnerPp: 7 }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:2:v2:5', JSON.stringify({ won: false, payout: 0, betType: 'Exacta Box', position: 3 }));

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);

  const v2 = body.engines.v2;
  assert.ok(v2, 'v2 engine bucket must exist');
  assert.equal(v2.settled, 2, 'overall settled count must still include both bet shapes (no regression)');
  assert.equal(v2.wins, 1);

  assert.ok(v2.byBetType, 'byBetType breakdown must be present');
  assert.equal(v2.byBetType.Win.settled, 1);
  assert.equal(v2.byBetType.Win.wins, 1);
  assert.equal(v2.byBetType.Win.winRate, 1);
  assert.equal(v2.byBetType.Win.roi, 2.2, '(6.4 - 2) / 2 = 2.2');

  assert.equal(v2.byBetType['Exacta Box'].settled, 1);
  assert.equal(v2.byBetType['Exacta Box'].wins, 0);
  assert.equal(v2.byBetType['Exacta Box'].winRate, 0);
  assert.equal(v2.byBetType['Exacta Box'].roi, -1, '(0 - 4) / 4 = -1 (total loss)');
});

test('GET /api/picks/stats: byBetType falls back to "Win" for legacy outcome records with no betType field', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-01:1:v1:2', JSON.stringify({ engine: 'v1', amount: 2 }), { metadata: { engine: 'v1' } });
  // Legacy outcome record, settled before betType/won existed (pre-v2.49.34).
  await kv.put('outcome:SAR:2026-07-01:1:v1:2', JSON.stringify({ position: 1, payout: 5.0 }));

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);

  const v1 = body.engines.v1;
  assert.ok(v1.byBetType.Win, 'a legacy record with no betType must fall back into the Win bucket, not be dropped');
  assert.equal(v1.byBetType.Win.settled, 1);
  assert.equal(v1.byBetType.Win.wins, 1, 'legacy record must still use the position===1 fallback for won');
});

test('GET /api/picks/stats: engine filter still scopes byBetType correctly', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:3', JSON.stringify({ won: true, payout: 6.4, betType: 'Win', position: 1 }));
  await kv.put('pick:SAR:2026-07-13:1:baseline_ml:2', JSON.stringify({ engine: 'baseline_ml', amount: 2, betType: 'Win' }), { metadata: { engine: 'baseline_ml' } });
  await kv.put('outcome:SAR:2026-07-13:1:baseline_ml:2', JSON.stringify({ won: false, payout: 0, betType: 'Win', position: 2 }));

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env, '?engine=v2');

  assert.ok(body.engines.v2);
  assert.equal(body.engines.baseline_ml, undefined, 'engine filter must exclude other engines entirely');
});

test('GET /api/picks/stats: date filter (v2.49.39) scopes to a single day for the Today/All Time toggle', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-12:1:v2:3', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-12:1:v2:3', JSON.stringify({ won: true, payout: 6.4, betType: 'Win', position: 1 }));
  await kv.put('pick:SAR:2026-07-13:1:v2:5', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:5', JSON.stringify({ won: false, payout: 0, betType: 'Win', position: 3 }));

  const env = { ENGINE_ACCURACY: kv };

  const all = await callPickStats(env);
  assert.equal(all.engines.v2.settled, 2, 'no date param must still return the full all-time total (no regression)');
  assert.equal(all.appliedDateFilter, null);

  const today = await callPickStats(env, '?date=2026-07-13');
  assert.equal(today.engines.v2.settled, 1, 'date filter must exclude the other day\'s pick/outcome entirely');
  assert.equal(today.engines.v2.wins, 0);
  assert.equal(today.appliedDateFilter, '2026-07-13', 'the applied filter must be echoed back so an older client can detect it was honored');

  const otherDay = await callPickStats(env, '?date=2026-07-12');
  assert.equal(otherDay.engines.v2.settled, 1);
  assert.equal(otherDay.engines.v2.wins, 1);
});
