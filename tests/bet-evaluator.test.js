// tests/bet-evaluator.test.js
// Unit + integration tests for scripts/lib/bet_evaluator.js
//
// Covers:
//   - Odds parsing / inverse
//   - Takeout table lookup + fallback
//   - Harville win/place/show probabilities
//   - Permutation generators (straight/box/key/wheel)
//   - WPS evaluator
//   - Exotic evaluator (exacta/trifecta/superfecta)
//   - Multi-race evaluator (pick3/4/5/6)
//   - Top-level evaluateBet dispatcher

const test = require('node:test');
const assert = require('node:assert/strict');
const be = require('../scripts/lib/bet_evaluator.js');

// ── Helpers ────────────────────────────────────────────────────────────────
function makeRace(trackCode, runners) {
  // runners: array of {pp, prob, ml?, composite?, name?}
  return {
    trackCode,
    raceNumber: 1,
    scoredField: runners.map((r, i) => ({
      pp: r.pp,
      prob: r.prob,
      composite: r.composite != null ? r.composite : 100 - i,
      ml: r.ml || null,
      name: r.name || `H${r.pp}`,
    })),
  };
}

function fourHorseField(trackCode = 'BEL') {
  return makeRace(trackCode, [
    { pp: 1, prob: 0.40, ml: '3/2' },
    { pp: 2, prob: 0.30, ml: '5/2' },
    { pp: 3, prob: 0.20, ml: '4/1' },
    { pp: 4, prob: 0.10, ml: '9/1' },
  ]);
}

const APPROX = 1e-6;
function approxEq(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps;
}

// ── parseOdds ───────────────────────────────────────────────────────────────
test('parseOdds: fractional 7-2 → 1/4.5', () => {
  assert.ok(approxEq(be.parseOdds('7-2'), 1 / 4.5, APPROX));
});
test('parseOdds: fractional 7/2 (slash) equals 7-2', () => {
  assert.equal(be.parseOdds('7/2'), be.parseOdds('7-2'));
});
test('parseOdds: even money "1-1" → 0.5', () => {
  assert.ok(approxEq(be.parseOdds('1-1'), 0.5, APPROX));
});
test('parseOdds: integer "8" interpreted as 8/1 → 1/9', () => {
  assert.ok(approxEq(be.parseOdds('8'), 1 / 9, APPROX));
});
test('parseOdds: numeric 8 → 1/9 (same as string)', () => {
  assert.ok(approxEq(be.parseOdds(8), 1 / 9, APPROX));
});
test('parseOdds: decimal "3.50" → 1/4.5', () => {
  assert.ok(approxEq(be.parseOdds('3.50'), 1 / 4.5, APPROX));
});
test('parseOdds: null/empty → null', () => {
  assert.equal(be.parseOdds(null), null);
  assert.equal(be.parseOdds(''), null);
  assert.equal(be.parseOdds('garbage'), null);
});

// ── probToFractional ────────────────────────────────────────────────────────
test('probToFractional: 0.5 → "1/1"', () => {
  assert.match(be.probToFractional(0.5), /^1[\/-]1$/);
});
test('probToFractional: roundtrip for 7/2', () => {
  const p = be.parseOdds('7/2');
  const str = be.probToFractional(p);
  assert.ok(approxEq(be.parseOdds(str), p, 0.05),
    `Round trip drifted: 7/2 → ${p} → ${str} → ${be.parseOdds(str)}`);
});
test('probToFractional: 0 / 1 / negative → null', () => {
  assert.equal(be.probToFractional(0), null);
  assert.equal(be.probToFractional(1), null);
  assert.equal(be.probToFractional(-0.1), null);
});

// ── Takeout table ───────────────────────────────────────────────────────────
test('getTakeout: BEL win = 0.16', () => {
  assert.equal(be.getTakeout('BEL', 'win'), 0.16);
});
test('getTakeout: BEL pick4 = 0.24 (NYRA published rate)', () => {
  assert.equal(be.getTakeout('BEL', 'pick4'), 0.24);
});
test('getTakeout: BEL pick5 = 0.15 (NYRA lower-take wager)', () => {
  assert.equal(be.getTakeout('BEL', 'pick5'), 0.15);
});
test('getTakeout: CT (Charles Town) exacta = 0.19', () => {
  assert.equal(be.getTakeout('CT', 'exacta'), 0.19);
});
test('getTakeout: unknown track falls back to NYRA rates', () => {
  // Use NYRA fallback for unknown track
  assert.equal(be.getTakeout('XYZ', 'win'), 0.16);
  assert.equal(be.getTakeout('XYZ', 'trifecta'), 0.24);
});
test('takeoutSource: known track returns explicit source string', () => {
  const src = be.takeoutSource('BEL');
  assert.match(src, /NYRA/);
});
test('takeoutSource: unknown track returns NYRA fallback note', () => {
  const src = be.takeoutSource('XYZ');
  assert.match(src, /fallback/);
});

