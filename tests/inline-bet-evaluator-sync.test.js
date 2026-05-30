'use strict';

/**
 * inline-bet-evaluator-sync.test.js — guard against drift between
 * scripts/lib/bet_evaluator.js (source of truth) and the inlined IIFE block
 * in index.html (used by the live PWA).
 *
 * If this fails: `node scripts/build/inline_bet_evaluator.js` and commit.
 */

const test = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const path = require('node:path');

test('index.html bet-evaluator block is in sync with scripts/lib/bet_evaluator.js', () => {
  try {
    execSync('node scripts/build/inline_bet_evaluator.js --check', {
      cwd: path.resolve(__dirname, '..'),
      stdio: 'pipe',
    });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    const stdout = err.stdout ? err.stdout.toString() : '';
    assert.fail(
      'Inlined RailbirdBetEvaluator block in index.html is out of date.\n' +
      'Run: node scripts/build/inline_bet_evaluator.js\n\n' +
      stdout + stderr
    );
  }
});

test('inlined RailbirdBetEvaluator block exports the same surface as bet_evaluator.js', () => {
  delete require.cache[require.resolve('../scripts/build/_inlined_bet_evaluator.js')];
  require('../scripts/build/_inlined_bet_evaluator.js');
  const inlined = globalThis.RailbirdBetEvaluator;
  assert.ok(inlined, 'RailbirdBetEvaluator not attached to global');

  const source = require('../scripts/lib/bet_evaluator.js');
  const sourceKeys = Object.keys(source).sort();
  const inlinedKeys = Object.keys(inlined).sort();
  assert.deepStrictEqual(inlinedKeys, sourceKeys);

  // Spot-check: a few functions must produce identical results.
  assert.strictEqual(inlined.getTakeout('BEL', 'win'), source.getTakeout('BEL', 'win'));
  assert.strictEqual(inlined.getTakeout('BEL', 'pick4'), source.getTakeout('BEL', 'pick4'));
  assert.strictEqual(inlined.takeoutSource('BEL'), source.takeoutSource('BEL'));
});
