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
 * NYRA generally races Wed-Sun, but the weekday schedule varies.
 * This pipeline runs Mon-Fri; we look for the next likely race day.
 */
function nextRaceDate() {
  const { year, month, day, iso } = todayET();
  const today = new Date(`${iso}T12:00:00`);
  const dow = today.getDay(); // 0=Sun ... 6=Sat

  // If today is Wed-Fri, assume today is a race day.
  // If Mon or Tue, advance to Wednesday.
  // (These are defaults; the NYRA schedule can vary.)
  let target = new Date(today);
  if (dow === 1) {
    // Monday -> advance 2 days to Wednesday
    target.setDate(target.getDate() + 2);
  } else if (dow === 2) {
    // Tuesday -> advance 1 day to Wednesday
    target.setDate(target.getDate() + 1);
  }
  // Wed(3), Thu(4), Fri(5) -> use today

  const pad = (n) => String(n).padStart(2, '0');
  const ry = target.getFullYear();
  const rm = pad(target.getMonth() + 1);
  const rd = pad(target.getDate());
  return `${ry}-${rm}-${rd}`;
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
// NYRA entries fetching (best-effort)
// ---------------------------------------------------------------------------

/**
 * Attempt to fetch entries from NYRA's website.
 * This is a best-effort scraper -- the page structure can change at any time.
 * Returns an array of race objects or null on failure.
 */
async function fetchNYRAEntries(track, date) {
  const trackNames = { AQU: 'aqueduct', BEL: 'belmont', SAR: 'saratoga' };
  const trackSlug = trackNames[track] || track.toLowerCase();

  // Try the NYRA entries API/page
  const urls = [
    `${NYRA_BASE}/racing/entries/${trackSlug}/${date}`,
    `${NYRA_BASE}/racing/entries`,
  ];

  for (const url of urls) {
    try {
      console.log(`  Fetching: ${url}`);
      const html = await fetch(url);

      // Try to find embedded JSON data (NYRA sometimes embeds race data in script tags)
      const jsonMatch = html.match(/__NEXT_DATA__.*?<\/script>/s);
      if (jsonMatch) {
        const dataMatch = jsonMatch[0].match(/\{[\s\S]*\}/);
        if (dataMatch) {
          try {
            const nextData = JSON.parse(dataMatch[0]);
            const races = extractRacesFromNextData(nextData, track);
            if (races && races.length > 0) {
              console.log(`  Found ${races.length} races from NYRA data.`);
              return races;
            }
          } catch (e) {
            console.warn(`  Could not parse NYRA embedded data: ${e.message}`);
          }
        }
      }

      // Try to find races from HTML structure
      const races = extractRacesFromHTML(html, track);
      if (races && races.length > 0) {
        console.log(`  Extracted ${races.length} races from HTML.`);
        return races;
      }

      console.log(`  No race data found at ${url}`);
    } catch (err) {
      console.warn(`  Fetch failed for ${url}: ${err.message}`);
    }
  }

  return null;
}

/** Extract race data from Next.js __NEXT_DATA__ payload. */
function extractRacesFromNextData(nextData, track) {
  try {
    // Navigate common Next.js data paths
    const props = nextData.props?.pageProps;
    if (!props) return null;

    const raceData = props.races || props.entries || props.card;
    if (!Array.isArray(raceData)) return null;

    return raceData.map((race, idx) => ({
      race_number: race.raceNumber || race.race_number || idx + 1,
      post_time: race.postTime || race.post_time || null,
      purse: race.purse || null,
      race_type: race.raceType || race.race_type || null,
      conditions: race.conditions || null,
      distance: race.distance || null,
      surface: race.surface || 'Dirt',
      entries: (race.entries || race.runners || []).map((e, eidx) => ({
        pp: e.pp || e.postPosition || e.post_position || eidx + 1,
        name: e.name || e.horseName || e.horse_name || 'Unknown',
        jockey: e.jockey || e.jockeyName || e.jockey_name || 'Unknown',
        trainer: e.trainer || e.trainerName || e.trainer_name || 'Unknown',
        weight: String(e.weight || '120'),
        scratched: e.scratched || false,
        ml: e.ml || e.morningLine || e.morning_line || null,
        speedFigs: e.speedFigs || [null, null, null],
        runningStyle: null, // will be populated later
        lastClass: e.lastClass || e.last_class || null,
        jockeyPct: null,
        trainerPct: null,
      })),
      race_type_code: race.raceTypeCode || race.race_type_code || null,
    }));
  } catch (err) {
    console.warn(`  extractRacesFromNextData error: ${err.message}`);
    return null;
  }
}

/** Best-effort HTML extraction. Likely to fail if structure changes. */
function extractRacesFromHTML(html, track) {
  // This is intentionally simplistic -- if NYRA changes their HTML this will
  // return null and the pipeline will generate placeholder data.
  try {
    const races = [];
    // Look for race-card patterns; many NYRA pages use data-race-number attributes
    const raceBlocks = html.match(/data-race-number="(\d+)"/g);
    if (!raceBlocks || raceBlocks.length === 0) return null;

    const uniqueRaces = [...new Set(raceBlocks.map((b) => {
      const m = b.match(/(\d+)/);
      return m ? parseInt(m[1], 10) : 0;
    }))].sort((a, b) => a - b);

    for (const rNum of uniqueRaces) {
      races.push({
        race_number: rNum,
        post_time: null,
        purse: null,
        race_type: null,
        conditions: null,
        distance: null,
        surface: 'Dirt',
        entries: [],
        race_type_code: null,
      });
    }

    return races.length > 0 ? races : null;
  } catch (err) {
    console.warn(`  extractRacesFromHTML error: ${err.message}`);
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
// Expert picks (best-effort)
// ---------------------------------------------------------------------------

async function fetchExpertPicks(track, date) {
  const trackNames = { AQU: 'aqueduct', BEL: 'belmont', SAR: 'saratoga' };
  const trackSlug = trackNames[track] || track.toLowerCase();

  const urls = [
    `${NYRA_BASE}/racing/picks/${trackSlug}/${date}`,
    `${NYRA_BASE}/racing/picks`,
  ];

  for (const url of urls) {
    try {
      console.log(`  Fetching picks: ${url}`);
      const html = await fetch(url);

      // Try to find picks in embedded JSON
      const jsonMatch = html.match(/__NEXT_DATA__.*?<\/script>/s);
      if (jsonMatch) {
        const dataMatch = jsonMatch[0].match(/\{[\s\S]*\}/);
        if (dataMatch) {
          try {
            const nextData = JSON.parse(dataMatch[0]);
            const picks = nextData.props?.pageProps?.picks;
            if (picks) {
              console.log('  Found expert picks data.');
              return picks;
            }
          } catch (_) { /* ignore parse errors */ }
        }
      }
    } catch (err) {
      console.warn(`  Picks fetch failed: ${err.message}`);
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Additional expert pick sources (best-effort, fail gracefully)
// ---------------------------------------------------------------------------

/**
 * Fetch Andy Serling / Talking Horses picks from NYRA expert picks page.
 * Returns array of { raceNumber, source, pick, horseName } or empty array.
 */
async function fetchSerlingPicks(track, date) {
  try {
    const trackNames = { AQU: 'aqueduct', BEL: 'belmont', SAR: 'saratoga' };
    const trackSlug = trackNames[track] || track.toLowerCase();
    const url = `${NYRA_BASE}/${trackSlug}/racing/expert-picks/`;
    console.log(`  Fetching Serling picks: ${url}`);
    const html = await fetch(url);

    // Look for Serling/Talking Horses section in the picks page
    const picks = [];
    // Try embedded JSON first
    const jsonMatch = html.match(/__NEXT_DATA__.*?<\/script>/s);
    if (jsonMatch) {
      const dataMatch = jsonMatch[0].match(/\{[\s\S]*\}/);
      if (dataMatch) {
        try {
          const nextData = JSON.parse(dataMatch[0]);
          const allPicks = nextData.props?.pageProps?.picks || nextData.props?.pageProps?.experts || [];
          const serlingData = Array.isArray(allPicks) ? allPicks.filter(p =>
            p.expert && (p.expert.toLowerCase().includes('serling') || p.expert.toLowerCase().includes('talking'))
          ) : [];
          for (const sp of serlingData) {
            if (sp.raceNumber && sp.horseName) {
              picks.push({
                raceNumber: sp.raceNumber,
                source: 'NYRA - Serling',
                pick: sp.pp || sp.postPosition || sp.pick || 0,
                horseName: sp.horseName || '',
              });
            }
          }
        } catch (_) { /* ignore parse errors */ }
      }
    }

    // Fallback: try to find Serling picks in HTML patterns
    if (!picks.length) {
      const serlingSection = html.match(/[Ss]erling|[Tt]alking\s*[Hh]orses/i);
      if (serlingSection) {
        // Best-effort HTML parsing for Serling section
        const racePickPattern = /[Rr]ace\s*(\d+)[^<]*?#(\d+)\s+([^<\n]+)/g;
        let match;
        while ((match = racePickPattern.exec(html)) !== null) {
          picks.push({
            raceNumber: parseInt(match[1], 10),
            source: 'NYRA - Serling',
            pick: parseInt(match[2], 10),
            horseName: match[3].trim(),
          });
        }
      }
    }

    if (picks.length) console.log(`  Found ${picks.length} Serling picks.`);
    else console.log('  No Serling picks found.');
    return picks;
  } catch (err) {
    console.warn(`  Serling picks fetch failed (graceful): ${err.message}`);
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
  const raceDate = nextRaceDate();
  const track = activeTrack(raceDate);
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

  // Step 3: Fetch entries from NYRA
  console.log('\nFetching NYRA entries...');
  let races = null;
  try {
    races = await fetchNYRAEntries(track, raceDate);
  } catch (err) {
    console.warn(`  NYRA fetch error: ${err.message}`);
  }

  // Step 4: Fallback to placeholder if no data fetched
  if (!races || races.length === 0) {
    console.log('  No live entries available. Using placeholder card.');
    races = generatePlaceholderCard(track, raceDate);
  }

  // Step 5: Fetch expert picks (optional — all sources fail gracefully)
  console.log('\nFetching expert picks...');
  let picks = null;
  try {
    picks = await fetchExpertPicks(track, raceDate);
  } catch (err) {
    console.warn(`  Expert picks fetch error: ${err.message}`);
  }
  if (picks) {
    console.log('  Expert picks loaded.');
  } else {
    console.log('  No expert picks available.');
  }

  // Step 5b: Fetch additional expert sources (all fail gracefully)
  console.log('\nFetching additional expert sources...');
  const serlingPicks = await fetchSerlingPicks(track, raceDate);
  const smartPicks = await fetchEquibaseSmartPick(track, raceDate, races.length);
  const fanDuelPicks = await fetchFanDuelConsensus(track, raceDate);

  // Merge additional expert picks into race-level expertPicks arrays
  const additionalPicks = [...serlingPicks, ...smartPicks, ...fanDuelPicks];
  if (additionalPicks.length) {
    console.log(`  Total additional expert picks: ${additionalPicks.length}`);
    for (const race of races) {
      if (!race.expertPicks) race.expertPicks = [];
      const racePicks = additionalPicks.filter(p => p.raceNumber === race.race_number);
      for (const rp of racePicks) {
        race.expertPicks.push({
          source: rp.source,
          pick: rp.pick,
          horseName: rp.horseName,
        });
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

  // Step 6: Enrich entries with stats and running styles
  console.log('\nEnriching entries...');
  races = enrichRaces(races, jockeyLookup, trainerLookup);

  // Step 7: Build output JSON
  const output = {
    track,
    date: raceDate,
    races,
  };

  // Include expert picks if available (legacy top-level field)
  if (picks) {
    output.expertPicks = picks;
  }

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
  for (const race of races) {
    totalEntries += (race.entries || []).length;
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
