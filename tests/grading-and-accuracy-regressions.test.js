'use strict';

// Regression lock for the bet-grading and accuracy-tracking bugs found and
// fixed on 2026-07-05/06 (v2.49.13 through v2.49.19). Each of these shipped
// with a one-off Playwright script that proved the bug and then the fix,
// but none of those became part of the permanent suite — so a future edit
// to this code could silently reintroduce any of them with nothing to
// catch it. This file executes the actual patched functions (extracted
// from index.html) inside a sandboxed vm context, mirroring the pattern
// established in tests/bets-tab-fix.test.js, rather than re-testing via a
// live browser.
//
// Bugs covered (see CHANGELOG.md for full root-cause writeups):
//   v2.49.13 — "Exacta Box" display-label bets never matched grading's
//              short-code checks and could never resolve.
//   v2.49.14 — Expert Consensus accuracy counted a win only if the user
//              also personally bet and won, not whether the pick won.
//   v2.49.15 — Wizard-built Daily Double/Pick 3-6 bets always graded as a
//              loss (selections['leg_N'] never read); deduplicateBets()
//              crashed on the same object-shaped selections.
//   v2.49.16 — removeExoticBet() never refreshed the bankroll banner.
//   v2.49.17 — isActionBet was never assigned, so the Action Bet Record
//              tile was permanently dead.
//   v2.49.18 — Overall Advice Engine ROI pooled in every non-exotic bet,
//              tagged or not, graded or not; bet-type breakdown didn't
//              merge legacy/short-code exotic type rows.
//   v2.49.19 — the "still pending" toast count included ungraded bets
//              from any past date, not just today's card.

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

const TODAY = '2026-07-06';

// normalizeHorseName + fuzzyHorseMatch + _normalizeRaceResult + cache
// helpers + normalizeExoticTypeCode + resolveExoticBet + resolveMultiRaceBet
// — this whole block is self-contained (no deps outside itself besides
// localStorage, which none of the functions under test here actually call).
const GRADING_HELPERS_SRC = sliceBetween(
  'function normalizeHorseName(name)',
  'async function fetchLiveResults()'
);

function makeElMap() {
  const elMap = new Map();
  function el(id) {
    if (!elMap.has(id)) {
      const classes = new Set();
      elMap.set(id, {
        textContent: '',
        innerHTML: '',
        classList: {
          add: (c) => classes.add(c),
          remove: (c) => classes.delete(c),
          contains: (c) => classes.has(c),
        },
      });
    }
    return elMap.get(id);
  }
  return { el, elMap };
}

class FakeLocalStorage {
  constructor() { this._map = new Map(); }
  get length() { return this._map.size; }
  key(i) { return Array.from(this._map.keys())[i]; }
  getItem(k) { return this._map.has(k) ? this._map.get(k) : null; }
  setItem(k, v) { this._map.set(k, String(v)); }
  removeItem(k) { this._map.delete(k); }
}

function makeSandbox(overrides) {
  const { el } = makeElMap();
  const sandbox = {
    el,
    console,
    getTodayStr: () => TODAY,
    getActiveTrack: () => 'SAR',
    fmt$: (n) => '$' + Number(n).toFixed(2),
    fmtPct: (n) => (parseFloat(n) || 0).toFixed(1) + '%',
  };
  Object.assign(sandbox, overrides);
  return vm.createContext(sandbox);
}

// ── v2.49.13: "Exacta Box" display-label bets must resolve ─────────────────
test('v2.49.13 regression: resolveExoticBet grades a bet.type of "Exacta Box" (display label), not just "EX"', () => {
  const ctx = makeSandbox({});
  vm.runInContext(GRADING_HELPERS_SRC, ctx);

  const raceResult = {
    results: [
      { position: 1, pp: 6, horseName: 'Music in Motion' },
      { position: 2, pp: 3, horseName: 'Second Choice' },
      { position: 3, pp: 1, horseName: 'Bystander' },
    ],
    exotics: [{ type: 'exacta', payout: 42.5 }],
  };
  const bet = {
    type: 'Exacta Box', mode: 'box', amount: 2,
    selections: ['Music in Motion', 'Second Choice'],
  };
  const result = vm.runInContext('resolveExoticBet(bet, raceResult)', Object.assign(ctx, { bet, raceResult }));
  assert.equal(result.result, 'win', '"Exacta Box" must be recognized as an EX-type bet and grade the box hit as a win');
  assert.ok(result.payout > 0);
});

