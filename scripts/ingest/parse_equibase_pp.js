#!/usr/bin/env node
'use strict';

/**
 * parse_equibase_pp.js — parses one Equibase "EntryRaceCard" simulcast XML
 * file (the "2023 PPs" dataset the owner provided, format
 * SIMD{YYYYMMDD}{TRACK}_USA.zip → one .xml per date) into the race/horses
 * shape scripts/backtest/load_corpus.js and scripts/lib/scoring.js expect.
 *
 * This is a genuine past-performance file (pre-race only -- no same-day
 * results), verified field-by-field against a real sample
 * (SIMD20230713SAR_USA.xml) cross-checked against the matching real result
 * chart (sar20230713tch.xml) for the same horse/race: program numbers,
 * jockey/trainer, and morning-line-vs-closing-odds all lined up exactly.
 *
 * What this file has that ENTRIES_R2 (the live-data backtest source) does
 * NOT: multiple past starts per horse with real speed figures, real point-
 * of-call running lines, and a real last-race date -- closing the exact
 * gaps flagged in the 2026-07-25 backtest report (Bias and Freshness were
 * constant/non-discriminating for every horse because the live snapshot
 * carries neither track-bias context nor lastRaceDate).
 *
 * What it does NOT have: jockey/trainer meet win %. Unlike Brisnet's PP
 * format (see tools/parse-brisnet.js), there is no per-jockey/trainer
 * aggregate stats field anywhere in this schema (confirmed by grepping the
 * full file for Jockey/Trainer-adjacent Wins/Starts elements -- none
 * exist). scripts/ingest/build_2023_corpus.js computes this itself as a
 * walk-forward rolling win rate from the corpus's own real results, using
 * only strictly-earlier races -- not fabricated, not looked up externally.
 *
 * Running style is not a labeled code here either -- derived from each
 * horse's most recent past performance's point-of-call position relative
 * to field size (see classifyRunningStyle below). This is an approximation
 * documented in code, not a guess presented as fact.
 */

const fs = require('fs');
const { parseXml, child, children, childText } = require('./lib/tiny_xml_parser');

// Direct-match codes this schema's <RaceType><RaceType> already uses that
// line up with scoring.js's CLASS_SCALE keys one-for-one -- no fuzzy text
// matching needed the way the result-chart's verbose TYPE field requires.
// 'STR' (Starter Allowance) has no exact CLASS_SCALE key; scoring.js's own
// classValueFor() falls back to 40 for anything unrecognized, same as it
// already does for any other unmapped code.
function classCodeFor(raceTypeCode, grade) {
  if (raceTypeCode === 'STK') {
    const g = String(grade || '').trim();
    if (g === '1' || g === '2' || g === '3') return 'STK-G' + g;
    return 'STK-L'; // ungraded stakes
  }
  return raceTypeCode || null;
}

/**
 * Approximate running style from a single past-performance's point-of-call
 * positions. Prefers the first "quarter-ish" call (label "1"); falls back
 * to the start call ("S") when call "1" is absent or unrecorded (position
 * 0, which this schema uses for "not applicable at this distance").
 * Returns one of 'E'/'EP'/'P'/'S'/'SS', or null when no usable call exists.
 *
 * Thresholds are a simple, documented heuristic (early position as a
 * fraction of field size), not a proprietary formula -- treat style values
 * derived this way as directional, not authoritative.
 */
function classifyRunningStyle(startEl, numStarters) {
  if (!startEl || !numStarters) return null;
  const calls = children(startEl, 'PointOfCall');
  const byLabel = {};
  for (const c of calls) {
    const label = childText(c, 'PointOfCall');
    const pos = parseInt(childText(c, 'Position'), 10);
    if (label != null) byLabel[label] = Number.isFinite(pos) ? pos : 0;
  }
  const pos = (byLabel['1'] > 0) ? byLabel['1'] : (byLabel['S'] > 0 ? byLabel['S'] : 0);
  if (!pos) return null;
  const frac = pos / numStarters;
  if (frac <= 0.2) return 'E';
  if (frac <= 0.4) return 'EP';
  if (frac <= 0.6) return 'P';
  if (frac <= 0.8) return 'S';
  return 'SS';
}

