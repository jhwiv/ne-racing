'use strict';

// Regression lock for bugs found and fixed on 2026-07-06 (v2.49.20) during an
// audit of the handicapping/pick-selection engine and the standalone Bet
// Evaluator tool, requested after the earlier v2.49.13-19 bet-grading pass.
// Same vm-sandbox pattern as tests/grading-and-accuracy-regressions.test.js.
//
// Bugs covered here:
//   - isTruePass()'s ">50% scratched" auto-Pass rule could never fire (it
//     compared scratched/all using an array that never contains scratched
//     horses in the first place), so a race gutted by scratches could still
//     become the day's Best Bet or an Action Bet.
//   - storeTicketPicks()/findExpertConsensusPicks() only ever recorded the
//     #1-ranked Action Bet, though up to 5 render as equal cards on the
//     ticket -- silently undercounting Expert Consensus tracking for the
//     other 4.
//   - The Bet Evaluator's verdict badge ("OVERLAY"/"Fair"/"Underlay")
//     mislabeled genuinely negative-EV bets as "Fair" in a takeout gray
//     zone, and could never show "OVERLAY" for exotic/multi-race bets.
//   - Value Play and Exotic-of-the-Day selection never checked the same
//     True-Pass gate Best Bet/Action Bet enforce, so the app could
//     recommend a real wager (or directly contradict its own "Pass" row)
//     in a race the engine itself considers too thin to handicap.
//
// Not covered by an automated test in this file (verified instead by direct
// source tracing, since it requires driving the full DOM-heavy Bet
// Evaluator UI state machine rather than a pure data transform): the Bet
// Evaluator's stale-leg-selection-across-races fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceFn(name, endMarker) {
  const start = INDEX.indexOf('function ' + name);
  assert.ok(start > -1, name + ' not found');
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(end > -1, 'end marker ' + endMarker + ' not found for ' + name);
  return INDEX.slice(start, end);
}

function sliceBetween(startMarker, endMarker) {
  const start = INDEX.indexOf(startMarker);
  assert.ok(start > -1, 'start marker ' + JSON.stringify(startMarker) + ' not found');
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(end > -1, 'end marker ' + JSON.stringify(endMarker) + ' not found');
  return INDEX.slice(start, end);
}

function makeElMap() {
  const elMap = new Map();
  function el(id) {
    if (!elMap.has(id)) {
      const classes = new Set();
      elMap.set(id, { textContent: '', innerHTML: '', classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) } });
    }
    return elMap.get(id);
  }
  return { el, elMap };
}

function makeSandbox(overrides) {
  const { el } = makeElMap();
  const sandbox = { el, console };
  Object.assign(sandbox, overrides);
  return vm.createContext(sandbox);
}

// ── isTruePass: scratch-ratio gate must use the real field size ───────────
test('v2.49.20 regression: isTruePass auto-Passes a race with >50% scratches even when >3 live runners remain', () => {
  const src = sliceFn('isTruePass', 'function betSizeHint');
  const ctx = makeSandbox({ parseOddsToNum: (ml) => parseFloat(ml) || 0 });

  // 10-horse original field, 6 scratched -> 4 live runners, 60% scratched.
  // `scored` (as both scoring engines produce it) only ever contains the
  // 4 live horses -- scratched horses are filtered out before scoring.
  const race = { horses: new Array(10).fill(0).map((_, i) => ({ pp: i + 1, scratched: i < 6 })) };
  const scored = [
    { horse: { pp: 7, ml: '3-1' } },
    { horse: { pp: 8, ml: '5-1' } },
    { horse: { pp: 9, ml: '7-2' } },
    { horse: { pp: 10, ml: '9-2' } },
  ];
  const result = vm.runInContext(src + '\nisTruePass(race, scored);', Object.assign(ctx, { race, scored }));
  assert.equal(result, true, 'a 60%-scratched field with 4 live runners and valid odds must still auto-Pass (the v2.49.20 bug: this could never fire)');
});

test('v2.49.20 regression: isTruePass does NOT auto-Pass a normal field just because some horses scratched (no over-fix)', () => {
  const src = sliceFn('isTruePass', 'function betSizeHint');
  const ctx = makeSandbox({ parseOddsToNum: (ml) => parseFloat(ml) || 0 });

  // 8-horse original field, 1 scratched -> 7 live runners, 12.5% scratched.
  const race = { horses: new Array(8).fill(0).map((_, i) => ({ pp: i + 1, scratched: i === 0 })) };
  const scored = new Array(7).fill(0).map((_, i) => ({ horse: { pp: i + 2, ml: '4-1' } }));
  const result = vm.runInContext(src + '\nisTruePass(race, scored);', Object.assign(ctx, { race, scored }));
  assert.equal(result, false, 'a normal field with light scratching and valid odds must not auto-Pass');
});