test('v2.49.13 regression: normalizeExoticTypeCode maps every known display label and short code', () => {
  const ctx = makeSandbox({});
  vm.runInContext(GRADING_HELPERS_SRC, ctx);
  const cases = [
    ['Exacta Box', 'EX'], ['EX', 'EX'],
    ['Trifecta Box', 'TRI'], ['TRI', 'TRI'],
    ['Superfecta Box', 'SUPER'], ['SUPER', 'SUPER'],
    ['Daily Double', 'DD'], ['DD', 'DD'],
    ['Pick 3', 'P3'], ['Pick3', 'P3'],
    ['Pick 6', 'P6'],
  ];
  for (const [input, expected] of cases) {
    const got = vm.runInContext('normalizeExoticTypeCode(' + JSON.stringify(input) + ')', ctx);
    assert.equal(got, expected, `normalizeExoticTypeCode(${input}) should be ${expected}, got ${got}`);
  }
});

// ── v2.49.15 (Bug 1, CRITICAL): wizard multi-race exotics must grade correctly ─
test('v2.49.15 regression: resolveMultiRaceBet reads leg_N-keyed selections (wizLockBet shape) and grades a clean sweep as a win', () => {
  const ctx = makeSandbox({});
  vm.runInContext(GRADING_HELPERS_SRC, ctx);

  const bet = {
    type: 'P3', raceNum: '2,3,4', amount: 2,
    selections: { leg_0: ['Leg One Winner'], leg_1: ['Leg Two Winner'], leg_2: ['Leg Three Winner'] },
  };
  const allRaceResults = [
    { raceNumber: 2, results: [{ position: 1, horseName: 'Leg One Winner', pp: 1 }] },
    { raceNumber: 3, results: [{ position: 1, horseName: 'Leg Two Winner', pp: 2 }] },
    { raceNumber: 4, results: [{ position: 1, horseName: 'Leg Three Winner', pp: 3 }], exotics: [{ type: 'pick3', payout: 20 }] },
  ];
  const result = vm.runInContext('resolveMultiRaceBet(bet, allRaceResults)', Object.assign(ctx, { bet, allRaceResults }));
  assert.equal(result.result, 'win', 'every leg won — this must never grade as a loss (the v2.49.15 bug)');
  assert.ok(result.payout > 0);
});

test('v2.49.15 regression: resolveMultiRaceBet still grades a losing leg as a loss (no over-fix)', () => {
  const ctx = makeSandbox({});
  vm.runInContext(GRADING_HELPERS_SRC, ctx);

  const bet = {
    type: 'P3', raceNum: '5,6,7', amount: 2,
    selections: { leg_0: ['Leg A Winner'], leg_1: ['Leg B Winner'], leg_2: ['Wrong Horse'] },
  };
  const allRaceResults = [
    { raceNumber: 5, results: [{ position: 1, horseName: 'Leg A Winner', pp: 1 }] },
    { raceNumber: 6, results: [{ position: 1, horseName: 'Leg B Winner', pp: 2 }] },
    { raceNumber: 7, results: [{ position: 1, horseName: 'Right Horse', pp: 3 }] },
  ];
  const result = vm.runInContext('resolveMultiRaceBet(bet, allRaceResults)', Object.assign(ctx, { bet, allRaceResults }));
  assert.equal(result.result, 'loss');
});

test('v2.49.15 regression: resolveMultiRaceBet still supports legacy numeric-key selections', () => {
  const ctx = makeSandbox({});
  vm.runInContext(GRADING_HELPERS_SRC, ctx);

  const bet = {
    type: 'DD', raceNum: '8,9', amount: 2,
    selections: { 0: ['Legacy Winner One'], 1: ['Legacy Winner Two'] },
  };
  const allRaceResults = [
    { raceNumber: 8, results: [{ position: 1, horseName: 'Legacy Winner One', pp: 1 }] },
    { raceNumber: 9, results: [{ position: 1, horseName: 'Legacy Winner Two', pp: 2 }], exotics: [{ type: 'daily_double', payout: 25 }] },
  ];
  const result = vm.runInContext('resolveMultiRaceBet(bet, allRaceResults)', Object.assign(ctx, { bet, allRaceResults }));
  assert.equal(result.result, 'win', 'pre-existing numeric-key fallback path must not regress');
});

