'use strict';

// Regression coverage for tools/parse_pp_feed.js, the parser for the
// independent (confirmed non-Brisnet, 2026-08-26) markdown PP feed. The
// fixture below reproduces the exact structural quirks found by direct
// inspection of a real file: race preamble uses `- **Label** (F#): value`
// while PP-block fields use `- F# Label: value`; workouts #5-#12 use
// different label wording than workouts #1-#4 for several fields (see the
// comment in extractWorkouts()).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePpFeedMarkdown, extractRace, indexedLabel, findBase,
} = require('../tools/parse_pp_feed.js');

const FIXTURE = `# Saratoga — August 26, 2026

## Race 1

- **Track** (F1): SAR
- **Date** (F2): 20260826
- **Distance** (F6): 1430 yards (~6.50 furlongs)
- **Surface** (F7): D (Dirt)
- **Race Type** (F8): S (Maiden Special Weight)
- **Purse** (F12): 90000
- **Age/Sex Restrictions** (F144): AOF (2yo, only, fillies only)
- **Wager Types** (F1142-1150): EXACTA ($1); TRIFECTA (.50)

### Race 1 — PP 1 (Pgm 1) — ATLAS A EYE

_Jockey: FRANCO MANUEL · Trainer: MOTT RILEY · Owner: THOROBID AI HOLDINGS · Wt: 123 · ML: 1.80_

- F4 Post Position: 1
- F13 Horse Name: ATLAS A EYE
- F134 # of days since last race: 40
- F89 Date of Workout #1: 20260816
- F93 Time of Workout #1: 48.60
- F97 Track of Workout #1: SAR
- F101 Distance of Workout #1: 880
- F105 Track Condition of Workout #1: ft
- F109 Description of Workout #1: B
- F117 Bullet indicator Workout #1: 0
- F121 Main/Inner track indicator #1: MT
- F125 # Works at Trk/Dis/Srf #1: 151
- F1045 Date of Workout #5 - #12 #1: 20260619
- F1053 Time of Workout #5 - #12 #1: 47.60
- F1061 Track of Workout #5 - #12 #1: CD
- F1069 Distance of Workout #5-#12 #1: 880
- F1077 Track Condition #5 - #12 #1: ft
- F1085 Workout Description #5-#12 #1: B
- F1101 Bullet work indicator #5-#12 #1: 0
- F1109 Main/Inner indicator #5-#12 #1: MT
- F1117 # Works at Trk/Dis/Srf #5-#12 #1: 82
- F206 Race Date #1: 20260717
- F226 Track Code #1: SAR
- F246 Track Condition #1: FT
- F256 Distance (in yards) #1: 1210
- F266 Surface #1: D
- F286 Post Position #1: 9
- F316 Trip Comment #1: 4-3w; led uppr to 1/8p
- F406 Extended Start Comment #1: 07-17-26 Brk out st; chased 4-3w
- F456 Odds #1: 4.06
- F506 Start Call Position #1: 6
- F556 Finish Position #1: 2
- F616 Finish BtnLngths/Wnrs margin #1: 1.75
- F796 Final Time #1: 67.07
- F816 Trainer #1: MOTT RILEY
- F826 Jockey #1: FRANCO MANUEL
- F876 Favorite indicator #1: 0
- F933 Speed Bias% (Meet): 80.00
- F934 Speed Bias% (Week): 100.0
- F971 "Rail" Avg Win% for the Meet: 13.33
- F972 "1-3" Avg Win% for the Meet: 14.44
- F973 "4-7" Avg Win% for the Meet: 12.50
- F974 "8+" Avg Win% for the Meet: 7.50
- F963 "E" %RacesWon for the Meet: 26.67
- F964 "E/P" %RacesWon for the Meet: 53.33
- F965 "P" %RacesWon for the Meet: 3.33
- F966 "S" %RacesWon for the Meet: 16.67

### Race 1 — PP 2 (Pgm 2) — SECOND HORSE

_Jockey: JANE DOE · Trainer: JOHN SMITH · Owner: SOMEBODY · Wt: 120 · ML: 3.00_

- F4 Post Position: 2
- F13 Horse Name: SECOND HORSE
`;

