// tests/load-corpus-worker.test.js
// Tests for the Worker-backed corpus loader and merge helper.
//
// Rewritten 2026-07 after discovering loadCorpusFromWorker had never been
// run against the real worker: it assumed GET /api/history/list returned
// { entries: [{track,date}, ...] } requiring a second per-day fetch, but the
// actual handler (worker.js handleHistoryList) returns full race payloads in
// ONE call when ?track= is given -- { track, from, to, count, races: [...] }
// -- and never returns anything fetchable at all without a track. These
// tests (and the implementation) were both wrong in the same way, so this
// was never caught. Fixtures below match the real handler's shape,
// confirmed by reading worker.js directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadCorpusFromWorker, mergeCorpora } = require('../scripts/backtest/load_corpus.js');

// ── Fake fetch helper ────────────────────────────────────────────────────────
function fakeFetch(handlers) {
  return async function (url) {
    const u = typeof url === 'string' ? url : url.toString();
    for (const re of Object.keys(handlers)) {
      if (u.includes(re)) {
        const data = handlers[re];
        return {
          ok: data !== null,
          status: data === null ? 500 : 200,
          json: async () => data,
        };
      }
    }
    return { ok: false, status: 404, json: async () => null };
  };
}

test('loadCorpusFromWorker: requires workerUrl', async () => {
  await assert.rejects(
    loadCorpusFromWorker({ track: 'SAR', fetch: fakeFetch({}) }),
    /workerUrl/
  );
});

test('loadCorpusFromWorker: requires track (the endpoint returns no race payloads without one)', async () => {
  await assert.rejects(
    loadCorpusFromWorker({ workerUrl: 'https://example.test', fetch: fakeFetch({}) }),
    /track is required/
  );
});

test('loadCorpusFromWorker: empty listing yields zero races', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    track: 'SAR',
    fetch: fakeFetch({ '/api/history/list': { track: 'SAR', count: 0, races: [] } }),
  });
  assert.equal(result.races.length, 0);
  assert.equal(result.stats.total_loaded, 0);
});

test('loadCorpusFromWorker: listing failure returns error in stats, no throw', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    track: 'SAR',
    fetch: fakeFetch({ '/api/history/list': null }),
  });
  assert.equal(result.races.length, 0);
  assert.ok(result.stats.error);
});

test('loadCorpusFromWorker: builds annotated, normalized races from one call (no per-day fetch)', async () => {
  // Real shape: /api/history/list?track=SAR returns { races: [ <payload per date> ] },
  // each payload being a normaliseNaResults() output with its own .races[].
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    track: 'SAR',
    fetch: fakeFetch({
      '/api/history/list': {
        track: 'SAR', count: 1,
        races: [{
          track: 'SAR', date: '2026-05-29',
          races: [
            {
              raceNumber: 1,
              finishOrder: [
                { pp: 3, position: 1, horseName: 'Winner', winPayoff: 6.4 },
                { pp: 5, position: 2, horseName: 'Second' },
              ],
              payouts: { exacta: 22.4 },
            },
            { raceNumber: 2, finishOrder: [] }, // not yet official -- no result
          ],
        }],
      },
    }),
  });
  assert.equal(result.races.length, 2);
  assert.equal(result.stats.with_results, 1);
  assert.equal(result.stats.without_results, 1);
  assert.match(result.races[0]._src, /^worker:\/\/SAR\/2026-05-29$/);
  assert.equal(result.races[0].id, 'SAR-20260529-R1');
  assert.equal(result.races[0].horses.length, 0, 'RACE_HISTORY never carries pre-race horses data');
  assert.deepEqual(result.races[0].results.finish_positions.map(f => f.pp), [3, 5]);
  assert.equal(result.races[0].results.exotics.find(e => e.type === 'exacta').payout, 22.4);
});

test('loadCorpusFromWorker: skips payload dates with no races array', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    track: 'SAR',
    fetch: fakeFetch({
      '/api/history/list': {
        track: 'SAR', count: 2,
        races: [
          { track: 'SAR', date: '2026-05-29' }, // malformed -- no .races
          null,
        ],
      },
    }),
  });
  assert.equal(result.races.length, 0);
});

test('loadCorpusFromWorker: multiple dates in one listing all get pulled', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    track: 'SAR',
    fetch: fakeFetch({
      '/api/history/list': {
        track: 'SAR', count: 2,
        races: [
          { track: 'SAR', date: '2026-05-29', races: [{ raceNumber: 1, finishOrder: [] }] },
          { track: 'SAR', date: '2026-05-30', races: [{ raceNumber: 1, finishOrder: [] }] },
        ],
      },
    }),
  });
  assert.equal(result.races.length, 2);
});

// ── mergeCorpora ────────────────────────────────────────────────────────────
test('mergeCorpora: combines unique races across sources', () => {
  const a = { races: [{ id: 'R1', _hasResult: false }, { id: 'R2', _hasResult: true }], stats: {} };
  const b = { races: [{ id: 'R3', _hasResult: true }], stats: {} };
  const merged = mergeCorpora(a, b);
  assert.equal(merged.races.length, 3);
  assert.equal(merged.stats.with_results, 2);
});

test('mergeCorpora: result-bearing copy beats result-less duplicate', () => {
  const a = { races: [{ id: 'R1', _hasResult: false, source: 'disk', results: undefined }], stats: {} };
  const b = { races: [{ id: 'R1', _hasResult: true, source: 'worker', results: { finish_positions: [{ pp: 1, position: 1 }] } }], stats: {} };
  const merged = mergeCorpora(a, b);
  assert.equal(merged.races.length, 1);
  assert.equal(merged.races[0].source, 'worker',
    'worker copy (with results) should win over disk copy (no results)');
  assert.equal(merged.stats.duplicates_dropped, 1);
});

test('mergeCorpora: a result-bearing copy with no horses keeps the other copy\'s horses (the RACE_HISTORY case)', () => {
  const diskCopy = { id: 'R1', _hasResult: false, horses: [{ pp: 1, name: 'Alpha' }] };
  const workerCopy = { id: 'R1', _hasResult: true, horses: [], results: { finish_positions: [{ pp: 1, position: 1 }] } };
  const merged = mergeCorpora({ races: [diskCopy], stats: {} }, { races: [workerCopy], stats: {} });
  assert.equal(merged.races.length, 1);
  assert.equal(merged.races[0].horses.length, 1, 'must keep the disk copy\'s horses, not blank them out with the result-bearing copy\'s empty array');
  assert.ok(merged.races[0].results, 'must also keep the results from the worker copy');
});

test('mergeCorpora: with no inputs returns empty', () => {
  const merged = mergeCorpora();
  assert.equal(merged.races.length, 0);
});
