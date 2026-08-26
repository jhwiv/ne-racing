#!/usr/bin/env node
'use strict';

/**
 * parse_pp_feed.js — parser for the independent (non-Brisnet) markdown PP feed
 * (e.g. "Saratoga_8_26_2026 — Full Race Data SAR0826.ALL.md").
 *
 * Confirmed by direct inspection of a real file (2026-08-26, SAR, 8 races, 74
 * horses), not assumed: source uses a documented field-per-line format,
 * `- F<N> <Label>: <value>` inside each horse's PP block, plus a race-level
 * preamble block per race using `- **<Label>** (F<N>): <value>`. No speed
 * figures or class ratings anywhere in the file (confirmed via exhaustive
 * label survey) -- this vendor's edge is workouts (up to 12/horse), full
 * running-line points of call + free-text trip comments for up to 10 past
 * races/horse, and real meet/week post-position and pace-style bias stats.
 * Does not share Brisnet's field-numbering scheme (spot-checked against
 * tools/parse-brisnet.js's own field offsets) or its proprietary figures --
 * owner has confirmed this is an independent, non-Brisnet source.
 *
 * Usage:
 *   node tools/parse_pp_feed.js <input.md> <TRACK> <YYYY-MM-DD> > out.json
 */

const fs = require('fs');

function stripLabel(label) {
  return label.replace(/\s+/g, ' ').trim();
}