// ── v2.49.15 (bonus): deduplicateBets must not crash on object-shaped selections ─
test('v2.49.15 regression: deduplicateBets does not throw on a multi-race exotic\'s leg_N-keyed selections', () => {
  const src = sliceFn('deduplicateBets', 'function initApp');
  let saved = null;
  const ctx = makeSandbox({
    getTrackData: () => ctx.__data,
    saveTrackData: (d) => { saved = d; },
  });
  ctx.__data = {
    bets: [
      { raceNum: '2,3,4', type: 'P3', selections: { leg_0: ['A'], leg_1: ['B'], leg_2: ['C'] }, amount: 2 },
      { raceNum: 1, type: 'Win', selections: ['Some Horse'], amount: 2 },
    ],
  };
  assert.doesNotThrow(() => {
    vm.runInContext(src + '\ndeduplicateBets();', ctx);
  }, 'must not throw TypeError: (bet.selections || []).join is not a function');
});

test('v2.49.15 regression: deduplicateBets still merges true array-shaped duplicates', () => {
  const src = sliceFn('deduplicateBets', 'function initApp');
  const ctx = makeSandbox({
    getTrackData: () => ctx.__data,
    saveTrackData: (d) => { ctx.__data = d; },
  });
  ctx.__data = {
    bets: [
      { raceNum: 1, type: 'Win', selections: ['Some Horse'], amount: 2 },
      { raceNum: 1, type: 'Win', selections: ['Some Horse'], amount: 5 },
    ],
  };
  vm.runInContext(src + '\ndeduplicateBets();', ctx);
  assert.equal(ctx.__data.bets.length, 1, 'true duplicates must still merge');
  assert.equal(ctx.__data.bets[0].amount, 5, 'higher amount must be preserved on merge');
});

// ── v2.49.6: scratch refund logic (already-shipped, locking it in) ─────────
test('v2.49.6 regression: applyScratchToBetsAndData refunds a matching ungraded straight bet', () => {
  const helpers = GRADING_HELPERS_SRC; // fuzzyHorseMatch, normalizeExoticTypeCode
  const src = sliceFn('applyScratchToBetsAndData', 'function toggleScratch');
  const ctx = makeSandbox({});
  const data = {
    bets: [
      { date: TODAY, raceNum: 3, isExotic: false, selections: ['Scratched Horse'], amount: 10, result: null },
    ],
  };
  const race = { num: 3 };
  const horse = { name: 'Scratched Horse', wps: ['W'] };
  vm.runInContext(helpers + '\n' + src + '\nglobalThis.__refunded = applyScratchToBetsAndData(data, race, horse);',
    Object.assign(ctx, { data, race, horse }));
  assert.equal(ctx.__refunded, 1);
  assert.equal(data.bets[0].result, 'scratch');
  assert.equal(data.bets[0].payout, 10, 'must refund the full stake');
});

// ── v2.49.16: removeExoticBet must refresh the bankroll banner ─────────────
test('v2.49.16 regression: removeExoticBet calls updateBankrollBanner after removing the bet', () => {
  const src = sliceFn('removeExoticBet', 'function renderTodaysLockedBets');
  let bannerCalls = 0;
  const ctx = makeSandbox({
    getTrackData: () => ctx.__data,
    saveTrackData: (d) => { ctx.__data = d; },
    renderLockedExotics: () => {},
    renderTodaysLockedBets: () => {},
    updateBankrollBanner: () => { bannerCalls++; },
  });
  ctx.__data = { bets: [{ id: 'bet-1', cost: 60 }] };
  vm.runInContext(src + "\nremoveExoticBet('bet-1');", ctx);
  assert.equal(ctx.__data.bets.length, 0, 'bet must be removed');
  assert.equal(bannerCalls, 1, 'updateBankrollBanner must be called exactly once (the v2.49.16 bug: it was never called)');
});

