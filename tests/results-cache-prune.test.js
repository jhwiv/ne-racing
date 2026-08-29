'use strict';

// Regression coverage for a real bug found live in production (v2.49.79):
// RESULTS_CACHE_KEY (index.html/app.html) is keyed "{track}_{date}", one
// entry per track+date ever viewed, with NO eviction anywhere. After ~7
// weeks of a running meet it grew large enough to help exhaust the shared
// per-origin localStorage quota, causing saveStore()'s real data write (the
// user's actual bets) to fail with "Storage error: The quota has been
// exceeded" -- reported live, with a screenshot, on 2026-08-29.
//
// Extracts pruneResultsCache() straight out of index.html (not a copy) so
// this test exercises the actual shipped function, not a stand-in that could
// silently drift from it.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

function extractFunction(html, name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`${name} not found in source`);
  // Walk braces from the first "{" after the marker to find the matching close.
  const braceStart = html.indexOf('{', start);
  let depth = 0, i = braceStart;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(start, i + 1);
}

function loadPruneResultsCache() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const constMatch = html.match(/var RESULTS_CACHE_MAX_AGE_DAYS = \d+;/);
  if (!constMatch) throw new Error('RESULTS_CACHE_MAX_AGE_DAYS not found in source');
  const src = extractFunction(html, 'pruneResultsCache');
  const sandbox = { Date, Object };
  vm.createContext(sandbox);
  vm.runInContext(`${constMatch[0]}\n${src}\nthis.pruneResultsCache = pruneResultsCache;`, sandbox);
  return sandbox.pruneResultsCache;
}

const pruneResultsCache = loadPruneResultsCache();

function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

test('pruneResultsCache keeps entries within the max age window', () => {
  const cache = { ['SAR_' + isoDaysAgo(5)]: { races: [1] } };
  const out = pruneResultsCache(cache, 30);
  assert.equal(Object.keys(out).length, 1);
});

test('pruneResultsCache evicts entries older than the max age window', () => {
  const oldKey = 'SAR_' + isoDaysAgo(45);
  const cache = { [oldKey]: { races: [1] } };
  const out = pruneResultsCache(cache, 30);
  assert.equal(Object.keys(out).length, 0);
});

test('pruneResultsCache keeps entries from multiple tracks/dates, mixed old and new', () => {
  const cache = {
    ['SAR_' + isoDaysAgo(2)]: { races: [1] },
    ['BEL_' + isoDaysAgo(10)]: { races: [2] },
    ['AQU_' + isoDaysAgo(60)]: { races: [3] },
  };
  const out = pruneResultsCache(cache, 30);
  assert.deepEqual(Object.keys(out).sort(), ['BEL_' + isoDaysAgo(10), 'SAR_' + isoDaysAgo(2)].sort());
});

test('pruneResultsCache evicts a key with no parseable date suffix (defensive, cache-only data)', () => {
  const cache = { 'malformedkey': { races: [1] } };
  const out = pruneResultsCache(cache, 30);
  assert.equal(Object.keys(out).length, 0);
});

test('pruneResultsCache defaults to 30 days when maxAgeDays is omitted', () => {
  const cache = {
    ['SAR_' + isoDaysAgo(20)]: { races: [1] },
    ['SAR_' + isoDaysAgo(40)]: { races: [2] },
  };
  const out = pruneResultsCache(cache);
  assert.deepEqual(Object.keys(out), ['SAR_' + isoDaysAgo(20)]);
});

test('app.html has the identical pruneResultsCache logic (no drift between the two shells)', () => {
  const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const appHtml = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  assert.equal(
    extractFunction(appHtml, 'pruneResultsCache'),
    extractFunction(indexHtml, 'pruneResultsCache')
  );
});

test('saveStore has the quota-exceeded recovery path in both index.html and app.html', () => {
  for (const file of ['index.html', 'app.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const src = extractFunction(html, 'saveStore');
    assert.match(src, /saveResultsCache\(\{\}\)/, `${file}: saveStore should clear the results cache and retry on quota error`);
  }
});