function parseOneStarter(starterEl) {
  const horseEl = child(starterEl, 'Horse');
  const name = childText(horseEl, 'HorseName');
  const pp = parseInt(childText(starterEl, 'ProgramNumber'), 10) || null;
  const ml = childText(starterEl, 'Odds'); // e.g. "3/1" -- already parseOddsToNum-compatible
  const weight = parseInt(childText(starterEl, 'WeightCarried'), 10) || null;
  const scratched = childText(child(starterEl, 'ScratchIndicator'), 'Value') === 'Y';
  const equipmentNow = childText(child(starterEl, 'Equipment'), 'Value') || '';

  const jockeyEl = child(starterEl, 'Jockey');
  const trainerEl = child(starterEl, 'Trainer');
  const jockeyId = jockeyEl ? childText(jockeyEl, 'ExternalPartyId') : null;
  const trainerId = trainerEl ? childText(trainerEl, 'ExternalPartyId') : null;
  const jockeyName = jockeyEl ? [childText(jockeyEl, 'FirstName'), childText(jockeyEl, 'LastName')].filter(Boolean).join(' ') : null;
  const trainerName = trainerEl ? [childText(trainerEl, 'FirstName'), childText(trainerEl, 'LastName')].filter(Boolean).join(' ') : null;

  const pastPerfs = children(starterEl, 'PastPerformance');
  // Confirmed via real sample (Mia Bea Star, 10 PPs): index 0 is the MOST
  // RECENT past race, descending chronologically -- NOT oldest-first.
  const speedFigsRecentFirst = [];
  for (const pp0 of pastPerfs) {
    const startEl = child(pp0, 'Start');
    const figRaw = startEl ? childText(startEl, 'SpeedFigure') : null;
    const fig = figRaw != null && figRaw !== '' ? parseInt(figRaw, 10) / 10 : null;
    speedFigsRecentFirst.push(fig);
    if (speedFigsRecentFirst.length >= 3) break;
  }
  // scoring.js convention: speedFigs[length-1] is the latest -- reverse to
  // oldest-first, matching tools/parse-brisnet.js's own convention exactly.
  const speedFigs = speedFigsRecentFirst.slice().reverse();
  while (speedFigs.length < 3) speedFigs.unshift(null);

  const mostRecentPP = pastPerfs[0] || null;
  const lastClass = mostRecentPP ? classCodeFor(childText(child(mostRecentPP, 'RaceType'), 'RaceType'), childText(mostRecentPP, 'Grade')) : null;
  const lastRaceDateRaw = mostRecentPP ? childText(mostRecentPP, 'RaceDate') : null; // "2023-07-02+00:00"
  const lastRaceDate = lastRaceDateRaw ? lastRaceDateRaw.slice(0, 10) : null;
  const mostRecentStart = mostRecentPP ? child(mostRecentPP, 'Start') : null;
  const numStartersLastRace = mostRecentPP ? parseInt(childText(mostRecentPP, 'NumberOfStarters'), 10) : null;
  const runningStyle = classifyRunningStyle(mostRecentStart, numStartersLastRace);

  const equipmentBefore = mostRecentStart ? (childText(child(mostRecentStart, 'Equipment'), 'Value') || '') : '';
  const equipmentChanges = !!equipmentNow && equipmentNow !== equipmentBefore;

  return {
    pp, name, ml, weight, scratched, equipmentChanges,
    jockey: jockeyName, jockeyId,
    trainer: trainerName, trainerId,
    speedFigs, lastClass, lastRaceDate, runningStyle,
    // jockeyPct/trainerPct deliberately absent here -- see file header;
    // build_2023_corpus.js fills these in from the corpus's own history.
  };
}

/**
 * Parses one EntryRaceCard XML file (already extracted from its
 * SIMD{date}{track}_USA.zip) into { track, date, races: [...] }.
 * `track`/`date` are supplied by the caller (not reliably derivable from
 * the XML content alone) -- pass the values encoded in the source filename.
 */
function parseEquibasePP(xmlContent, track, date) {
  const root = parseXml(xmlContent);
  const raceEls = children(root, 'Race');
  const races = raceEls.map(raceEl => {
    const num = parseInt(childText(raceEl, 'RaceNumber'), 10);
    const typeCode = classCodeFor(childText(child(raceEl, 'RaceType'), 'RaceType'), childText(raceEl, 'Grade'));
    const starters = children(raceEl, 'Starters').map(parseOneStarter).filter(h => !h.scratched);
    return {
      id: `${track}-${date.replace(/-/g, '')}-R${num}`,
      track, date, num,
      type: typeCode,
      horses: starters,
      expertPicks: [],
    };
  });
  return { track, date, races };
}

function main() {
  const args = process.argv.slice(2);
  const fileArg = args[0];
  if (!fileArg) {
    console.error('Usage: node scripts/ingest/parse_equibase_pp.js <path-to-SIMD*.xml> <TRACK> <YYYY-MM-DD>');
    process.exit(1);
  }
  const track = args[1] || 'SAR';
  const date = args[2];
  if (!date) { console.error('Third argument (YYYY-MM-DD date) is required.'); process.exit(1); }
  const xml = fs.readFileSync(fileArg, 'utf8');
  const result = parseEquibasePP(xml, track, date);
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main();

module.exports = { parseEquibasePP, classCodeFor, classifyRunningStyle };