test('v2.49.20 regression: isTruePass still auto-Passes on <=3 live runners (pre-existing rule unaffected)', () => {
  const src = sliceFn('isTruePass', 'function betSizeHint');
  const ctx = makeSandbox({ parseOddsToNum: (ml) => parseFloat(ml) || 0 });
  const race = { horses: [{ pp: 1 }, { pp: 2 }, { pp: 3 }] };
  const scored = [{ horse: { pp: 1, ml: '2-1' } }, { horse: { pp: 2, ml: '3-1' } }, { horse: { pp: 3, ml: '4-1' } }];
  const result = vm.runInContext(src + '\nisTruePass(race, scored);', Object.assign(ctx, { race, scored }));
  assert.equal(result, true);
});

// ── storeTicketPicks / findExpertConsensusPicks: track ALL displayed Action Bets ─
test('v2.49.20 regression: findExpertConsensusPicks checks every displayed Action Bet, not just the #1-ranked one', () => {
  const src = sliceBetween('function storeTicketPicks', 'function updateAdviceRaceSelect');
  const ctx = makeSandbox({
    getStore: () => ({}),
    getActiveTrack: () => 'SAR',
    getTodayStr: () => '2026-07-06',
    localStorage: { setItem: () => {} },
  });
  ctx.loadedRaceDate = null;

  const bestBet = null;
  const valuePlays = [];
  // Three displayed Action Bets. #1 by score has no expert backing; #2 and
  // #3 (lower score, still displayed as equal cards) have real consensus.
  const actionBets = [
    { entry: { race: { num: 4 }, horse: { pp: 2, name: 'Top Score No Consensus' }, score: 80, expertMatchCount: 0 } },
    { entry: { race: { num: 6 }, horse: { pp: 5, name: 'Consensus Pick A' }, score: 70, expertMatchCount: 3 } },
    { entry: { race: { num: 7 }, horse: { pp: 1, name: 'Consensus Pick B' }, score: 65, expertMatchCount: 2 } },
  ];
  const picks = vm.runInContext(src + '\nstoreTicketPicks(bestBet, valuePlays, actionBets); globalThis.__stored;',
    Object.assign(ctx, {
      bestBet, valuePlays, actionBets,
      localStorage: {
        setItem: (k, v) => { ctx.__stored = JSON.parse(v); },
      },
    }));
  const stored = ctx.__stored;
  assert.equal(stored.expertConsensus.length, 2,
    'both real consensus picks (#2 and #3 displayed Action Bets) must be tracked, not just the #1-ranked one (the v2.49.20 bug)');
  assert.ok(stored.expertConsensus.some(p => p.name === 'Consensus Pick A'));
  assert.ok(stored.expertConsensus.some(p => p.name === 'Consensus Pick B'));
  assert.equal(stored.actionBets.length, 3, 'all 3 displayed Action Bets must be stored');
  assert.equal(stored.actionBet.name, 'Top Score No Consensus', 'the singular actionBet field stays the #1 pick for backward compatibility');
});

// ── Bet Evaluator verdict badge: base on ev sign, not a takeout-blind flag ─
test('v2.49.20 regression: Bet Evaluator verdict shows "Underlay" (not "Fair") for a bet with positive isOverlay but negative EV', () => {
  const src = sliceFn('renderBetEvalResult', '// Expose for inline handlers');
  const ctx = makeSandbox({
    _betEvalFmtPct: (n) => (n * 100).toFixed(1) + '%',
    _betEvalFmtMoney: (n) => '$' + n.toFixed(2),
    _betEvalFmtSigned: (n) => (n >= 0 ? '+' : '') + n.toFixed(2),
  });
  // Takeout gray zone: isOverlay true (modelProb 0.32 > takenOddsProb 0.30)
  // but ev < 0 once takeout is applied -- the pre-fix code fell through to
  // "Fair" here since neither branch's condition was satisfied.
  const r = { expectedValue: -0.104, overlay: { isOverlay: true, fairOdds: '2.1-1', takenOdds: '2.3-1' }, probability: 0.32, cost: 2, expectedReturn: 1.79, type: 'win' };
  vm.runInContext(src + '\nrenderBetEvalResult(r);', Object.assign(ctx, { r }));
  assert.match(ctx.el('bet-eval-result').innerHTML, />Underlay</,
    'a negative-EV bet must show "Underlay", not fall through to "Fair" (the v2.49.20 gray-zone bug)');
});

