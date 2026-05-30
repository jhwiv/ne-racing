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

test('loadFittedWeights takes absolute values of negative coefficients', () => {
  // Conditional logit can produce negative betas if a sub-score is mis-signed.
  // We treat magnitudes as the effective weight (higher = more influence).
  const payload = {
    features: ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'],
    weights_normalized: [-0.4, 0.2, -0.15, 0.1, 0.1, 0.05],
    n_races: 300, status: 'fitted',
  };
  const out = loadFittedWeights(payload);
  assert.ok(out);
  for (const v of Object.values(out.weights)) {
    assert.ok(v >= 0, 'all weights non-negative after abs');
  }
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
