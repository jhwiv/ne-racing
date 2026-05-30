'use strict';

/**
 * inline-scoring-sync.test.js — guard against drift between
 * scripts/lib/scoring.js (the source of truth, used by tests + backtest)
 * and the inlined IIFE block in index.html (used by the live PWA).
 *
 * If this fails: `node scripts/build/inline_scoring.js` and commit.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

test('index.html scoring block is in sync with scripts/lib/scoring.js', () => {
  try {
    execSync('node scripts/build/inline_scoring.js --check', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    assert.fail(
      'Inlined RailbirdScoring block in index.html is out of date.\n' +
      'Run: node scripts/build/inline_scoring.js\n\n' +
      stdout + stderr
    );
  }
});

test('inlined RailbirdScoring block exports the same surface as scoring.js', () => {
  // Load via require so the IIFE attaches to globalThis.
  delete require.cache[require.resolve('../scripts/build/_inlined_scoring.js')];
  require('../scripts/build/_inlined_scoring.js');
  const inlined = globalThis.RailbirdScoring;
  assert.ok(inlined, 'RailbirdScoring not attached to global');

  const source = require('../scripts/lib/scoring.js');
  const sourceKeys = Object.keys(source).sort();
  const inlinedKeys = Object.keys(inlined).sort();
  assert.deepStrictEqual(inlinedKeys, sourceKeys);

  // Spot-check: a few functions must produce identical results.
  assert.strictEqual(inlined.scoreToGrade(72), source.scoreToGrade(72));
  assert.strictEqual(inlined.scoreToGrade(95), source.scoreToGrade(95));
});