// ── placeShowProbabilities (Harville) ───────────────────────────────────────
test('placeShowProbabilities: favorite has place > win, show > place', () => {
  const race = fourHorseField();
  const ps = be.placeShowProbabilities(race.scoredField, 1);
  assert.ok(ps.place > 0.40, `place ${ps.place} should exceed win prob 0.40`);
  assert.ok(ps.show > ps.place, `show ${ps.show} should exceed place ${ps.place}`);
  assert.ok(ps.show <= 1, 'show probability must be ≤ 1');
});
test('placeShowProbabilities: longshot has place > win, show > place', () => {
  const race = fourHorseField();
  const ps = be.placeShowProbabilities(race.scoredField, 4);
  assert.ok(ps.place > 0.10);
  assert.ok(ps.show > ps.place);
});
test('placeShowProbabilities: unknown pp returns zeros or null', () => {
  const race = fourHorseField();
  const ps = be.placeShowProbabilities(race.scoredField, 99);
  // either zero probs or null — accept both
  if (ps !== null) {
    assert.ok((ps.place || 0) === 0);
    assert.ok((ps.show || 0) === 0);
  }
});

// ── engineRankOf ────────────────────────────────────────────────────────────
test('engineRankOf: top composite ranks 1', () => {
  const race = fourHorseField();
  assert.equal(be.engineRankOf(race.scoredField, 1), 1);
});
test('engineRankOf: last composite ranks 4', () => {
  const race = fourHorseField();
  assert.equal(be.engineRankOf(race.scoredField, 4), 4);
});
test('engineRankOf: unknown pp returns null or out-of-range', () => {
  const race = fourHorseField();
  const rank = be.engineRankOf(race.scoredField, 99);
  assert.ok(rank === null || rank > 4 || rank === undefined);
});

// ── generatePermutations ────────────────────────────────────────────────────
test('generatePermutations: straight produces single ordered perm', () => {
  const perms = be.generatePermutations('straight', { positions: [1, 2, 3] }, 3);
  assert.equal(perms.length, 1);
  assert.deepEqual(perms[0], [1, 2, 3]);
});
test('generatePermutations: box of 3 horses depth 3 → 6 permutations', () => {
  const perms = be.generatePermutations('box', { horses: [1, 2, 3] }, 3);
  assert.equal(perms.length, 6);
  // every perm uses exactly the 3 horses
  for (const p of perms) {
    assert.equal(p.length, 3);
    assert.deepEqual([...p].sort(), [1, 2, 3]);
  }
});
test('generatePermutations: box of 4 horses depth 2 (exacta box) → 12 perms', () => {
  const perms = be.generatePermutations('box', { horses: [1, 2, 3, 4] }, 2);
  assert.equal(perms.length, 12); // 4P2 = 12
});
test('generatePermutations: key {1 with 2,3} depth 2 → 2 perms', () => {
  const perms = be.generatePermutations('key', { keyHorse: 1, withHorses: [2, 3] }, 2);
  assert.equal(perms.length, 2);
  for (const p of perms) assert.equal(p[0], 1);
});
test('generatePermutations: wheel positions [[1],[2,3],[4]] depth 3 → 2 perms', () => {
  const perms = be.generatePermutations('wheel', { positions: [[1], [2, 3], [4]] }, 3);
  assert.equal(perms.length, 2);
  // No duplicate horses across positions in any single perm
  for (const p of perms) {
    assert.equal(new Set(p).size, 3);
  }
});

// ── harvilleProb ────────────────────────────────────────────────────────────
test('harvilleProb: P(win=fav) ≈ favorite prob for length-1 perm', () => {
  const race = fourHorseField();
  // depth-1 perm is essentially "horse 1 wins"
  const p = be.harvilleProb(race.scoredField, [1]);
  assert.ok(approxEq(p, 0.40, 1e-3));
});
test('harvilleProb: exacta 1-2 ≈ 0.40 × (0.30 / 0.60) = 0.20', () => {
  const race = fourHorseField();
  const p = be.harvilleProb(race.scoredField, [1, 2]);
  assert.ok(approxEq(p, 0.40 * (0.30 / 0.60), 1e-6),
    `expected ~0.20, got ${p}`);
});
test('harvilleProb: trifecta 1-2-3 = 0.40 × 0.30/0.60 × 0.20/0.30', () => {
  const race = fourHorseField();
  const p = be.harvilleProb(race.scoredField, [1, 2, 3]);
  const expected = 0.40 * (0.30 / 0.60) * (0.20 / 0.30);
  assert.ok(approxEq(p, expected, 1e-6), `expected ${expected}, got ${p}`);
});

