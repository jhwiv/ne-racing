'use strict';

/**
 * fitter-output-contract.test.js
 *
 * Runs scripts/training/fit_logit.py end-to-end against a synthetic JSONL
 * corpus and asserts the produced data/weights/v2.json file conforms to
 * the contract expected by the runtime loader (RailbirdFittedWeights +
 * loadFittedWeights):
 *
 *   - non-negative `weights_normalized` summing to 1.0
 *   - required keys present (features, n_races, status, schema_version)
 *   - status either 'fitted' or 'insufficient'
 *   - 'fitted' implies n_races >= min_races_required
 *
 * This test is skipped automatically if python3 or scipy is unavailable.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const FITTER    = path.join(REPO_ROOT, 'scripts', 'training', 'fit_logit.py');

function pythonAvailable() {
  try {
    const r = spawnSync('python3', ['-c', 'import numpy, scipy.optimize; print("ok")'], {
      encoding: 'utf8',
    });
    return r.status === 0 && /ok/.test(r.stdout);
  } catch (_) { return false; }
}

function makeSyntheticCorpus(nRaces) {
  // Each race: 8 horses, features = [speed, class, pace, tj, bias, fresh].
  // We bake in a real signal: speed dominates winner choice so the fitter
  // should converge to a speed-heavy weight vector.
  const lines = [];
  for (let i = 0; i < nRaces; i++) {
    const features = [];
    let bestSpeed = -Infinity, bestIdx = 0;
    for (let h = 0; h < 8; h++) {
      const speed = 40 + Math.floor(Math.random() * 60);   // 40..99
      const klass = 40 + Math.floor(Math.random() * 30);
      const pace  = 40 + Math.floor(Math.random() * 30);
      const tj    = 40 + Math.floor(Math.random() * 30);
      const bias  = 50;
      const fresh = 50;
      features.push([speed, klass, pace, tj, bias, fresh]);
      if (speed > bestSpeed) { bestSpeed = speed; bestIdx = h; }
    }
    lines.push(JSON.stringify({
      raceId: 'TEST-R' + i,
      track: 'TST',
      date: '2025-01-01',
      features,
      ppOrder: features.map((_, j) => j + 1),
      winnerIdx: bestIdx,                                  // pure speed signal
    }));
  }
  return lines.join('\n') + '\n';
}

test('fitter produces a runtime-loader-compatible v2.json', { skip: !pythonAvailable() }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fitter-contract-'));
  const inPath  = path.join(tmp, 'features.jsonl');
  const outPath = path.join(tmp, 'v2.json');
  fs.writeFileSync(inPath, makeSyntheticCorpus(250));

  const r = spawnSync('python3', [
    FITTER, '--in', inPath, '--out', outPath, '--min-races', '200',
  ], { encoding: 'utf8' });

  assert.strictEqual(r.status, 0, 'fitter exits 0\n' + r.stdout + r.stderr);
  assert.ok(fs.existsSync(outPath), 'wrote v2.json');

  const payload = JSON.parse(fs.readFileSync(outPath, 'utf8'));

  // Schema fields.
  assert.strictEqual(payload.schema_version, 1);
  assert.strictEqual(payload.engine_version, 'v2');
  assert.deepStrictEqual(payload.features, ['speed','class','pace','tj','bias','fresh']);
  assert.ok(['fitted','insufficient'].includes(payload.status));
  assert.strictEqual(typeof payload.n_races, 'number');
  assert.ok(payload.n_races >= 200);
  if (payload.status === 'fitted') {
    assert.ok(payload.n_races >= payload.min_races_required);
  }

  // Weight contract: non-negative, sums to 1.
  const w = payload.weights_normalized;
  assert.ok(Array.isArray(w) && w.length === 6, 'weights_normalized is length-6 array');
  for (const v of w) {
    assert.ok(typeof v === 'number' && v >= 0,
      'weights_normalized values must be non-negative, got ' + v);
  }
  const sum = w.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 1e-6,
    'weights_normalized must sum to 1.0 (got ' + sum + ')');

  // Diagnostics block present.
  assert.ok(payload.fit_diagnostics, 'fit_diagnostics present');
  assert.strictEqual(typeof payload.fit_diagnostics.pseudo_r2_mcfadden, 'number');
  assert.strictEqual(typeof payload.fit_diagnostics.top1_hit_rate, 'number');

  // trained_at is ISO-ish UTC.
  assert.match(payload.trained_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

  // Runtime loader must accept this payload.
  const { loadFittedWeights } = require('../scripts/lib/scoring.js');
  const loaded = loadFittedWeights(payload);
  assert.ok(loaded, 'runtime loader accepts fitter output');
  const loadedSum = Object.values(loaded.weights).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(loadedSum - 1.0) < 1e-9);

  // Cleanup.
  fs.rmSync(tmp, { recursive: true, force: true });
});
