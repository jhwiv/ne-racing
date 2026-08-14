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

test('GET /api/picks/stats breaks out settled results by betTag (conviction level) within v2', async () => {
  // Best Bet (highest conviction) wins; Action Bet (lower conviction) loses.
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win', betTag: 'best' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:3', JSON.stringify({ won: true, payout: 6.4, betType: 'Win', position: 1 }));

  await kv.put('pick:SAR:2026-07-13:2:v2:5', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win', betTag: 'action' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:2:v2:5', JSON.stringify({ won: false, payout: 0, betType: 'Win', position: 4 }));

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);
  const v2 = body.engines.v2;

  assert.ok(v2.byBetTag, 'byBetTag breakdown must be present');
  assert.equal(v2.byBetTag.best.settled, 1);
  assert.equal(v2.byBetTag.best.wins, 1);
  assert.equal(v2.byBetTag.best.roi, 2.2, '(6.4 - 2) / 2 = 2.2');
  assert.equal(v2.byBetTag.action.settled, 1);
  assert.equal(v2.byBetTag.action.wins, 0);
  assert.equal(v2.byBetTag.action.roi, -1);
});

test('GET /api/picks/stats: byBetTag falls back to "unknown" for a pick record missing betTag entirely', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:3', JSON.stringify({ won: true, payout: 6.4, betType: 'Win', position: 1 }));

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);
  assert.equal(body.engines.v2.byBetTag.unknown.settled, 1);
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

// v2.49.64: real accumulated history (since June, across 3 engines) grew
// past Cloudflare's per-invocation subrequest ceiling -- confirmed live via
// wrangler tail: "Error: Too many API requests by single Worker invocation",
// thrown from handlePickStats' per-outcome detail loop (2 extra KV .get()
// calls per settled outcome, previously unbounded). This locks in the fix:
// only the most recent outcomes get the expensive per-outcome detail fetch,
// and the response is honest about it via truncated/processedOutcomes/
// totalOutcomes.
//
// v2.49.68: that cap was originally a single GLOBAL budget shared across
// every engine -- confirmed via scripts/qa/verify_analytics_numbers.js
// against production that this produced actively wrong per-engine numbers
// once real volume crossed it (one engine's outcomes crowding another's
// still-recent outcomes out of the shared window). Now per engine
// (MAX_DETAILED_OUTCOMES_PER_ENGINE = 150) -- this test locks in a single
// engine's own cap behavior; the next test locks in cross-engine
// independence, the actual bug that was found.
test('GET /api/picks/stats: caps per-outcome detail reads (per engine) and reports truncation honestly', async () => {
  const kv = makeFakeKv();
  const TOTAL = 160;
  for (let i = 0; i < TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const key = `SAR:2026-0${1 + Math.floor(i / 280)}-${day}:1:v2:${i}`;
    await kv.put(`pick:${key}`, JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
    await kv.put(`outcome:${key}`, JSON.stringify({ won: true, payout: 4, betType: 'Win', position: 1 }));
  }

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);

  assert.equal(body.totalOutcomes, TOTAL, 'totalOutcomes must reflect the real full count, not the capped one');
  assert.equal(body.processedOutcomes, 150, 'processedOutcomes must be clamped to MAX_DETAILED_OUTCOMES_PER_ENGINE');
  assert.equal(body.truncated, true, 'truncated must be true whenever real history exceeds the per-engine cap');
  assert.equal(body.engines.v2.settled, 150, 'aggregates themselves must only reflect the capped, processed subset');
  assert.equal(body.engines.v2.truncated, true, 'per-engine truncated flag must also be set');
  assert.equal(body.engines.v2.processedOutcomes, 150);
  assert.equal(body.engines.v2.totalOutcomes, TOTAL);
});

// The actual bug found live: a global shared cap let one engine's volume
// crowd another engine's still-recent outcomes out of the window, so a
// busy engine's numbers were fine but a quieter engine's numbers were
// silently wrong (and vice versa, unpredictably). This proves engine B's
// numbers are complete and untruncated even though engine A alone exceeds
// what used to be the GLOBAL cap (400) on its own.
test('GET /api/picks/stats: one engine exceeding the cap does not truncate another engine', async () => {
  const kv = makeFakeKv();
  const BUSY_TOTAL = 450; // exceeds the old global cap (400) on its own
  for (let i = 0; i < BUSY_TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const key = `SAR:2026-0${1 + Math.floor(i / 280)}-${day}:1:v2:${i}`;
    await kv.put(`pick:${key}`, JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
    await kv.put(`outcome:${key}`, JSON.stringify({ won: true, payout: 4, betType: 'Win', position: 1 }));
  }
  const QUIET_TOTAL = 20; // well under any cap
  for (let i = 0; i < QUIET_TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const key = `SAR:2026-0${1 + Math.floor(i / 280)}-${day}:2:crowd:${i}`;
    await kv.put(`pick:${key}`, JSON.stringify({ engine: 'crowd', amount: 2, betType: 'Win' }), { metadata: { engine: 'crowd' } });
    await kv.put(`outcome:${key}`, JSON.stringify({ won: true, payout: 4, betType: 'Win', position: 1 }));
  }

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);

  assert.equal(body.engines.v2.truncated, true, 'the busy engine is truncated at its own per-engine cap');
  assert.equal(body.engines.v2.settled, 150);
  assert.equal(body.engines.crowd.truncated, false, 'the quiet engine must NOT be truncated by the busy engine\'s volume');
  assert.equal(body.engines.crowd.settled, QUIET_TOTAL, 'the quiet engine must see ALL of its own outcomes, not a share of a pooled budget');
});

test('GET /api/picks/stats: truncated is false and matches real counts when under the cap', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:3', JSON.stringify({ won: true, payout: 6.4, betType: 'Win', position: 1 }));

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickStats(env);

  assert.equal(body.truncated, false);
  assert.equal(body.processedOutcomes, 1);
  assert.equal(body.totalOutcomes, 1);
});

// v2.49.69: a same-day regression -- shipping ONE shared per-engine cap
// (150) for both the pooled (?engine= omitted) and filtered (?engine=X)
// cases broke scripts/qa/verify_analytics_numbers.js's own "ground truth"
// fetch, which always calls with ?engine=X and expects to see a single
// engine's FULL real history, not an artificially small window. When a
// filter is already applied there is exactly one engine group and never
// any cross-engine competition for the subrequest budget, so the filtered
// case gets a much larger single-engine cap (450) than the pooled case
// (150) that still protects the multi-engine unfiltered call.
test('GET /api/picks/stats: engine-filtered request gets a much larger single-engine cap than the pooled request', async () => {
  const kv = makeFakeKv();
  const TOTAL = 300; // over the pooled cap (150), under the filtered cap (450)
  for (let i = 0; i < TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    const key = `SAR:2026-0${1 + Math.floor(i / 280)}-${day}:1:v2:${i}`;
    await kv.put(`pick:${key}`, JSON.stringify({ engine: 'v2', amount: 2, betType: 'Win' }), { metadata: { engine: 'v2' } });
    await kv.put(`outcome:${key}`, JSON.stringify({ won: true, payout: 4, betType: 'Win', position: 1 }));
  }

  const env = { ENGINE_ACCURACY: kv };
  const filtered = await callPickStats(env, '?engine=v2');
  assert.equal(filtered.engines.v2.settled, TOTAL, 'a filtered request for a single engine must see its FULL history, not the smaller pooled-case cap');
  assert.equal(filtered.engines.v2.truncated, false);
});
