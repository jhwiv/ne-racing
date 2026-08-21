'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { scoreRace, loadFittedWeights, DEFAULT_V2_WEIGHTS } = require(
  '../scripts/lib/scoring.js'
);

// Minimal three-horse race used across tests below.
function tinyRace() {
  return {
    id: 'TEST-R1',
    type: 'ALW',
    horses: [
      { pp: 1, name: 'A', ml: '5/2', speedFigs: [88, 90, 92], runningStyle: 'E',  trainer: 'T1', jockey: 'J1' },
      { pp: 2, name: 'B', ml: '4/1', speedFigs: [80, 82, 81], runningStyle: 'EP', trainer: 'T2', jockey: 'J2' },
      { pp: 3, name: 'C', ml: '8/1', speedFigs: [72, 70, 74], runningStyle: 'S',  trainer: 'T3', jockey: 'J3' },
    ],
  };
}

test('loadFittedWeights accepts a valid payload and normalizes to sum 1', () => {
  const payload = {
    schema_version: 1,
    engine_version: 'v2',
    method: 'conditional_logit',
    features: ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'],
    weights_normalized: [0.40, 0.20, 0.15, 0.10, 0.10, 0.05],
    n_races: 250,
    status: 'fitted',
  };
  const out = loadFittedWeights(payload);
  assert.ok(out, 'should accept a valid payload');
  assert.strictEqual(typeof out.weights.speed, 'number');
  const sum = Object.values(out.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, 'normalized weights sum to 1');
  assert.strictEqual(out.n_races, 250);
  assert.strictEqual(out.status, 'fitted');
});

test('loadFittedWeights rejects insufficient-status payloads', () => {
  const payload = {
    features: ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'],
    weights_normalized: [0.4, 0.2, 0.15, 0.1, 0.1, 0.05],
    n_races: 50,
    status: 'insufficient',
  };
  assert.strictEqual(loadFittedWeights(payload), null);
});

test('loadFittedWeights rejects mis-shaped feature lists', () => {
  assert.strictEqual(loadFittedWeights(null), null);
  assert.strictEqual(loadFittedWeights({}), null);
  assert.strictEqual(loadFittedWeights({
    features: ['speed', 'class'], weights_normalized: [0.7, 0.3], status: 'fitted',
  }), null);
  assert.strictEqual(loadFittedWeights({
    features: ['speed', 'class', 'pace', 'tj', 'bias', 'WRONG'],
    weights_normalized: [0.4, 0.2, 0.15, 0.1, 0.1, 0.05],
    status: 'fitted',
  }), null);
});

test('loadFittedWeights preserves the sign of negative coefficients, normalizing only magnitude', () => {
  // Conditional logit can produce negative betas when a sub-score's real
  // relationship to winning runs opposite the hand-designed "higher = better"
  // assumption (v2.49.72: pace and fresh both did, in the real fitted data --
  // see the comment on this function). Sign must survive; only |beta| is
  // renormalized, so weights sum in absolute value to 1, not in raw sum.
  const payload = {
    features: ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'],
    weights_normalized: [-0.4, 0.2, -0.15, 0.1, 0.1, 0.05],
    n_races: 300, status: 'fitted',
  };
  const out = loadFittedWeights(payload);
  assert.ok(out);
  assert.ok(out.weights.speed < 0, 'negative speed coefficient must stay negative');
  assert.ok(out.weights.pace < 0, 'negative pace coefficient must stay negative');
  assert.ok(out.weights.class > 0, 'positive coefficients stay positive');
  const absSum = Object.values(out.weights).reduce((a, b) => a + Math.abs(b), 0);
  assert.ok(Math.abs(absSum - 1.0) < 1e-9, 'sum of absolute values normalizes to 1');
});

test('scoreRace v2 uses default weights when no fittedWeights provided', () => {
  const race = tinyRace();
  const baseline = scoreRace(race, { version: 'v2' });
  assert.strictEqual(baseline.length, 3);
  // Default weights are the hand-picked 0.35/0.20/0.15/0.15/0.10/0.05 vector.
  // Just sanity-check the surface: each horse has a score and modelProb.
  for (const s of baseline) {
    assert.ok(typeof s.score === 'number' && s.score > 0);
    assert.ok(typeof s.modelProb === 'number' && s.modelProb > 0 && s.modelProb < 1);
  }
});

test('scoreRace v2 with fittedWeights weighting speed heavily favors top speed horse', () => {
  const race = tinyRace();
  const speedHeavy = {
    features: ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'],
    weights_normalized: [0.95, 0.01, 0.01, 0.01, 0.01, 0.01],
    n_races: 300, status: 'fitted',
  };
  const scored = scoreRace(race, { version: 'v2', fittedWeights: speedHeavy });
  // Horse A has highest speedFigs (88-92); should be top of the board.
  assert.strictEqual(scored[0].horse.pp, 1);
});

test('scoreRace v2 ignores fittedWeights when version is v1', () => {
  const race = tinyRace();
  const v1A = scoreRace(race, { version: 'v1' });
  const v1B = scoreRace(race, {
    version: 'v1',
    fittedWeights: {
      features: ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'],
      weights_normalized: [0.95, 0.01, 0.01, 0.01, 0.01, 0.01],
      n_races: 300, status: 'fitted',
    },
  });
  // Should be identical \u2014 v1 doesn't consult fittedWeights.
  assert.strictEqual(v1A.length, v1B.length);
  for (let i = 0; i < v1A.length; i++) {
    assert.strictEqual(v1A[i].horse.pp, v1B[i].horse.pp);
    assert.ok(Math.abs(v1A[i].score - v1B[i].score) < 1e-9);
  }
});

test('DEFAULT_V2_WEIGHTS sum to 1.0', () => {
  const sum = Object.values(DEFAULT_V2_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-9, 'default weights must sum to 1');
});

// v2.49.53: data/weights/v2.json went from a permanent "insufficient"
// placeholder to a real fitted payload (559 real SAR races, 2023 Equibase
// dataset + live 2026 data) the moment the corpus cleared this project's
// own 200-race threshold -- the exact mechanism RailbirdFittedWeights in
// index.html/app.html was built for (see its header comment). This is a
// regression guard, not a duplicate of fitter-output-contract.test.js
// (which only exercises the fitter against synthetic data): if this file
// is ever accidentally reverted to the placeholder, or hand-edited into
// something loadFittedWeights rejects, the live app silently falls back to
// DEFAULT_V2_WEIGHTS with no visible error -- this test is what would
// actually catch that before it ships.
test('the committed data/weights/v2.json is real, fitted, and accepted by loadFittedWeights', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'weights', 'v2.json'), 'utf8'));
  assert.strictEqual(payload.status, 'fitted');
  assert.ok(payload.n_races >= 200, `n_races (${payload.n_races}) must meet the live app's own 200-race threshold`);
  const loaded = loadFittedWeights(payload);
  assert.ok(loaded, 'loadFittedWeights must accept the real committed payload');
  // v2.49.72: weights are signed (pace/fresh are negative in this real
  // payload), so only the ABSOLUTE VALUES sum to 1 -- the raw signed sum does not.
  const absSum = Object.values(loaded.weights).reduce((a, b) => a + Math.abs(b), 0);
  assert.ok(Math.abs(absSum - 1.0) < 1e-9, 'sum of |weights| must be 1');
});
