'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/lib/scoring.js');

// ── Helpers ──────────────────────────────────────────────────────────────────
function horse(overrides) {
  return Object.assign({
    id: 'h', pp: 1, name: 'Test Horse',
    speedFigs: [70, 72, 74],
    runningStyle: 'EP',
    jockeyPct: 15, trainerPct: 15,
    lastClass: 'ALW',
    lastRaceDate: '2026-05-10',
    ml: '5-1',
    scratched: false,
  }, overrides || {});
}

function race(horses, overrides) {
  return Object.assign({
    id: 'R1', type: 'ALW', horses, expertPicks: [],
  }, overrides || {});
}

// ── classValueFor ────────────────────────────────────────────────────────────
test('classValueFor: direct codes', () => {
  assert.equal(S.classValueFor('STK-G1'), 100);
  assert.equal(S.classValueFor('ALW'), 48);
  assert.equal(S.classValueFor('MCL'), 28);
});

test('classValueFor: fuzzy string match', () => {
  assert.equal(S.classValueFor('Maiden Special Weight'), 42);
  assert.equal(S.classValueFor('Maiden Claiming'), 28);
  assert.equal(S.classValueFor('Grade 1 Stakes'), 100);
  assert.equal(S.classValueFor('Listed Stakes'), 62);
  assert.equal(S.classValueFor(undefined), 40);
});

// ── speedSubScore ────────────────────────────────────────────────────────────
test('speedSubScore: no figs returns 50 with n=0', () => {
  const r = S.speedSubScore({ speedFigs: [] });
  assert.equal(r.score, 50);
  assert.equal(r.n, 0);
});

test('speedSubScore: avg 90 → top of range', () => {
  // Note: identical figs trigger BOTH the career-best AND career-worst clauses;
  // the worst clause wins (−5). Use a rising pattern to verify the ceiling.
  const r = S.speedSubScore({ speedFigs: [85, 88, 92] });
  assert.ok(r.score >= 95, `expected near-ceiling, got ${r.score}`);
});

test('speedSubScore: career-best most-recent gets +8', () => {
  const r1 = S.speedSubScore({ speedFigs: [60, 60, 60] });
  const r2 = S.speedSubScore({ speedFigs: [60, 60, 75] });
  assert.ok(r2.score > r1.score + 5, 'career-best latest fig should bump score');
});

// v2.49.21: brought into parity with the live engine's Prime-Power blend so
// scripts/training/extract_features.js (which imports this exact function
// to build the fitted-weights training feature matrix) computes the same
// "speed" quantity the live engine actually uses -- previously this file's
// speedSubScore was figs-only while the live inline version blended Prime
// Power at 70% weight, a silent train/serve skew.
test('speedSubScore: Prime Power blend matches the documented calibration (PP100->30, PP120->55, PP140->80, PP160->95)', () => {
  for (const [pp, expected] of [[100, 30], [120, 55], [140, 80], [160, 95]]) {
    const r = S.speedSubScore({ primePower: pp, speedFigs: [] });
    assert.ok(Math.abs(r.score - expected) < 1e-6, `PP ${pp} should score ${expected}, got ${r.score}`);
  }
});

test('speedSubScore: blends 70% Prime Power / 30% figs when both are present', () => {
  const ppOnly = S.speedSubScore({ primePower: 120, speedFigs: [] });
  const figsOnly = S.speedSubScore({ speedFigs: [70, 70, 70] });
  const both = S.speedSubScore({ primePower: 120, speedFigs: [70, 70, 70] });
  const expected = ppOnly.score * 0.7 + figsOnly.score * 0.3;
  assert.ok(Math.abs(both.score - expected) < 1e-6, `expected ${expected}, got ${both.score}`);
});

test('speedSubScore: no figs and no Prime Power still falls back to neutral 50', () => {
  const r = S.speedSubScore({ speedFigs: [] });
  assert.equal(r.score, 50);
  assert.equal(r.n, 0);
});

// ── classSubScore ────────────────────────────────────────────────────────────
test('classSubScore: dropping from G1 into ALW = big bonus', () => {
  const raceClass = S.classValueFor('ALW'); // 48
  const score = S.classSubScore({ lastClass: 'STK-G1' }, raceClass);
  assert.equal(score, 90);
});

