#!/usr/bin/env node
'use strict';

/**
 * pull_entries_history.js — merges real pre-race horses data (speed figs,
 * running style, jockey/trainer %, last class, ML odds) onto the
 * results-only data/normalized/{year}/{track}/{date}.json files that
 * pull_race_history.js already writes, so the backtest harness can actually
 * score real historical races instead of finding horses:[] for every date.
 *
 * Why this exists: the daily-entries pipeline that used to write
 * data/entries-{TRACK}-{DATE}.json WITH horses data was disabled; every
 * entries file since then carries only expertPicks (see
 * load_corpus.js:normalizeEntriesRace's own comment on this). As a result,
 * pull_race_history.js's merge step has had nothing but empty horses:[] to
 * offer for any date after 2026-07-03 -- every race in the on-disk corpus
 * has been unscoreable, and the backtest harness has never actually
 * measured a single real historical race. ENTRIES_R2 has been quietly
 * mirroring one full entries snapshot per (track,date) since v2.47.0
 * (2026-06-05) and never deletes it -- this pulls that mirror down using
 * the exact same fetchEntries()/transformEntriesToRaces() machinery already
 * proven in backfill_control_history.js and daily_pick_log.js, so this is
 * not a new, parallel data path.
 *
 * Must run with real network access (GitHub Actions) -- see
 * .github/workflows/pull-entries-history.yml. Idempotent: re-running for an
 * already-pulled date just overwrites that date's file with the same data.
 *
 * Usage:
 *   node scripts/backtest/pull_entries_history.js --track SAR [--from 2026-06-05] [--to 2026-07-25] [--worker-url https://...]
 */

const fs = require('fs');
const path = require('path');
const { transformEntriesToRaces } = require('../daily_pick_log');
const { fetchEntries, dateRange } = require('../backfill_control_history');
const { loadCorpus, mergeRaceCopies } = require('./load_corpus');

const DEFAULT_WORKER_URL = 'https://cloudflare-worker.jhwiv-online.workers.dev';
// Earliest date the R2 entries mirror could possibly have anything -- see
// backfill_control_history.js's own header for why.
const EARLIEST_POSSIBLE_DATE = '2026-06-05';

function parseArgs(argv) {
  const out = { track: 'SAR', from: null, to: null, workerUrl: DEFAULT_WORKER_URL };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v.toUpperCase(); i++; }
    else if (k === '--from') { out.from = v; i++; }
    else if (k === '--to') { out.to = v; i++; }
    else if (k === '--worker-url') { out.workerUrl = v; i++; }
  }
  if (!out.from) out.from = EARLIEST_POSSIBLE_DATE;
  if (!out.to) out.to = new Date().toISOString().slice(0, 10);
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Pulling ENTRIES_R2 horses data for track=${args.track}, ${args.from}..${args.to} ...`);

  const dates = dateRange(args.from, args.to);
  const { races: localRaces } = loadCorpus({ includeFixtures: false });
  const localById = new Map(localRaces.map(r => [r.id, r]));

  let datesWithEntries = 0, datesSkipped = 0, racesMerged = 0;
  const touchedDates = new Set();

  for (const date of dates) {
    const entriesBody = await fetchEntries(args.workerUrl, args.track, date);
    if (!entriesBody) { datesSkipped++; continue; }
    datesWithEntries++;

    const entryRaces = transformEntriesToRaces(entriesBody, args.track, date);
    for (const er of entryRaces) {
      if (!er.horses || !er.horses.length) continue;
      const existing = localById.get(er.id);
      const merged = existing ? mergeRaceCopies(existing, Object.assign({}, er, { _hasResult: false })) : Object.assign({}, er, { _hasResult: false });
      localById.set(er.id, merged);
      touchedDates.add(date);
      racesMerged++;
    }
  }

  console.log(`Fetched entries for ${datesWithEntries} date(s), ${datesSkipped} had nothing available.`);
  console.log(`Merged real horses data onto ${racesMerged} race(s) across ${touchedDates.size} date(s).`);

  if (!racesMerged) {
    console.log('Nothing to write -- no dates in range had both an entries snapshot and a local race to merge onto.');
    return;
  }

  // Write back one file per touched date, same shape/location load_corpus.js
  // already reads. Only rewrite dates we actually touched -- leave everything
  // else on disk untouched.
  const byDate = new Map();
  for (const r of localById.values()) {
    if (!touchedDates.has(r.date)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    const { _src, _hasResult, ...clean } = r;
    byDate.get(r.date).push(clean);
  }

  let filesWritten = 0;
  for (const [date, races] of byDate) {
    const year = date.slice(0, 4);
    const dir = path.resolve(__dirname, '..', '..', 'data', 'normalized', year, args.track);
    fs.mkdirSync(dir, { recursive: true });
    const outPath = path.join(dir, `${date}.json`);
    races.sort((a, b) => (a.num || 0) - (b.num || 0));
    fs.writeFileSync(outPath, JSON.stringify({
      track: args.track,
      date,
      source: 'RACE_HISTORY + ENTRIES_R2 (worker.js), merged by pull_entries_history.js',
      pulled_at: new Date().toISOString(),
      races,
    }, null, 2));
    filesWritten++;
  }
  console.log(`Wrote ${filesWritten} date file(s) under data/normalized/*/${args.track}/.`);
}

if (require.main === module) {
  // Same explicit process.exit() as pull_race_history.js -- Node's fetch
  // keeps a keep-alive socket open, which would otherwise hang this script
  // (and any CI step running it) indefinitely after main() resolves.
  main().then(() => process.exit(process.exitCode || 0))
        .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs };
