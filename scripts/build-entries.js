#!/usr/bin/env node
'use strict';

/**
 * build-entries.js
 *
 * Daily data pipeline for NE Racing.
 * Fetches NYRA race entries, enriches them with jockey/trainer stats and
 * running-style heuristics, and writes an entries JSON file to data/.
 *
 * No external npm dependencies -- uses only Node.js built-ins.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NYRA_BASE = process.env.NYRA_BASE || 'https://www.nyra.com';
const DATA_DIR = path.join(__dirname, '..', 'data');

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Simple promisified GET that follows redirects (up to 5). */
function fetch(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'NERacing-Pipeline/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'));
        const next = new URL(res.headers.location, url).href;
        return resolve(fetch(next, maxRedirects - 1));
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/** Read a JSON file from the data directory. Returns null on any failure. */
function readDataJson(filename) {
  try {
    const fp = path.join(DATA_DIR, filename);
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch (err) {
    console.warn(`  Warning: could not read ${filename}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Date & track helpers
// ---------------------------------------------------------------------------

/** Get today's date parts in ET (UTC-4 / UTC-5 depending on DST). */
function todayET() {
  // Use Intl to get the date in America/New_York
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const str = fmt.format(new Date()); // "YYYY-MM-DD"
  const [y, m, d] = str.split('-').map(Number);
  return { year: y, month: m, day: d, iso: str };
}

/**
 * Determine the next race date.
 * First tries to discover actual race dates from the NYRA HTMX endpoint,
 * then falls back to a heuristic (skip Mon/Tue).
 */
function nextRaceDateFallback() {
  const { iso } = todayET();
  const today = new Date(`${iso}T12:00:00`);
  const pad = (n) => String(n).padStart(2, '0');

  // Scan today + up to 7 days to find a Wed-Sun race day
  for (let offset = 0; offset <= 7; offset++) {
    const target = new Date(today);
    target.setDate(target.getDate() + offset);
    const dow = target.getDay(); // 0=Sun ... 6=Sat
    if (dow === 1 || dow === 2) continue;

    const ry = target.getFullYear();
    const rm = pad(target.getMonth() + 1);
    const rd = pad(target.getDate());
    return `${ry}-${rm}-${rd}`;
  }

  return iso;
}

/**
 * Discover the actual next race date from NYRA's HTMX endpoint.
 * The entries page includes day-switcher buttons with upcoming dates.
 * Returns a YYYY-MM-DD string or null if discovery fails.
 */
async function discoverNextRaceDate(trackSlug) {
  try {
    const { iso } = todayET();
    // Fetch the entries page for today — even if no races today, it shows upcoming dates
    const url = `${NYRA_BASE}/${trackSlug}/rdl/race/?day=${iso}&limit=entries`;
    console.log(`  Discovering race dates from: ${url}`);
    const html = await fetch(url);

    // Extract all dates from the day-switcher buttons
    const datePattern = /hx-get="\/[^/]+\/rdl\/race\/\?day=([\d-]+)&amp;limit=entries"/g;
    const dates = new Set();
    let m;
    while ((m = datePattern.exec(html)) !== null) {
      dates.add(m[1]);
    }

    if (dates.size === 0) return null;

    // Sort dates and find the earliest one >= today
    const sorted = [...dates].sort();
    const nextDate = sorted.find(d => d >= iso) || sorted[0];
    console.log(`  Available race dates: ${sorted.join(', ')}`);
    console.log(`  Selected: ${nextDate}`);
    return nextDate;
  } catch (err) {
    console.warn(`  Race date discovery failed: ${err.message}`);
    return null;
  }
}

/**
 * Determine the active NYRA track based on the date.
 *   AQU: roughly Jan 1 - Apr 30 (winter/spring meet)
 *   BEL: roughly May 1 - Jul 13 (spring/summer meet)
 *   SAR: roughly Jul 14 - Sep 7 (Saratoga summer meet)
 *   BEL: roughly Sep 8 - Oct 31 (fall meet)
 *   AQU: roughly Nov 1 - Dec 31 (fall/winter meet)
 */
function activeTrack(dateStr) {
  const [, monthStr, dayStr] = dateStr.split('-');
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);

  if (month <= 4) return 'AQU';
  if (month <= 6) return 'BEL';
  if (month === 7 && day <= 13) return 'BEL';
  if (month === 7) return 'SAR';
  if (month === 8) return 'SAR';
  if (month === 9 && day <= 7) return 'SAR';
  if (month <= 10) return 'BEL';
  return 'AQU';
}

// ---------------------------------------------------------------------------
// Jockey / Trainer stats lookup
// ---------------------------------------------------------------------------

function buildLookup(statsArray) {
  const map = {};
  if (!Array.isArray(statsArray)) return map;
  for (const entry of statsArray) {
    if (entry.name) {
      map[entry.name.toLowerCase().trim()] = entry;
    }
  }
  return map;
}

function lookupWinPct(name, lookup, fallback) {
  if (!name || !lookup) return fallback;
  const key = name.toLowerCase().trim();
  const hit = lookup[key];
  if (hit && typeof hit.winPct === 'number') return hit.winPct;
  if (hit && typeof hit.win_pct === 'number') return hit.win_pct;
  if (hit && typeof hit.pct === 'number') return hit.pct;

  // Try partial match (last name)
  const parts = key.split(/[\s,]+/).filter(Boolean);
  if (parts.length > 1) {
    const lastName = parts[parts.length - 1];
    for (const [k, v] of Object.entries(lookup)) {
      if (k.endsWith(lastName)) {
        if (typeof v.winPct === 'number') return v.winPct;
        if (typeof v.win_pct === 'number') return v.win_pct;
        if (typeof v.pct === 'number') return v.pct;
      }
    }
  }

  return fallback;
}

// ---------------------------------------------------------------------------
// Running style heuristic
// ---------------------------------------------------------------------------

/**
 * Assign a running-style code based on race type, distance, and position info.
 *   E  = Early speed / frontrunner
 *   EP = Early presser
 *   P  = Presser / stalker
 *   SS = Sustained / closer
 *
 * Without past-performance data we use a heuristic:
 *   - Sprints (<=6.5f) and low post positions lean E/EP
 *   - Routes (>= 1M) and higher post positions lean P/SS
 *   - First-time starters default to P
 */
function assignRunningStyle(entry, distance) {
  const dist = parseDistance(distance);
  const pp = entry.pp || 1;

  // First-time starter (no speed figs) -> default to P
  const hasFigs = (entry.speedFigs || []).some((f) => f !== null && f !== undefined);
  if (!hasFigs) {
    return pp <= 3 ? 'E' : 'P';
  }

  // Sprint heuristic (6.5f or less)
  if (dist <= 6.5) {
    if (pp <= 2) return 'E';
    if (pp <= 4) return 'EP';
    return 'P';
  }

  // Route heuristic (1 mile+)
  if (dist >= 8) {
    if (pp <= 2) return 'EP';
    if (pp <= 5) return 'P';
    return 'SS';
  }

  // Middle distances
  if (pp <= 3) return 'EP';
  return 'P';
}

/** Parse a distance string like "6F", "1 1/8M", "7F" into furlongs. */
function parseDistance(distStr) {
  if (!distStr) return 8; // default to 1 mile
  const s = distStr.toUpperCase().trim();

  // "6F", "7F", "6.5F"
  const fMatch = s.match(/^([\d.]+)\s*F$/);
  if (fMatch) return parseFloat(fMatch[1]);

  // "1M", "1 1/16M", "1 1/8M", "1 3/16M", "1 1/4M", "1 1/2M"
  const mMatch = s.match(/^(\d+)\s*(?:(\d+)\/(\d+))?\s*M$/);
  if (mMatch) {
    let miles = parseInt(mMatch[1], 10);
    if (mMatch[2] && mMatch[3]) {
      miles += parseInt(mMatch[2], 10) / parseInt(mMatch[3], 10);
    }
    return miles * 8; // convert miles to furlongs
  }

  return 8; // fallback
}

// ---------------------------------------------------------------------------
// NYRA HTMX entries fetching (best-effort)
// ---------------------------------------------------------------------------

const TRACK_SLUGS = { AQU: 'aqueduct', BEL: 'belmont', SAR: 'saratoga' };

/**
 * Decode common HTML entities in scraped text.
 */
function decodeEntities(str) {
  return str
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&bull;/g, '•')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/**
 * Detect how many races exist by fetching the all-races HTMX endpoint
 * and counting race tab links.
 */
async function discoverRaceCount(trackSlug, date) {
  const url = `${NYRA_BASE}/${trackSlug}/rdl/race/?day=${date}&limit=entries`;
  console.log(`  Discovering race count: ${url}`);
  const html = await fetch(url);
  const pattern = new RegExp(
    `hx-get="/${trackSlug}/rdl/race/\\?day=[\\d-]+&amp;limit=entries&amp;race=(\\d+)"`,
    'g'
  );
  const raceNums = new Set();
  let m;
  while ((m = pattern.exec(html)) !== null) {
    raceNums.add(parseInt(m[1], 10));
  }
  const count = raceNums.size;
  console.log(`  Found ${count} race tabs.`);
  return count;
}

/**
 * Parse a single race's HTMX HTML response into a race object.
 * Returns { race, serlingPicks } where serlingPicks may be null.
 */
function parseRaceHTML(html, raceNumber) {
  const race = {
    race_number: raceNumber,
    post_time: null,
    purse: null,
    race_type: null,
    conditions: null,
    distance: null,
    surface: 'Dirt',
    entries: [],
    race_type_code: null,
  };

  // --- Race metadata ---
  // Race header: "Race N"
  const headerMatch = html.match(/<header[^>]*font-heading[^>]*>\s*Race\s+(\d+)\s*<\/header>/);
  if (headerMatch) race.race_number = parseInt(headerMatch[1], 10);

  // Purse and race type: "$40,000\n    Maiden Claiming"
  const purseTypeMatch = html.match(/<div>\s*(\$[\d,]+)\s*\n\s*([^<]+)\s*<\/div>/);
  if (purseTypeMatch) {
    race.purse = purseTypeMatch[1].trim();
    race.race_type = purseTypeMatch[2].trim();
  }

  // Race type code from race_type
  if (race.race_type) {
    const rt = race.race_type.toLowerCase();
    if (rt.includes('maiden claiming')) race.race_type_code = 'MCL';
    else if (rt.includes('maiden special')) race.race_type_code = 'MSW';
    else if (rt.includes('allowance optional') || rt.includes('optional claiming')) race.race_type_code = 'AOC';
    else if (rt.includes('allowance')) race.race_type_code = 'ALW';
    else if (rt.includes('claiming')) race.race_type_code = 'CLM';
    else if (rt.includes('stakes') || rt.includes('graded')) race.race_type_code = 'STK';
  }

  // Distance: title="Six Furlongs">6F</div> or title="One And One Eighth Miles">1 1/8M</div>
  const distMatch = html.match(/title="[^"]*">([\d\s/]+[FM])<\/div>/);
  if (distMatch) race.distance = distMatch[1].trim();

  // Surface: "Dirt" or "Turf" or "Inner Turf"
  const surfaceMatch = html.match(/<div[^>]*text-zinc-800[^>]*>\s*(Dirt|Turf|Inner Turf|Hurdle)\s*<\/div>/);
  if (surfaceMatch) race.surface = surfaceMatch[1].trim();

  // Post time: "1:10p at Aqueduct"
  const postTimeMatch = html.match(/([\d]+:[\d]+[ap])\s*at\s/);
  if (postTimeMatch) {
    const raw = postTimeMatch[1];
    const ampm = raw.endsWith('p') ? 'PM' : 'AM';
    race.post_time = raw.slice(0, -1) + ' ' + ampm;
  }

  // Conditions
  const condMatch = html.match(/<div class="text-sm lg:text-base text-zinc-800 dark:text-white">\s*FOR\s+([\s\S]*?)<\/div>/);
  if (condMatch) race.conditions = condMatch[1].replace(/\s+/g, ' ').trim();

  // --- Entries ---
  // Each entry block starts with: <div class="flex items-start gap-3 lg:gap-5 text-sm
  const entryBlocks = html.split(/<div class="flex items-start gap-3 lg:gap-5 text-sm/).slice(1);

  for (const block of entryBlocks) {
    const entry = {
      pp: 0,
      name: 'Unknown',
      jockey: 'Unknown',
      trainer: 'Unknown',
      weight: '120',
      scratched: false,
      ml: null,
      equibaseUrl: null,
      speedFigs: [null, null, null],
      runningStyle: null,
      lastClass: null,
      jockeyPct: null,
      trainerPct: null,
    };

    // Horse name from equibase link inside blend-links div
    const nameMatch = block.match(/blend-links[^>]*><a\s+href="([^"]*)"[^>]*>\s*([^<]+)\s*<\/a>/);
    if (nameMatch) {
      entry.equibaseUrl = decodeEntities(nameMatch[1]);
      entry.name = decodeEntities(nameMatch[2]).trim();
    }

    // Jockey • Trainer
    const jtMatch = block.match(/<div class="text-zinc-800 dark:text-white">([^<]+?)&bull;([^<]+?)<\/div>/);
    if (jtMatch) {
      entry.jockey = decodeEntities(jtMatch[1]).trim();
      entry.trainer = decodeEntities(jtMatch[2]).trim();
    }

    // Weight: "120lbs • L • 3/F" or "113lbs • 3/F"
    const weightMatch = block.match(/(\d+)lbs/);
    if (weightMatch) entry.weight = weightMatch[1];

    // Post position from saddle-N class
    const ppMatch = block.match(/saddle-(\d+)/);
    if (ppMatch) entry.pp = parseInt(ppMatch[1], 10);

    // Morning line: title="Morning Line Odds">ML 4/1</div>
    const mlMatch = block.match(/title="Morning Line Odds">ML\s*([^<]+)<\/div>/);
    if (mlMatch) entry.ml = mlMatch[1].trim();

    // Scratched: check for line-through or "Scratched"
    if (block.includes('line-through') || block.includes('Scratched') || block.includes('scratched')) {
      entry.scratched = true;
    }

    if (entry.name !== 'Unknown') {
      race.entries.push(entry);
    }
  }

  // --- Serling picks (embedded in race response) ---
  let serlingPicks = null;
  const serlingMatch = html.match(/Talking Horses[\s\S]*?Andy Serling[\s\S]*?<div>\s*([\d]+(?:\s*-\s*[\d]+)*)\s*<\/div>/);
  if (serlingMatch) {
    const picksStr = serlingMatch[1].trim();
    const picks = picksStr.split(/\s*-\s*/).map(Number).filter(n => !isNaN(n));
    if (picks.length >= 2) {
      serlingPicks = picks;
    }
  }

  return { race, serlingPicks };
}

/**
 * Fetch entries from NYRA's HTMX endpoints.
 * Returns { races, serlingPicksByRace } or null on failure.
 */
async function fetchNYRAEntries(track, date) {
  const trackSlug = TRACK_SLUGS[track] || track.toLowerCase();

  try {
    // Step 1: Discover how many races exist
    const numRaces = await discoverRaceCount(trackSlug, date);
    if (!numRaces || numRaces === 0) {
      console.log('  No races found at HTMX endpoint.');
      return null;
    }

    // Step 2: Fetch each race individually with 500ms delay
    const races = [];
    const serlingPicksByRace = {};

    for (let rn = 1; rn <= numRaces; rn++) {
      try {
        const url = `${NYRA_BASE}/${trackSlug}/rdl/race/?day=${date}&limit=entries&race=${rn}`;
        console.log(`  Fetching Race ${rn}: ${url}`);
        const html = await fetch(url);

        const { race, serlingPicks } = parseRaceHTML(html, rn);
        races.push(race);

        if (serlingPicks) {
          serlingPicksByRace[rn] = serlingPicks;
          console.log(`    Serling picks for R${rn}: ${serlingPicks.join(' - ')}`);
        }

        console.log(`    R${rn}: ${race.entries.length} entries, ${race.race_type || 'unknown type'}, ${race.distance || '?'}`);
      } catch (err) {
        console.warn(`  Race ${rn} fetch failed: ${err.message}`);
        // Push a stub so race numbering stays correct
        races.push({
          race_number: rn, post_time: null, purse: null, race_type: null,
          conditions: null, distance: null, surface: 'Dirt', entries: [],
          race_type_code: null,
        });
      }

      if (rn < numRaces) await delay(500);
    }

    console.log(`  Fetched ${races.length} races total.`);
    return { races, serlingPicksByRace };
  } catch (err) {
    console.warn(`  fetchNYRAEntries error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Rate-limiting helper
// ---------------------------------------------------------------------------

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Expert picks — NYRA Talking Horses & TimeformUS (best-effort)
// ---------------------------------------------------------------------------

/**
 * Parse picks from an NYRA picks page section.
 * Looks for: <div class="font-semibold w-[5rem]">Race N</div><div>picks</div>
 * within a date section identified by id="th-pick-{date}".
 * Returns object: { [raceNumber]: [pp, pp, pp, ...] }
 */
function parsePicksFromHTML(html, targetDate) {
  const picksByRace = {};

  // Try to find the section for the target date first
  const dateId = `th-pick-${targetDate}`;
  const dateIdx = html.indexOf(`id="${dateId}"`);

  // Determine section to parse: target date section, or first section, or whole page
  let section = html;
  if (dateIdx !== -1) {
    // Extract from this date section to the next th-pick section or end
    const rest = html.slice(dateIdx);
    const nextSection = rest.indexOf('id="th-pick-', 20);
    section = nextSection !== -1 ? rest.slice(0, nextSection) : rest;
  } else {
    // No exact date match — try the first th-pick section
    const firstIdx = html.indexOf('id="th-pick-');
    if (firstIdx !== -1) {
      const rest = html.slice(firstIdx);
      const nextSection = rest.indexOf('id="th-pick-', 20);
      section = nextSection !== -1 ? rest.slice(0, nextSection) : rest;
    }
  }

  // Parse Race N -> picks pairs
  const pattern = /font-semibold w-\[5rem\]">Race\s*(\d+)<\/div>\s*<div>([^<]+)<\/div>/g;
  let m;
  while ((m = pattern.exec(section)) !== null) {
    const raceNum = parseInt(m[1], 10);
    const picksStr = m[2].trim();
    const picks = picksStr.split(/\s*-\s*/).map(Number).filter(n => !isNaN(n));
    if (picks.length >= 2) {
      picksByRace[raceNum] = picks;
    }
  }

  return picksByRace;
}

/**
 * Fetch Serling picks from the Talking Horses page (backup source).
 * Returns array of { raceNumber, source, picks } or empty array.
 */
async function fetchSerlingPicks(track, date) {
  try {
    const trackSlug = TRACK_SLUGS[track] || track.toLowerCase();
    const url = `${NYRA_BASE}/${trackSlug}/racing/talking-horses/`;
    console.log(`  Fetching Serling picks (Talking Horses page): ${url}`);
    const html = await fetch(url);

    const picksByRace = parsePicksFromHTML(html, date);
    const picks = [];
    for (const [rn, pp] of Object.entries(picksByRace)) {
      picks.push({
        raceNumber: parseInt(rn, 10),
        source: 'NYRA - Serling',
        pick: pp[0], // top pick is first PP
        picks: pp,
      });
    }

    if (picks.length) console.log(`  Found ${picks.length} Serling picks from Talking Horses page.`);
    else console.log('  No Serling picks found on Talking Horses page.');
    return picks;
  } catch (err) {
    console.warn(`  Serling picks fetch failed (graceful): ${err.message}`);
    return [];
  }
}

/**
 * Fetch Aragona picks from the TimeformUS page.
 * Returns array of { raceNumber, source, picks } or empty array.
 */
async function fetchAragonaPicks(track, date) {
  try {
    const trackSlug = TRACK_SLUGS[track] || track.toLowerCase();
    const url = `${NYRA_BASE}/${trackSlug}/racing/timeformus/`;
    console.log(`  Fetching Aragona picks: ${url}`);
    const html = await fetch(url);

    const picksByRace = parsePicksFromHTML(html, date);
    const picks = [];
    for (const [rn, pp] of Object.entries(picksByRace)) {
      picks.push({
        raceNumber: parseInt(rn, 10),
        source: 'NYRA - Aragona',
        pick: pp[0],
        picks: pp,
      });
    }

    if (picks.length) console.log(`  Found ${picks.length} Aragona picks.`);
    else console.log('  No Aragona picks found.');
    return picks;
  } catch (err) {
    console.warn(`  Aragona picks fetch failed (graceful): ${err.message}`);
    return [];
  }
}

/**
 * Fetch DeSantis picks from NYRABets expert picks.
 * Returns array of { raceNumber, source, pick } or empty array.
 */
async function fetchDeSantisPicks(track, date) {
  try {
    const url = 'https://racing.nyrabets.com/expert-picks';
    console.log(`  Fetching DeSantis picks: ${url}`);
    const html = await fetch(url);

    const picks = [];
    // Look for DeSantis section and parse Race N -> picks
    const desantisIdx = html.search(/DeSantis/i);
    if (desantisIdx !== -1) {
      const section = html.slice(desantisIdx, desantisIdx + 5000);
      const pattern = /Race\s*(\d+)[^<]*?(\d+(?:\s*-\s*\d+)*)/g;
      let m;
      while ((m = pattern.exec(section)) !== null) {
        const raceNum = parseInt(m[1], 10);
        const pp = m[2].split(/\s*-\s*/).map(Number).filter(n => !isNaN(n));
        if (pp.length >= 1) {
          picks.push({
            raceNumber: raceNum,
            source: 'NYRA - DeSantis',
            pick: pp[0],
            picks: pp,
          });
        }
      }
    }

    if (picks.length) console.log(`  Found ${picks.length} DeSantis picks.`);
    else console.log('  No DeSantis picks found.');
    return picks;
  } catch (err) {
    console.warn(`  DeSantis picks fetch failed (graceful): ${err.message}`);
    return [];
  }
}

/**
 * Fetch Equibase Smart Pick for each race.
 * Returns array of { raceNumber, source, pick, horseName } or empty array.
 */
async function fetchEquibaseSmartPick(track, date, numRaces) {
  try {
    const [y, m, d] = date.split('-');
    const dtParam = `${m}${d}${y}`; // MMDDYYYY
    const picks = [];
    const maxRaces = numRaces || 10;

    // Fetch up to maxRaces races
    for (let rn = 1; rn <= maxRaces; rn++) {
      try {
        const url = `https://www.equibase.com/static/entry/index.html?type=Entry&dt=${dtParam}&cy=USA&tk=${track}&rn=${rn}`;
        console.log(`  Fetching Equibase SmartPick R${rn}...`);
        const html = await fetch(url);

        // Look for "Smart Pick" or "smartPick" in the HTML
        const smartPickMatch = html.match(/[Ss]mart\s*[Pp]ick[^<]*?#(\d+)\s+([^<\n"]+)/);
        if (smartPickMatch) {
          picks.push({
            raceNumber: rn,
            source: 'Equibase SmartPick',
            pick: parseInt(smartPickMatch[1], 10),
            horseName: smartPickMatch[2].trim(),
          });
        }

        await delay(500); // Rate limit
      } catch (err) {
        console.warn(`  Equibase SmartPick R${rn} failed (graceful): ${err.message}`);
        // Continue to next race
      }
    }

    if (picks.length) console.log(`  Found ${picks.length} Equibase SmartPick selections.`);
    else console.log('  No Equibase SmartPick data found.');
    return picks;
  } catch (err) {
    console.warn(`  Equibase SmartPick fetch failed (graceful): ${err.message}`);
    return [];
  }
}

/**
 * Fetch FanDuel Consensus top pick per race for the given NYRA track.
 * Returns array of { raceNumber, source, pick, horseName } or empty array.
 */
async function fetchFanDuelConsensus(track, date) {
  try {
    const url = 'https://www.fanduel.com/research/horse-racing/consensus-picks-tool';
    console.log(`  Fetching FanDuel Consensus: ${url}`);
    const html = await fetch(url);

    const picks = [];
    const trackNames = { AQU: 'Aqueduct', BEL: 'Belmont', SAR: 'Saratoga' };
    const trackName = trackNames[track] || track;

    // Look for the track section in the consensus table
    const trackRegex = new RegExp(trackName + '[\\s\\S]*?(?=<\\/table|$)', 'i');
    const trackSection = html.match(trackRegex);
    if (trackSection) {
      // Parse race rows: look for race number and #1 consensus pick
      const rowPattern = /[Rr]ace\s*(\d+)[^<]*?(?:#(\d+)|[Pp]ick[:\s]*(\d+))\s*([^<\n"]*)/g;
      let match;
      while ((match = rowPattern.exec(trackSection[0])) !== null) {
        picks.push({
          raceNumber: parseInt(match[1], 10),
          source: 'FanDuel Consensus',
          pick: parseInt(match[2] || match[3], 10),
          horseName: (match[4] || '').trim(),
        });
      }
    }

    if (picks.length) console.log(`  Found ${picks.length} FanDuel Consensus picks.`);
    else console.log('  No FanDuel Consensus data found.');
    return picks;
  } catch (err) {
    console.warn(`  FanDuel Consensus fetch failed (graceful): ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Equibase Entries Plus — speed figures (best-effort)
// ---------------------------------------------------------------------------

/**
 * Fetch Equibase Entries Plus for a single race to get speed figures.
 * Returns array of { horseName, speedFigs, lastClass, lastRaceDate } or empty array.
 */
async function fetchEquibaseEntriesPlus(track, date, raceNumber) {
  try {
    const [y, m, d] = date.split('-');
    const dtParam = `${m}${d}${y}`; // MMDDYYYY
    const url = `https://www.equibase.com/premium/eqbEntriesPlus.cfm?type=EP&dt=${dtParam}&cy=USA&tk=${track}&rn=${raceNumber}`;
    console.log(`  Fetching Equibase Entries Plus R${raceNumber}...`);
    const html = await fetch(url);

    const results = [];

    // Try to parse speed figures from the Entries Plus HTML
    // The page typically has a table with horse name and last 3 speed figures
    const horseRows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
    for (const row of horseRows) {
      // Look for horse name
      const nameMatch = row.match(/class="[^"]*horse[^"]*"[^>]*>([^<]+)</i) ||
                         row.match(/<td[^>]*>([A-Z][a-z]+(?:\s+[A-Za-z]+)+)<\/td>/);
      if (!nameMatch) continue;

      const horseName = nameMatch[1].trim();

      // Look for speed figures (typically 2-3 digit numbers in consecutive cells)
      const figMatches = row.match(/(?:speed|fig|beyer)[^<]*?(\d{2,3})/gi) ||
                         row.match(/<td[^>]*>\s*(\d{2,3})\s*<\/td>/g);
      const figs = [];
      if (figMatches) {
        for (const fm of figMatches.slice(0, 3)) {
          const num = fm.match(/(\d{2,3})/);
          if (num) {
            const val = parseInt(num[1], 10);
            if (val >= 20 && val <= 130) figs.push(val);
          }
        }
      }

      // Look for last class
      const classMatch = row.match(/(?:CLM|MCL|MSW|ALW|AOC|STK)/);
      const lastClass = classMatch ? classMatch[0] : null;

      // Look for last race date
      const dateMatch = row.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
      let lastRaceDate = null;
      if (dateMatch) {
        const parts = dateMatch[1].split('/');
        if (parts.length === 3) {
          const yr = parts[2].length === 2 ? '20' + parts[2] : parts[2];
          lastRaceDate = `${yr}-${parts[0].padStart(2, '0')}-${parts[1].padStart(2, '0')}`;
        }
      }

      results.push({
        horseName,
        speedFigs: figs.length ? figs : [null, null, null],
        lastClass,
        lastRaceDate,
      });
    }

    return results;
  } catch (err) {
    console.warn(`  Equibase Entries Plus R${raceNumber} failed (graceful): ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Placeholder race card generation
// ---------------------------------------------------------------------------

/**
 * Generate a placeholder race card when NYRA data is unavailable.
 * This provides the correct structure so the rest of the pipeline can continue.
 */
function generatePlaceholderCard(track, date) {
  console.log('  Generating placeholder card (no live data available).');
  const numRaces = 9;
  const races = [];

  const raceTypes = [
    { type: 'Maiden Claiming', code: 'MCL', purse: '$40,000' },
    { type: 'Claiming', code: 'CLM', purse: '$28,000' },
    { type: 'Maiden Special Weight', code: 'MSW', purse: '$80,000' },
    { type: 'Allowance', code: 'ALW', purse: '$72,000' },
    { type: 'Claiming', code: 'CLM', purse: '$35,000' },
    { type: 'Allowance Optional Claiming', code: 'AOC', purse: '$82,000' },
    { type: 'Claiming', code: 'CLM', purse: '$25,000' },
    { type: 'Allowance', code: 'ALW', purse: '$80,000' },
    { type: 'Maiden Special Weight', code: 'MSW', purse: '$80,000' },
  ];

  const distances = ['6F', '1 1/8M', '6F', '1M', '7F', '1 1/16M', '6F', '1 1/8M', '1M'];
  const basePostTime = 13; // 1:00 PM

  for (let i = 0; i < numRaces; i++) {
    const raceInfo = raceTypes[i] || raceTypes[0];
    const hour = basePostTime + Math.floor((i * 28) / 60);
    const minute = (10 + (i * 28)) % 60;
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const dispHour = hour > 12 ? hour - 12 : hour;
    const postTime = `${dispHour}:${String(minute).padStart(2, '0')} ${ampm}`;

    races.push({
      race_number: i + 1,
      post_time: postTime,
      purse: raceInfo.purse,
      race_type: raceInfo.type,
      conditions: `Placeholder conditions for Race ${i + 1}. Actual conditions will be available when NYRA publishes entries.`,
      distance: distances[i] || '6F',
      surface: 'Dirt',
      entries: [],
      race_type_code: raceInfo.code,
    });
  }

  return races;
}

// ---------------------------------------------------------------------------
// Enrichment: merge stats and running styles into entries
// ---------------------------------------------------------------------------

function enrichRaces(races, jockeyLookup, trainerLookup) {
  for (const race of races) {
    for (const entry of race.entries) {
      // Jockey win %
      if (entry.jockeyPct === null || entry.jockeyPct === undefined) {
        entry.jockeyPct = lookupWinPct(entry.jockey, jockeyLookup, 10);
      }

      // Trainer win %
      if (entry.trainerPct === null || entry.trainerPct === undefined) {
        entry.trainerPct = lookupWinPct(entry.trainer, trainerLookup, 10);
      }

      // Running style
      if (!entry.runningStyle) {
        entry.runningStyle = assignRunningStyle(entry, race.distance);
      }

      // Data completeness: count of non-null fields out of 7
      let dc = 0;
      const figs = entry.speedFigs || [];
      if (figs[0] != null) dc++;
      if (figs[1] != null) dc++;
      if (figs[2] != null) dc++;
      if (entry.runningStyle) dc++;
      if ((parseFloat(entry.jockeyPct) || 0) > 0) dc++;
      if ((parseFloat(entry.trainerPct) || 0) > 0) dc++;
      if (entry.lastClass) dc++;
      entry.dataCompleteness = parseFloat((dc / 7).toFixed(2));
    }
  }
  return races;
}

/**
 * Merge speed figure data from Equibase Entries Plus into race entries.
 * Only overwrites null/empty values — preserves manually entered data.
 */
function mergeSpeedFigures(races, epDataByRace) {
  for (const race of races) {
    const epData = epDataByRace[race.race_number];
    if (!epData || !epData.length) continue;

    for (const entry of race.entries) {
      // Find matching horse in EP data (case-insensitive name match)
      const entryName = (entry.name || '').toLowerCase().trim();
      const epMatch = epData.find(ep =>
        (ep.horseName || '').toLowerCase().trim() === entryName
      );
      if (!epMatch) continue;

      // Merge speed figures: only overwrite if fetched array has at least 1 non-null
      const fetchedFigs = epMatch.speedFigs || [];
      const hasNonNull = fetchedFigs.some(f => f != null);
      if (hasNonNull) {
        const existingFigs = entry.speedFigs || [null, null, null];
        const existingHasData = existingFigs.some(f => f != null);
        if (!existingHasData) {
          // No existing data — use fetched
          entry.speedFigs = [
            fetchedFigs[0] != null ? fetchedFigs[0] : null,
            fetchedFigs[1] != null ? fetchedFigs[1] : null,
            fetchedFigs[2] != null ? fetchedFigs[2] : null,
          ];
        }
      }

      // Merge lastClass: only overwrite if existing is null
      if (!entry.lastClass && epMatch.lastClass) {
        entry.lastClass = epMatch.lastClass;
      }

      // Merge lastRaceDate: only overwrite if existing is null
      if (!entry.lastRaceDate && epMatch.lastRaceDate) {
        entry.lastRaceDate = epMatch.lastRaceDate;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== NE Racing Daily Entries Pipeline ===');
  console.log(`  Time: ${new Date().toISOString()}`);

  // Step 1: Determine race date and track
  let raceDate = nextRaceDateFallback();
  let track = activeTrack(raceDate);
  const trackSlug = TRACK_SLUGS[track] || track.toLowerCase();

  // Try to discover actual next race date from NYRA
  const discoveredDate = await discoverNextRaceDate(trackSlug);
  if (discoveredDate) {
    raceDate = discoveredDate;
    track = activeTrack(raceDate);
  }

  console.log(`  Race date: ${raceDate}`);
  console.log(`  Track:     ${track}`);

  // Step 2: Load jockey and trainer stats for enrichment
  console.log('\nLoading stats files...');
  const jockeyStats = readDataJson('jockey-stats.json');
  const trainerStats = readDataJson('trainer-stats.json');
  const jockeyLookup = buildLookup(jockeyStats);
  const trainerLookup = buildLookup(trainerStats);
  console.log(`  Jockeys loaded: ${Object.keys(jockeyLookup).length}`);
  console.log(`  Trainers loaded: ${Object.keys(trainerLookup).length}`);

  // Step 3: Fetch entries from NYRA HTMX endpoints
  console.log('\nFetching NYRA entries (HTMX)...');
  let races = null;
  let serlingPicksByRace = {};
  try {
    const result = await fetchNYRAEntries(track, raceDate);
    if (result) {
      races = result.races;
      serlingPicksByRace = result.serlingPicksByRace || {};
    }
  } catch (err) {
    console.warn(`  NYRA fetch error: ${err.message}`);
  }

  // Step 4: Fallback to placeholder if no data fetched
  if (!races || races.length === 0) {
    console.log('  No live entries available. Using placeholder card.');
    races = generatePlaceholderCard(track, raceDate);
  }

  // Step 5: Inject Serling picks from embedded HTMX data
  if (Object.keys(serlingPicksByRace).length) {
    console.log(`\n  Serling picks found in entries for ${Object.keys(serlingPicksByRace).length} races.`);
    for (const race of races) {
      const sp = serlingPicksByRace[race.race_number];
      if (sp) {
        if (!race.expertPicks) race.expertPicks = [];
        race.expertPicks.push({
          source: 'NYRA - Serling',
          pick: sp[0],
          picks: sp,
        });
      }
    }
  }

  // Step 5b: Fetch additional expert sources (all fail gracefully)
  console.log('\nFetching additional expert sources...');

  // Serling backup from Talking Horses page (only if not already from entries)
  let serlingPicks = [];
  if (Object.keys(serlingPicksByRace).length === 0) {
    serlingPicks = await fetchSerlingPicks(track, raceDate);
    await delay(500);
  }

  // Aragona from TimeformUS
  const aragonaPicks = await fetchAragonaPicks(track, raceDate);
  await delay(500);

  // DeSantis from NYRABets (fail gracefully)
  const desantisPicks = await fetchDeSantisPicks(track, raceDate);
  await delay(500);

  // Other sources (keep existing, fail gracefully)
  const smartPicks = await fetchEquibaseSmartPick(track, raceDate, races.length);
  const fanDuelPicks = await fetchFanDuelConsensus(track, raceDate);

  // Merge all additional expert picks into race-level expertPicks arrays
  const additionalPicks = [...serlingPicks, ...aragonaPicks, ...desantisPicks, ...smartPicks, ...fanDuelPicks];
  if (additionalPicks.length) {
    console.log(`  Total additional expert picks: ${additionalPicks.length}`);
    for (const race of races) {
      if (!race.expertPicks) race.expertPicks = [];
      const racePicks = additionalPicks.filter(p => p.raceNumber === race.race_number);
      for (const rp of racePicks) {
        // Avoid duplicate Serling entries
        const isDupe = race.expertPicks.some(ep => ep.source === rp.source);
        if (!isDupe) {
          race.expertPicks.push({
            source: rp.source,
            pick: rp.pick,
            picks: rp.picks,
          });
        }
      }
    }
  }

  // Step 5c: Fetch Equibase Entries Plus speed figures (with rate limiting)
  console.log('\nFetching Equibase Entries Plus (speed figures)...');
  const epDataByRace = {};
  for (const race of races) {
    const epData = await fetchEquibaseEntriesPlus(track, raceDate, race.race_number);
    if (epData.length) {
      epDataByRace[race.race_number] = epData;
    }
    await delay(500); // Rate limit: 500ms between requests
  }
  const epRaceCount = Object.keys(epDataByRace).length;
  if (epRaceCount) {
    console.log(`  Speed figures found for ${epRaceCount} races.`);
    mergeSpeedFigures(races, epDataByRace);
  } else {
    console.log('  No Equibase Entries Plus data available.');
  }

  // Step 5d: Resolve expert pick PP numbers to horse names
  for (const race of races) {
    const entries = race.entries || [];
    for (const ep of (race.expertPicks || [])) {
      if (!ep.horseName && ep.pick) {
        const match = entries.find(e => e.pp === ep.pick);
        if (match) ep.horseName = match.name;
      }
    }
  }

  // Step 6: Enrich entries with stats and running styles
  console.log('\nEnriching entries...');
  races = enrichRaces(races, jockeyLookup, trainerLookup);

  // Step 7: Build output JSON
  const output = {
    track,
    date: raceDate,
    races,
  };

  // Step 8: Write to disk
  const outputFilename = `entries-${track}-${raceDate}.json`;
  const outputPath = path.join(DATA_DIR, outputFilename);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf-8');
  console.log(`\nOutput written to: ${outputPath}`);
  console.log(`  Races: ${races.length}`);

  let totalEntries = 0;
  console.log('\n  Entries per race:');
  for (const race of races) {
    const count = (race.entries || []).length;
    const expertCount = (race.expertPicks || []).length;
    console.log(`    R${race.race_number}: ${count} horses, ${expertCount} expert picks`);
    totalEntries += count;
  }
  console.log(`  Total entries: ${totalEntries}`);

  console.log('\n=== Pipeline complete ===');
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('Pipeline failed with error:', err.message);
  console.error(err.stack);
  // Exit 0 so the GitHub Action doesn't fail on partial errors
  process.exit(0);
});
