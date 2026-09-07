'use strict';

/**
 * Paid TheRacingAPI → free-source fallback (entries + Equibase scratches).
 *
 * Why this exists: DATA_SOURCE=theracingapi with an inactive subscription
 * used to 503 both /api/entries and /api/scratches with
 *   Upstream 401 … {"detail":"Subscription inactive"}
 * and error: "upstream_unavailable". Scratches must stay dynamic from
 * Equibase XML; the static card keeps scratched:false.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_URL = 'file://' + path.join(__dirname, '..', 'worker.js');
const CARD_PATH = path.join(__dirname, '..', 'data', 'entries-SAR-2026-09-07.json');
const XML_PATH = path.join(__dirname, 'fixtures', 'equibase-late-change-sar-2026-09-07.xml');

const CARD_JSON = fs.readFileSync(CARD_PATH, 'utf8');
const EQB_XML = fs.readFileSync(XML_PATH, 'utf8');

function installCacheStub() {
  const prev = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async () => undefined,
      put: async () => {},
    },
  };
  return () => { globalThis.caches = prev; };
}

function urlOf(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function jsonRes(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    text: async () => JSON.stringify(obj),
    json: async () => obj,
  };
}

function textRes(text, status = 200, statusText = 'OK') {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

function mockFetch({ traStatus = 401, traBody = { detail: 'Subscription inactive' } } = {}) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    calls.push({ url, init });
    if (url.includes('api.theracingapi.com')) {
      return jsonRes(traBody, traStatus);
    }
    if (url.includes('github.io') || url.includes('raw.githubusercontent.com')) {
      if (url.includes('PLACEHOLDER-TEST')) return textRes('PLACEHOLDER');
      return textRes(CARD_JSON);
    }
    if (url.includes('eqbLateChangeXMLDownload')) {
      return textRes(EQB_XML);
    }
    return textRes('not-mocked', 404, 'Not Found');
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const PAID_ENV = {
  DATA_SOURCE: 'theracingapi',
  API_USER: 'user',
  API_KEY: 'key',
  DEFAULT_TRACK: 'SAR',
  ALLOWED_ORIGIN: '*',
};

async function callApi(pathname) {
  const worker = (await import(WORKER_URL)).default;
  const request = new Request('https://fake.test' + pathname, { method: 'GET' });
  return worker.fetch(request, PAID_ENV, {});
}

test('static SAR 2026-09-07 card is 12 races / ~128 runners with scratched:false', () => {
  const card = JSON.parse(CARD_JSON);
  assert.equal(card.track, 'SAR');
  assert.equal(card.date, '2026-09-07');
  assert.equal(card.races.length, 12);
  let runners = 0;
  let scratchedTrue = 0;
  for (const race of card.races) {
    assert.ok(Array.isArray(race.expertPicks) && race.expertPicks.length > 0, `R${race.race_number} expertPicks`);
    for (const e of race.entries || []) {
      runners += 1;
      if (e.scratched === true) scratchedTrue += 1;
      assert.ok(e.pp > 0, `pp for ${e.name}`);
      assert.ok(e.name);
      assert.ok(e.jockey);
      assert.ok(e.trainer);
      assert.ok(e.weight !== undefined);
      assert.ok(e.ml);
    }
  }
  assert.equal(runners, 128);
  assert.equal(scratchedTrue, 0);
});

test('TRA 401 Subscription inactive falls back to static entries (not 503)', async () => {
  const restoreCache = installCacheStub();
  const mock = mockFetch();
  try {
    const res = await callApi('/api/entries?track=SAR&date=2026-09-07');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'github-pages-static');
    assert.equal(body.track, 'SAR');
    assert.equal(body.races.length, 12);
    const runners = body.races.reduce((n, r) => n + (r.entries || []).length, 0);
    assert.equal(runners, 128);
    assert.ok(body.paidFallback);
    assert.match(body.paidFallback.reason, /401|Subscription inactive/i);
    assert.ok(mock.calls.some((c) => c.url.includes('api.theracingapi.com')));
    assert.ok(mock.calls.some((c) => c.url.includes('entries-SAR-2026-09-07.json')));
  } finally {
    mock.restore();
    restoreCache();
  }
});

test('TRA 401 Subscription inactive falls back to Equibase scratches (dynamic)', async () => {
  const restoreCache = installCacheStub();
  const mock = mockFetch();
  try {
    const res = await callApi('/api/scratches?track=SAR&date=2026-09-07');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'equibase-live');
    assert.ok(Array.isArray(body.scratches));
    assert.ok(body.scratches.length >= 4);
    const names = body.scratches.map((s) => s.horseName);
    assert.ok(names.includes("Scarlett's Halo"));
    assert.ok(names.includes('Jadorlinija'));
    assert.ok(names.includes('Beira'));
    assert.ok(body.paidFallback);
    assert.ok(mock.calls.some((c) => c.url.includes('eqbLateChangeXMLDownload')));
  } finally {
    mock.restore();
    restoreCache();
  }
});

test('DATA_SOURCE=free uses Equibase scratches without TRA', async () => {
  const restoreCache = installCacheStub();
  const mock = mockFetch();
  try {
    const worker = (await import(WORKER_URL)).default;
    const request = new Request('https://fake.test/api/scratches?track=SAR&date=2026-09-07', { method: 'GET' });
    const res = await worker.fetch(request, { DATA_SOURCE: 'free', DEFAULT_TRACK: 'SAR', ALLOWED_ORIGIN: '*' }, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.source, 'equibase-live');
    assert.ok(body.scratches.length >= 4);
    assert.ok(!mock.calls.some((c) => c.url.includes('api.theracingapi.com')));
  } finally {
    mock.restore();
    restoreCache();
  }
});

test('TRA 401 odds/results degrade to empty 200, not 503', async () => {
  const restoreCache = installCacheStub();
  const mock = mockFetch();
  try {
    const oddsRes = await callApi('/api/odds?track=SAR&date=2026-09-07&race=1');
    assert.equal(oddsRes.status, 200);
    const odds = await oddsRes.json();
    assert.equal(odds.source, 'unavailable');
    assert.deepEqual(odds.odds, []);

    const resultsRes = await callApi('/api/results?track=SAR&date=2026-09-07');
    assert.equal(resultsRes.status, 200);
    const results = await resultsRes.json();
    assert.equal(results.source, 'unavailable');
  } finally {
    mock.restore();
    restoreCache();
  }
});