// ── evaluateWPS ─────────────────────────────────────────────────────────────
test('evaluateWPS win: returns cost = amount', () => {
  const race = fourHorseField();
  const r = be.evaluateWPS(race, { pp: 1 }, 'win', 2);
  assert.equal(r.cost, 2);
  assert.ok(r.probability > 0);
  assert.ok(r.expectedReturn >= 0);
  assert.equal(typeof r.expectedValue, 'number');
});
test('evaluateWPS place: place probability > win probability for same horse', () => {
  const race = fourHorseField();
  const win = be.evaluateWPS(race, { pp: 2 }, 'win', 2);
  const place = be.evaluateWPS(race, { pp: 2 }, 'place', 2);
  assert.ok(place.probability > win.probability,
    `place ${place.probability} should exceed win ${win.probability}`);
});
test('evaluateWPS show: show probability > place probability', () => {
  const race = fourHorseField();
  const place = be.evaluateWPS(race, { pp: 3 }, 'place', 2);
  const show = be.evaluateWPS(race, { pp: 3 }, 'show', 2);
  assert.ok(show.probability >= place.probability);
});
test('evaluateWPS: unknown pp returns error', () => {
  const race = fourHorseField();
  const r = be.evaluateWPS(race, { pp: 99 }, 'win', 2);
  assert.ok(r.error, 'expected error for unknown pp');
});
test('evaluateWPS: overlay verdict shape is present', () => {
  const race = fourHorseField();
  const r = be.evaluateWPS(race, { pp: 1 }, 'win', 2);
  // overlay may be null if no morning line; just check field exists
  assert.ok('overlay' in r);
});

// ── evaluateExotic ──────────────────────────────────────────────────────────
test('evaluateExotic: exacta straight 1-2, $1 base → cost $1', () => {
  const race = fourHorseField();
  const r = be.evaluateExotic(race, 'straight', { positions: [1, 2] }, 1, 'exacta');
  assert.equal(r.cost, 1);
  assert.equal(r.permutations, 1);
  assert.ok(r.probability > 0);
});
test('evaluateExotic: exacta box of 4, $1 base → cost = 12 (4P2)', () => {
  const race = fourHorseField();
  const r = be.evaluateExotic(race, 'box', { horses: [1, 2, 3, 4] }, 1, 'exacta');
  assert.equal(r.permutations, 12);
  assert.equal(r.cost, 12);
});
test('evaluateExotic: full-field exacta box ER = (1-takeout) × cost (pricing identity)', () => {
  const race = fourHorseField();
  const r = be.evaluateExotic(race, 'box', { horses: [1, 2, 3, 4] }, 1, 'exacta');
  const t = be.getTakeout('BEL', 'exacta'); // 0.185
  const expectedER = (1 - t) * r.cost;
  // Some implementations sum per-permutation ER, which differs slightly from
  // strict (1-t)*cost when the field isn't fully covered. For full-field box
  // they should match within float tolerance.
  assert.ok(approxEq(r.expectedReturn, expectedER, 0.05),
    `Fair-pricing identity broken: ER ${r.expectedReturn} vs ${(1-t)} × ${r.cost} = ${expectedER}`);
});
test('evaluateExotic: trifecta box of 3 → cost = $6 (3! = 6)', () => {
  const race = fourHorseField();
  const r = be.evaluateExotic(race, 'box', { horses: [1, 2, 3] }, 1, 'trifecta');
  assert.equal(r.permutations, 6);
  assert.equal(r.cost, 6);
});
test('evaluateExotic: trifecta key 1 with 2,3,4 → 6 perms = (3 × 2) for 2nd/3rd order', () => {
  const race = fourHorseField();
  const r = be.evaluateExotic(race, 'key', { keyHorse: 1, withHorses: [2, 3, 4] }, 1, 'trifecta');
  assert.equal(r.permutations, 6);
});

// ── evaluateMultiRace ───────────────────────────────────────────────────────
function legsFromFields(fields, horsesPerLeg) {
  return fields.map((race, i) => ({ race, horses: horsesPerLeg[i] }));
}

test('evaluateMultiRace: pick3 with 1×1×1 = $1 cost, ER = (1-0.24)×$1', () => {
  const r = be.evaluateMultiRace(
    legsFromFields([fourHorseField(), fourHorseField(), fourHorseField()], [[1], [1], [1]]),
    1,
    'pick3'
  );
  assert.equal(r.cost, 1);
  assert.equal(r.combinations, 1);
  assert.ok(approxEq(r.expectedReturn, 0.76 * 1, 1e-3));
});