test('v2.49.20 regression: Bet Evaluator verdict shows "OVERLAY" for a positive-EV exotic bet (which never sets r.overlay)', () => {
  const src = sliceFn('renderBetEvalResult', '// Expose for inline handlers');
  const ctx = makeSandbox({
    _betEvalFmtPct: (n) => (n * 100).toFixed(1) + '%',
    _betEvalFmtMoney: (n) => '$' + n.toFixed(2),
    _betEvalFmtSigned: (n) => (n >= 0 ? '+' : '') + n.toFixed(2),
  });
  // evaluateExotic() never sets r.overlay at all -- pre-fix, this meant an
  // exotic bet could never show "OVERLAY" no matter how positive its EV.
  const r = { expectedValue: 3.5, probability: 0.2, cost: 6, expectedReturn: 9.5, type: 'exacta' };
  vm.runInContext(src + '\nrenderBetEvalResult(r);', Object.assign(ctx, { r }));
  assert.match(ctx.el('bet-eval-result').innerHTML, />OVERLAY</,
    'a positive-EV exotic bet must be able to show "OVERLAY" (the v2.49.20 bug: r.overlay is never set for exotics/multi-race bets)');
});

test('v2.49.20 regression: Bet Evaluator verdict still shows "Fair" for a genuinely near-zero-EV bet', () => {
  const src = sliceFn('renderBetEvalResult', '// Expose for inline handlers');
  const ctx = makeSandbox({
    _betEvalFmtPct: (n) => (n * 100).toFixed(1) + '%',
    _betEvalFmtMoney: (n) => '$' + n.toFixed(2),
    _betEvalFmtSigned: (n) => (n >= 0 ? '+' : '') + n.toFixed(2),
  });
  const r = { expectedValue: 0, probability: 0.2, cost: 2, expectedReturn: 2, type: 'win' };
  vm.runInContext(src + '\nrenderBetEvalResult(r);', Object.assign(ctx, { r }));
  assert.match(ctx.el('bet-eval-result').innerHTML, />Fair</);
});

// ── Value Play / Exotic-of-the-Day: must respect the True-Pass gate ───────
// Sliced as a raw statement block (not a standalone function) with
// allScores/raceMap/raceInfo/bestBetEntry pre-seeded, bypassing the actual
// scoring engine entirely -- this snippet only consumes already-scored data.
const PICK_SELECTION_BLOCK_SRC = sliceBetween(
  'const bestBetRaceId = bestBetEntry ? bestBetEntry.race.id : null;',
  '  const passRaceNums = [];\n  Object.entries(raceMap).forEach(([raceId, group]) => {\n    if (raceId === bestBetRaceId) return;\n    if (valueRaceIds.has(raceId)) return;\n    if (actionRaceIds.has(raceId)) return;\n    if (raceInfo[raceId].truePass) {\n      passRaceNums.push(group[0].race.num);\n    }\n  });\n'
);

function truePassScenario() {
  // Race A: flagged True-Pass (heavy scratches), but has the CARD'S
  // HIGHEST score and a second horse that would otherwise clear the Value
  // Play bar (overlay > 0.08, score >= 55).
  const raceA = { id: 'rA', num: 1 };
  const raceB = { id: 'rB', num: 2 };
  const a1 = { race: raceA, score: 99, overlay: 0.5, horse: { pp: 1, name: 'PassRaceTopScorer' } };
  const a2 = { race: raceA, score: 90, overlay: 0.3, horse: { pp: 2, name: 'PassRaceSecondScorer' } };
  const b1 = { race: raceB, score: 70, overlay: 0.2, horse: { pp: 1, name: 'NormalRaceHorse' } };
  const b2 = { race: raceB, score: 40, overlay: 0.05, horse: { pp: 2, name: 'NormalRaceHorse2' } };
  const raceMap = { rA: [a1, a2], rB: [b1, b2] };
  const raceInfo = { rA: { truePass: true }, rB: { truePass: false } };
  const allScores = [a1, a2, b1, b2];
  return { raceMap, raceInfo, allScores, bestBetEntry: null };
}

