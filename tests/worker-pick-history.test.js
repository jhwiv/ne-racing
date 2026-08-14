'use strict';

// Regression coverage for GET /api/picks/history (v2.49.43) -- the Analytics
// tab's real per-pick history list. Unlike /api/picks/stats, which only
// ever returns aggregated sums, this exposes each individual pick's real
// detail (horse name, race, bet type) and whether it's been graded yet, so
// a source with logged-but-unsettled picks shows up as "pending" instead
// of looking like it was never tracked at all.

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

async function callPickHistory(env, query) {
  const worker = (await import(WORKER_URL)).default;
  const request = new Request('https://fake.test/api/picks/history' + (query || ''), { method: 'GET' });
  const res = await worker.fetch(request, env, {});
  return res.json();
}

test('GET /api/picks/history returns real per-pick detail, settled and pending both included', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({
    engine: 'v2', track: 'SAR', date: '2026-07-13', race: 1, pp: 3,
    horseName: 'Alpha', betType: 'Win', betTag: 'best', amount: 2,
  }), { metadata: { engine: 'v2' } });
  await kv.put('outcome:SAR:2026-07-13:1:v2:3', JSON.stringify({ won: true, payout: 6.4, position: 1 }));

  // A logged pick with NO outcome yet -- must show up as pending, not be
  // silently dropped or indistinguishable from "never tracked".
  await kv.put('pick:SAR:2026-07-18:2:baseline_ml:5', JSON.stringify({
    engine: 'baseline_ml', track: 'SAR', date: '2026-07-18', race: 2, pp: 5,
    horseName: 'Bravo', betType: 'Win', betTag: 'best', amount: 2,
  }), { metadata: { engine: 'baseline_ml' } });

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickHistory(env);

  assert.equal(body.total, 2);
  assert.equal(body.picks.length, 2);

  // Newest date first.
  assert.equal(body.picks[0].date, '2026-07-18');
  assert.equal(body.picks[0].horseName, 'Bravo');
  assert.equal(body.picks[0].settled, false, 'a pick with no outcome record must be marked pending, not dropped');
  assert.equal(body.picks[0].won, null);

  assert.equal(body.picks[1].date, '2026-07-13');
  assert.equal(body.picks[1].horseName, 'Alpha');
  assert.equal(body.picks[1].settled, true);
  assert.equal(body.picks[1].won, true);
  assert.equal(body.picks[1].payout, 6.4);
});

test('GET /api/picks/history: engine filter scopes results', async () => {
  const kv = makeFakeKv();
  await kv.put('pick:SAR:2026-07-13:1:v2:3', JSON.stringify({ engine: 'v2', track: 'SAR', date: '2026-07-13', race: 1, pp: 3, horseName: 'Alpha' }), { metadata: { engine: 'v2' } });
  await kv.put('pick:SAR:2026-07-13:1:crowd:2', JSON.stringify({ engine: 'crowd', track: 'SAR', date: '2026-07-13', race: 1, pp: 2, horseName: 'Charlie' }), { metadata: { engine: 'crowd' } });

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickHistory(env, '?engine=crowd');

  assert.equal(body.total, 1);
  assert.equal(body.picks[0].horseName, 'Charlie');
});

test('GET /api/picks/history: limit caps the returned list but not the reported total', async () => {
  const kv = makeFakeKv();
  for (let i = 1; i <= 5; i++) {
    await kv.put(`pick:SAR:2026-07-1${i}:1:v2:${i}`, JSON.stringify({
      engine: 'v2', track: 'SAR', date: `2026-07-1${i}`, race: 1, pp: i, horseName: 'Horse' + i,
    }), { metadata: { engine: 'v2' } });
  }
  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickHistory(env, '?limit=2');
  assert.equal(body.picks.length, 2);
  assert.equal(body.total, 5, 'total must reflect the full matching set, not just the returned page');
});

