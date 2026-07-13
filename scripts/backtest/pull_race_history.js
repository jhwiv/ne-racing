#!/usr/bin/env node
'use strict';

/**
 * pull_race_history.js — pull the server's real, already-archived race
 * results (RACE_HISTORY KV, written automatically by worker.js whenever any
 * client checks live results for an official race) into
 * data/normalized/{year}/{track}/{date}.json, the exact shape
 * scripts/backtest/load_corpus.js already reads as its highest-priority
 * source.
 *
 * Why this exists: this repo has never had a durable archive of real race
 * results on disk. RACE_HISTORY has been quietly accumulating them
 * server-side, but nothing ever pulled them down, so the backtest harness
 * has only ever measured against the placeholder synthetic fixture. This
 * closes that gap -- for dates where a local data/entries-{TRACK}-{DATE}.json
 * file also has real pre-race field data (horses), the two are merged so
 * the race is fully scoreable; for dates where only entries' `expertPicks`
 * exist (or no local entries file exists at all), the pulled race still
 * gets written with results only (still real, still useful for the
 * Analytics tab's race-results history, just not independently scoreable by
 * scoreRace() without pre-race data).
 *
 * Must be run somewhere with real network access to the worker -- this
 * repo's own CI sandbox has historically been network-restricted, so this
 * is designed to run from a GitHub Action (see
 * .github/workflows/pull-race-history.yml), not interactively here.
 *
 * Usage:
 *   node scripts/backtest/pull_race_history.js --track SAR [--from 2026-04-01] [--to 2026-12-31] [--worker-url https://...]
 */

const fs = require('fs');
const path = require('path');
const { loadCorpusFromWorker, loadCorpus, mergeRaceCopies } = require('./load_corpus');

const DEFAULT_WORKER_URL = 'https://cloudflare-worker.jhwiv-online.workers.dev';

function parseArgs(argv) {
  const out = { track: 'SAR', from: null, to: null, workerUrl: DEFAULT_WORKER_URL };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v.toUpperCase(); i++; }
    else if (k === '--from') { out.from = v; i++; }
    else if (k === '--to') { out.to = v; i++; }
    else if (k === '--worker-url') { out.workerUrl = v; i++; }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Pulling RACE_HISTORY for track=${args.track} from=${args.from || '(none)'} to=${args.to || '(none)'} ...`);

  const remote = await loadCorpusFromWorker({
    workerUrl: args.workerUrl,
    track: args.track,
    from: args.from,
    to: args.to,
  });

  if (remote.stats.error) {
    console.error(`Pull failed: ${remote.stats.error}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Pulled ${remote.races.length} races (${remote.stats.with_results} with real results) from RACE_HISTORY.`);
  if (!remote.races.length) {
    console.log('Nothing archived yet for this range -- nothing to write. This is expected if no client has ever checked live results for these dates while races were official.');
    return;
  }

  // Merge onto whatever local entries-file horses data exists for the same
  // race ids, so dates that DO have a real pre-race card become fully
  // scoreable, not just results-only.
  const { races: localRaces } = loadCorpus({ includeFixtures: false });

  // Write the FULL card for every date we pulled -- not just the races that
  // happened to have a remote result. A race with no result yet (or one
  // RACE_HISTORY never archived) still belongs in the file with its real
  // pre-race horses data; only races[].results should vary by whether we
  // actually have a result for that specific race.
  const datesPulled = new Set(remote.races.map(r => r.date));
  const byId = new Map();
  for (const r of localRaces) {
    if (datesPulled.has(r.date)) byId.set(r.id, r);
  }
  for (const r of remote.races) {
    const existingLocal = byId.get(r.id);
    byId.set(r.id, existingLocal ? mergeRaceCopies(existingLocal, r) : r);
  }
  const merged = Array.from(byId.values());

  const scoreableCount = merged.filter(r => (r.horses || []).length > 0 && r._hasResult).length;
  console.log(`${scoreableCount} of those are fully scoreable after merging with local entries data (have both horses and results).`);

  // Group by date, write one file per date under data/normalized/{year}/{track}/.
  const byDate = new Map();
  for (const r of merged) {
    if (!r.date) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    // Strip loader-added annotation fields before writing to disk.
    const { _src, _hasResult, ...clean } = r;
    byDate.get(r.date).push(clean);
  }

  let filesWritten = 0;
  for (const [date, races] of byDate) {
    const year = date.slice(0, 4);
    const dir = path.resolve(__dirname, '..', '..', 'data', 'normalized', year, args.track);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${date}.json`);
    fs.writeFileSync(outPath, JSON.stringify({
      track: args.track,
      date,
      source: 'RACE_HISTORY (worker.js), merged with local entries data where available',
      pulled_at: new Date().toISOString(),
      races,
    }, null, 2));
    filesWritten++;
  }
  console.log(`Wrote ${filesWritten} date file(s) under data/normalized/*/${args.track}/.`);
}

if (require.main === module) {
  // Explicit process.exit(): Node's fetch (undici) keeps an HTTP keep-alive
  // socket open by default, which prevents the event loop from ever going
  // idle on its own -- this CLI script would otherwise hang indefinitely
  // after finishing, never returning control to whatever invoked it
  // (confirmed: a GitHub Actions step would time out, and so did this
  // script's own test).
  main().then(() => process.exit(process.exitCode || 0))
        .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs };
