'use strict';

// Proves scripts/lib/pick_selection.js (the new headless port, built so a
// scheduled job can compute the day's picks without a browser) makes the
// EXACT same decisions as the live client's updateTopPicksCard(). Rather
// than trusting a hand-copied port, this extracts the real selection logic
// straight out of index.html via the same vm-sandbox pattern the rest of
// this test suite already uses, runs it against a real fixture, and asserts
// the headless module produces identical output for the same input.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { selectPicks, relativeConfidence, isTruePass } = require('../scripts/lib/pick_selection');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceBetween(startMarker, endMarker) {
  const start = INDEX.indexOf(startMarker);
  assert.ok(start > -1, 'start marker ' + JSON.stringify(startMarker) + ' not found');
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(end > -1, 'end marker ' + JSON.stringify(endMarker) + ' not found');
  return INDEX.slice(start, end);
}

// The pure decision logic, in the exact order it runs in updateTopPicksCard:
// best bet -> value plays -> action bets -> pass -> (further down, unchanged
// in between) exotic of the day. Both slices are fully self-contained pure
// array/object logic -- no DOM, no HTML building -- confirmed by reading
// index.html directly before extracting these exact markers.
const HELPERS_SRC = sliceBetween('function relativeConfidence(scored, fieldSize)', 'function betSizeHint');
const SELECTION_SRC = sliceBetween('  const raceMap = {};\n  allScores.forEach(s => {\n    if (!raceMap[s.race.id])', '\n  let html = \'\';');
const EXOTIC_SRC = sliceBetween('  // ── Exotic of the Day: best exacta box across all races ──', '\n  if (bestExoticRace && bestExoticRace.group.length >= 2) {');

// index.html actually declares parseOddsToNum TWICE (lines ~223 and ~15612,
// unrelated to this port); the later declaration wins as the effective
// binding at runtime, per normal JS function-redeclaration semantics. Use
// that same one here so this comparison reflects real runtime behavior.
const PARSE_ODDS_SRC = sliceBetween('function parseOddsToNum(odds) {', '\n/* ── Post-time parsing');

function runLiveSelection(allScores) {
  const ctx = vm.createContext({ allScores, console });
  vm.runInContext(PARSE_ODDS_SRC, ctx);
  vm.runInContext(HELPERS_SRC + '\n' + SELECTION_SRC + '\n' + EXOTIC_SRC + '\n' +
    'globalThis.__out = { bestBetEntry, valuePlays, topActionBets, passRaceNums, raceInfo, bestExoticRace };', ctx);
  return ctx.__out;
}

// ── Fixture builder ──────────────────────────────────────────────────────
// Mirrors the shape scoreRace()/runAdviceEngine() produce: flat scored
// entries with .race and .rank attached.
function makeCard() {
  function race(id, num, size) {
    return { id, num, horses: new Array(size).fill(0).map((_, i) => ({ pp: i + 1 })) };
  }
  const r1 = race('R1', 1, 8); // High-confidence winner -> Best Bet
  const r2 = race('R2', 2, 6); // Overlay horse -> Value Play
  const r3 = race('R3', 3, 5); // Modest gap -> Action Bet
  const r4 = race('R4', 4, 2); // <=3 live runners -> True Pass

  const allScores = [
    // Race 1: big, clear gap, 5 scored runners -> High confidence (needs
    // fieldSize >= 5) -> Best Bet. Zero overlay throughout, so v2.49.42's
    // value-preferred pass correctly falls back to this tier's plain
    // best-by-gap choice (there's no positive-overlay alternative in the
    // High tier to prefer instead).
    { race: r1, rank: 1, score: 90, overlay: 0, modelProb: 0.5, horse: { pp: 1, ml: '2-1' }, completeness: 0.9 },
    { race: r1, rank: 2, score: 60, overlay: 0, modelProb: 0.1, horse: { pp: 2, ml: '5-1' }, completeness: 0.8 },
    { race: r1, rank: 3, score: 55, overlay: 0, modelProb: 0.05, horse: { pp: 3, ml: '8-1' }, completeness: 0.7 },
    { race: r1, rank: 4, score: 50, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '10-1' }, completeness: 0.6 },
    { race: r1, rank: 5, score: 45, overlay: 0, modelProb: 0.05, horse: { pp: 5, ml: '12-1' }, completeness: 0.6 },

    // Race 2: real overlay + score >= 55 -> Value Play. (>=4 scored horses so
    // isTruePass's "<=3 live runners" rule doesn't auto-Pass it.)
    { race: r2, rank: 1, score: 70, overlay: 0.12, modelProb: 0.3, horse: { pp: 1, ml: '9-2' }, completeness: 0.8 },
    { race: r2, rank: 2, score: 65, overlay: 0.02, modelProb: 0.2, horse: { pp: 2, ml: '3-1' }, completeness: 0.7 },
    { race: r2, rank: 3, score: 40, overlay: 0, modelProb: 0.1, horse: { pp: 3, ml: '6-1' }, completeness: 0.5 },
    { race: r2, rank: 4, score: 35, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '12-1' }, completeness: 0.5 },

    // Race 3: no overlay, modest gap -> falls through to Action Bet. (>=4
    // scored horses for the same reason as race 2.)
    { race: r3, rank: 1, score: 62, overlay: 0.01, modelProb: 0.25, horse: { pp: 1, ml: '7-2' }, completeness: 0.6 },
    { race: r3, rank: 2, score: 58, overlay: 0, modelProb: 0.15, horse: { pp: 2, ml: '4-1' }, completeness: 0.5 },
    { race: r3, rank: 3, score: 45, overlay: 0, modelProb: 0.1, horse: { pp: 3, ml: '9-1' }, completeness: 0.4 },
    { race: r3, rank: 4, score: 40, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '15-1' }, completeness: 0.3 },

    // Race 4: only 2 live runners -> True Pass regardless of score.
    { race: r4, rank: 1, score: 80, overlay: 0, modelProb: 0.6, horse: { pp: 1, ml: '1-2' }, completeness: 0.9 },
    { race: r4, rank: 2, score: 30, overlay: 0, modelProb: 0.1, horse: { pp: 2, ml: '20-1' }, completeness: 0.3 },
  ];
  return allScores;
}