// ── v2.49.17: isActionBet must be set on Action Bet ticket clicks ──────────
test('v2.49.17 regression: handleTicketBetClick sets isActionBet for betTag "action" (and not the other flags)', () => {
  const src = sliceFn('handleTicketBetClick', 'function openBetAmountPicker');
  const ctx = makeSandbox({
    getBettingMode: () => 'simulate',
    getTrackData: () => ctx.__data,
    saveTrackData: (d) => { ctx.__data = d; },
    saveStraightBetAmount: () => {},
    showToast: () => {},
    updateBankrollBanner: () => {},
    renderStraightBets: () => {},
    renderLockedExotics: () => {},
    renderTodaysLockedBets: () => {},
    checkBankrollOverrun: () => {},
    generateId: () => 'test-id',
    window: {},
  });
  ctx.__data = { bets: [], races: [{ num: 6, horses: [{ pp: 4, name: 'Action Bet Horse', wps: [] }] }] };
  const fakeEvent = { preventDefault: () => {} };
  vm.runInContext(src, ctx);
  vm.runInContext(
    "handleTicketBetClick(fakeEvent, 6, 'Action Bet Horse', 4, 'Win', 5, 'action');",
    Object.assign(ctx, { fakeEvent })
  );
  const bet = ctx.__data.bets[ctx.__data.bets.length - 1];
  assert.equal(bet.isActionBet, true, 'isActionBet must be set for betTag "action" (the v2.49.17 bug: it was never assigned)');
  assert.equal(bet.isBestBet, false);
  assert.equal(bet.isValuePlay, false);
});