test('evaluateMultiRace: pick4 ALL×ALL×ALL×ALL → ER = (1-takeout) × cost (pricing identity)', () => {
  const r = be.evaluateMultiRace(
    legsFromFields(
      [fourHorseField(), fourHorseField(), fourHorseField(), fourHorseField()],
      [[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]]
    ),
    0.5,
    'pick4'
  );
  // cost = 4^4 × 0.5 = 128. takeout BEL pick4 = 0.24. ER = 0.76 × 128 = 97.28
  const t = be.getTakeout('BEL', 'pick4');
  assert.equal(r.combinations, 256);
  assert.equal(r.cost, 128);
  assert.ok(approxEq(r.expectedReturn, (1 - t) * r.cost, 1e-2),
    `Pricing identity broken on Pick 4: got ER ${r.expectedReturn}, expected ${(1-t)*r.cost}`);
});

test('evaluateMultiRace: pick3 mixed 1×2×3 = 6 combos', () => {
  const r = be.evaluateMultiRace(
    legsFromFields([fourHorseField(), fourHorseField(), fourHorseField()], [[1], [1, 2], [1, 2, 3]]),
    0.5,
    'pick3'
  );
  assert.equal(r.combinations, 6);
  assert.equal(r.cost, 3);
});

test('evaluateMultiRace: leg count mismatch returns error', () => {
  const r = be.evaluateMultiRace(
    legsFromFields([fourHorseField(), fourHorseField(), fourHorseField()], [[1], [1], [1]]),
    1,
    'pick4'
  );
  assert.ok(r.error);
});

test('evaluateMultiRace: < 3 legs returns error', () => {
  const r = be.evaluateMultiRace(
    legsFromFields([fourHorseField(), fourHorseField()], [[1], [1]]),
    1,
    'pick3'
  );
  assert.ok(r.error);
});

test('evaluateMultiRace: empty leg returns error', () => {
  const r = be.evaluateMultiRace(
    legsFromFields([fourHorseField(), fourHorseField(), fourHorseField()], [[1], [], [1]]),
    1,
    'pick3'
  );
  assert.ok(r.error);
});

test('evaluateMultiRace: wide-leg warning fires when selecting > half the field', () => {
  const r = be.evaluateMultiRace(
    legsFromFields([fourHorseField(), fourHorseField(), fourHorseField()], [[1], [1, 2, 3], [1]]),
    0.5,
    'pick3'
  );
  const codes = (r.warnings || []).map((w) => w.code);
  assert.ok(codes.includes('wide_leg'));
});

// ── evaluateBet (dispatcher) ────────────────────────────────────────────────
test('evaluateBet: routes "win" pool to WPS evaluator', () => {
  const race = fourHorseField();
  const r = be.evaluateBet({ pool: 'win', race, selection: { pp: 1 }, amount: 2 });
  assert.equal(r.cost, 2);
  assert.equal(r.type || 'win', 'win');
});

test('evaluateBet: routes "exacta" with box structure', () => {
  const race = fourHorseField();
  const r = be.evaluateBet({
    pool: 'exacta',
    race,
    structure: 'box',
    selection: { horses: [1, 2, 3] },
    amount: 1,
  });
  // 3P2 = 6 perms
  assert.equal(r.permutations, 6);
});

test('evaluateBet: routes "pick3" to multi-race evaluator', () => {
  const r = be.evaluateBet({
    pool: 'pick3',
    legs: legsFromFields([fourHorseField(), fourHorseField(), fourHorseField()], [[1], [1], [1]]),
    amount: 1,
  });
  assert.equal(r.cost, 1);
});

test('evaluateBet: unknown pool returns error', () => {
  const r = be.evaluateBet({ pool: 'fakebet', race: fourHorseField(), amount: 1 });
  assert.ok(r.error);
});

// ── TAKEOUT_TABLE structure ─────────────────────────────────────────────────
test('TAKEOUT_TABLE: every entry has a source and required pool keys', () => {
  const requiredKeys = ['win', 'place', 'show', 'exacta', 'trifecta', 'superfecta', 'pick3', 'pick4', 'pick5'];
  for (const code of Object.keys(be.TAKEOUT_TABLE)) {
    const entry = be.TAKEOUT_TABLE[code];
    assert.ok(typeof entry.source === 'string' && entry.source.length > 0,
      `${code} missing source`);
    for (const k of requiredKeys) {
      assert.ok(typeof entry[k] === 'number' && entry[k] >= 0 && entry[k] < 0.5,
        `${code}.${k} not a valid takeout (${entry[k]})`);
    }
  }
});
