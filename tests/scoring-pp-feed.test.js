'use strict';

// Unit coverage for the three NEW, opt-in sub-scores added in scoring.js
// (v2.49.78): workoutSubScore, tripTroubleSubScore, dataDrivenBiasSubScore.
// These are deliberately unfitted/hand-picked (see the block comment above
// workoutSubScore() in scripts/lib/scoring.js) -- these tests lock in
// behavior and edge cases, not a validated calibration.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/lib/scoring.js');

function horseWithPpFeed(overrides) {
  return Object.assign({
    pp: 1, postPosition: 1, runningStyle: 'EP',
    ppFeed: { workouts: [], pastRaces: [], biasStats: null },
  }, overrides || {});
}

// ── workoutSubScore ──────────────────────────────────────────────────────────

test('workoutSubScore: no ppFeed data returns neutral 50', () => {
  const h = { pp: 1 }; // no ppFeed at all
  assert.equal(S.workoutSubScore(h, '2026-08-26'), 50);
});

test('workoutSubScore: no workouts in ppFeed returns neutral 50', () => {
  const h = horseWithPpFeed({ ppFeed: { workouts: [], pastRaces: [], biasStats: null } });
  assert.equal(S.workoutSubScore(h, '2026-08-26'), 50);
});

test('workoutSubScore: a recent bullet work scores well above neutral', () => {
  const h = horseWithPpFeed({
    ppFeed: { workouts: [{ date: '20260819', bullet: true }], pastRaces: [], biasStats: null },
  });
  const score = S.workoutSubScore(h, '2026-08-26'); // 7 days out
  assert.ok(score > 65, `expected a recent bullet work to score well above neutral, got ${score}`);
});

test('workoutSubScore: a stale single work (60+ days, no bullet) scores below neutral', () => {
  const h = horseWithPpFeed({
    ppFeed: { workouts: [{ date: '20260601', bullet: false }], pastRaces: [], biasStats: null },
  });
  const score = S.workoutSubScore(h, '2026-08-26'); // ~86 days out
  assert.ok(score < 40, `expected a stale lone work to score below neutral, got ${score}`);
});

test('workoutSubScore: a tight cluster of recent works scores higher than one isolated work at the same recency', () => {
  const isolated = horseWithPpFeed({
    ppFeed: { workouts: [{ date: '20260819', bullet: false }], pastRaces: [], biasStats: null },
  });
  const clustered = horseWithPpFeed({
    ppFeed: {
      workouts: [
        { date: '20260819', bullet: false }, { date: '20260812', bullet: false },
        { date: '20260805', bullet: false }, { date: '20260729', bullet: false },
      ],
      pastRaces: [], biasStats: null,
    },
  });
  const a = S.workoutSubScore(isolated, '2026-08-26');
  const b = S.workoutSubScore(clustered, '2026-08-26');
  assert.ok(b > a, `expected a cluster of recent works (${b}) to score higher than one isolated work (${a})`);
});

// ── tripTroubleSubScore ──────────────────────────────────────────────────────

test('tripTroubleSubScore: no past races returns neutral 50', () => {
  const h = horseWithPpFeed({});
  assert.equal(S.tripTroubleSubScore(h), 50);
});

test('tripTroubleSubScore: a clean-trip comment (no trouble keywords) stays neutral', () => {
  const h = horseWithPpFeed({
    ppFeed: { workouts: [], pastRaces: [{ tripComment: 'Stalked pace, led str, driving', finishMargin: 0.5 }], biasStats: null },
  });
  assert.equal(S.tripTroubleSubScore(h), 50);
});

test('tripTroubleSubScore: real trouble language + a close finish scores well above neutral', () => {
  const h = horseWithPpFeed({
    ppFeed: { workouts: [], pastRaces: [{ tripComment: 'Bumped start; steadied 3/8p', finishMargin: 1.5 }], biasStats: null },
  });
  const score = S.tripTroubleSubScore(h);
  assert.ok(score > 60, `expected trouble + close finish to score above neutral, got ${score}`);
});

test('tripTroubleSubScore: real trouble language but well beaten scores below neutral', () => {
  const h = horseWithPpFeed({
    ppFeed: { workouts: [], pastRaces: [{ tripComment: 'Checked hard, steadied, never a factor', finishMargin: 22 }], biasStats: null },
  });
  const score = S.tripTroubleSubScore(h);
  assert.ok(score < 50, `expected trouble + well beaten to score below neutral, got ${score}`);
});