test('classSubScore: missing lastClass → neutral (uses raceClassVal)', () => {
  const raceClass = S.classValueFor('ALW');
  const score = S.classSubScore({}, raceClass);
  assert.equal(score, 50);
});

// ── Pace ─────────────────────────────────────────────────────────────────────
test('paceSubScore: lone E gets 80', () => {
  const ctx = { loneSpeed: true, hotPace: false };
  assert.equal(S.paceSubScore({ runningStyle: 'E' }, ctx), 80);
});

test('paceSubScore: hot pace boosts closers and tanks speed', () => {
  const ctx = { loneSpeed: false, hotPace: true };
  assert.equal(S.paceSubScore({ runningStyle: 'SS' }, ctx), 70);
  assert.equal(S.paceSubScore({ runningStyle: 'E' }, ctx), 30);
});

// ── Trainer/Jockey v1 vs v2 (the double-count fix) ───────────────────────────
test('TJ v1: double-counts a hot rider on a hot barn', () => {
  // jky=20, trn=20 → avg 20 → bucket 80
  const hi = S.trainerJockeySubScore_v1({ jockeyPct: 20, trainerPct: 20 });
  // jky=20, trn=10 → avg 15 → bucket 65 (still uses overall mean)
  const mix = S.trainerJockeySubScore_v1({ jockeyPct: 20, trainerPct: 10 });
  assert.ok(hi - mix >= 10, 'v1 rewards stacked hot pairs heavily');
});

test('TJ v2: hot+hot only modestly higher than hot+cold (no double-count)', () => {
  const hi = S.trainerJockeySubScore_v2({ jockeyPct: 20, trainerPct: 20 });
  const mix = S.trainerJockeySubScore_v2({ jockeyPct: 20, trainerPct: 10 });
  assert.ok(hi > mix, 'v2 still rewards hot+hot');
  assert.ok(hi - mix < 15, 'v2 narrows the double-count gap vs v1');
});

test('TJ v2: hot jockey on cold barn beats two mid', () => {
  const hotMid = S.trainerJockeySubScore_v2({ jockeyPct: 22, trainerPct: 6 });
  const twoMid = S.trainerJockeySubScore_v2({ jockeyPct: 14, trainerPct: 14 });
  // Hot+cold = 0.6*95 + 0.4*35 = 71
  // Two-mid   = 0.6*65 + 0.4*65 = 65
  assert.ok(hotMid > twoMid, 'hot connection should beat two mediocre ones');
});

// ── Bias v1 vs v2 (additivity cap fix) ───────────────────────────────────────
test('Bias v1: speed-favoring + inside rail can stack to 95', () => {
  const s = S.biasSubScore_v1(
    { runningStyle: 'E', pp: 1 },
    { style: 'Speed', rail: 'Inside' }
  );
  assert.equal(s, 95, 'v1 stacks style 80 + rail +15 = 95');
});

test('Bias v2: same horse capped lower, plus penalizes wrong-style/post', () => {
  const matched = S.biasSubScore_v2(
    { runningStyle: 'E', pp: 1 },
    { style: 'Speed', rail: 'Inside' }
  );
  // 50 + 25 + 10 = 85, capped at 100 → 85
  assert.equal(matched, 85);

  const mismatched = S.biasSubScore_v2(
    { runningStyle: 'S', pp: 1 },
    { style: 'Speed', rail: 'Inside' }
  );
  // Closer on speed-favoring + inside post on inside-rail (rail still helps) = 50-15+10 = 45
  assert.equal(mismatched, 45);
});

// ── Freshness ────────────────────────────────────────────────────────────────
test('freshnessSubScore: sweet spot 14–28 days = 80', () => {
  assert.equal(S.freshnessSubScore({ lastRaceDate: '2026-05-15' }, '2026-05-29'), 80);
});

test('freshnessSubScore: long layoff > 90d = 20', () => {
  assert.equal(S.freshnessSubScore({ lastRaceDate: '2026-01-01' }, '2026-05-29'), 20);
});

