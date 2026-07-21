'use strict';

// Regression coverage for POST /api/picks/settle (handlePickSettle in
// worker.js). Found via a real production backfill run: 72 of 189 settle
// calls failed with HTTP 400 because `position` was a hard-required field,
// but gradePick() (scripts/lib/pick_settlement.js, v2.49.41) deliberately
// sends `position: null` for a horse absent from an official race's
// recorded finishers -- a CONFIRMED LOSS, not an unknown outcome. That
// validation silently defeated the entire point of v2.49.41: those picks
// never actually got settled, they just stayed "pending" forever.

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
  };
}

async function postSettle(env, body) {
  const worker = (await import(WORKER_URL)).default;
  const request = new Request('https://fake.test/api/picks/settle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(request, env, {});
  return { status: res.status, body: await res.json() };
}

test('POST /api/picks/settle accepts position: null -- a confirmed loss (horse absent from recorded finishers), not a missing field', async () => {
  const kv = makeFakeKv();
  const env = { ENGINE_ACCURACY: kv };
  const { status, body } = await postSettle(env, {
    engine: 'baseline_ml', track: 'SAR', date: '2026-07-09', race: 8, pp: 8,
    position: null, payout: 0, won: false, betType: 'Win',
  });
  assert.equal(status, 200, `expected a confirmed loss to settle successfully, got: ${JSON.stringify(body)}`);
  const stored = await kv.get('outcome:SAR:2026-07-09:8:baseline_ml:8', 'json');
  assert.equal(stored.won, false);
  assert.equal(stored.position, null);
});

test('POST /api/picks/settle still records a normal win with a real position', async () => {
  const kv = makeFakeKv();
  const env = { ENGINE_ACCURACY: kv };
  const { status } = await postSettle(env, {
    engine: 'v2', track: 'SAR', date: '2026-07-09', race: 2, pp: 6,
    position: 1, payout: 7.54, won: true, betType: 'Win',
  });
  assert.equal(status, 200);
  const stored = await kv.get('outcome:SAR:2026-07-09:2:v2:6', 'json');
  assert.equal(stored.won, true);
  assert.equal(stored.position, 1);
  assert.equal(stored.payout, 7.54);
});

test('POST /api/picks/settle still 400s when a truly required field (e.g. pp) is missing', async () => {
  const kv = makeFakeKv();
  const env = { ENGINE_ACCURACY: kv };
  const { status, body } = await postSettle(env, {
    engine: 'v2', track: 'SAR', date: '2026-07-09', race: 2,
    position: 1, payout: 7.54, won: true,
  });
  assert.equal(status, 400);
  assert.match(body.message, /pp/);
});

test('POST /api/picks/settle still 400s for an unknown engine', async () => {
  const kv = makeFakeKv();
  const env = { ENGINE_ACCURACY: kv };
  const { status } = await postSettle(env, {
    engine: 'not_a_real_engine', track: 'SAR', date: '2026-07-09', race: 2, pp: 6,
    position: 1, payout: 7.54, won: true,
  });
  assert.equal(status, 400);
});