// ── v2.49.14 + v2.49.17: updateAccuracyTracking computes both metrics correctly ─
test('v2.49.14 regression: Expert Consensus counts a win whenever the picked horse actually won, independent of any user bet', () => {
  const ACC_SRC = sliceBetween('const ACCURACY_KEY', 'function renderAccuracyFromStorage');
  const fakeStorage = new FakeLocalStorage();
  const ctx = makeSandbox({
    getTrackData: () => ({ bets: [] }), // v2.49.14's whole point: zero bets placed on the pick
    getCachedResults: () => ([
      { raceNumber: 3, results: [
        { position: 1, horseName: 'Consensus Winner', pp: 5 },
        { position: 2, horseName: 'Consensus Loser', pp: 2 },
      ] },
    ]),
    fuzzyHorseMatch: (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase(),
    renderAdviceReportCard: () => {},
    localStorage: fakeStorage,
  });
  fakeStorage.setItem('ne-racing-ticket-SAR-' + TODAY, JSON.stringify({
    date: TODAY, track: 'SAR',
    expertConsensus: [
      { race: 3, pp: 5, name: 'Consensus Winner' },
      { race: 3, pp: 2, name: 'Consensus Loser' },
    ],
  }));
  vm.runInContext(ACC_SRC + '\nupdateAccuracyTracking();\nglobalThis.__acc = getAccuracyData();', ctx);
  assert.equal(ctx.__acc.expertConsensusWins, 1, 'the actual race winner must count as a win even with zero bets placed');
  assert.equal(ctx.__acc.expertConsensusTotal, 2);
});

test('v2.49.17 regression: updateAccuracyTracking counts isActionBet-flagged, graded bets toward actionBetWins/Total', () => {
  const ACC_SRC = sliceBetween('const ACCURACY_KEY', 'function renderAccuracyFromStorage');
  const fakeStorage = new FakeLocalStorage();
  const ctx = makeSandbox({
    getTrackData: () => ({
      bets: [
        { isActionBet: true, result: 'win', amount: 10, payout: 18 },
        { isBestBet: true, result: 'loss', amount: 10, payout: 0 },
      ],
    }),
    getCachedResults: () => [],
    fuzzyHorseMatch: () => false,
    renderAdviceReportCard: () => {},
    localStorage: fakeStorage,
  });
  vm.runInContext(ACC_SRC + '\nupdateAccuracyTracking();\nglobalThis.__acc = getAccuracyData();', ctx);
  assert.equal(ctx.__acc.actionBetWins, 1);
  assert.equal(ctx.__acc.actionBetTotal, 1, 'only the isActionBet-flagged bet counts, not the isBestBet one');
});

// ── v2.49.18: Overall Advice Engine ROI must exclude untagged/ungraded bets ─
test('v2.49.18 regression: renderAdviceReportCard\'s Overall Advice Engine ROI excludes untagged and ungraded bets', () => {
  const src = sliceFn('renderAdviceReportCard', 'function getAccuracyData');
  const ctx = makeSandbox({
    getTrackData: () => ({
      bets: [
        { isBestBet: true, result: 'win', amount: 10, payout: 22, isExotic: false },      // +12
        { isValuePlay: true, result: 'loss', amount: 10, payout: 0, isExotic: false },    // -10
        { isActionBet: true, result: 'win', amount: 10, payout: 18, isExotic: false },    // +8
        { result: 'win', amount: 500, payout: 900, isExotic: false },                     // untagged — must be EXCLUDED
        { isBestBet: true, result: null, amount: 10, payout: 0, isExotic: false },        // ungraded — must be EXCLUDED
      ],
    }),
    getAccuracyData: () => ({}),
  });
  vm.runInContext(src + '\nrenderAdviceReportCard();', ctx);
  // engine ROI: wagered 30, returned 40 -> (40-30)/30 = 33.3%
  assert.equal(ctx.el('arc-overall-roi').textContent, '33.3%',
    'must reflect only graded, engine-flagged bets — the untagged $500 bet and the ungraded bet must not pool in (the v2.49.18 bug)');
});

// ── v2.49.18 (cosmetic): bet-type breakdown merges legacy/short-code exotics ─
test('v2.49.18 regression: renderBetTypeBreakdown merges a legacy "Exacta Box" bet with a new "EX" bet into one row', () => {
  const src = sliceBetween('var EXOTIC_TYPE_DISPLAY_NAMES', 'function renderResultsList');
  const helpers = GRADING_HELPERS_SRC; // normalizeExoticTypeCode
  const ctx = makeSandbox({
    getResultsBets: () => ([
      { type: 'Exacta Box', isExotic: true, amount: 2, cost: 4, result: 'loss', payout: 0 },
      { type: 'EX', isExotic: true, amount: 2, cost: 4, result: 'win', payout: 12 },
    ]),
  });
  vm.runInContext(helpers + '\n' + src + '\nrenderBetTypeBreakdown();', ctx);
  const tbody = ctx.el('breakdown-body');
  const rowCount = (tbody.innerHTML.match(/<tr>/g) || []).length;
  assert.equal(rowCount, 1, '"Exacta Box" and "EX" must merge into a single row, not render separately');
  assert.match(tbody.innerHTML, />Exacta</, 'merged row should use the friendly display name');
  assert.match(tbody.innerHTML, /\$8\.00/, 'merged wagered total should be 4+4=8');
});

// ── v2.49.19: "still pending" count must be scoped to today's bets ─────────
test('v2.49.19 regression: fetchLiveResults\' pending count excludes ungraded bets from other dates', async () => {
  const helpers = GRADING_HELPERS_SRC; // fuzzyHorseMatch, _normalizeRaceResult
  const src = sliceBetween('async function fetchLiveResults()', 'function hasUnresolvedBets');
  let toastMsg = null;
  const ctx = makeSandbox({
    getStore: () => ({ settings: { workerUrl: 'https://fake.test' } }),
    showToast: (msg) => { toastMsg = msg; },
    getCachedResults: () => [],
    setCachedResults: () => {},
    getTrackData: () => ctx.__data,
    saveTrackData: (d) => { ctx.__data = d; },
    renderResultsTab: () => {},
    renderStraightBets: () => {},
    updateAccuracyTracking: () => {},
    showWinnerOverlay: () => {},
    renderTodayTab: () => {},
    refreshStatusTabIfActive: () => {},
    fetch: async () => ({
      ok: true,
      json: async () => ({ races: [{ raceNumber: 1, results: [{ position: 1, horseName: 'Already Graded Horse', pp: 1 }] }] }),
    }),
  });
  ctx.__data = {
    bets: [
      // Today's only bet — already graded before this call.
      { id: 'today-done', date: TODAY, raceNum: 1, type: 'Win', isExotic: false, selections: ['Already Graded Horse'], amount: 2, result: 'loss', payout: 0 },
      // Old orphaned bets from a month-past date — must NOT count as "today's still pending".
      { id: 'old-1', date: '2026-06-01', raceNum: 4, type: 'Win', isExotic: false, selections: ['Old Horse 1'], amount: 2, result: null },
      { id: 'old-2', date: '2026-06-01', raceNum: 5, type: 'Win', isExotic: false, selections: ['Old Horse 2'], amount: 2, result: null },
    ],
    races: [],
  };
  await vm.runInContext(helpers + '\n' + src + '\nfetchLiveResults();', ctx);
  assert.equal(toastMsg, 'Checked — no new results yet',
    'the toast must not report stale bets from other dates as "still pending" (the v2.49.19 bug reported live)');
});
