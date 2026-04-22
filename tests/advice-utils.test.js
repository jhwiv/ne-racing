'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const U = require('../scripts/lib/advice-utils.js');

test('expertPickMatchesHorse: prefers pp when present', () => {
  const horse = { pp: 3, name: 'Thunder Creek' };
  assert.equal(U.expertPickMatchesHorse({ pick: 3, horseName: 'Different Horse', source: 'A' }, horse), true);
  assert.equal(U.expertPickMatchesHorse({ pick: 2, horseName: 'Thunder Creek', source: 'B' }, horse), false,
    'pp mismatch should NOT fall through to name — AND-with-fallback prefers pp');
});

test('expertPickMatchesHorse: falls back to name when pp missing', () => {
  const horse = { pp: 3, name: 'Thunder Creek' };
  assert.equal(U.expertPickMatchesHorse({ pick: null, horseName: 'Thunder Creek', source: 'A' }, horse), true);
  assert.equal(U.expertPickMatchesHorse({ pick: '', horseName: 'Thunder Creek', source: 'A' }, horse), true);
  assert.equal(U.expertPickMatchesHorse({ pick: null, horseName: 'Other', source: 'A' }, horse), false);
});

test('countExpertPicks: dedupes by source so one picker counts once', () => {
  const horse = { pp: 5, name: 'Irish Sky' };
  const race = {
    expertPicks: [
      { pick: 5, horseName: 'Irish Sky', source: 'Aragona' },
      { pick: 5, horseName: 'Irish Sky', source: 'Aragona' }, // duplicate source
      { pick: 5, horseName: 'Irish Sky', source: 'DeSantis' },
    ],
  };
  assert.equal(U.countExpertPicks(race, horse), 2);
});

test('countExpertPicks: does NOT double-count when pp and name both could match', () => {
  const horse = { pp: 5, name: 'Irish Sky' };
  // A single pick record that names and numbers the horse counts ONCE.
  const race = {
    expertPicks: [
      { pick: 5, horseName: 'Irish Sky', source: 'A' },
    ],
  };
  assert.equal(U.countExpertPicks(race, horse), 1);
});

test('countExpertPicks: handles empty / missing expertPicks', () => {
  assert.equal(U.countExpertPicks({}, { pp: 1, name: 'X' }), 0);
  assert.equal(U.countExpertPicks({ expertPicks: [] }, { pp: 1, name: 'X' }), 0);
  assert.equal(U.countExpertPicks(null, { pp: 1, name: 'X' }), 0);
});

test('getExpertNames: strips "NYRA - " prefix and dedupes', () => {
  const horse = { pp: 2, name: 'Bourbon Ridge' };
  const race = {
    expertPicks: [
      { pick: 2, horseName: 'Bourbon Ridge', source: 'NYRA - Aragona' },
      { pick: 2, horseName: 'Bourbon Ridge', source: 'NYRA - Aragona' },
      { pick: 2, horseName: 'Bourbon Ridge', source: 'Form' },
    ],
  };
  assert.deepEqual(U.getExpertNames(race, horse), ['Aragona', 'Form']);
});

test('parseOddsToNum: supports dash and slash fractions', () => {
  assert.equal(U.parseOddsToNum('5-1'), 5);
  assert.equal(U.parseOddsToNum('5/2'), 2.5);
  assert.equal(U.parseOddsToNum('6/5'), 1.2);
  assert.ok(Number.isNaN(U.parseOddsToNum('MTO')));
  assert.equal(U.parseOddsToNum('3.5'), 3.5);
});

test('overlay: positive when model thinks horse is more likely than tote', () => {
  assert.ok(Math.abs(U.overlay(0.20, 0.10) - 1.0) < 1e-9);
  assert.ok(Math.abs(U.overlay(0.09, 0.10) - (-0.1)) < 1e-9);
  assert.equal(U.overlay(0.20, 0), 0);
  assert.equal(U.overlay(0.20, -0.5), 0);
});

test('classifyOverlay: badge thresholds', () => {
  assert.equal(U.classifyOverlay(0.20), 'big-overlay');
  assert.equal(U.classifyOverlay(0.15), 'overlay'); // strictly > 0.15 means big
  assert.equal(U.classifyOverlay(0.10), 'overlay');
  assert.equal(U.classifyOverlay(0), 'neutral');
  assert.equal(U.classifyOverlay(-0.02), 'neutral');
  assert.equal(U.classifyOverlay(-0.10), 'underlay');
});

test('exoticBoxCost: $2 EX box of 4 = P(4,2)*2 = 24', () => {
  assert.equal(U.exoticBoxCost('EX', 4, 2), 24);
});

test('exoticBoxCost: $1 TRI box of 5 = P(5,3)*1 = 60', () => {
  assert.equal(U.exoticBoxCost('TRI', 5, 1), 60);
});

test('exoticBoxCost: $1 SUPER box of 4 = P(4,4)*1 = 24', () => {
  assert.equal(U.exoticBoxCost('SUPER', 4, 1), 24);
});

test('exoticBoxCost: below minimum legs returns 0', () => {
  assert.equal(U.exoticBoxCost('TRI', 2, 1), 0);
  assert.equal(U.exoticBoxCost('SUPER', 3, 1), 0);
});

test('exoticBoxCost: unknown type throws', () => {
  assert.throws(() => U.exoticBoxCost('PICK6', 6, 1));
});
