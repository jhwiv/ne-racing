#!/usr/bin/env node
'use strict';

/**
 * build_2023_corpus.js — merges parsed Equibase PP files (pre-race horses
 * data) with parsed result-chart files (real outcomes) into
 * data/normalized/2023/{track}/{date}.json, the exact shape
 * scripts/backtest/load_corpus.js already reads as its highest-priority
 * source.
 *
 * Two things this does that a naive per-file merge would get wrong,
 * confirmed against real data before writing any of this:
 *
 * 1. The result chart, not the PP file, is the authority on who actually
 *    started. A horse can be an active, unscratched entrant in the PP file
 *    and still be scratched by post time (confirmed: "Toned Up",
 *    2023-07-13 race 1, present in the PP file, absent from the chart's
 *    finishers, listed under the chart's own <SCRATCH>). Any PP horse whose
 *    pp isn't in the chart's actualStarterPps is dropped, not scored.
 *
 * 2. Jockey/trainer win % isn't in either source file. This schema has no
 *    jockey/trainer aggregate-stats field anywhere (confirmed by direct
 *    inspection), unlike Brisnet's PP format. Computed here as a genuine
 *    walk-forward rolling win rate from the corpus's OWN real results --
 *    processing races in chronological order and crediting each
 *    jockey/trainer's record only from races strictly BEFORE the one being
 *    scored, so a horse's connections stats never see that horse's own
 *    race or any future race. Not fabricated, not looked up externally.
 *
 * Usage:
 *   node scripts/ingest/build_2023_corpus.js --pps-dir <dir> --charts-dir <dir> --track SAR
 *
 * <pps-dir> should contain the extracted SIMD{date}{track}_USA.xml files;
 * <charts-dir> should contain the {track}{date}tch.xml files. Both
 * directories are scanned non-recursively. A date present in only one
 * directory is still written (horses-only or results-only), matching
 * pull_race_history.js's existing "write what we have" convention.
 */

const fs = require('fs');
const path = require('path');
const { parseEquibasePP } = require('./parse_equibase_pp');
const { parseEquibaseChart } = require('./parse_equibase_chart');

function parseArgs(argv) {
  const out = { ppsDir: null, chartsDir: null, track: 'SAR' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--pps-dir') { out.ppsDir = v; i++; }
    else if (k === '--charts-dir') { out.chartsDir = v; i++; }
    else if (k === '--track') { out.track = v.toUpperCase(); i++; }
  }
  return out;
}

