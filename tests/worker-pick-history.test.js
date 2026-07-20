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
