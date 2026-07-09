'use strict';

// Regression coverage for v2.49.26: race.expertPicks was hardcoded to []
// for every race in the live paid-mode data path (worker.js's
// normaliseNaEntries), so the Expert Consensus Record tile, the per-race
// "Expert Sources" chips, and the "N of M experts agree" LOCK messaging
// were all silently non-functional in production. This wires the client to
// the already-built (but never-called) GET /api/expert-picks worker
// endpoint. See docs/SARATOGA_NYRA.md for the full design.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = INDEX.indexOf(startMarker);
  assert.ok(start > -1, 'start marker ' + JSON.stringify(startMarker) + ' not found');
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(end > -1, 'end marker ' + JSON.stringify(endMarker) + ' not found');
  return INDEX.slice(start, end);
}

// Full literal async signature required -- a generic name-only marker search
// (sliceFn's INDEX.indexOf('function fetchExpertPicksForCard')) would match
// mid-string inside "async function fetchExpertPicksForCard(...)" and
// silently drop the "async" keyword, producing a confusing
// "await is only valid in async functions" error at run time.
const FETCH_EXPERT_PICKS_SRC = sliceBetween(
  'async function fetchExpertPicksForCard(code, date)',
  '\nvar _scratchInitialLoadDone'
);

class FakeLocalStorage {
  constructor() { this._map = new Map(); }
  get length() { return this._map.size; }
  key(i) { return Array.from(this._map.keys())[i]; }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
}

function makeSandbox(overrides) {
  const sandbox = {
    console,
    fetch: async () => ({ ok: false }),
  };
  Object.assign(sandbox, overrides);
  return vm.createContext(sandbox);
}

test('v2.49.26 regression: fetchExpertPicksForCard merges /api/expert-picks results onto matching race numbers', async () => {
  const trackData = {
    racesDate: '2026-07-09',
    races: [
      { num: 1, expertPicks: [] },
      { num: 2, expertPicks: [] },
    ],
  };
  let saved = null;
  let rendered = false;
  const ctx = makeSandbox({
    getStore: () => ({ settings: { workerUrl: 'https://worker.example' } }),
    getTrackData: () => trackData,
    saveTrackData: (d) => { saved = d; },
    renderTodayTab: () => { rendered = true; },
    fetch: async (url) => {
      assert.match(url, /\/api\/expert-picks\?track=SAR&date=2026-07-09/);
      return {
        ok: true,
        json: async () => ({
          expertPicks: [
            { race: 1, picks: [{ source: 'NYRA - Serling', pick: 4, horseName: 'Midnight Cowboy Kid' }] },
          ],
        }),
      };
    },
  });
  await vm.runInContext(
    FETCH_EXPERT_PICKS_SRC + '\nfetchExpertPicksForCard("SAR", "2026-07-09");',
    ctx
  );
  assert.deepEqual(trackData.races[0].expertPicks, [{ source: 'NYRA - Serling', pick: 4, horseName: 'Midnight Cowboy Kid' }]);
  assert.deepEqual(trackData.races[1].expertPicks, [], 'race 2 had no matching picks and must be left untouched');
  assert.ok(saved, 'must persist the merged data');
  assert.ok(rendered, 'must re-render so the new picks show up');
});

test('v2.49.26 regression: fetchExpertPicksForCard is a no-op if the user navigated to a different date while the fetch was in flight', async () => {
  const trackData = { racesDate: '2026-07-10', races: [{ num: 1, expertPicks: [] }] };
  let saved = false;
  const ctx = makeSandbox({
    getStore: () => ({ settings: { workerUrl: 'https://worker.example' } }),
    getTrackData: () => trackData,
    saveTrackData: () => { saved = true; },
    renderTodayTab: () => {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ expertPicks: [{ race: 1, picks: [{ source: 'NYRA - Serling', pick: 4, horseName: 'X' }] }] }),
    }),
  });
  await vm.runInContext(
    FETCH_EXPERT_PICKS_SRC + '\nfetchExpertPicksForCard("SAR", "2026-07-09");',
    ctx
  );
  assert.equal(saved, false, 'stale response for a date the user left must not be persisted');
  assert.deepEqual(trackData.races[0].expertPicks, []);
});

test('v2.49.26 regression: fetchExpertPicksForCard never throws when the worker URL is missing or the fetch fails', async () => {
  const ctxNoWorker = makeSandbox({ getStore: () => ({ settings: {} }) });
  await assert.doesNotReject(vm.runInContext(FETCH_EXPERT_PICKS_SRC + '\nfetchExpertPicksForCard("SAR", "2026-07-09");', ctxNoWorker));

  const ctxFailedFetch = makeSandbox({
    getStore: () => ({ settings: { workerUrl: 'https://worker.example' } }),
    fetch: async () => { throw new Error('network down'); },
  });
  await assert.doesNotReject(vm.runInContext(FETCH_EXPERT_PICKS_SRC + '\nfetchExpertPicksForCard("SAR", "2026-07-09");', ctxFailedFetch));
});
