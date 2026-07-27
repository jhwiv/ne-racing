#!/usr/bin/env node
'use strict';

/**
 * parse_equibase_chart.js — parses one Equibase/Trackmaster result-chart XML
 * file (the "2023 Result Charts" dataset, filename pattern
 * {track}{YYYYMMDD}tch.xml) into the results shape
 * scripts/backtest/load_corpus.js and metrics.js expect.
 *
 * Verified field-by-field against a real sample (sar20230713tch.xml):
 * DOLLAR_ODDS and WIN_PAYOFF/PLACE_PAYOFF/SHOW_PAYOFF are real $2-mutuel
 * figures -- confirmed the exact payout formula (2 * (1 + odds)) against
 * Bustin Bay's real 1.70-to-1 / $5.40 win line before trusting this data at
 * all. PROGRAM_NUM here is the same "pp" scoring.js/metrics.js already use.
 *
 * This file is the RESULTS side only. It is also the authority on who
 * actually raced: build_2023_corpus.js must use THIS file's field (not the
 * PP file's) to decide which horses actually started, because a horse can
 * appear as an active entrant in the pre-race PP file and still end up
 * scratched by post time -- confirmed happening for real ("Toned Up",
 * 2023-07-13 race 1: present and unscratched in the PP file, listed under
 * <SCRATCH> here).
 */

const fs = require('fs');
const { parseXml, child, children, childText } = require('./lib/tiny_xml_parser');

function parseOneEntry(entryEl) {
  const pp = parseInt(childText(entryEl, 'PROGRAM_NUM'), 10) || null;
  const name = childText(entryEl, 'NAME');
  const finRaw = childText(entryEl, 'OFFICIAL_FIN');
  const position = finRaw != null && finRaw !== '' ? parseInt(finRaw, 10) : null;
  const winPayoff = parseFloat(childText(entryEl, 'WIN_PAYOFF'));
  const ml = childText(entryEl, 'DOLLAR_ODDS'); // closing odds, plain "X-to-1" decimal -- parseOddsToNum-compatible as-is
  return {
    pp, name, position,
    win_payout: Number.isFinite(winPayoff) && winPayoff > 0 ? winPayoff : undefined,
    dollarOdds: ml,
  };
}

function parseOneWager(wagerEl) {
  const type = (childText(wagerEl, 'WAGER_TYPE') || '').toLowerCase();
  const payoff = parseFloat(childText(wagerEl, 'PAYOFF'));
  const winners = (childText(wagerEl, 'WINNERS') || '').trim(); // e.g. "5-1-2"
  return { type, payout: Number.isFinite(payoff) ? payoff : null, winners };
}

/**
 * Parses one chart XML file into { track, date, races: [...] }.
 * Track and date are read directly from the file's own <TRACK><CODE> and
 * the root <CHART RACE_DATE="..."> attribute -- unlike the PP file, this
 * schema is self-describing and doesn't need them passed in, though a
 * caller-supplied override is honored if given (defends against a
 * mislabeled/corrupt file silently writing to the wrong date).
 */
function parseEquibaseChart(xmlContent, trackOverride, dateOverride) {
  const root = parseXml(xmlContent);
  const trackEl = child(root, 'TRACK');
  const track = trackOverride || (trackEl ? childText(trackEl, 'CODE') : null);
  const date = dateOverride || root.attrs.RACE_DATE;
  if (!track || !date) throw new Error('parse_equibase_chart: could not determine track/date from file content or arguments');

  const raceEls = children(root, 'RACE');
  const races = raceEls.map(raceEl => {
    const num = parseInt(raceEl.attrs.NUMBER, 10);
    const entries = children(raceEl, 'ENTRY').map(parseOneEntry);
    const winner = entries.find(e => e.position === 1);
    const finish_positions = entries
      .filter(e => e.position != null && e.position > 0)
      .map(e => ({ pp: e.pp, horseName: e.name, position: e.position, win_payout: e.win_payout }));

    const wagerEls = [];
    const exoticWagersEl = child(raceEl, 'EXOTIC_WAGERS');
    if (exoticWagersEl) wagerEls.push(...children(exoticWagersEl, 'WAGER').map(parseOneWager));
    const exotics = wagerEls
      .filter(w => w.payout != null)
      .map(w => ({ type: w.type, payout: w.payout, winners: w.winners }));

    return {
      id: `${track}-${date.replace(/-/g, '')}-R${num}`,
      track, date, num,
      results: finish_positions.length ? { finish_positions, exotics } : undefined,
      // Closing odds per horse, keyed by pp -- build_2023_corpus.js uses
      // this only as a fallback when the PP file's morning line is missing
      // for a given horse (e.g. a late scratch/also-eligible not in the PP
      // file at all); the PP file's own <Odds> (real morning line) wins
      // when both are present, since scoring.js's "ml" field is meant to
      // represent the pre-race line, not the closing price.
      closingOdds: Object.fromEntries(entries.filter(e => e.pp != null).map(e => [e.pp, e.dollarOdds])),
      actualStarterPps: new Set(entries.map(e => e.pp).filter(pp => pp != null)),
    };
  });
  return { track, date, races };
}

function main() {
  const fileArg = process.argv[2];
  if (!fileArg) {
    console.error('Usage: node scripts/ingest/parse_equibase_chart.js <path-to-chart.xml> [TRACK] [YYYY-MM-DD]');
    process.exit(1);
  }
  const xml = fs.readFileSync(fileArg, 'utf8');
  const result = parseEquibaseChart(xml, process.argv[3], process.argv[4]);
  // Sets don't JSON.stringify usefully -- convert for the CLI printer only.
  const printable = { ...result, races: result.races.map(r => ({ ...r, actualStarterPps: [...r.actualStarterPps] })) };
  console.log(JSON.stringify(printable, null, 2));
}

if (require.main === module) main();

module.exports = { parseEquibaseChart };