test('v2.49.20 regression: Exotic of the Day never lands on a True-Pass race, even with the card\'s highest score', () => {
  const { raceMap, raceInfo, allScores, bestBetEntry } = truePassScenario();
  const ctx = makeSandbox({ raceMap, raceInfo, allScores, bestBetEntry });
  const exoticSrc = sliceBetween(
    "let bestExoticRace = null;\n  let bestExoticScore = -1;",
    "  if (bestExoticRace && bestExoticRace.group.length >= 2) {"
  );
  vm.runInContext(PICK_SELECTION_BLOCK_SRC + '\n' + exoticSrc + '\nglobalThis.__bestExoticRace = bestExoticRace;', ctx);
  assert.equal(ctx.__bestExoticRace.raceId, 'rB',
    'Exotic of the Day must skip the True-Pass race (rA, score 99) and land on rB instead (the v2.49.20 bug: it ignored the gate entirely)');
});

test('v2.49.20 regression: Value Play never recommends a horse from a True-Pass race', () => {
  const { raceMap, raceInfo, allScores, bestBetEntry } = truePassScenario();
  const ctx = makeSandbox({ raceMap, raceInfo, allScores, bestBetEntry });
  vm.runInContext(PICK_SELECTION_BLOCK_SRC + '\nglobalThis.__valuePlays = valuePlays;', ctx);
  const races = ctx.__valuePlays.map(v => v.race.id);
  assert.ok(!races.includes('rA'), 'no Value Play may come from the True-Pass race rA (the v2.49.20 bug: this gate was entirely missing)');
  assert.ok(races.includes('rB'), 'the legitimate rB candidate must still qualify (no over-fix)');
});

// ── speedSubScore: Prime Power must match its own documented calibration ──
// Confirmed via CHANGELOG.md's v2.46.0 entry (2026-06-05, the original ship
// of Prime Power scoring): the calibration table (PP100->30, PP120->55,
// PP140->80, PP160->95) was documented from day one, but the linear formula
// that shipped alongside it never actually produced those values.
test('v2.49.21 regression: speedSubScore\'s Prime Power sub-score matches its documented calibration table exactly', () => {
  const src = sliceFn('speedSubScore', 'function classSubScore');
  const ctx = makeSandbox({});
  const cases = [[100, 30], [120, 55], [140, 80], [160, 95]];
  for (const [pp, expected] of cases) {
    const horse = { primePower: pp, speedFigs: [] };
    const result = vm.runInContext(src + '\nspeedSubScore(horse);', Object.assign(ctx, { horse }));
    assert.ok(Math.abs(result.score - expected) < 1e-6,
      `PP ${pp} must score ${expected} per the documented calibration (the v2.49.21 bug: the old linear formula gave a materially different value)`);
  }
});

test('v2.49.21 regression: speedSubScore extrapolates sensibly and stays clamped to [0,100] outside the documented range', () => {
  const src = sliceFn('speedSubScore', 'function classSubScore');
  const ctx = makeSandbox({});
  const low = vm.runInContext(src + '\nspeedSubScore(horse);', Object.assign(ctx, { horse: { primePower: 60, speedFigs: [] } }));
  const high = vm.runInContext(src + '\nspeedSubScore(horse);', Object.assign(ctx, { horse: { primePower: 200, speedFigs: [] } }));
  assert.ok(low.score >= 0 && low.score < 30, 'a very low Prime Power must extrapolate below the PP100 anchor, clamped at 0');
  assert.ok(high.score <= 100 && high.score > 95, 'a very high Prime Power must extrapolate above the PP160 anchor, clamped at 100');
});

// ── dataCompleteness: primePower:0 must not short-circuit to "fully complete" ─
test('v2.49.20 regression: dataCompleteness does not treat primePower:0 as full data coverage', () => {
  const src = sliceFn('dataCompleteness', 'function buildPaceContext');
  const ctx = makeSandbox({});
  const horse = { primePower: 0, speedFigs: [], runningStyle: null, jockeyPct: 0, trainerPct: 0, lastClass: null };
  const result = vm.runInContext(src + '\ndataCompleteness(horse);', Object.assign(ctx, { horse }));
  assert.ok(result < 1, 'primePower:0 (malformed data) must not short-circuit to completeness=1 the way a real Prime Power does');
});

test('v2.49.20 regression: dataCompleteness still short-circuits to 1 for a real Prime Power value', () => {
  const src = sliceFn('dataCompleteness', 'function buildPaceContext');
  const ctx = makeSandbox({});
  const horse = { primePower: 118, speedFigs: [], runningStyle: null, jockeyPct: 0, trainerPct: 0, lastClass: null };
  const result = vm.runInContext(src + '\ndataCompleteness(horse);', Object.assign(ctx, { horse }));
  assert.equal(result, 1, 'a real Prime Power value must still anchor completeness to 1 (no regression)');
});
