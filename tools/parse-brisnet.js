#!/usr/bin/env node
/**
 * Brisnet single-file PP parser.
 *
 * Input:  /tmp/brisnet/SAR{MMDD}.DRF  (comma-delimited, 1,435 fields per row)
 * Output: /tmp/ne-racing-current/data/brisnet-SAR-{YYYY-MM-DD}.json
 *
 * Field map sourced from:
 *   https://support.brisnet.com/hc/en-us/articles/360056092092
 *
 * Per-runner output shape (matches what the worker enrichment shim already
 * consumes via index.html scoring engine):
 *   {
 *     programNumber, postPosition, horseName, morningLine,
 *     jockey, trainer,
 *     jockeyMeetWinPct, trainerMeetWinPct,
 *     primePower, runStyle, quirinSpeed, speedPar, daysOff,
 *     bestBrisAllWeather,
 *     speedFigs: [n,n,n],          // last 3 BRIS Speed Ratings, most-recent first
 *     speedFigsExtended: [n..n],   // up to 10
 *     lastClass,                    // BRIS class normalized for scoring engine
 *     lastClassRaw,                 // raw Brisnet class code last race
 *     tjCombo365: { sts, wins, places, shows, roi2 }
 *   }
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const DATES = [
  { mmdd: '0704', iso: '2026-07-04' },
  { mmdd: '0705', iso: '2026-07-05' },
  { mmdd: '0709', iso: '2026-07-09' },
];
const TRACK = 'SAR';
const OUT_DIR = path.join(__dirname, '..', 'data');

// Map Brisnet class codes to the CLASS_SCALE the scoring engine uses.
// CLASS_SCALE in app.html is keyed by short codes the legacy build-entries.js
// used. We use simplest robust mapping based on Brisnet class field (#11)
// and grade indicator at PP block (~F1086+) for last race.
function normalizeClass(raw, grade) {
  if (!raw) return null;
  const r = String(raw).toLowerCase();
  if (grade) {
    const g = String(grade).toUpperCase();
    if (g === 'G1') return 'G1';
    if (g === 'G2') return 'G2';
    if (g === 'G3') return 'G3';
  }
  if (r.includes('md sp wt') || r.includes('msw')) return 'MSW';
  if (r.includes('md clm') || r.includes('mdn clm') || r.includes('mclm')) return 'MCL';
  if (r.includes('stk') || r.includes('stakes')) return 'STK';
  if (r.includes('alw n1x') || r.includes('alw nw1')) return 'ALW1';
  if (r.includes('alw n2x') || r.includes('alw nw2')) return 'ALW2';
  if (r.includes('alw n3x') || r.includes('alw nw3')) return 'ALW3';
  if (r.includes('alw'))     return 'ALW';
  if (r.includes('clm'))     return 'CLM';
  return null;
}

// "ORTIZ IRAD JR" → "Irad Ortiz, Jr."   /   "GARGAN DANNY" → "Danny Gargan"
function humanizeName(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/^"|"$/g, '').trim();
  if (!s) return null;
  const parts = s.split(/\s+/);
  // Detect trailing JR/SR/II/III suffix
  let suffix = '';
  if (parts.length > 1 && /^(JR|SR|II|III)$/i.test(parts[parts.length - 1])) {
    suffix = parts.pop();
  }
  // Brisnet format: LAST FIRST MIDDLE  →  First Middle Last [, Jr.]
  const last = parts.shift() || '';
  const first = parts.shift() || '';
  const middle = parts.join(' ');
  const pretty = [first, middle, last].filter(Boolean)
    .map(p => p.charAt(0) + p.slice(1).toLowerCase())
    .join(' ');
  if (suffix) {
    const suf = suffix.toUpperCase() === 'JR' ? 'Jr.'
              : suffix.toUpperCase() === 'SR' ? 'Sr.'
              : suffix.toUpperCase();
    return pretty + ', ' + suf;
  }
  return pretty;
}

// Strip wrapping quotes Brisnet uses for text fields.
function unq(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).trim() || null;
  return s;
}
function num(v) {
  const s = unq(v);
  if (s == null) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}
function int(v) {
  const n = num(v);
  return n == null ? null : Math.round(n);
}
function pct(num, denom) {
  if (!denom || !Number.isFinite(num) || !Number.isFinite(denom)) return null;
  return Math.round((num / denom) * 100);
}

function brisnetCsvSplit(line) {
  // Brisnet single-file is comma-delimited with double-quoted text.
  // No embedded commas inside quotes that we've seen, but be safe.
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; cur += c; continue; }
    if (c === ',' && !inQ) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function parseRunner(row, raceContext) {
  const f = row; // 0-indexed array; Brisnet docs use 1-indexed positions.
  const g = i => f[i - 1]; // 1-indexed helper

  // Past-performance: pull up to 10 BRIS Speed Ratings.
  // From sample inspection: F1167..F1176 are BRIS Speed Ratings for the
  // last 10 races (most recent first). Empty / 0 / -999 / -1 / -3 ≈ no data,
  // but valid figs can include single-digit and negative track variants — we
  // accept anything in [-200, 200].
  const speedFigs10 = [];
  for (let i = 1167; i <= 1176; i++) {
    const v = int(g(i));
    if (v == null) continue;
    if (v < -50 || v > 200) continue;
    if (v === 0) continue;
    speedFigs10.push(v);
  }
  // Take first 3 for scoring engine, but ALSO pad with nulls and reverse
  // order to chronological (oldest→newest) so latest = last element, matching
  // the existing scoring engine convention.
  const last3 = speedFigs10.slice(0, 3);
  while (last3.length < 3) last3.push(null);
  // scoring engine uses speedFigs[length-1] as "latest" → so we need newest at end.
  const speedFigsForScoring = last3.slice().reverse();

  // Last race class for class-shift scoring.
  // PP block class label is at F1419-1428 (10 races, most recent first).
  // Grade at F1086-1095. Use last race only.
  const lastRaceClassRaw = unq(g(1419));
  const lastRaceGrade    = unq(g(1086));
  const lastClass = normalizeClass(lastRaceClassRaw, lastRaceGrade)
                  || normalizeClass(unq(g(11)), null);

  const primePower = num(g(251));
  const runStyle   = unq(g(210)) === 'NA' ? null : unq(g(210));
  const quirinSpeed = int(g(211));
  const speedPar   = int(g(217));
  const daysOff    = int(g(224));

  const tjSts    = int(g(219));
  const tjWins   = int(g(220));
  const tjPlaces = int(g(221));
  const tjShows  = int(g(222));
  const tjRoi    = num(g(223));

  // Jockey meet stats: starts/wins (fields 35/36)
  const jkySts  = int(g(35));
  const jkyWins = int(g(36));
  // Trainer meet stats: 29/30
  const trnSts  = int(g(29));
  const trnWins = int(g(30));

  return {
    programNumber: unq(g(43)) || String(int(g(4)) || ''),
    postPosition: int(g(4)),
    horseName: unq(g(45)),
    morningLine: num(g(44)),
    weight: int(g(51)),
    jockey: humanizeName(unq(g(33))),
    trainer: humanizeName(unq(g(28))),
    jockeyMeetWinPct: pct(jkyWins, jkySts),
    trainerMeetWinPct: pct(trnWins, trnSts),
    primePower,
    runStyle,
    quirinSpeed,
    speedPar,
    daysOff,
    bestBrisAllWeather: int(g(236)),
    speedFigs: speedFigsForScoring, // [oldest...latest], length 3
    speedFigsExtended: speedFigs10, // up to 10, most-recent first
    lastClass,
    lastClassRaw: lastRaceClassRaw,
    tjCombo365: {
      starts: tjSts, wins: tjWins, places: tjPlaces, shows: tjShows, roi2: tjRoi,
      winPct: pct(tjWins, tjSts),
    },
  };
}

function parseFile(mmdd, iso) {
  const drf = `/tmp/brisnet/SAR${mmdd}.DRF`;
  const raw = fs.readFileSync(drf, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);

  // Group rows by race number (field 3) into races.
  const racesMap = new Map();
  for (const line of lines) {
    const row = brisnetCsvSplit(line);
    const raceNum = int(row[2]); // 1-indexed F3
    if (!raceNum) continue;

    if (!racesMap.has(raceNum)) {
      racesMap.set(raceNum, {
        raceNumber: raceNum,
        distanceYards: int(row[5]), // F6
        surfaceCode:   unq(row[6]), // F7
        raceType:      unq(row[8]), // F9
        raceClassRaw:  unq(row[10]), // F11
        purse:         int(row[11]), // F12
        runners: [],
      });
    }
    const race = racesMap.get(raceNum);
    race.runners.push(parseRunner(row, race));
  }

  const races = Array.from(racesMap.values())
    .sort((a, b) => a.raceNumber - b.raceNumber)
    .map(r => ({
      ...r,
      runnerCount: r.runners.length,
      runners: r.runners.sort((a, b) => (a.postPosition || 99) - (b.postPosition || 99)),
    }));

  const totalRunners = races.reduce((n, r) => n + r.runnerCount, 0);
  const hasPrimePower = races.reduce(
    (n, r) => n + r.runners.filter(x => x.primePower != null).length, 0,
  );
  const hasSpeedFigs = races.reduce(
    (n, r) => n + r.runners.filter(x => x.speedFigs.some(s => s != null)).length, 0,
  );

  return {
    source: 'brisnet-single-file',
    track: TRACK,
    date: iso,
    generatedAt: new Date().toISOString(),
    raceCount: races.length,
    runnerCount: totalRunners,
    coverage: {
      primePower: hasPrimePower,
      speedFigs: hasSpeedFigs,
      primePowerPct: Math.round((hasPrimePower / totalRunners) * 100),
      speedFigsPct: Math.round((hasSpeedFigs / totalRunners) * 100),
    },
    races,
  };
}

// Main
fs.mkdirSync(OUT_DIR, { recursive: true });
const summary = [];
for (const { mmdd, iso } of DATES) {
  try {
    const out = parseFile(mmdd, iso);
    const outFile = path.join(OUT_DIR, `brisnet-SAR-${iso}.json`);
    fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
    summary.push({
      date: iso,
      races: out.raceCount,
      runners: out.runnerCount,
      primePowerCoverage: `${out.coverage.primePower}/${out.runnerCount} (${out.coverage.primePowerPct}%)`,
      speedFigsCoverage: `${out.coverage.speedFigs}/${out.runnerCount} (${out.coverage.speedFigsPct}%)`,
      outFile,
    });
  } catch (e) {
    summary.push({ date: iso, error: e.message });
  }
}
console.log(JSON.stringify(summary, null, 2));