test('tripTroubleSubScore: only looks at the single most recent past race', () => {
  const h = horseWithPpFeed({
    ppFeed: {
      workouts: [],
      pastRaces: [
        { tripComment: 'Clean trip, no issues', finishMargin: 1 },
        { tripComment: 'Steadied hard, blocked', finishMargin: 1 },
      ],
      biasStats: null,
    },
  });
  assert.equal(S.tripTroubleSubScore(h), 50);
});

// ── dataDrivenBiasSubScore ───────────────────────────────────────────────────

test('dataDrivenBiasSubScore: no biasStats returns neutral 50', () => {
  const h = horseWithPpFeed({ ppFeed: { workouts: [], pastRaces: [], biasStats: null } });
  assert.equal(S.dataDrivenBiasSubScore(h), 50);
});

test('dataDrivenBiasSubScore: a favorable post + running-style combo scores above neutral', () => {
  const h = horseWithPpFeed({
    runningStyle: 'E',
    ppFeed: {
      postPosition: 1,
      workouts: [], pastRaces: [],
      biasStats: {
        postBiasMeet: { rail: 30, oneToThree: 25, fourToSeven: 10, eightPlus: 5 },
        paceStyleWinPctMeet: { E: 40, EP: 20, P: 10, S: 5 },
      },
    },
  });
  const score = S.dataDrivenBiasSubScore(h);
  assert.ok(score > 60, `expected a strongly-favored post+style combo to score above neutral, got ${score}`);
});

test('dataDrivenBiasSubScore: an unfavorable post + running-style combo scores below neutral', () => {
  const h = horseWithPpFeed({
    runningStyle: 'S',
    ppFeed: {
      postPosition: 9,
      workouts: [], pastRaces: [],
      biasStats: {
        postBiasMeet: { rail: 30, oneToThree: 25, fourToSeven: 10, eightPlus: 2 },
        paceStyleWinPctMeet: { E: 40, EP: 20, P: 10, S: 1 },
      },
    },
  });
  const score = S.dataDrivenBiasSubScore(h);
  assert.ok(score < 40, `expected a weakly-favored post+style combo to score below neutral, got ${score}`);
});

// ── compositeForHorse wiring: opt-in, no effect on horses without ppFeed ────

test('scoreRace: horses without ppFeed get null workout/trip/dataBias fields, composite unchanged', () => {
  const h1 = { id: 'a', pp: 1, name: 'A', runningStyle: 'EP', jockeyPct: 15, trainerPct: 15, ml: '3-1', scratched: false };
  const h2 = { id: 'b', pp: 2, name: 'B', runningStyle: 'S', jockeyPct: 10, trainerPct: 10, ml: '5-1', scratched: false };
  const race = { id: 'R1', type: 'ALW', horses: [h1, h2], expertPicks: [] };
  const scored = S.scoreRace(race, { version: 'v2' });
  for (const s of scored) {
    assert.equal(s.workoutScore, null);
    assert.equal(s.tripScore, null);
    assert.equal(s.dataBiasScore, null);
  }
});

test('scoreRace: a horse with ppFeed gets real sub-scores attached without changing the composite score formula', () => {
  const withFeed = {
    id: 'a', pp: 1, name: 'A', runningStyle: 'EP', jockeyPct: 15, trainerPct: 15, ml: '3-1', scratched: false,
    ppFeed: { workouts: [{ date: '20260819', bullet: true }], pastRaces: [], biasStats: null },
  };
  const withoutFeed = Object.assign({}, withFeed, { ppFeed: undefined });
  delete withoutFeed.ppFeed;
  const race1 = { id: 'R1', type: 'ALW', horses: [withFeed], expertPicks: [] };
  const race2 = { id: 'R1', type: 'ALW', horses: [withoutFeed], expertPicks: [] };
  const scored1 = S.scoreRace(race1, { version: 'v2' });
  const scored2 = S.scoreRace(race2, { version: 'v2' });
  assert.notEqual(scored1[0].workoutScore, null);
  // Composite score itself must be identical -- these new sub-scores are not
  // yet part of the weighted formula (no fitted weight exists for them).
  assert.equal(scored1[0].score, scored2[0].score);
});