test('relativeConfidence / isTruePass: headless port matches the live client byte-for-byte on shared cases', () => {
  const ctx = vm.createContext({});
  vm.runInContext(HELPERS_SRC + '\nglobalThis.__rc = relativeConfidence; globalThis.__tp = isTruePass;', ctx);
  const cases = [
    [[{ score: 90 }, { score: 60 }, { score: 55 }, { score: 50 }, { score: 45 }], 5],
    [[{ score: 62 }, { score: 58 }], 2],
    [[{ score: 70 }, { score: 68 }, { score: 66 }, { score: 64 }], 4],
  ];
  for (const [scored, fieldSize] of cases) {
    assert.equal(relativeConfidence(scored, fieldSize), vm.runInContext('__rc', ctx)(scored, fieldSize));
  }
  const race = { horses: [{ pp: 1 }, { pp: 2 }, { pp: 3 }] };
  const scored3 = [{ horse: { ml: '2-1' } }, { horse: { ml: '3-1' } }, { horse: { ml: '4-1' } }];
  assert.equal(isTruePass(race, scored3), vm.runInContext('__tp', ctx)(race, scored3));
});

test('selectPicks: matches the live client exactly on a realistic mixed card', () => {
  const allScores = makeCard();
  const live = runLiveSelection(allScores);
  const ported = selectPicks(allScores);

  assert.equal(ported.bestBet.race.id, live.bestBetEntry.race.id, 'Best Bet race must match');
  assert.equal(ported.bestBet.horse.pp, live.bestBetEntry.horse.pp);

  // Compared via JSON round-trip rather than assert.deepEqual: `live`'s
  // arrays are built inside the vm sandbox (its own realm), and Node's
  // strict deepEqual treats same-shape cross-realm arrays as unequal.
  assert.equal(ported.valuePlays.length, live.valuePlays.length);
  assert.deepEqual(
    ported.valuePlays.map(v => v.race.id + ':' + v.horse.pp),
    JSON.parse(JSON.stringify(live.valuePlays)).map(v => v.race.id + ':' + v.horse.pp),
  );

  assert.equal(ported.actionBets.length, live.topActionBets.length);
  assert.deepEqual(
    ported.actionBets.map(a => a.entry.race.id + ':' + a.entry.horse.pp),
    JSON.parse(JSON.stringify(live.topActionBets)).map(a => a.entry.race.id + ':' + a.entry.horse.pp),
  );

  assert.deepEqual(ported.passRaceNums, JSON.parse(JSON.stringify(live.passRaceNums)));
  assert.equal(ported.passRaceNums.length, 1);
  assert.equal(ported.passRaceNums[0], 4, 'Race 4 (<=3 live runners) must be the only True Pass');

  assert.equal(!!ported.exoticOfDay, !!live.bestExoticRace);
  if (ported.exoticOfDay) {
    assert.equal(ported.exoticOfDay.race.id, live.bestExoticRace.group[0].race.id);
    assert.equal(ported.exoticOfDay.ex1.horse.pp, live.bestExoticRace.group[0].horse.pp);
    assert.equal(ported.exoticOfDay.ex2.horse.pp, live.bestExoticRace.group[1].horse.pp);
  }
});

test('selectPicks: Value Play carries the same Exacta Box partner the client would use', () => {
  const allScores = makeCard();
  const ported = selectPicks(allScores);
  const vp = ported.valuePlays[0];
  assert.ok(vp, 'expected at least one Value Play in the fixture');
  // Race 2's Value Play is rank 1 (pp 1) -> partner should be raceGroup[1] (pp 2), per
  // the exact same rule the live "Value Plays" ticket loop uses.
  assert.equal(vp._exactaPartner.horse.pp, 2);
});

