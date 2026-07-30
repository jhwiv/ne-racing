'use strict';

// Regression coverage for GET /api/track-status (v2.49.56).
//
// Why this exists: neither The Racing API nor Equibase exposes a
// cancellation-reason field, so a rained-out meet looks identical, from
// that data alone, to a normal scheduled dark day (reported live: the app
// gave zero indication Saratoga had been weather-closed). This endpoint
// asks Perplexity's web-search API directly and caches the result in
// RACE_HISTORY KV under `trackstatus:{TRACK}:{DATE}`, written once daily by
// the scheduled() cron's 07:00 ET tick. These tests mock global fetch (the
// real worker.js code path calls the bare `fetch()`, not an injected
// client) since no real PERPLEXITY_API_KEY exists in this environment --
// see the file-header caveat in worker.js: the actual Perplexity request/
// response shape used here has NOT been exercised against a real key.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const WORKER_URL = 'file://' + path.join(__dirname, '..', 'worker.js');

function makeFakeKv() {
  const map = new Map();
  return {
    _map: map,
    async put(key, value) { map.set(key, value); },
    async get(key, type) {
      const entry = map.get(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry) : entry;
    },
  };
}

function mockPerplexity(content, { ok = true, status = 200 } = {}) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (!ok) return { ok: false, status, text: async () => 'upstream error' };
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content } }],
        citations: ['https://example.test/source1'],
      }),
    };
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

async function callTrackStatus(env, query) {
  const worker = (await import(WORKER_URL)).default;
  const request = new Request('https://fake.test/api/track-status' + (query || ''), { method: 'GET' });
  const res = await worker.fetch(request, env, {});
  return res.json();
}

test('no PERPLEXITY_API_KEY configured -> status unknown, never calls fetch', async () => {
  const mock = mockPerplexity('irrelevant');
  try {
    const kv = makeFakeKv();
    const body = await callTrackStatus({ RACE_HISTORY: kv }, '?track=SAR&date=2026-07-29');
    assert.equal(body.status, 'unknown');
    assert.equal(body.reason, 'not_configured');
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('live search classifies a clear cancellation report as confirmed_closed and caches it', async () => {
  const mock = mockPerplexity(
    'Saratoga Race Course cancelled today’s card due to heavy rain, per a same-day NYRA announcement.'
  );
  try {
    const kv = makeFakeKv();
    const body = await callTrackStatus(
      { PERPLEXITY_API_KEY: 'fake-key', RACE_HISTORY: kv },
      '?track=SAR&date=2026-07-29'
    );
    assert.equal(body.status, 'confirmed_closed');
    assert.match(body.summary, /cancelled/i);
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].url, /api\.perplexity\.ai\/chat\/completions/);
    // Cached under the documented key shape.
    const cached = JSON.parse(await kv.get('trackstatus:SAR:2026-07-29'));
    assert.equal(cached.status, 'confirmed_closed');
  } finally {
    mock.restore();
  }
});

test('live search classifies a clear "proceeding as scheduled" report as confirmed_live', async () => {
  const mock = mockPerplexity(
    'No cancellation has been reported. Saratoga’s card today is proceeding as scheduled.'
  );
  try {
    const body = await callTrackStatus(
      { PERPLEXITY_API_KEY: 'fake-key', RACE_HISTORY: makeFakeKv() },
      '?track=SAR&date=2026-07-30'
    );
    assert.equal(body.status, 'confirmed_live');
  } finally {
    mock.restore();
  }
});

test('an ambiguous / hedged answer classifies as unclear, not a guessed status', async () => {
  const mock = mockPerplexity(
    'I could not find a specific, dated source reporting on today’s Saratoga card status.'
  );
  try {
    const body = await callTrackStatus(
      { PERPLEXITY_API_KEY: 'fake-key', RACE_HISTORY: makeFakeKv() },
      '?track=SAR&date=2026-07-30'
    );
    assert.equal(body.status, 'unclear');
  } finally {
    mock.restore();
  }
});

test('a cached KV entry is served without calling fetch again', async () => {
  const mock = mockPerplexity('should not be called');
  try {
    const kv = makeFakeKv();
    await kv.put('trackstatus:SAR:2026-07-29', JSON.stringify({
      track: 'SAR', date: '2026-07-29', status: 'confirmed_closed',
      summary: 'cached answer', sources: [], checkedAt: '2026-07-29T11:00:00.000Z',
    }));
    const body = await callTrackStatus(
      { PERPLEXITY_API_KEY: 'fake-key', RACE_HISTORY: kv },
      '?track=SAR&date=2026-07-29'
    );
    assert.equal(body.summary, 'cached answer');
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('force=1 bypasses the cache and runs a live check, overwriting it', async () => {
  const mock = mockPerplexity('Racing is proceeding as scheduled today, no cancellation reported.');
  try {
    const kv = makeFakeKv();
    await kv.put('trackstatus:SAR:2026-07-29', JSON.stringify({
      track: 'SAR', date: '2026-07-29', status: 'confirmed_closed',
      summary: 'stale cached answer', sources: [], checkedAt: '2026-07-28T11:00:00.000Z',
    }));
    const body = await callTrackStatus(
      { PERPLEXITY_API_KEY: 'fake-key', RACE_HISTORY: kv },
      '?track=SAR&date=2026-07-29&force=1'
    );
    assert.equal(mock.calls.length, 1);
    assert.equal(body.status, 'confirmed_live');
    const cached = JSON.parse(await kv.get('trackstatus:SAR:2026-07-29'));
    assert.equal(cached.status, 'confirmed_live');
  } finally {
    mock.restore();
  }
});

test('an upstream HTTP failure degrades to status unknown / search_failed, never throws to the client', async () => {
  const mock = mockPerplexity('', { ok: false, status: 500 });
  try {
    const body = await callTrackStatus(
      { PERPLEXITY_API_KEY: 'fake-key', RACE_HISTORY: makeFakeKv() },
      '?track=SAR&date=2026-07-29'
    );
    assert.equal(body.status, 'unknown');
    assert.equal(body.reason, 'search_failed');
  } finally {
    mock.restore();
  }
});

test('works with no RACE_HISTORY binding (dev mode) -- still returns a live result, just uncached', async () => {
  const mock = mockPerplexity('Racing is proceeding as scheduled today, no cancellation reported.');
  try {
    const body = await callTrackStatus({ PERPLEXITY_API_KEY: 'fake-key' }, '?track=SAR&date=2026-07-29');
    assert.equal(body.status, 'confirmed_live');
  } finally {
    mock.restore();
  }
});
