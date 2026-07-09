#!/usr/bin/env node
'use strict';

/**
 * fetch-nyra-expert-picks.js
 *
 * Scrapes NYRA's four public handicapper-picks pages for the Saratoga meet
 * (per docs/SARATOGA_NYRA.md) and publishes the results into
 * data/entries-SAR-{date}.json's per-race `expertPicks` field. That file is
 * served from GitHub Pages and is exactly what worker.js's
 * GET /api/expert-picks reads (handleExpertPicks, STATIC_ENTRIES_BASE) --
 * no worker changes needed, this just keeps that file's expertPicks fresh.
 *
 * Run manually first (--dry-run) before trusting the scheduled workflow:
 * NYRA's markup is not a documented, versioned contract, and this was
 * written without live network access to inspect the real pages, so the
 * parser (scripts/lib/nyra-picks-parser.js) needs a real-world check before
 * you rely on it unattended.
 *
 * Usage:
 *   node scripts/fetch-nyra-expert-picks.js [--track SAR] [--date YYYY-MM-DD] [--dry-run]
 *
 *   --dry-run   Fetch and parse, but don't write the entries file. Prints
 *               what would have been written and which parse strategy (or
 *               failure) each source hit.
 */

const fs = require('fs');
const path = require('path');
const { parseNyraPicksHtml } = require('./lib/nyra-picks-parser');

const DATA_DIR = path.join(__dirname, '..', 'data');
const WORKER_URL = process.env.RAILBIRD_WORKER_URL || 'https://cloudflare-worker.jhwiv-online.workers.dev';

// Per docs/SARATOGA_NYRA.md — four NYRA-official handicappers, refreshed
// every race day during the meet.
const SOURCES = [
  { label: 'NYRA - Serling', url: 'https://www.nyra.com/saratoga/racing/talking-horses/' },
  { label: 'NYRA - Aragona', url: 'https://www.nyra.com/saratoga/racing/timeformus/' },
  { label: 'NYRA - DeSantis', url: 'https://www.nyra.com/saratoga/racing/nyra-bets-picks/' },
  { label: 'NYRA - Vizcaya', url: 'https://www.nyra.com/saratoga/racing/nyra-picks/' },
];

function parseArgs(argv) {
  const args = { track: 'SAR', date: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--track') args.track = argv[++i];
    else if (argv[i] === '--date') args.date = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  if (!args.date) {
    args.date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  }
  return args;
}

async function fetchSource(source) {
  try {
    const res = await fetch(source.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RailbirdAI/1.0; +https://railbirdai.com)',
        Accept: 'text/html',
      },
    });
    if (!res.ok) {
      return { source, ok: false, reason: `HTTP ${res.status} ${res.statusText}` };
    }
    const html = await res.text();
    const result = parseNyraPicksHtml(html);
    return { source, ok: result.picks.length > 0, picks: result.picks, strategy: result.strategy, reason: result.reason };
  } catch (err) {
    return { source, ok: false, reason: err && err.message };
  }
}

/**
 * Discovers the real race numbers for the card via the already-deployed
 * worker's own entries endpoint, so this script doesn't have to guess how
 * many races NYRA is publishing picks for today.
 */
async function discoverRaceNumbers(track, date) {
  try {
    const res = await fetch(`${WORKER_URL}/api/entries?track=${encodeURIComponent(track)}&date=${encodeURIComponent(date)}`);
    if (!res.ok) return [];
    const body = await res.json();
    return (body.races || []).map((r) => r.raceNumber).filter((n) => Number.isFinite(n));
  } catch (err) {
    return [];
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const entriesPath = path.join(DATA_DIR, `entries-${args.track}-${args.date}.json`);

  const results = await Promise.all(SOURCES.map(fetchSource));

  console.log(`\n[fetch-nyra-expert-picks] ${args.track} ${args.date}`);
  results.forEach((r) => {
    if (r.ok) {
      console.log(`  ${r.source.label}: ${r.picks.length} pick(s) via "${r.strategy}"`);
    } else {
      console.log(`  ${r.source.label}: NO PICKS FOUND (${r.reason || 'unknown'}) -- ${r.source.url}`);
    }
  });

  const raceNumbers = new Set(await discoverRaceNumbers(args.track, args.date));
  results.forEach((r) => (r.picks || []).forEach((p) => raceNumbers.add(p.race)));

  if (!raceNumbers.size) {
    console.log('\nNo race numbers discovered (worker entries lookup failed and no source yielded any race number) -- nothing to write.');
    process.exitCode = 1;
    return;
  }

  // Build/refresh expertPicks per race. Existing non-NYRA-sourced picks (if
  // any future source is ever added) are preserved; only entries whose
  // source starts with "NYRA - " are replaced on each run so a scrape that
  // finds fewer picks this cycle doesn't leave stale duplicates from a
  // previous cycle.
  let existing = { track: args.track, date: args.date, races: [] };
  if (fs.existsSync(entriesPath)) {
    try { existing = JSON.parse(fs.readFileSync(entriesPath, 'utf8')); } catch (e) { /* start fresh */ }
  }
  const raceByNum = new Map();
  (existing.races || []).forEach((r) => raceByNum.set(r.race_number, r));

  Array.from(raceNumbers).sort((a, b) => a - b).forEach((num) => {
    if (!raceByNum.has(num)) raceByNum.set(num, { race_number: num, expertPicks: [] });
    const race = raceByNum.get(num);
    const kept = (race.expertPicks || []).filter((ep) => !String(ep.source || '').startsWith('NYRA - '));
    const fresh = [];
    results.forEach((r) => {
      const pick = (r.picks || []).find((p) => p.race === num);
      if (pick) fresh.push({ source: r.source.label, pick: pick.pick, horseName: pick.horseName });
    });
    race.expertPicks = kept.concat(fresh);
  });

  existing.track = args.track;
  existing.date = args.date;
  existing.races = Array.from(raceByNum.values()).sort((a, b) => a.race_number - b.race_number);
  existing.expertPicksLastUpdated = new Date().toISOString();

  const totalPicks = existing.races.reduce((s, r) => s + (r.expertPicks || []).filter((ep) => String(ep.source || '').startsWith('NYRA - ')).length, 0);
  console.log(`\n${totalPicks} NYRA pick(s) across ${existing.races.length} race(s).`);

  if (args.dryRun) {
    console.log('\n--dry-run: not writing. Would have written:', entriesPath);
    console.log(JSON.stringify(existing, null, 2));
    return;
  }

  fs.writeFileSync(entriesPath, JSON.stringify(existing, null, 2) + '\n');
  console.log(`Wrote ${entriesPath}`);
}

main().catch((err) => {
  console.error('[fetch-nyra-expert-picks] fatal:', err);
  process.exitCode = 1;
});
