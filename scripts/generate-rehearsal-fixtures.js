#!/usr/bin/env node
'use strict';

/**
 * generate-rehearsal-fixtures.js
 *
 * Generates two synthetic entries files that match the live worker's
 * expected static shape, for end-to-end UI rehearsal BEFORE the user
 * subscribes to a live data feed:
 *
 *   data/entries-BEL-2026-06-03.json   (Belmont Stakes Festival opener, run at Saratoga)
 *   data/entries-SAR-2026-07-03.json   (Saratoga summer meet opener)
 *
 * These are clearly marked as `dataMode: "rehearsal"` inside the JSON so
 * the UI can label them appropriately (TBD: surface this in the diagnostic
 * panel). All horse names are fictional. All jockey/trainer names are
 * fictional unless they're well-known NY-circuit regulars.
 *
 * Run:
 *   node scripts/generate-rehearsal-fixtures.js
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// --- Fictional horse name pool (curated for plausibility) -------------------
const HORSE_NAMES = [
  'Crystal Frontier', 'Bourbon Echo', 'Stoneglass', 'Wire to Wire', 'Last Call',
  'Hudson Honor', 'Empire Standard', 'Pinhook', 'Spinaway Saint', 'Travers Toast',
  'Open Question', 'Saturday Sermon', 'Velvet Touch', 'Iron Cipher', 'Coastal Plain',
  'High Roller', 'Mainline Money', 'Quiet Power', 'Stable Mind', 'Vault Storm',
  'Catskill Dawn', 'Mohawk Trail', 'Eight Furlong', 'Whirlaway Echo', 'Track Bias',
  'Cold Hard Cash', 'Late Pace', 'Closing Kick', 'Photo Finish', 'Wire Walker',
  'Steel Cathedral', 'Glass Empire', 'Marble Hill', 'Riverside Inn', 'Brookside Park',
  'Lasting Glory', 'Brave Talker', 'Steady Hand', 'Northern Standard', 'Gulfstream Sun',
  'Saratoga Special', 'Belmont Bound', 'Triple Crown Echo', 'Inside Rail', 'Outside Path',
  'Speed Figure', 'Class Drop', 'Sharp Work', 'Bullet Move', 'First Off Bench',
  'Galloping Out', 'Rated Pace', 'Cleared Inside', 'Late Kick', 'Held On Gamely',
  'Drove Past', 'Drew Off', 'Boxed In', 'Stayed On', 'Showed Late',
  'Wisteria Lane', 'Birchwood', 'Chestnut Hill', 'Linden Park', 'Maple Knoll',
  'Westfield', 'Eastvale', 'Northbound', 'Southport', 'Centerline',
  'Pearl District', 'Diamond Cluster', 'Ruby Cross', 'Sapphire Rest', 'Emerald Cut',
  'Old Friends', 'New Money', 'Quiet Confidence', 'Loud Whisper', 'Soft Landing',
  'Hard Knocks', 'Easy Money', 'Slow Burn', 'Fast Track', 'Mid Pack',
  'Vanguard', 'Bellwether', 'Polestar', 'Lodestar', 'Northstar',
];

// --- Plausible jockey pool (some real NY regulars, weights randomised) ------
const JOCKEYS = [
  { name: 'Jose L. Ortiz', pct: 22 },
  { name: 'Irad Ortiz Jr.', pct: 26 },
  { name: 'Joel Rosario', pct: 21 },
  { name: 'Manny Franco', pct: 19 },
  { name: 'Luis Saez', pct: 20 },
  { name: 'Flavien Prat', pct: 24 },
  { name: 'John Velazquez', pct: 17 },
  { name: 'Junior Alvarado', pct: 14 },
  { name: 'Eric Cancel', pct: 12 },
  { name: 'Kendrick Carmouche', pct: 11 },
  { name: 'Dylan Davis', pct: 15 },
  { name: 'Tyler Gaffalione', pct: 18 },
  { name: 'Trevor McCarthy', pct: 13 },
  { name: 'Reylu Gutierrez', pct: 10 },
  { name: 'Romero Maragh', pct: 9 },
];

const TRAINERS = [
  { name: 'Chad C. Brown', pct: 28 },
  { name: 'Todd A. Pletcher', pct: 24 },
  { name: 'Bill Mott', pct: 18 },
  { name: 'Christophe Clement', pct: 17 },
  { name: 'Brad H. Cox', pct: 26 },
  { name: 'Steve Asmussen', pct: 19 },
  { name: 'Linda Rice', pct: 22 },
  { name: 'Rudy R. Rodriguez', pct: 18 },
  { name: 'David Donk', pct: 14 },
  { name: 'Jorge Abreu', pct: 16 },
  { name: 'Mike Maker', pct: 15 },
  { name: 'James A. Jerkens', pct: 13 },
  { name: 'Jason Servis', pct: 17 },
  { name: 'Gary C. Contessa', pct: 11 },
  { name: 'Carlos Martin', pct: 10 },
];

const RUNNING_STYLES = ['E', 'E/P', 'P', 'P', 'S', 'S']; // weighted toward presser
const ML_ODDS = ['5/2', '3/1', '7/2', '4/1', '9/2', '5/1', '6/1', '8/1', '10/1', '12/1', '15/1', '20/1', '30/1'];

// --- Deterministic RNG so file regeneration is stable ------------------------
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

function buildEntry(rand, pp, distance, surface, race_type_code) {
  const horse   = pickWeighted(rand, HORSE_NAMES);
  const jockey  = pickWeighted(rand, JOCKEYS);
  const trainer = pickWeighted(rand, TRAINERS);
  const ml      = pickWeighted(rand, ML_ODDS);
  const style   = pickWeighted(rand, RUNNING_STYLES);

  // Speed figures: cluster around 75-95 with a long tail down to 50
  const baseFig = 70 + Math.floor(rand() * 25);
  const speedFigs = [
    baseFig + Math.floor(rand() * 10 - 5),
    baseFig + Math.floor(rand() * 12 - 6),
    baseFig + Math.floor(rand() * 14 - 7),
  ].map(v => Math.max(40, Math.min(110, v)));

  const lastClassPool = {
    MSW: ['MSW', 'MCL'],
    MCL: ['MCL', 'MSW'],
    ALW: ['ALW', 'AOC', 'MSW'],
    AOC: ['AOC', 'ALW', 'CLM'],
    CLM: ['CLM', 'AOC'],
    SOC: ['ALW', 'AOC'],
    STK: ['STK', 'GR3', 'GR2'],
    GR3: ['GR3', 'STK', 'ALW'],
    GR2: ['GR2', 'GR3', 'GR1'],
    GR1: ['GR1', 'GR2'],
  };
  const lastClass = pickWeighted(rand, lastClassPool[race_type_code] || ['ALW']);

  // Last race date: 14-60 days back
  const daysBack = 14 + Math.floor(rand() * 46);
  const lastRace = new Date('2026-06-03');
  lastRace.setDate(lastRace.getDate() - daysBack);
  const lastRaceDate = lastRace.toISOString().slice(0, 10);

  return {
    pp,
    name: horse,
    jockey: jockey.name,
    trainer: trainer.name,
    weight: String(118 + Math.floor(rand() * 8)),  // 118-125
    scratched: false,
    ml,
    speedFigs,
    runningStyle: style,
    lastClass,
    jockeyPct: jockey.pct,
    trainerPct: trainer.pct,
    lastRaceDate,
    dataCompleteness: 1,
  };
}

function buildRace(rand, raceNum, raceMeta) {
  const fieldSize = raceMeta.fieldSize || (6 + Math.floor(rand() * 5)); // 6-10
  const usedNames = new Set();
  const entries = [];
  for (let pp = 1; pp <= fieldSize; pp++) {
    let entry;
    let attempts = 0;
    do {
      entry = buildEntry(rand, pp, raceMeta.distance, raceMeta.surface, raceMeta.code);
      attempts++;
    } while (usedNames.has(entry.name) && attempts < 12);
    usedNames.add(entry.name);
    entries.push(entry);
  }

  // Expert picks: 3-4 sources each pick a top horse (lowest ML wins more often)
  const sorted = entries.slice().sort((a, b) => {
    const aOdds = parseInt(a.ml.split('/')[0], 10);
    const bOdds = parseInt(b.ml.split('/')[0], 10);
    return aOdds - bOdds;
  });
  const top4pp = sorted.slice(0, 4).map(e => e.pp);

  const expertPicks = [
    { source: 'NYRA - Serling',  pick: top4pp[0], picks: top4pp,                horseName: sorted[0].name },
    { source: 'NYRA - Aragona',  pick: top4pp[0], picks: [top4pp[0], top4pp[2], top4pp[1], top4pp[3]], horseName: sorted[0].name },
    { source: 'DRF Consensus',   pick: top4pp[1], picks: [top4pp[1], top4pp[0], top4pp[2], top4pp[3]], horseName: sorted[1].name },
    { source: 'TimeformUS',      pick: top4pp[0], picks: top4pp,                horseName: sorted[0].name },
  ];

  return {
    race_number: raceNum,
    post_time: raceMeta.postTime,
    purse: raceMeta.purse,
    race_type: raceMeta.type,
    conditions: raceMeta.conditions,
    distance: raceMeta.distance,
    surface: raceMeta.surface,
    race_type_code: raceMeta.code,
    entries,
    expertPicks,
  };
}

// --- Belmont Stakes Festival opener (Jun 3, 2026 — run at Saratoga) ---------
// NYRA shifted the Belmont Stakes Festival to Saratoga while the new Belmont
// Park is under construction. Track code BEL still routes to the festival.
const BEL_JUN3_RACES = [
  { postTime: '1:00 PM', purse: '$100,000', type: 'Maiden Special Weight',  code: 'MSW',  distance: '6F',     surface: 'Dirt', conditions: 'MAIDENS, TWO YEAR OLDS. Weight 119 lbs.', fieldSize: 9 },
  { postTime: '1:30 PM', purse: '$110,000', type: 'Allowance Optional Claiming', code: 'AOC', distance: '1 1/16M', surface: 'Turf', conditions: 'FILLIES AND MARES, THREE YEARS OLD AND UPWARD WHICH HAVE NEVER WON A RACE OTHER THAN MAIDEN, CLAIMING, STARTER, OR STATE BRED OR WHICH HAVE NEVER WON THREE RACES OR OPTIONAL CLAIMING PRICE $80,000.', fieldSize: 10 },
  { postTime: '2:00 PM', purse: '$150,000', type: 'Listed Stakes',          code: 'STK',  distance: '6F',     surface: 'Dirt', conditions: 'THREE YEAR OLDS AND UPWARD. Weight 122 lbs. Non-winners of two races other than maiden or claiming since April 1 allowed 2 lbs.', fieldSize: 8 },
  { postTime: '2:30 PM', purse: '$120,000', type: 'Allowance',              code: 'ALW',  distance: '1 1/8M', surface: 'Turf', conditions: 'THREE YEAR OLDS AND UPWARD WHICH HAVE NEVER WON A RACE OTHER THAN MAIDEN, CLAIMING, STARTER, OR STATE BRED.', fieldSize: 9 },
  { postTime: '3:00 PM', purse: '$300,000', type: 'Grade 3 Stakes',         code: 'GR3',  distance: '1 1/16M', surface: 'Turf', conditions: 'TRUE NORTH HANDICAP — THREE YEAR OLDS AND UPWARD. Weight: Three Year Olds, 118 lbs.; Older, 124 lbs.', fieldSize: 10 },
  { postTime: '3:30 PM', purse: '$350,000', type: 'Grade 2 Stakes',         code: 'GR2',  distance: '1 1/4M', surface: 'Dirt', conditions: 'BROOKLYN STAKES — FOUR YEAR OLDS AND UPWARD. Weight 124 lbs.', fieldSize: 7 },
  { postTime: '4:00 PM', purse: '$400,000', type: 'Grade 2 Stakes',         code: 'GR2',  distance: '1M',     surface: 'Turf', conditions: 'JAIPUR STAKES — THREE YEAR OLDS AND UPWARD. Weight: Three Year Olds, 118 lbs.; Older, 124 lbs.', fieldSize: 12 },
  { postTime: '4:30 PM', purse: '$500,000', type: 'Grade 1 Stakes',         code: 'GR1',  distance: '1 1/8M', surface: 'Dirt', conditions: 'MET MILE — THREE YEAR OLDS AND UPWARD. Weight: Three Year Olds, 121 lbs.; Older, 124 lbs.', fieldSize: 8 },
  { postTime: '5:00 PM', purse: '$300,000', type: 'Grade 3 Stakes',         code: 'GR3',  distance: '6F',     surface: 'Dirt', conditions: 'TOM FOOL HANDICAP — FOUR YEAR OLDS AND UPWARD. Weight 122 lbs.', fieldSize: 9 },
];

const SAR_JUL3_RACES = [
  { postTime: '1:10 PM', purse: '$95,000',  type: 'Maiden Special Weight',  code: 'MSW',  distance: '5 1/2F', surface: 'Turf', conditions: 'MAIDENS, TWO YEAR OLDS. Weight 119 lbs.', fieldSize: 12 },
  { postTime: '1:42 PM', purse: '$85,000',  type: 'Maiden Claiming',        code: 'MCL',  distance: '6F',     surface: 'Dirt', conditions: 'MAIDENS, THREE YEARS OLD AND UPWARD. Claiming price $50,000.', fieldSize: 9 },
  { postTime: '2:14 PM', purse: '$110,000', type: 'Allowance',              code: 'ALW',  distance: '1 1/16M', surface: 'Turf', conditions: 'FILLIES AND MARES, THREE YEARS OLD AND UPWARD WHICH HAVE NEVER WON A RACE OTHER THAN MAIDEN OR CLAIMING.', fieldSize: 11 },
  { postTime: '2:46 PM', purse: '$72,000',  type: 'Claiming',               code: 'CLM',  distance: '7F',     surface: 'Dirt', conditions: 'THREE YEARS OLD AND UPWARD. Claiming price $40,000.', fieldSize: 10 },
  { postTime: '3:18 PM', purse: '$130,000', type: 'Allowance Optional Claiming', code: 'AOC', distance: '1 1/8M', surface: 'Turf', conditions: 'THREE YEARS OLD AND UPWARD WHICH HAVE NEVER WON A RACE OTHER THAN MAIDEN, CLAIMING, STARTER, OR STATE BRED OR WHICH HAVE NEVER WON TWO RACES OR OPTIONAL CLAIMING PRICE $80,000.', fieldSize: 10 },
  { postTime: '3:50 PM', purse: '$200,000', type: 'Listed Stakes',          code: 'STK',  distance: '1M',     surface: 'Dirt', conditions: 'SARATOGA OPENING DAY HANDICAP — THREE YEARS OLD AND UPWARD. Weight 124 lbs.', fieldSize: 9 },
  { postTime: '4:22 PM', purse: '$110,000', type: 'Allowance',              code: 'ALW',  distance: '6F',     surface: 'Dirt', conditions: 'FILLIES, THREE YEARS OLD. Weight 122 lbs.', fieldSize: 8 },
  { postTime: '4:54 PM', purse: '$95,000',  type: 'Maiden Special Weight',  code: 'MSW',  distance: '1 1/16M', surface: 'Turf', conditions: 'MAIDENS, THREE YEARS OLD AND UPWARD.', fieldSize: 12 },
  { postTime: '5:26 PM', purse: '$150,000', type: 'Allowance Optional Claiming', code: 'AOC', distance: '1 1/4M', surface: 'Turf', conditions: 'FOUR YEARS OLD AND UPWARD WHICH HAVE NEVER WON A RACE OTHER THAN MAIDEN, CLAIMING, STARTER, OR STATE BRED OR WHICH HAVE NEVER WON THREE RACES OR OPTIONAL CLAIMING PRICE $100,000.', fieldSize: 9 },
  { postTime: '5:58 PM', purse: '$80,000',  type: 'Claiming',               code: 'CLM',  distance: '1 1/16M', surface: 'Turf', conditions: 'THREE YEARS OLD AND UPWARD. Claiming price $35,000.', fieldSize: 10 },
];

function buildCard(track, date, raceList, seed, banner) {
  const rand = mulberry32(seed);
  const races = raceList.map((meta, i) => buildRace(rand, i + 1, meta));
  return {
    track,
    date,
    dataMode: 'rehearsal',
    rehearsalNote: banner,
    races,
  };
}

const belCard = buildCard(
  'BEL', '2026-06-03', BEL_JUN3_RACES, 20260603,
  'Synthetic rehearsal card for Belmont Stakes Festival opener (run at Saratoga). Horses fictional; race meta plausible. Replace with live data on cutover.'
);
const sarCard = buildCard(
  'SAR', '2026-07-03', SAR_JUL3_RACES, 20260703,
  'Synthetic rehearsal card for Saratoga summer meet opener. Horses fictional; race meta plausible. Replace with live data on cutover.'
);

const belPath = path.join(DATA_DIR, 'entries-BEL-2026-06-03.json');
const sarPath = path.join(DATA_DIR, 'entries-SAR-2026-07-03.json');

fs.writeFileSync(belPath, JSON.stringify(belCard, null, 2) + '\n', 'utf-8');
fs.writeFileSync(sarPath, JSON.stringify(sarCard, null, 2) + '\n', 'utf-8');

console.log('Wrote:', belPath);
console.log('  Races:', belCard.races.length, '— Total entries:', belCard.races.reduce((s, r) => s + r.entries.length, 0));
console.log('Wrote:', sarPath);
console.log('  Races:', sarCard.races.length, '— Total entries:', sarCard.races.reduce((s, r) => s + r.entries.length, 0));