test('indexedLabel splits trailing "#N" from a base label', () => {
  assert.deepEqual(indexedLabel('Race Date #1'), { base: 'Race Date', idx: 1 });
  assert.equal(indexedLabel('Horse Name'), null);
});

test('findBase matches by required substrings, tolerant of spacing', () => {
  const bases = ['Date of Workout', 'Date of Workout #5 - #12', 'Time of Workout'];
  assert.equal(findBase(bases, ['date', 'workout', '5', '12']), 'Date of Workout #5 - #12');
});

test('parsePpFeedMarkdown finds both races/PPs and separates preamble from PP fields', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  assert.equal(races.length, 1);
  assert.equal(races[0].raceNumber, 1);
  assert.equal(races[0].runners.length, 2);
  assert.equal(races[0].runners[0].horseName, 'ATLAS A EYE');
  assert.equal(races[0].preamble['Track'], 'SAR');
  assert.equal(races[0].runners[0].fields['Post Position'], '1');
});

test('extractRace: race-level preamble fields', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  const race = extractRace(races[0]);
  assert.equal(race.track, 'SAR');
  assert.equal(race.date, '20260826');
  assert.equal(race.distanceYards, 1430);
  assert.equal(race.purse, 90000);
});

test('extractRace: connections line parsed correctly', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  const race = extractRace(races[0]);
  const h = race.runners[0];
  assert.deepEqual(h.connections, {
    jockey: 'FRANCO MANUEL', trainer: 'MOTT RILEY', owner: 'THOROBID AI HOLDINGS',
    weight: 123, morningLine: 1.8,
  });
});

test('extractRace: workouts #1-#4 and #5-#12 both extracted despite differing label wording', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  const h = extractRace(races[0]).runners[0];
  assert.equal(h.workouts.length, 2);
  // Sorted newest-first.
  assert.equal(h.workouts[0].date, '20260816');
  assert.equal(h.workouts[0].time, 48.6);
  assert.equal(h.workouts[0].bullet, false);
  assert.equal(h.workouts[1].date, '20260619');
  assert.equal(h.workouts[1].track, 'CD');
  // The regression this test locks in: group-2's "Track Condition #5 - #12"
  // (no "of Workout") must still resolve, not silently come back null.
  assert.equal(h.workouts[1].condition, 'ft');
  assert.equal(h.workouts[1].description, 'B');
});

test('extractRace: one past race fully extracted with trip comment and running line', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  const h = extractRace(races[0]).runners[0];
  assert.equal(h.pastRaces.length, 1);
  const p = h.pastRaces[0];
  assert.equal(p.raceDate, '20260717');
  assert.equal(p.trackCode, 'SAR');
  assert.equal(p.finishPosition, 2);
  assert.equal(p.finishMargin, 1.75);
  assert.equal(p.tripComment, '4-3w; led uppr to 1/8p');
  assert.equal(p.favoriteIndicator, false);
});

test('extractRace: bias stats block extracted', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  const h = extractRace(races[0]).runners[0];
  assert.equal(h.biasStats.speedBiasMeet, 80);
  assert.equal(h.biasStats.postBiasMeet.oneToThree, 14.44);
  assert.equal(h.biasStats.paceStyleWinPctMeet.EP, 53.33);
});

test('extractRace: a horse with no past-race/workout data at all does not throw', () => {
  const races = parsePpFeedMarkdown(FIXTURE);
  const h = extractRace(races[0]).runners[1];
  assert.equal(h.horseName, 'SECOND HORSE');
  assert.deepEqual(h.workouts, []);
  assert.deepEqual(h.pastRaces, []);
});
