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

/**
 * Combine two records believed to represent the same real race, preferring
 * whichever side has results for everything EXCEPT `horses` (pre-race field
 * data). Result-only sources -- RACE_HISTORY chief among them, since it's
 * built from /api/results and never sees the pre-race card -- would
 * otherwise silently blank out horses data that only exists on an
 * entries/normalized copy of the same race id, making it unscoreable even
 * though we have everything needed to score it.
 */
function mergeRaceCopies(a, b) {
  const withResult = a._hasResult ? a : (b._hasResult ? b : a);
  const withoutResult = withResult === a ? b : a;
  const horses = (withResult.horses && withResult.horses.length) ? withResult.horses
    : (withoutResult.horses || []);
  const merged = Object.assign({}, withoutResult, withResult, { horses });
  merged._hasResult = hasResults(merged);
  return merged;
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

/**
 * Normalize one race object from a data/entries-{TRACK}-{DATE}.json file into
 * the shape scoreRace()/run.js expect.
 *
 * Found while wiring real results into the backtest (2026-07): these files
 * use `entries` (or, for dates after the daily-entries pipeline was
 * disabled, nothing at all -- just `expertPicks`), never `horses`, and never
 * stamp `track`/`date`/`num`/`id` onto the race object itself. scoreRace()
 * reads `race.horses`; run.js's dedup keys on `race.id`. Neither ever
 * matched, so any race loaded from an entries file silently scored zero
 * horses and was dropped from every backtest run to date -- only the
 * placeholder fixture corpus was ever actually measured.
 */
function normalizeEntriesRace(race, track, date) {
  const num = race.race_number || race.num;
  const horses = Array.isArray(race.horses) ? race.horses
    : Array.isArray(race.entries) ? race.entries
    : [];
  return Object.assign({}, race, {
    id: race.id || `${track}-${date.replace(/-/g, '')}-R${num}`,
    track: race.track || track,
    date: race.date || date,
    num,
    type: race.type || race.race_type_code || race.race_type || null,
    horses,
  });
}

function loadEntriesFiles() {
  const files = listFiles(DATA, n => /^entries-[A-Z]+-\d{4}-\d{2}-\d{2}\.json$/.test(n));
  const out = [];
  for (const f of files) {
    const doc = readJson(f);
    if (!doc) continue;
    const m = path.basename(f).match(/^entries-([A-Z]+)-(\d{4}-\d{2}-\d{2})\.json$/);
    const track = m ? m[1] : null;
    const date = m ? m[2] : null;
    // Entries files are either { races: [...] } or a single card object.
    const races = Array.isArray(doc.races) ? doc.races : (Array.isArray(doc) ? doc : []);
    const normalized = races.map(r => normalizeEntriesRace(r, track, date));
    out.push(...annotate(normalized, f));
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
        // Merge rather than replace -- see mergeRaceCopies(): a result-bearing
        // copy (e.g. RACE_HISTORY) never carries pre-race horses data, so a
        // blind replace would silently make the race unscoreable again.
        if (r._hasResult !== existing._hasResult || (r.horses||[]).length || (existing.horses||[]).length) {
          byId.set(key, mergeRaceCopies(existing, r));
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
    if (existing && !existing._hasResult) byId.set(key, mergeRaceCopies(existing, r));
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

// ── Worker-backed corpus loader (optional, async) ────────────────────────────
//
// As races settle in production, the Worker archives them into the
// RACE_HISTORY KV namespace via /api/history endpoints (see worker.js). This
// gives us a durable, queryable history we can pull into the backtest harness
// alongside the on-disk corpus.
//
// Usage:
//   const { loadCorpusFromWorker } = require('./load_corpus.js');
//   const remote = await loadCorpusFromWorker({
//     workerUrl: 'https://cloudflare-worker.jhwiv-online.workers.dev',
//     track:     'BEL',        // optional; omit for all tracks
//     from:      '2026-05-01', // optional; omit for full history
//     to:        '2026-07-31', // optional
//   });
//   // remote.races is the same annotated shape as loadCorpus().races
//
// Then merge with loadCorpus() by passing both to scripts/backtest/run.js.
// We intentionally KEEP this separate from loadCorpus() (which is sync and
// has no fetch dependency) so existing harness code keeps working unchanged.
/**
 * Normalize one race from a RACE_HISTORY-archived results payload (the shape
 * worker.js's normaliseNaResults() produces: `finishOrder` instead of
 * `results.finish_positions`, `payouts.exacta`/`trifecta`/`superfecta` as
 * bare numbers instead of a `results.exotics` array) into the shape
 * scoreRace()/the metrics module expect.
 *
 * RACE_HISTORY is built entirely from /api/results and never sees the
 * pre-race card, so `horses` is always empty here -- this record is only
 * ever useful merged with an entries/normalized copy of the same race id
 * that actually has pre-race horses data (see mergeRaceCopies()).
 */
function normalizeWorkerRace(race, track, date) {
  const num = race.raceNumber || race.num;
  const finishOrder = Array.isArray(race.finishOrder) ? race.finishOrder : [];
  const finish_positions = finishOrder.map(f => ({
    pp: f.pp,
    horseName: f.horseName,
    position: f.position,
    win_payout: f.winPayoff != null ? f.winPayoff : undefined,
  }));
  const payouts = race.payouts || {};
  const exotics = [
    { type: 'exacta', payout: payouts.exacta },
    { type: 'trifecta', payout: payouts.trifecta },
    { type: 'superfecta', payout: payouts.superfecta },
  ].filter(e => e.payout != null);
  return {
    id: `${track}-${date.replace(/-/g, '')}-R${num}`,
    track, date, num,
    horses: [],
    results: finish_positions.length ? { finish_positions, exotics } : undefined,
  };
}

async function loadCorpusFromWorker(opts) {
  opts = opts || {};
  const base = String(opts.workerUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('loadCorpusFromWorker: workerUrl is required');
  if (!opts.track) throw new Error('loadCorpusFromWorker: track is required (the worker\'s /api/history/list only returns race payloads when a track is given)');

  // Node 18+ has global fetch; allow callers to inject a polyfill for older runtimes.
  const fetchImpl = opts.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (!fetchImpl) {
    throw new Error('loadCorpusFromWorker: global fetch not available; pass opts.fetch');
  }

  const listUrl = new URL(base + '/api/history/list');
  listUrl.searchParams.set('track', opts.track);
  if (opts.from) listUrl.searchParams.set('from', opts.from);
  if (opts.to)   listUrl.searchParams.set('to', opts.to);
  if (opts.limit) listUrl.searchParams.set('limit', String(opts.limit));

  let listing;
  try {
    const res = await fetchImpl(listUrl.toString());
    if (!res.ok) throw new Error('list ' + res.status);
    listing = await res.json();
  } catch (e) {
    return { races: [], stats: { total_loaded: 0, with_results: 0, without_results: 0, error: String(e) } };
  }

  // Real shape (worker.js handleHistoryList, track given):
  //   { track, from, to, count, races: [ <full results payload per date>, ... ] }
  // Each payload is itself { date, races: [ {raceNumber, finishOrder, payouts, ...} ] }.
  const payloads = (listing && Array.isArray(listing.races)) ? listing.races : [];
  const out = [];
  for (const payload of payloads) {
    if (!payload || !Array.isArray(payload.races)) continue;
    const date = payload.date;
    if (!date) continue;
    const normalized = payload.races.map(r => normalizeWorkerRace(r, opts.track, date));
    out.push(...annotate(normalized, 'worker://' + opts.track + '/' + date));
  }

  const withResults = out.filter(r => r._hasResult).length;
  return {
    races: out,
    stats: {
      total_loaded: out.length,
      with_results: withResults,
      without_results: out.length - withResults,
      from_worker: out.length,
      worker_url: base,
    },
  };
}

/**
 * Merge a Worker-loaded corpus with the on-disk corpus, applying the same
 * "results-wins" de-dup policy as loadCorpus() across all sources.
 */
function mergeCorpora(...corpora) {
  const byId = new Map();
  let dropDupes = 0;
  for (const c of corpora) {
    for (const r of (c.races || [])) {
      const key = r.id || `${r.track}-${r.date}-R${r.num}`;
      const existing = byId.get(key);
      if (existing) {
        if (r._hasResult !== existing._hasResult || (r.horses||[]).length || (existing.horses||[]).length) {
          byId.set(key, mergeRaceCopies(existing, r));
        }
        dropDupes++;
        continue;
      }
      byId.set(key, r);
    }
  }
  const races = Array.from(byId.values());
  const withResults = races.filter(r => r._hasResult).length;
  return {
    races,
    stats: {
      total_loaded: races.length,
      with_results: withResults,
      without_results: races.length - withResults,
      duplicates_dropped: dropDupes,
      sources: corpora.map(c => c.stats || {}),
    },
  };
}

module.exports = { loadCorpus, loadCorpusFromWorker, mergeCorpora, hasResults, mergeRaceCopies, normalizeEntriesRace, normalizeWorkerRace };