// Splits a label like "Race Date #1" into { base: "Race Date", idx: 1 }.
// Returns null for a non-indexed label (e.g. "Horse Name").
function indexedLabel(label) {
  const m = label.match(/^(.*) #(\d+)$/);
  if (!m) return null;
  return { base: stripLabel(m[1]), idx: parseInt(m[2], 10) };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

// Finds the one base-label key in `basesSeen` whose normalized text contains
// every substring in `mustInclude` (case-insensitive). Tolerates the source
// file's inconsistent spacing around "#5 - #12" / "#5-#12".
function findBase(basesSeen, mustInclude) {
  const norm = s => s.toLowerCase().replace(/[\s-]+/g, '');
  const needles = mustInclude.map(norm);
  for (const base of basesSeen) {
    const n = norm(base);
    if (needles.every(needle => n.includes(needle))) return base;
  }
  return null;
}

const RACE_HEADER_RE = /^## Race (\d+)\s*$/;
const PP_HEADER_RE = /^### Race (\d+) — PP (\d+) \(Pgm (\d+)\) — (.+)$/;
const CONNECTIONS_RE = /^_Jockey: (.+?) · Trainer: (.+?) · Owner: (.+?) · Wt: (\d+) · ML: ([\d.]+)_$/;
const RACE_PREAMBLE_FIELD_RE = /^- \*\*(.+?)\*\* \(F(\d+)\): (.*)$/;
const PP_FIELD_RE = /^- F(\d+) (.+?): (.*)$/;

function parsePpFeedMarkdown(text) {
  const lines = text.split(/\r?\n/);
  const races = [];
  let currentRace = null;
  let currentPP = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');

    const rh = line.match(RACE_HEADER_RE);
    if (rh) {
      currentPP = null;
      currentRace = { raceNumber: parseInt(rh[1], 10), preamble: {}, runners: [] };
      races.push(currentRace);
      continue;
    }

    const ph = line.match(PP_HEADER_RE);
    if (ph) {
      currentPP = {
        programNumber: parseInt(ph[3], 10),
        horseName: ph[4].trim(),
        connections: null,
        fields: {}, // label -> raw string value
      };
      if (currentRace) currentRace.runners.push(currentPP);
      continue;
    }

    const conn = line.match(CONNECTIONS_RE);
    if (conn && currentPP) {
      currentPP.connections = {
        jockey: conn[1].trim(),
        trainer: conn[2].trim(),
        owner: conn[3].trim(),
        weight: numOrNull(conn[4]),
        morningLine: numOrNull(conn[5]),
      };
      continue;
    }

    if (currentPP) {
      const fm = line.match(PP_FIELD_RE);
      if (fm) currentPP.fields[stripLabel(fm[2])] = fm[3].trim();
      continue;
    }

    if (currentRace) {
      const rf = line.match(RACE_PREAMBLE_FIELD_RE);
      if (rf) currentRace.preamble[stripLabel(rf[1])] = rf[3].trim();
    }
  }

  return races;
}

// ── Semantic extraction from one PP block's flat field map ──────────────────

function buildIndexedGroups(fields) {
  // base label -> Map(idx -> value)
  const groups = new Map();
  for (const label of Object.keys(fields)) {
    const ix = indexedLabel(label);
    if (!ix) continue;
    if (!groups.has(ix.base)) groups.set(ix.base, new Map());
    groups.get(ix.base).set(ix.idx, fields[label]);
  }
  return groups;
}

function extractWorkouts(fields, groups) {
  const bases = Array.from(groups.keys());

  // Group 1: workouts #1-#4 (exact base labels, no "5-12" qualifier).
  const g1 = {
    date: bases.find(b => /^date of workout$/i.test(b)),
    time: bases.find(b => /^time of workout$/i.test(b)),
    track: bases.find(b => /^track of workout$/i.test(b)),
    distance: bases.find(b => /^distance of workout$/i.test(b)),
    condition: bases.find(b => /^track condition of workout$/i.test(b)),
    description: bases.find(b => /^description of workout$/i.test(b)),
    bullet: bases.find(b => /^bullet indicator workout$/i.test(b)),
    mainInner: bases.find(b => /^main\/inner track indicator$/i.test(b)),
    worksAtTrkDisSrf: bases.find(b => /^# works at trk\/dis\/srf$/i.test(b)),
  };
  // Group 2: workouts #5-#12. Confirmed by direct inspection of a real file
  // that this group's labels are NOT simply group-1's labels with "#5 - #12"
  // inserted -- several are reworded or drop a word entirely (e.g. group 1's
  // "Track Condition of Workout" becomes just "Track Condition #5 - #12";
  // "Bullet indicator Workout" becomes "Bullet work indicator #5-#12"; "Main/
  // Inner track indicator" drops "track"; "Description of Workout" becomes
  // "Workout Description"). Matched here by exact regex against the
  // confirmed real label text, not fuzzy substring matching, after an
  // earlier fuzzy version silently produced `condition: null` for every
  // group-2 workout by requiring "workout" to appear in a label that omits it.
  const findExact = (re) => bases.find(b => re.test(b)) || null;
  const g2 = {
    date: findExact(/^Date of Workout #5\s*-\s*#12$/i),
    time: findExact(/^Time of Workout #5\s*-\s*#12$/i),
    track: findExact(/^Track of Workout #5\s*-\s*#12$/i),
    distance: findExact(/^Distance of Workout #5\s*-?\s*#12$/i),
    condition: findExact(/^Track Condition #5\s*-\s*#12$/i),
    description: findExact(/^Workout Description #5\s*-?\s*#12$/i),
    bullet: findExact(/^Bullet work indicator #5\s*-?\s*#12$/i),
    mainInner: findExact(/^Main\/Inner indicator #5\s*-\s*#12$/i),
    worksAtTrkDisSrf: findExact(/^# Works at Trk\/Dis\/Srf #5\s*-?\s*#12$/i),
  };

  const workouts = [];
  const readGroup = (map, base, idx) => (base && groups.has(base) && groups.get(base).has(idx)) ? groups.get(base).get(idx) : null;

  for (let i = 1; i <= 4; i++) {
    const date = readGroup(groups, g1.date, i);
    if (!date) continue;
    workouts.push({
      date, time: numOrNull(readGroup(groups, g1.time, i)), track: readGroup(groups, g1.track, i),
      distance: numOrNull(readGroup(groups, g1.distance, i)), condition: readGroup(groups, g1.condition, i),
      description: readGroup(groups, g1.description, i), bullet: readGroup(groups, g1.bullet, i) === '1',
      mainInner: readGroup(groups, g1.mainInner, i), worksAtTrkDisSrf: numOrNull(readGroup(groups, g1.worksAtTrkDisSrf, i)),
    });
  }
  for (let i = 1; i <= 8; i++) {
    const date = readGroup(groups, g2.date, i);
    if (!date) continue;
    workouts.push({
      date, time: numOrNull(readGroup(groups, g2.time, i)), track: readGroup(groups, g2.track, i),
      distance: numOrNull(readGroup(groups, g2.distance, i)), condition: readGroup(groups, g2.condition, i),
      description: readGroup(groups, g2.description, i), bullet: readGroup(groups, g2.bullet, i) === '1',
      mainInner: readGroup(groups, g2.mainInner, i), worksAtTrkDisSrf: numOrNull(readGroup(groups, g2.worksAtTrkDisSrf, i)),
    });
  }
  // Sort newest-first by date (YYYYMMDD strings sort correctly lexically).
  workouts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return workouts;
}

function extractPastRaces(fields, groups) {
  const bases = Array.from(groups.keys());
  const b = (re) => bases.find(x => re.test(x));
  const cols = {
    raceDate: b(/^race date$/i),
    trackCode: b(/^track code$/i),
    trackCondition: b(/^track condition$/i),
    distance: b(/^distance \(in yards\)$/i),
    surface: b(/^surface$/i),
    entrants: b(/^# of entrants$/i),
    postPosition: b(/^post position$/i),
    medication: b(/^medication$/i),
    tripComment: b(/^trip comment$/i),
    extendedStartComment: b(/^extended start comment$/i),
    winnerName: b(/^winner'?s name$/i),
    winnerMargin: b(/^winner'?s margin$/i),
    weight: b(/^weight$/i),
    odds: b(/^odds$/i),
    raceClassification: b(/^race classification$/i),
    claimingPrice: b(/^claiming price \(of horse\)$/i),
    purse: b(/^purse$/i),
    startCallPosition: b(/^start call position$/i),
    firstCallPosition: b(/^1st call position\(if any\)$/i),
    secondCallPosition: b(/^2nd call position\(if any\)$/i),
    stretchPosition: b(/^stretch position \(if any\)$/i),
    finishPosition: b(/^finish position$/i),
    finishMargin: b(/^finish btnlngths\/wnrs margin$/i),
    moneyPosition: b(/^money position$/i),
    trackVariant: b(/^track variant$/i),
    finalTime: b(/^final time$/i),
    trainer: b(/^trainer$/i),
    jockey: b(/^jockey$/i),
    raceType: b(/^race type$/i),
    favoriteIndicator: b(/^favorite indicator$/i),
  };
  const get = (col, i) => {
    const base = cols[col];
    if (!base || !groups.has(base)) return null;
    const v = groups.get(base).get(i);
    return v === undefined ? null : v;
  };

  const past = [];
  for (let i = 1; i <= 10; i++) {
    const raceDate = get('raceDate', i);
    if (!raceDate) continue;
    past.push({
      raceDate, trackCode: get('trackCode', i), trackCondition: get('trackCondition', i),
      distanceYards: numOrNull(get('distance', i)), surface: get('surface', i),
      entrants: numOrNull(get('entrants', i)), postPosition: numOrNull(get('postPosition', i)),
      medication: get('medication', i), tripComment: get('tripComment', i),
      extendedStartComment: get('extendedStartComment', i),
      winnerName: get('winnerName', i), winnerMargin: numOrNull(get('winnerMargin', i)),
      weight: numOrNull(get('weight', i)), odds: numOrNull(get('odds', i)),
      raceClassification: get('raceClassification', i), claimingPrice: numOrNull(get('claimingPrice', i)),
      purse: numOrNull(get('purse', i)),
      startCallPosition: numOrNull(get('startCallPosition', i)),
      firstCallPosition: numOrNull(get('firstCallPosition', i)),
      secondCallPosition: numOrNull(get('secondCallPosition', i)),
      stretchPosition: numOrNull(get('stretchPosition', i)),
      finishPosition: numOrNull(get('finishPosition', i)),
      finishMargin: numOrNull(get('finishMargin', i)),
      moneyPosition: numOrNull(get('moneyPosition', i)),
      trackVariant: numOrNull(get('trackVariant', i)),
      finalTime: numOrNull(get('finalTime', i)),
      trainer: get('trainer', i), jockey: get('jockey', i),
      raceType: get('raceType', i), favoriteIndicator: get('favoriteIndicator', i) === '1',
    });
  }
  // Sort newest-first.
  past.sort((a, b2) => (b2.raceDate || '').localeCompare(a.raceDate || ''));
  return past;
}

function extractBiasStats(fields) {
  const num = (label) => numOrNull(fields[label]);
  const pick = (re) => {
    for (const label of Object.keys(fields)) if (re.test(label)) return numOrNull(fields[label]);
    return null;
  };
  return {
    speedBiasMeet: num('Speed Bias% (Meet)'),
    speedBiasWeek: num('Speed Bias% (Week)'),
    postBiasMeet: {
      rail: pick(/^"Rail" Avg Win% for the Meet$/),
      oneToThree: pick(/^"1-3" Avg Win% for the Meet$/),
      fourToSeven: pick(/^"4-7" Avg Win% for the Meet$/),
      eightPlus: pick(/^"8\+" Avg Win% for the Meet$/),
    },
    postBiasWeek: {
      rail: pick(/^"Rail" Avg Win% for the Week$/),
      oneToThree: pick(/^"1-3" Avg Win% for the Week$/),
      fourToSeven: pick(/^"4-7" Avg Win% for the Week$/),
      eightPlus: pick(/^"8\+" Avg Win% for the Week$/),
    },
    paceStyleWinPctMeet: {
      E: pick(/^"E" %RacesWon for the Meet$/),
      EP: pick(/^"E\/P" %RacesWon for the Meet$/),
      P: pick(/^"P" %RacesWon for the Meet$/),
      S: pick(/^"S" %RacesWon for the Meet$/),
    },
    paceStyleWinPctWeek: {
      E: pick(/^"E" %RacesWon for the Week$/),
      EP: pick(/^"E\/P" %RacesWon for the Week$/),
      P: pick(/^"P" %RacesWon for the Week$/),
      S: pick(/^"S" %RacesWon for the Week$/),
    },
  };
}

function extractHorse(pp) {
  const groups = buildIndexedGroups(pp.fields);
  const f = pp.fields;
  return {
    programNumber: pp.programNumber,
    postPosition: numOrNull(f['Post Position']),
    horseName: pp.horseName,
    connections: pp.connections,
    daysSinceLastRace: numOrNull(f['# of days since last race']),
    workouts: extractWorkouts(f, groups),
    pastRaces: extractPastRaces(f, groups),
    biasStats: extractBiasStats(f),
  };
}

function extractRace(race) {
  const p = race.preamble;
  return {
    raceNumber: race.raceNumber,
    track: p['Track'] || null,
    date: p['Date'] || null,
    distanceYards: numOrNull(p['Distance']),
    surface: p['Surface'] || null,
    raceType: p['Race Type'] || null,
    purse: numOrNull(p['Purse']),
    ageSexRestrictions: p['Age/Sex Restrictions'] || null,
    wagerTypes: p['Wager Types'] || null,
    runners: race.runners.map(extractHorse),
  };
}

function main() {
  const [, , inputPath, track, date] = process.argv;
  if (!inputPath) {
    process.stderr.write('Usage: parse_pp_feed.js <input.md> [TRACK] [YYYY-MM-DD]\n');
    process.exit(1);
  }
  const text = fs.readFileSync(inputPath, 'utf8');
  const rawRaces = parsePpFeedMarkdown(text);
  const races = rawRaces.map(extractRace);
  const out = {
    source: 'independent-pp-feed',
    track: track || (races[0] && races[0].track) || null,
    date: date || (races[0] && races[0].date) || null,
    parsedAt: new Date().toISOString(),
    races,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) main();

module.exports = { parsePpFeedMarkdown, extractRace, extractHorse, extractWorkouts, extractPastRaces, extractBiasStats, indexedLabel, findBase };
