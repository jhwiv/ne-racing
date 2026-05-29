'use strict';

/**
 * load_corpus.js — read every race we have on disk and normalize into a flat
 * list the backtest can iterate. Sources, in order of precedence:
 *
 *   1. data/normalized/{year}/{track}/{date}.json   ← from scripts/ingest/run.js
 *   2. data/entries-{TRACK}-{DATE}.json             ← hand-curated NYRA cards
 *   3. data/fixtures/*.json                          ← placeholder cards (last resort)
 *
 * Each loaded race is annotated with:
 *   - _src       : path it came from
 *   - _hasResult : true if race.results.finish_positions[] is present and non-empty
 *
 * We DO NOT invent results. Races without results are still returned so that
 * "scored but unmeasurable" can be reported alongside "scored and measurable."
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data');

function listFiles(dir, predicate) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const stat = fs.statSync(p);
    if (stat.isDirectory()) out.push(...listFiles(p, predicate));
    else if (predicate(name)) out.push(p);
  }
  return out;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { return null; }
}

function hasResults(race) {
  return !!(race && race.results
    && Array.isArray(race.results.finish_positions)
    && race.results.finish_positions.length > 0);
}

function annotate(races, src) {
  return (races || []).map(r => Object.assign({}, r, {
    _src: src,
    _hasResult: hasResults(r),
  }));
}

function loadNormalized() {
  const dir = path.join(DATA, 'normalized');
  const files = listFiles(dir, n => n.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const doc = readJson(f);
    if (doc && Array.isArray(doc.races)) out.push(...annotate(doc.races, f));
  }
  return out;
}

function loadEntriesFiles() {
  const files = listFiles(DATA, n => /^entries-[A-Z]+-\d{4}-\d{2}-\d{2}\.json$/.test(n));
  const out = [];
  for (const f of files) {
    const doc = readJson(f);
    if (!doc) continue;
    // Entries files are either { races: [...] } or a single card object.
    if (Array.isArray(doc.races)) out.push(...annotate(doc.races, f));
    else if (Array.isArray(doc)) out.push(...annotate(doc, f));
  }
  return out;
}

function loadFixtures() {
  const dir = path.join(DATA, 'fixtures');
  if (!fs.existsSync(dir)) return [];
  const files = listFiles(dir, n => n.endsWith('.json'));
  const out = [];
  for (const f of files) {
    const doc = readJson(f);
    if (doc && Array.isArray(doc.races)) out.push(...annotate(doc.races, f));
  }
  return out;
}

/**
 * Load the full corpus.
 *
 * @param {Object} opts
 * @param {boolean} opts.includeFixtures   — include placeholder fixtures (default false)
 * @param {boolean} opts.requireResults    — drop races without results (default false)
 * @returns {{races: Array, stats: Object}}
 */
function loadCorpus(opts) {
  opts = opts || {};
  const normalized = loadNormalized();
  const entries    = loadEntriesFiles();
  const fixtures   = opts.includeFixtures ? loadFixtures() : [];

  // De-duplicate by race.id. Priority:
  //   1. ANY copy with results beats any copy without.
  //   2. Otherwise prefer normalized > entries > fixtures.
  const byId = new Map();
  const order = [normalized, entries, fixtures];
  let dropDupes = 0;
  for (const list of order) {
    for (const r of list) {
      const key = r.id || `${r.track}-${r.date}-R${r.num}`;
      const existing = byId.get(key);
      if (existing) {
        // Replace only if the new copy has results and the existing one doesn't.
        if (r._hasResult && !existing._hasResult) {
          byId.set(key, r);
        }
        dropDupes++;
        continue;
      }
      byId.set(key, r);
    }
  }
  // Second pass: for any entry that doesn't have results, see if any later
  // source had a result-bearing copy with the same id (covers cases where the
  // primary source was added without results but a fixture has demo results).
  const allSources = [...normalized, ...entries, ...fixtures];
  for (const r of allSources) {
    if (!r._hasResult) continue;
    const key = r.id || `${r.track}-${r.date}-R${r.num}`;
    const existing = byId.get(key);
    if (existing && !existing._hasResult) byId.set(key, r);
  }

  let races = Array.from(byId.values());
  const total = races.length;
  const withResults = races.filter(r => r._hasResult).length;

  if (opts.requireResults) races = races.filter(r => r._hasResult);

  return {
    races,
    stats: {
      total_loaded: total,
      with_results: withResults,
      without_results: total - withResults,
      duplicates_dropped: dropDupes,
      from_normalized: normalized.length,
      from_entries: entries.length,
      from_fixtures: fixtures.length,
    },
  };
}

module.exports = { loadCorpus, hasResults };
