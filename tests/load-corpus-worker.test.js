// tests/load-corpus-worker.test.js
// Tests for the new Worker-backed corpus loader and merge helper.

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
    loadCorpusFromWorker({ fetch: fakeFetch({}) }),
    /workerUrl/
  );
});

test('loadCorpusFromWorker: empty listing yields zero races', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    fetch: fakeFetch({ '/api/history/list': { entries: [] } }),
  });
  assert.equal(result.races.length, 0);
  assert.equal(result.stats.total_loaded, 0);
});

test('loadCorpusFromWorker: listing failure returns error in stats, no throw', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    fetch: fakeFetch({ '/api/history/list': null }),
  });
  assert.equal(result.races.length, 0);
  assert.ok(result.stats.error);
});

test('loadCorpusFromWorker: builds annotated race list from listing + day fetches', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    fetch: fakeFetch({
      '/api/history/list': { entries: [{ track: 'BEL', date: '2026-05-29' }] },
      '/api/history/BEL/2026-05-29': {
        races: [
          { id: 'BEL-2026-05-29-R1', track: 'BEL', date: '2026-05-29', num: 1,
            results: { finish_positions: [{ pp: 1 }, { pp: 2 }, { pp: 3 }] } },
          { id: 'BEL-2026-05-29-R2', track: 'BEL', date: '2026-05-29', num: 2 },
        ],
      },
    }),
  });
  assert.equal(result.races.length, 2);
  assert.equal(result.stats.with_results, 1);
  assert.equal(result.stats.without_results, 1);
  // _src should be tagged worker://
  assert.match(result.races[0]._src, /^worker:\/\//);
});

test('loadCorpusFromWorker: skips entries with missing track or date', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    fetch: fakeFetch({
      '/api/history/list': {
        entries: [{ track: 'BEL' }, { date: '2026-05-29' }, null],
      },
    }),
  });
  assert.equal(result.races.length, 0);
});

test('loadCorpusFromWorker: per-day fetch failures are skipped, others succeed', async () => {
  const result = await loadCorpusFromWorker({
    workerUrl: 'https://example.test',
    fetch: fakeFetch({
      '/api/history/list': {
        entries: [
          { track: 'BEL', date: '2026-05-29' },
          { track: 'SAR', date: '2026-07-15' },
        ],
      },
      '/api/history/BEL/2026-05-29': {
        races: [{ id: 'BEL-R1', track: 'BEL', date: '2026-05-29', num: 1 }],
      },
      // Note: SAR day intentionally missing → 404 → skipped
    }),
  });
  assert.equal(result.races.length, 1);
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
  const a = { races: [{ id: 'R1', _hasResult: false, source: 'disk' }], stats: {} };
  const b = { races: [{ id: 'R1', _hasResult: true,  source: 'worker' }], stats: {} };
  const merged = mergeCorpora(a, b);
  assert.equal(merged.races.length, 1);
  assert.equal(merged.races[0].source, 'worker',
    'worker copy (with results) should win over disk copy (no results)');
  assert.equal(merged.stats.duplicates_dropped, 1);
});

test('mergeCorpora: with no inputs returns empty', () => {
  const merged = mergeCorpora();
  assert.equal(merged.races.length, 0);
});
