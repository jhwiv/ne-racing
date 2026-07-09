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
//
// Live-checked 2026-07-09 (see CHANGELOG.md v2.49.27):
//   - talking-horses/ : WORKS. Confirmed a multi-panelist page (Andy
//     Serling plus guest handicappers like Megan Burgess), not just
//     Serling alone -- each named panelist is attributed individually via
//     scripts/lib/nyra-picks-parser.js's handicapper-panel strategy.
//   - timeformus/     : CONFIRMED DEAD, not a scraping bug -- the page's
//     own text says "David Aragona is no longer posting TimeformUS
//     analysis on NYRA.com." Disabled below; re-enable only if NYRA starts
//     publishing a replacement TimeformUS analysis page.
//   - nyra-bets-picks/, nyra-picks/ : 404 on both. URLs from the original
//     docs/SARATOGA_NYRA.md scaffolding are stale/wrong; the real current
//     URLs need to be found (this script can't discover them itself).
//     Disabled below rather than hitting a known 404 every scheduled run.
const SOURCES = [
  { label: 'NYRA Talking Horses', url: 'https://www.nyra.com/saratoga/racing/talking-horses/' },
  // { label: 'NYRA - Aragona', url: 'https://www.nyra.com/saratoga/racing/timeformus/' }, // DEAD: discontinued per the page itself
  // { label: 'NYRA - DeSantis', url: 'https://www.nyra.com/saratoga/racing/nyra-bets-picks/' }, // 404: needs correct URL
  // { label: 'NYRA - Vizcaya', url: 'https://www.nyra.com/saratoga/racing/nyra-picks/' }, // 404: needs correct URL
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
    // Debug aid: when NYRA_DEBUG_DIR is set (workflow diagnostic run only,
    // never the scheduled job), dump the raw HTML as a file AND print a
    // bounded diagnostic straight to stdout. The artifact upload requires
    // downloading from external blob storage to inspect, which isn't always
    // reachable -- printing to the job log (fetched via the GitHub API,
    // which is reachable) is the fallback that doesn't depend on that.
    if (process.env.NYRA_DEBUG_DIR) {
      try {
        const slug = source.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        fs.mkdirSync(process.env.NYRA_DEBUG_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.env.NYRA_DEBUG_DIR, `${slug}.html`), html);
      } catch (e) { /* best-effort only */ }
      try {
        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const hasNextData = /__NEXT_DATA__/.test(html);
        const jsonScriptCount = (html.match(/<script[^>]+type=["']application\/json["']/gi) || []).length;
        const visibleText = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        console.log(`\n  --- DEBUG: ${source.label} (${source.url}) ---`);
        console.log(`  html length: ${html.length}, visible text length: ${visibleText.length}`);
        console.log(`  <title>: ${titleMatch ? titleMatch[1].trim() : '(none found)'}`);
        console.log(`  has __NEXT_DATA__: ${hasNextData}`);
        console.log(`  application/json <script> blocks: ${jsonScriptCount}`);
        // Look for "Race N" ANYWHERE in the visible text, not just the start
        // -- the page header/nav can run long before any real picks content.
        const raceMentions = [];
        const raceMentionRe = /\bRace\s*#?\s*\d{1,2}\b/gi;
        let rm;
        while ((rm = raceMentionRe.exec(visibleText)) !== null && raceMentions.length < 5) {
          raceMentions.push(rm.index);
        }
        if (raceMentions.length) {
          console.log(`  "Race N" mentions found at ${raceMentions.length} location(s) in visible text:`);
          raceMentions.forEach((idx) => {
            console.log(`    ...${visibleText.slice(Math.max(0, idx - 40), idx + 250)}...`);
          });
        } else {
          console.log(`  no "Race N" mentions anywhere in visible text (checked all ${visibleText.length} chars) -- first 1500 chars shown below for context:`);
          console.log(`  ${visibleText.slice(0, 1500)}`);
        }
      } catch (e) { /* best-effort only */ }
    }
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

  // Build/refresh expertPicks per race. Existing non-pipeline picks (if any
  // future source is ever added by hand) are preserved; only entries this
  // script itself wrote (tagged `_nyraPipeline: true`) are replaced each run
  // so a scrape that finds fewer picks this cycle doesn't leave stale
  // duplicates from a previous cycle. Tagged by a marker field rather than a
  // `source` string prefix because a single URL can now yield MULTIPLE
  // independently-named picks (one per panelist on a multi-handicapper page
  // like Talking Horses), not just one fixed label per source.
  let existing = { track: args.track, date: args.date, races: [] };
  if (fs.existsSync(entriesPath)) {
    try { existing = JSON.parse(fs.readFileSync(entriesPath, 'utf8')); } catch (e) { /* start fresh */ }
  }
  const raceByNum = new Map();
  (existing.races || []).forEach((r) => raceByNum.set(r.race_number, r));

  Array.from(raceNumbers).sort((a, b) => a - b).forEach((num) => {
    if (!raceByNum.has(num)) raceByNum.set(num, { race_number: num, expertPicks: [] });
    const race = raceByNum.get(num);
    const kept = (race.expertPicks || []).filter((ep) => !ep._nyraPipeline);
    const fresh = [];
    results.forEach((r) => {
      (r.picks || []).filter((p) => p.race === num).forEach((pick) => {
        fresh.push({
          source: pick.source || r.source.label,
          pick: pick.pick,
          horseName: pick.horseName,
          _nyraPipeline: true,
        });
      });
    });
    race.expertPicks = kept.concat(fresh);
  });

  existing.track = args.track;
  existing.date = args.date;
  existing.races = Array.from(raceByNum.values()).sort((a, b) => a.race_number - b.race_number);
  existing.expertPicksLastUpdated = new Date().toISOString();

  const totalPicks = existing.races.reduce((s, r) => s + (r.expertPicks || []).filter((ep) => ep._nyraPipeline).length, 0);
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