test('freshnessSubScore: no date = neutral 50', () => {
  assert.equal(S.freshnessSubScore({}, '2026-05-29'), 50);
});

// ── Data completeness ───────────────────────────────────────────────────────
test('dataCompleteness: full data → 7/7', () => {
  const c = S.dataCompleteness(horse());
  assert.ok(Math.abs(c - 1) < 1e-9);
});

test('dataCompleteness: only ML + name → 0/7', () => {
  const c = S.dataCompleteness({ ml: '5-1', name: 'X', speedFigs: [] });
  assert.equal(c, 0);
});

// ── Pace context ─────────────────────────────────────────────────────────────
test('buildPaceContext: lone speed', () => {
  const ctx = S.buildPaceContext([
    { runningStyle: 'E' },
    { runningStyle: 'S' },
    { runningStyle: 'P' },
  ]);
  assert.ok(ctx.loneSpeed);
  assert.equal(ctx.hotPace, false);
});

test('buildPaceContext: hot pace with 3+ front-runners', () => {
  const ctx = S.buildPaceContext([
    { runningStyle: 'E' }, { runningStyle: 'EP' }, { runningStyle: 'E' },
    { runningStyle: 'S' },
  ]);
  assert.ok(ctx.hotPace);
});

// ── Probability normalization (THE big fix) ──────────────────────────────────
test('probabilityNormalizeV1: produces score-shares that sum to 1', () => {
  const scored = [{ score: 80 }, { score: 60 }, { score: 40 }];
  S.probabilityNormalizeV1(scored);
  const sum = scored.reduce((a, s) => a + s.modelProb, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('probabilityNormalizeV2: produces softmax probs summing to 1', () => {
  const scored = [{ score: 80 }, { score: 60 }, { score: 40 }];
  S.probabilityNormalizeV2(scored);
  const sum = scored.reduce((a, s) => a + s.modelProb, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('probabilityNormalizeV2: respects ranking', () => {
  const scored = [{ score: 80 }, { score: 60 }, { score: 40 }];
  S.probabilityNormalizeV2(scored);
  assert.ok(scored[0].modelProb > scored[1].modelProb);
  assert.ok(scored[1].modelProb > scored[2].modelProb);
});

test('v1 vs v2 differ on flat fields: v1 score-share is roughly uniform, v2 too', () => {
  // When all scores are equal, both should produce uniform probs.
  const scored1 = [{ score: 60 }, { score: 60 }, { score: 60 }];
  S.probabilityNormalizeV1(scored1);
  scored1.forEach(s => assert.ok(Math.abs(s.modelProb - 1/3) < 1e-9));

  const scored2 = [{ score: 60 }, { score: 60 }, { score: 60 }];
  S.probabilityNormalizeV2(scored2);
  scored2.forEach(s => assert.ok(Math.abs(s.modelProb - 1/3) < 1e-9));
});

// ── Field-strength multiplier (v2) ───────────────────────────────────────────
test('fieldStrengthMultiplier: strong field > 1', () => {
  const scored = [
    { speedScore: 88 }, { speedScore: 84 }, { speedScore: 80 }, { speedScore: 78 },
  ];
  const m = S.fieldStrengthMultiplier(scored);
  assert.ok(m > 1);
});

test('fieldStrengthMultiplier: weak field < 1', () => {
  const scored = [
    { speedScore: 45 }, { speedScore: 42 }, { speedScore: 38 }, { speedScore: 35 },
  ];
  const m = S.fieldStrengthMultiplier(scored);
  assert.ok(m < 1);
});

test('fieldStrengthMultiplier: bounded [0.92, 1.08]', () => {
  const huge = [{ speedScore: 100 }, { speedScore: 100 }, { speedScore: 100 }];
  const tiny = [{ speedScore: 0 }, { speedScore: 0 }, { speedScore: 0 }];
  assert.ok(S.fieldStrengthMultiplier(huge) <= 1.08 + 1e-9);
  assert.ok(S.fieldStrengthMultiplier(tiny) >= 0.92 - 1e-9);
});

// ── Expert consensus inclusion (v1 vs v2 default behavior) ───────────────────
test('Expert consensus: v1 includes in composite by default', () => {
  const h = horse({ pp: 1 });
  const r = race([h, horse({ pp: 2, name: 'B' })], {
    expertPicks: [
      { pick: 1, horseName: h.name, source: 'A' },
      { pick: 1, horseName: h.name, source: 'B' },
    ],
  });
  const v1 = S.scoreRace(r, { version: 'v1' });
  const v1NoExpert = S.scoreRace(r, { version: 'v1', includeExpertInComposite: false });
  const a = v1.find(s => s.horse.pp === 1);
  const aNo = v1NoExpert.find(s => s.horse.pp === 1);
  assert.ok(a.score > aNo.score, 'v1 default adds consensus bonus to composite');
});

test('Expert consensus: v2 excludes from composite by default', () => {
  const h = horse({ pp: 1 });
  const r = race([h, horse({ pp: 2, name: 'B' })], {
    expertPicks: [
      { pick: 1, horseName: h.name, source: 'A' },
      { pick: 1, horseName: h.name, source: 'B' },
    ],
  });
  const v2 = S.scoreRace(r, { version: 'v2' });
  const v2Expert = S.scoreRace(r, { version: 'v2', includeExpertInComposite: true });
  const a = v2.find(s => s.horse.pp === 1);
  const aE = v2Expert.find(s => s.horse.pp === 1);
  assert.ok(aE.score > a.score, 'v2 only adds consensus when explicitly enabled');
  // But expertMatchCount is still surfaced for the UI to display as a benchmark.
  assert.equal(a.expertMatchCount, 2);
});

// ── End-to-end: scoreRace produces sorted, probabilistic output ──────────────
test('scoreRace: returns sorted, normalized output for both versions', () => {
  const horses = [
    horse({ pp: 1, name: 'A', speedFigs: [85, 86, 88] }),
    horse({ pp: 2, name: 'B', speedFigs: [65, 60, 62] }),
    horse({ pp: 3, name: 'C', speedFigs: [50, 52, 48] }),
  ];
  const r = race(horses);

  for (const v of ['v1', 'v2']) {
    const out = S.scoreRace(r, { version: v, today: '2026-05-29' });
    assert.equal(out.length, 3);
    // Sorted desc
    assert.ok(out[0].score >= out[1].score);
    assert.ok(out[1].score >= out[2].score);
    // Probs sum to ~1
    const sum = out.reduce((a, s) => a + s.modelProb, 0);
    assert.ok(Math.abs(sum - 1) < 1e-6, `${v} probs should sum to 1, got ${sum}`);
    // Overlay computed
    out.forEach(s => assert.ok('overlay' in s));
  }
});

test('scoreRace: scratched horses are excluded', () => {
  const horses = [
    horse({ pp: 1, name: 'A' }),
    horse({ pp: 2, name: 'B', scratched: true }),
    horse({ pp: 3, name: 'C' }),
  ];
  const out = S.scoreRace(race(horses), { version: 'v2' });
  assert.equal(out.length, 2);
});

test('scoreRace: empty field returns empty array', () => {
  assert.deepEqual(S.scoreRace(race([]), { version: 'v2' }), []);
});

// ── Grade + confidence ──────────────────────────────────────────────────────
test('scoreToGrade: boundary checks', () => {
  assert.equal(S.scoreToGrade(95), 'A+');
  assert.equal(S.scoreToGrade(85), 'A');
  assert.equal(S.scoreToGrade(75), 'B+');
  assert.equal(S.scoreToGrade(70), 'B');
  assert.equal(S.scoreToGrade(55), 'C');
  assert.equal(S.scoreToGrade(40), 'D');
});

test('confidenceFor: gap-based + completeness gate', () => {
  const high = [
    { score: 80, completeness: 0.85 }, { score: 60, completeness: 0.7 },
    { score: 55, completeness: 0.5 }, { score: 50, completeness: 0.5 },
    { score: 45, completeness: 0.5 },
  ];
  assert.equal(S.confidenceFor(high), 'high');

  const lowGap = [
    { score: 72, completeness: 0.85 }, { score: 70, completeness: 0.85 },
  ];
  assert.equal(S.confidenceFor(lowGap), 'low');
});
