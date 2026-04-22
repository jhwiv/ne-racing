#!/usr/bin/env node
// One-shot script to generate data/fixtures/saratoga_2025_sample.json.
// Re-run this script to regenerate the fixture. The fixture is a placeholder
// set for UI dev only — see data/fixtures/README.md.

'use strict';

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', '..', 'data', 'fixtures', 'saratoga_2025_sample.json');

// --- Name pools: real, publicly-known 2025 NYRA circuit trainers/jockeys. --
// Used so typeahead feels realistic while the data is clearly flagged as
// placeholder. No claim is being made about any specific starter.
const JOCKEYS = [
  'Irad Ortiz Jr.', 'Jose Ortiz', 'Flavien Prat', 'Joel Rosario', 'Manuel Franco',
  'Javier Castellano', 'Luis Saez', 'Dylan Davis', 'Tyler Gaffalione', 'John Velazquez',
  'Kendrick Carmouche', 'Junior Alvarado', 'Jose Lezcano', 'Eric Cancel', 'Hector Diaz Jr.'
];
const TRAINERS = [
  'Chad Brown', 'Todd Pletcher', 'Bill Mott', 'Christophe Clement', 'Brad Cox',
  'Steve Asmussen', 'Mark Casse', 'Rudy Rodriguez', 'Jorge Abreu', 'Horacio De Paz',
  'Jena Antonucci', 'Mike Maker', 'Linda Rice', 'George Weaver', 'Cherie DeVaux'
];
const HORSE_NAMES = [
  'Silent Gavel', 'Spa Postcard', 'Oklahoma Bluebird', 'Union Avenue', 'Saratoga Sundial',
  'Whitney Breeze', 'Travers Lantern', 'Reading Room', 'Morning Line Myth', 'Congress Spring',
  'Fasig Lamplight', 'Lake House Luck', 'Broadway Hemlock', 'Springwater Spire', 'Caffery Park',
  'Piping Rock', 'Gideon Putnam', 'Oklahoma Clocker', 'Shuvee Lane', 'Bonnie Blues',
  'Clare Court', 'Woodlawn Avenue', 'Nelson House', 'Canfield Fountain', 'High Rock Spring',
  'Union Gables', 'Caroline Street', 'Phila Street', 'Broadway Limit', 'Yaddo Garden',
  'Circular Street', 'North Broadway', 'Lincoln Baths', 'Geyser Creek', 'Hall of Springs',
  'Lake Avenue', 'Ballston Spa', 'Skidmore Skies', 'Congress Park', 'Oklahoma Annex'
];
const DISTANCES = [
  { text: '5 1/2 Furlongs', furlongs: 5.5, surface: 'Dirt' },
  { text: '6 Furlongs', furlongs: 6, surface: 'Dirt' },
  { text: '6 1/2 Furlongs', furlongs: 6.5, surface: 'Dirt' },
  { text: '7 Furlongs', furlongs: 7, surface: 'Dirt' },
  { text: '1 Mile', furlongs: 8, surface: 'Dirt' },
  { text: '1 1/16 Miles', furlongs: 8.5, surface: 'Dirt' },
  { text: '1 1/8 Miles', furlongs: 9, surface: 'Dirt' },
  { text: '1 1/16 Miles', furlongs: 8.5, surface: 'Turf' },
  { text: '1 Mile', furlongs: 8, surface: 'Turf' },
  { text: '5 1/2 Furlongs', furlongs: 5.5, surface: 'Turf' },
];

// Real 2025 Saratoga Summer Meet: Thursday July 10 – Monday September 1.
// Dark days: Mondays and Tuesdays (except opening Monday Sep 1 closing day).
const MEET_START = '2025-07-10';
const MEET_END = '2025-09-01';
function allMeetDays() {
  const days = [];
  let d = new Date(MEET_START + 'T12:00:00');
  const end = new Date(MEET_END + 'T12:00:00');
  while (d <= end) {
    const dow = d.getDay(); // 0=Sun 1=Mon 2=Tue
    // Dark on Mon/Tue EXCEPT closing Monday 9/1 which is a race day
    const iso = d.toISOString().slice(0, 10);
    const isClosingMonday = (iso === MEET_END);
    if (!(dow === 1 && !isClosingMonday) && dow !== 2) {
      days.push(iso);
    }
    d.setDate(d.getDate() + 1);
  }
  return days;
}

// Deterministic pseudo-random so repeated generations produce the same file.
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xFFFFFFFF;
  };
}