// v2.49.64: this endpoint shared the same unbounded-KV-reads pattern as
// /api/picks/stats -- `limit` was only ever applied to the final .slice(),
// so the loop still did 2 .get() calls per key for EVERY matching pick
// regardless of how small a page was requested, and it was shown failing
// with the identical live error in the same Analytics-tab screenshot. This
// locks in the fix: only the most recent candidates get detail-fetched at
// all.
//
// v2.49.68: that cap was originally a single GLOBAL budget shared across
// every engine in the unfiltered "All" view -- confirmed live (via
// scripts/qa/verify_analytics_numbers.js against /api/picks/stats' identical
// bug) that a shared budget lets one engine's volume crowd another's still-
// recent picks out. Now per engine (MAX_DETAILED_PICKS_PER_ENGINE = 150).
test('GET /api/picks/history: caps detail reads per engine regardless of requested limit', async () => {
  const kv = makeFakeKv();
  const TOTAL = 160;
  for (let i = 0; i < TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    await kv.put(`pick:SAR:2026-0${1 + Math.floor(i / 280)}-${day}:1:v2:${i}`, JSON.stringify({
      engine: 'v2', track: 'SAR', date: `2026-0${1 + Math.floor(i / 280)}-${day}`, race: 1, pp: i, horseName: 'Horse' + i,
    }), { metadata: { engine: 'v2' } });
  }
  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickHistory(env, '?limit=500');

  assert.equal(body.picks.length, 150, 'output is capped at MAX_DETAILED_PICKS_PER_ENGINE even though limit=500 was requested');
  assert.equal(body.total, 150, 'total reflects the processed (capped) candidate set, matching the honest cap in /api/picks/stats');
});

// The actual bug found live: in the unfiltered "All" view, a busy engine's
// picks used to crowd a quiet engine's picks out of a shared 400-slot
// budget. Proves a quiet engine's picks all survive even when a busy
// engine alone exceeds what used to be the old global cap.
test('GET /api/picks/history: one engine exceeding the cap does not crowd out another engine in the unfiltered "All" view', async () => {
  const kv = makeFakeKv();
  const BUSY_TOTAL = 450; // exceeds the old global cap (400) on its own
  for (let i = 0; i < BUSY_TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    await kv.put(`pick:SAR:2026-0${1 + Math.floor(i / 280)}-${day}:1:v2:${i}`, JSON.stringify({
      engine: 'v2', track: 'SAR', date: `2026-0${1 + Math.floor(i / 280)}-${day}`, race: 1, pp: i, horseName: 'Busy' + i,
    }), { metadata: { engine: 'v2' } });
  }
  const QUIET_TOTAL = 20;
  for (let i = 0; i < QUIET_TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    await kv.put(`pick:SAR:2026-0${1 + Math.floor(i / 280)}-${day}:2:crowd:${i}`, JSON.stringify({
      engine: 'crowd', track: 'SAR', date: `2026-0${1 + Math.floor(i / 280)}-${day}`, race: 2, pp: i, horseName: 'Quiet' + i,
    }), { metadata: { engine: 'crowd' } });
  }

  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickHistory(env, '?limit=1000');
  const crowdPicks = body.picks.filter(p => p.engine === 'crowd');

  assert.equal(crowdPicks.length, QUIET_TOTAL, 'the quiet engine\'s picks must all survive, not be crowded out by the busy engine\'s volume');
});

// v2.49.69: a same-day regression -- shipping ONE shared per-engine cap
// (150) for both the pooled and filtered (?engine=X) cases broke
// scripts/qa/verify_analytics_numbers.js's own "ground truth" fetch, which
// always calls with ?engine=X and expects a single engine's FULL real
// history (pending picks included), not an artificially small window that
// disproportionately captures today's still-pending picks and pushes
// genuinely older, already-settled ones out. A filtered request has no
// cross-engine competition for the subrequest budget, so it gets a much
// larger single-engine cap (450) than the pooled "All" case (150).
test('GET /api/picks/history: engine-filtered request gets a much larger single-engine cap than the pooled "All" request', async () => {
  const kv = makeFakeKv();
  const TOTAL = 300; // over the pooled cap (150), under the filtered cap (450)
  for (let i = 0; i < TOTAL; i++) {
    const day = String(1 + (i % 28)).padStart(2, '0');
    await kv.put(`pick:SAR:2026-0${1 + Math.floor(i / 280)}-${day}:1:v2:${i}`, JSON.stringify({
      engine: 'v2', track: 'SAR', date: `2026-0${1 + Math.floor(i / 280)}-${day}`, race: 1, pp: i, horseName: 'Horse' + i,
    }), { metadata: { engine: 'v2' } });
  }
  const env = { ENGINE_ACCURACY: kv };
  const body = await callPickHistory(env, '?engine=v2&limit=500');

  assert.equal(body.total, TOTAL, 'a filtered request for a single engine must see its FULL history, not the smaller pooled-case cap');
  assert.equal(body.picks.length, TOTAL);
});