/** SIMD20230713SAR_USA.xml -> '2023-07-13'. Returns null if it doesn't match. */
function dateFromPpFilename(name, track) {
  const m = name.match(new RegExp(`^SIMD(\\d{4})(\\d{2})(\\d{2})${track}_USA\\.xml$`, 'i'));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** sar20230713tch.xml -> '2023-07-13'. Returns null if it doesn't match. */
function dateFromChartFilename(name, track) {
  const m = name.match(new RegExp(`^${track}(\\d{4})(\\d{2})(\\d{2})tch\\.xml$`, 'i'));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function loadPpFiles(dir, track) {
  const byDate = new Map();
  if (!dir || !fs.existsSync(dir)) return byDate;
  for (const name of fs.readdirSync(dir)) {
    const date = dateFromPpFilename(name, track);
    if (!date) continue;
    const xml = fs.readFileSync(path.join(dir, name), 'utf8');
    byDate.set(date, parseEquibasePP(xml, track, date));
  }
  return byDate;
}

function loadChartFiles(dir, track) {
  const byDate = new Map();
  if (!dir || !fs.existsSync(dir)) return byDate;
  for (const name of fs.readdirSync(dir)) {
    const date = dateFromChartFilename(name, track);
    if (!date) continue;
    const xml = fs.readFileSync(path.join(dir, name), 'utf8');
    byDate.set(date, parseEquibaseChart(xml, track, date));
  }
  return byDate;
}

/**
 * Attaches walk-forward jockeyPct/trainerPct to every horse across every
 * race, processing dates in chronological order. A connection's percentage
 * as-of a given race reflects only races on strictly earlier dates in this
 * same corpus (same-day races are NOT included in each other's stats, since
 * their relative order within a day isn't meaningfully "earlier/later" here
 * and results across a whole card typically post together).
 *
 * Returns void; mutates each horse in place (adds jockeyPct/trainerPct,
 * both null until at least one prior start exists for that connection).
 */
function attachRollingConnectionsStats(datedRaces) {
  const jockeyRecord = new Map(); // id -> {starts, wins}
  const trainerRecord = new Map();
  const pct = rec => (rec && rec.starts > 0 ? Math.round((rec.wins / rec.starts) * 100) : null);

  const sortedDates = [...datedRaces.keys()].sort();
  for (const date of sortedDates) {
    const races = datedRaces.get(date);
    // Assign this date's percentages from stats accumulated over all
    // strictly-earlier dates, before any of today's results are folded in.
    for (const race of races) {
      for (const horse of race.horses) {
        horse.jockeyPct = horse.jockeyId ? pct(jockeyRecord.get(horse.jockeyId)) : null;
        horse.trainerPct = horse.trainerId ? pct(trainerRecord.get(horse.trainerId)) : null;
      }
    }
    // Now fold today's real results into the running record for future dates.
    for (const race of races) {
      if (!race.results) continue;
      const winnerPp = (race.results.finish_positions.find(f => f.position === 1) || {}).pp;
      for (const horse of race.horses) {
        const won = horse.pp === winnerPp;
        if (horse.jockeyId) {
          const rec = jockeyRecord.get(horse.jockeyId) || { starts: 0, wins: 0 };
          rec.starts++; if (won) rec.wins++;
          jockeyRecord.set(horse.jockeyId, rec);
        }
        if (horse.trainerId) {
          const rec = trainerRecord.get(horse.trainerId) || { starts: 0, wins: 0 };
          rec.starts++; if (won) rec.wins++;
          trainerRecord.set(horse.trainerId, rec);
        }
      }
    }
  }
}

function mergeDate(track, date, ppDoc, chartDoc) {
  const races = [];
  const ppByNum = new Map((ppDoc ? ppDoc.races : []).map(r => [r.num, r]));
  const chartByNum = new Map((chartDoc ? chartDoc.races : []).map(r => [r.num, r]));
  const nums = new Set([...ppByNum.keys(), ...chartByNum.keys()]);

  for (const num of nums) {
    const ppRace = ppByNum.get(num);
    const chartRace = chartByNum.get(num);
    let horses = ppRace ? ppRace.horses : [];
    // Chart is authoritative on who actually started -- see file header.
    if (chartRace) {
      horses = horses.filter(h => chartRace.actualStarterPps.has(h.pp));
      // Fall back to the chart's closing odds only for a horse the PP file
      // had no morning line for at all (ml missing/empty) -- the PP file's
      // real morning line otherwise always wins.
      horses.forEach(h => {
        if (!h.ml && chartRace.closingOdds && chartRace.closingOdds[h.pp]) h.ml = chartRace.closingOdds[h.pp];
      });
    }
    races.push({
      id: `${track}-${date.replace(/-/g, '')}-R${num}`,
      track, date, num,
      type: ppRace ? ppRace.type : null,
      horses,
      expertPicks: [],
      results: chartRace ? chartRace.results : undefined,
    });
  }
  races.sort((a, b) => a.num - b.num);
  return races;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.ppsDir && !args.chartsDir) {
    console.error('At least one of --pps-dir / --charts-dir is required.');
    process.exit(1);
  }

  const ppByDate = loadPpFiles(args.ppsDir, args.track);
  const chartByDate = loadChartFiles(args.chartsDir, args.track);
  const allDates = new Set([...ppByDate.keys(), ...chartByDate.keys()]);

  console.log(`PP files found: ${ppByDate.size}. Chart files found: ${chartByDate.size}. Union: ${allDates.size} date(s).`);

  const datedRaces = new Map();
  for (const date of allDates) {
    datedRaces.set(date, mergeDate(args.track, date, ppByDate.get(date), chartByDate.get(date)));
  }

  attachRollingConnectionsStats(datedRaces);

  let filesWritten = 0, scoreableRaces = 0, resultBearingRaces = 0;
  for (const [date, races] of datedRaces) {
    const year = date.slice(0, 4);
    const dir = path.resolve(__dirname, '..', '..', 'data', 'normalized', year, args.track);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${date}.json`), JSON.stringify({
      track: args.track, date,
      source: 'Equibase EntryRaceCard (PPs) + Equibase result chart, merged by build_2023_corpus.js',
      built_at: new Date().toISOString(),
      races,
    }, null, 2));
    filesWritten++;
    for (const r of races) {
      if (r.horses.length > 0) scoreableRaces++;
      if (r.results) resultBearingRaces++;
    }
  }

  console.log(`Wrote ${filesWritten} date file(s) under data/normalized/*/${args.track}/.`);
  console.log(`${scoreableRaces} race(s) have horses data, ${resultBearingRaces} have results.`);
}

if (require.main === module) main();

module.exports = { parseArgs, dateFromPpFilename, dateFromChartFilename, mergeDate, attachRollingConnectionsStats };