function pick(arr, rng) { return arr[Math.floor(rng() * arr.length)]; }
function pickUnique(arr, n, rng) {
  const copy = arr.slice();
  const out = [];
  for (let i = 0; i < n && copy.length; i++) {
    const idx = Math.floor(rng() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function buildRace(dateStr, raceNum, rng) {
  const dist = pick(DISTANCES, rng);
  const fieldSize = 6 + Math.floor(rng() * 6); // 6..11
  const horseNames = pickUnique(HORSE_NAMES, fieldSize, rng);
  const postHour = 13 + Math.floor(raceNum - 1); // rough 1pm start, +1h/race
  const postMin = Math.floor(rng() * 6) * 10;     // 0, 10, 20, 30, 40, 50
  const postTime = String(postHour).padStart(2, '0') + ':' + String(postMin).padStart(2, '0');

  const mlPool = ['5/2', '3/1', '7/2', '9/2', '5/1', '6/1', '8/1', '10/1', '12/1', '15/1', '20/1', '9/5', '2/1'];

  const horses = horseNames.map((nm, i) => ({
    id: 'SAR-' + dateStr.replace(/-/g, '') + '-R' + raceNum + '-PP' + (i + 1),
    pp: i + 1,
    name: nm,
    jockey: pick(JOCKEYS, rng),
    trainer: pick(TRAINERS, rng),
    ml: pick(mlPool, rng),
    speedFigs: [null, null, null], // figures gated behind licensed source
    runningStyle: pick(['E', 'EP', 'P', 'S', 'NA'], rng),
    scratched: false,
    age: 3 + Math.floor(rng() * 4),
    sex: pick(['C', 'F', 'G', 'M'], rng),
    weight: 118 + Math.floor(rng() * 6),
  }));

  return {
    id: 'SAR-' + dateStr.replace(/-/g, '') + '-R' + raceNum,
    track: 'SAR',
    meet_id: 'SAR-2025-SUMMER',
    date: dateStr,
    num: raceNum,
    postTime: postTime,
    distance: dist.text,
    distance_furlongs: dist.furlongs,
    surface: dist.surface,
    purse: [50000, 62000, 75000, 90000, 120000, 175000][Math.floor(rng() * 6)],
    conditions: pick([
      'Maiden Special Weight', 'Allowance N1X', 'Allowance N2X',
      'Starter Allowance', 'Claiming $40,000', 'Stakes (Listed)'
    ], rng),
    status: 'Scheduled',
    horses: horses,
    expertPicks: [],
    data_status: 'placeholder_sample_for_ui_dev',
    updated: '2026-04-22T00:00:00Z'
  };
}

// Deterministic shuffle (Fisher–Yates with a seeded RNG) so we always pick
// the same 30 days unless we deliberately change SAMPLE_SEED.
const SAMPLE_SEED = 20250710;
const SAMPLE_DAYS = 30;
function pickSampleDays(allDays) {
  const rng = makeRng(SAMPLE_SEED ^ 0xC0DE);
  const arr = allDays.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr.slice(0, SAMPLE_DAYS).sort();
}

function main() {
  const allDays = allMeetDays();
  const days = pickSampleDays(allDays);
  const races = [];
  days.forEach((d, dayIdx) => {
    const rng = makeRng(SAMPLE_SEED + dayIdx * 7919);
    const cardSize = 9 + Math.floor(rng() * 3); // 9..11
    for (let n = 1; n <= cardSize; n++) races.push(buildRace(d, n, rng));
  });

  const out = {
    meta: {
      generated_at: new Date().toISOString(),
      generator: 'scripts/ingest/build_sample_fixture.js',
      data_status: 'placeholder_sample_for_ui_dev',
      license_notice: 'Hand-authored placeholder set — see data/fixtures/README.md',
      sample_strategy: 'random-' + SAMPLE_DAYS + '-days (seed=' + SAMPLE_SEED + ')'
    },
    meet: {
      id: 'SAR-2025-SUMMER',
      track: 'SAR',
      name: '2025 Saratoga Summer Meet',
      year: 2025,
      start_date: MEET_START,
      end_date: MEET_END,
      race_days_in_meet: allDays.length,
      sampled_race_days: days.length,
      sampled_dates: days
    },
    races: races
  };

  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('wrote ' + races.length + ' sample races across ' + days.length + ' days to ' + OUT);
}

if (require.main === module) main();