test('selectPicks v2.49.42: Best Bet prefers a same-tier race with real market overlay over a bigger-gap race the market already prices fairly', () => {
  function race(id, num, size) {
    return { id, num, horses: new Array(size).fill(0).map((_, i) => ({ pp: i + 1 })) };
  }
  // Both races land in the same confidence tier (fieldSize 4 -> at best
  // 'medium', per relativeConfidence's fieldSize>=5 gate for 'high').
  // rA has the bigger raw score gap (would have won under the old,
  // overlay-blind logic) but zero market disagreement (overlay 0) --
  // the model isn't spotting anything the market hasn't already priced.
  // rB has a smaller gap but real overlay (0.15) -- genuine value.
  const rA = race('RA', 1, 4);
  const rB = race('RB', 2, 4);
  const allScores = [
    { race: rA, rank: 1, score: 90, overlay: 0, modelProb: 0.5, horse: { pp: 1, ml: '2-1' }, completeness: 0.9 },
    { race: rA, rank: 2, score: 60, overlay: 0, modelProb: 0.1, horse: { pp: 2, ml: '5-1' }, completeness: 0.8 },
    { race: rA, rank: 3, score: 55, overlay: 0, modelProb: 0.05, horse: { pp: 3, ml: '8-1' }, completeness: 0.7 },
    { race: rA, rank: 4, score: 50, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '10-1' }, completeness: 0.6 },

    { race: rB, rank: 1, score: 70, overlay: 0.15, modelProb: 0.35, horse: { pp: 1, ml: '9-2' }, completeness: 0.8 },
    { race: rB, rank: 2, score: 65, overlay: 0.02, modelProb: 0.2, horse: { pp: 2, ml: '3-1' }, completeness: 0.7 },
    { race: rB, rank: 3, score: 40, overlay: 0, modelProb: 0.1, horse: { pp: 3, ml: '6-1' }, completeness: 0.5 },
    { race: rB, rank: 4, score: 35, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '12-1' }, completeness: 0.5 },
  ];

  const ported = selectPicks(allScores);
  assert.equal(ported.bestBet.race.id, 'RB', 'the race with real market overlay must win Best Bet, not the bigger-gap race with no edge');
  assert.equal(ported.bestBet.horse.pp, 1);

  // Cross-check against the actual live client logic, not just the port.
  const live = runLiveSelection(allScores);
  assert.equal(live.bestBetEntry.race.id, 'RB', 'the live client must make the identical choice');
  assert.equal(ported.bestBet.race.id, live.bestBetEntry.race.id);
});

test('selectPicks v2.49.42: falls back to plain best-by-gap when NO same-tier candidate has positive overlay (no regression)', () => {
  function race(id, num, size) {
    return { id, num, horses: new Array(size).fill(0).map((_, i) => ({ pp: i + 1 })) };
  }
  const rA = race('RA', 1, 4);
  const rB = race('RB', 2, 4);
  const allScores = [
    { race: rA, rank: 1, score: 90, overlay: 0, modelProb: 0.5, horse: { pp: 1, ml: '2-1' }, completeness: 0.9 },
    { race: rA, rank: 2, score: 60, overlay: 0, modelProb: 0.1, horse: { pp: 2, ml: '5-1' }, completeness: 0.8 },
    { race: rA, rank: 3, score: 55, overlay: 0, modelProb: 0.05, horse: { pp: 3, ml: '8-1' }, completeness: 0.7 },
    { race: rA, rank: 4, score: 50, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '10-1' }, completeness: 0.6 },

    { race: rB, rank: 1, score: 70, overlay: 0, modelProb: 0.35, horse: { pp: 1, ml: '9-2' }, completeness: 0.8 },
    { race: rB, rank: 2, score: 65, overlay: 0, modelProb: 0.2, horse: { pp: 2, ml: '3-1' }, completeness: 0.7 },
    { race: rB, rank: 3, score: 40, overlay: 0, modelProb: 0.1, horse: { pp: 3, ml: '6-1' }, completeness: 0.5 },
    { race: rB, rank: 4, score: 35, overlay: 0, modelProb: 0.05, horse: { pp: 4, ml: '12-1' }, completeness: 0.5 },
  ];
  const ported = selectPicks(allScores);
  assert.equal(ported.bestBet.race.id, 'RA', 'with no overlay anywhere in the tier, the biggest-gap race must still win, unchanged from before');
});

test('selectPicks: an all-True-Pass card yields no Best Bet, no Value Plays, all Pass', () => {
  const race = { id: 'R1', num: 1, horses: [{ pp: 1 }, { pp: 2 }] }; // 2 live -> True Pass
  const allScores = [
    { race, rank: 1, score: 80, overlay: 0, horse: { pp: 1, ml: '1-2' }, completeness: 0.9 },
    { race, rank: 2, score: 30, overlay: 0, horse: { pp: 2, ml: '20-1' }, completeness: 0.3 },
  ];
  const out = selectPicks(allScores);
  assert.equal(out.bestBet, null);
  assert.equal(out.valuePlays.length, 0);
  assert.equal(out.actionBets.length, 0);
  assert.deepEqual(out.passRaceNums, [1]);
  assert.equal(out.exoticOfDay, null, 'a True-Pass-only card must not produce an Exotic of the Day either');
});
