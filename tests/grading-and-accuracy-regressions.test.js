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
  'async function fetchLiveResults(isManual)'
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

// ── v2.49.25: bet-type breakdown must exclude still-pending bets ───────────
test('v2.49.25 regression: renderBetTypeBreakdown excludes ungraded bets instead of counting them as losses', () => {
  const src = sliceBetween('var EXOTIC_TYPE_DISPLAY_NAMES', 'function renderResultsList');
  const helpers = GRADING_HELPERS_SRC; // normalizeExoticTypeCode
  const ctx = makeSandbox({
    getResultsBets: () => ([
      { type: 'Win', isExotic: false, amount: 2, result: null, payout: undefined }, // still pending
      { type: 'Win', isExotic: false, amount: 2, result: 'win', payout: 8 },
    ]),
  });
  vm.runInContext(helpers + '\n' + src + '\nrenderBetTypeBreakdown();', ctx);
  const tbody = ctx.el('breakdown-body');
  assert.match(tbody.innerHTML, /<td class="mono">1<\/td>/, 'count must be 1 (the pending bet excluded), not 2');
  assert.match(tbody.innerHTML, /100%/, 'win% must reflect only the graded bet (1-for-1), not be diluted to 50%');
  assert.match(tbody.innerHTML, /300\.0%/, 'ROI must be computed on the $2 graded wager only (300%), not diluted by the pending $2 stake to 100%');
});

// ── v2.49.19: "still pending" count must be scoped to today's bets ─────────
test('v2.49.19 regression: fetchLiveResults\' pending count excludes ungraded bets from other dates', async () => {
  const helpers = GRADING_HELPERS_SRC; // fuzzyHorseMatch, _normalizeRaceResult
  const src = sliceBetween('async function fetchLiveResults(isManual)', 'function hasUnresolvedBets');
  let toastMsg = null;
  const ctx = makeSandbox({
    selectedCalendarDate: null, // v2.49.23: fetchLiveResults() now guards on this
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

// ── v2.49.23: background polls must not disturb a future/past-date view ───
// Reported live: "when you scroll the app is very glitchy and will jump all
// over, sometimes going back to today or tomorrow." Root cause: the 60s
// scratch-poll and the results-poll both unconditionally called
// renderTodayTab() at the end regardless of what date the user was
// viewing, tearing down and rebuilding the whole race-list DOM out from
// under a user scrolled into a future card. fetchLiveEntries() already had
// this guard; fetchLiveScratches()/fetchLiveResults() did not.
test('v2.49.23 regression: fetchLiveScratches does nothing when viewing a non-today date', async () => {
  const src = sliceBetween('async function fetchLiveScratches()', 'function normalizeHorseName');
  let renderCalled = false;
  let fetchCalled = false;
  const ctx = makeSandbox({
    selectedCalendarDate: '2026-07-11', // viewing a future Saturday, not today
    getActiveTrack: () => 'SAR',
    getTodayStr: () => TODAY,
    getScratchesUrl: () => 'https://fake.test/scratches',
    fetch: async () => { fetchCalled = true; return { ok: true, json: async () => ({ scratches: [] }) }; },
    getTrackData: () => ({ races: [] }),
    renderTodayTab: () => { renderCalled = true; },
  });
  await vm.runInContext(src + '\nfetchLiveScratches();', ctx);
  assert.equal(fetchCalled, false, 'must not even fetch scratches while viewing a non-today date');
  assert.equal(renderCalled, false, 'must not rebuild the race-list DOM while viewing a non-today date (the v2.49.23 bug)');
});

test('v2.49.23 regression: fetchLiveScratches still works normally when viewing today', async () => {
  const src = sliceBetween('async function fetchLiveScratches()', 'function normalizeHorseName');
  let renderCalled = false;
  const trackData = { races: [{ num: 3, horses: [{ pp: 2, name: 'Scratch Me', scratched: false }] }] };
  const ctx = makeSandbox({
    selectedCalendarDate: null,
    _scratchInitialLoadDone: true,
    unviewedScratches: 0,
    getActiveTrack: () => 'SAR',
    getTodayStr: () => TODAY,
    getScratchesUrl: () => 'https://fake.test/scratches',
    fetch: async () => ({ ok: true, json: async () => ({ scratches: [{ raceNumber: 3, pp: 2, horseName: 'Scratch Me' }] }) }),
    getTrackData: () => trackData,
    saveTrackData: () => {},
    applyScratchToBetsAndData: () => 0,
    updateScratchBadge: () => {},
    showToast: () => {},
    renderTodayTab: () => { renderCalled = true; },
    renderBetsTab: () => {},
    refreshStatusTabIfActive: () => {},
    updateSyncTime: () => {},
  });
  await vm.runInContext(src + '\nfetchLiveScratches();', ctx);
  assert.equal(renderCalled, true, 'must still poll and render normally when actually viewing today (no over-fix)');
});

test('v2.49.23 regression: fetchLiveResults toasts when manually tapped on a non-today date, but stays silent for the automatic poll', async () => {
  const src = sliceBetween('async function fetchLiveResults(isManual)', 'function hasUnresolvedBets');
  let toastMsg = null;
  const makeCtx = () => makeSandbox({
    selectedCalendarDate: '2026-07-11',
    getStore: () => ({ settings: { workerUrl: 'https://fake.test' } }),
    showToast: (msg) => { toastMsg = msg; },
  });

  // Automatic poll (no args) — must stay completely silent.
  toastMsg = null;
  await vm.runInContext(src + '\nfetchLiveResults();', makeCtx());
  assert.equal(toastMsg, null, 'the automatic results-poll must not toast while viewing a non-today date');

  // Manual tap (isManual=true) — must explain why nothing happened.
  toastMsg = null;
  await vm.runInContext(src + '\nfetchLiveResults(true);', makeCtx());
  assert.match(toastMsg, /only available for today/i);
});

// ── v2.49.23: "No Odds Yet" vs "Pass" — the daily ticket's Pass-row copy ───
// Reported live: viewing a card several days out (odds not yet posted),
// EVERY race showed "Pass -- Save bankroll", reading as "nothing here is
// worth betting" when the real reason is that morning-line odds simply
// haven't posted for that date yet.
test('v2.49.23 regression: the ticket shows "No Odds Yet" (not "Pass -- Save bankroll") when zero horses on the card have ML odds', () => {
  const src = sliceBetween(
    '  // ── Pass Races ──',
    "\n  // ── Exotic of the Day"
  );
  const ctx = makeSandbox({
    parseOddsToNum: (ml) => { const n = parseFloat(String(ml).split('-')[0]); return isFinite(n) ? n : NaN; },
  });
  const raceA = { id: 'rA', num: 1 };
  const noOddsHorse = { race: raceA, score: 60, horse: { pp: 1, name: 'No Odds Horse', ml: null } };
  ctx.passRaceNums = [1];
  ctx.bestBetRaceId = null; ctx.valueRaceIds = new Set(); ctx.actionRaceIds = new Set();
  ctx.raceMap = { rA: [noOddsHorse] };
  ctx.allScores = [noOddsHorse];
  ctx.html = ''; ctx.ticketLines = [];
  vm.runInContext(src, ctx);
  assert.match(ctx.html, /No Odds Yet/, 'must show the "No Odds Yet" framing, not "Pass", when no horse on the card has ML odds');
  assert.doesNotMatch(ctx.html, /Save bankroll/);
});

test('v2.49.23 regression: the ticket still shows "Pass -- Save bankroll" when the card genuinely has odds elsewhere', () => {
  const src = sliceBetween(
    '  // ── Pass Races ──',
    "\n  // ── Exotic of the Day"
  );
  const ctx = makeSandbox({
    parseOddsToNum: (ml) => { const n = parseFloat(String(ml).split('-')[0]); return isFinite(n) ? n : NaN; },
  });
  const raceA = { id: 'rA', num: 1 };
  const raceB = { id: 'rB', num: 2 };
  const passHorse = { race: raceA, score: 40, horse: { pp: 1, name: 'Pass Race Horse', ml: null } };
  const oddsElsewhere = { race: raceB, score: 70, horse: { pp: 1, name: 'Has Odds', ml: '5-2' } };
  ctx.passRaceNums = [1];
  ctx.bestBetRaceId = null; ctx.valueRaceIds = new Set(); ctx.actionRaceIds = new Set();
  ctx.raceMap = { rA: [passHorse], rB: [oddsElsewhere] };
  ctx.allScores = [passHorse, oddsElsewhere];
  ctx.html = ''; ctx.ticketLines = [];
  vm.runInContext(src, ctx);
  assert.match(ctx.html, /Save bankroll/, 'a genuinely thin race on a card that otherwise has real odds must keep the original "Pass" framing (no over-fix)');
  assert.doesNotMatch(ctx.html, /No Odds Yet/);
});

// ── v2.49.30: Value Play "Exacta Box" quick-bet button drops the partner
// horse, silently placing an un-gradeable 1-horse "box" that can never win ──
//
// Reported live 2026-07-10: two of three exotic bets placed today ("Pauillac"
// $2 R1, "Trust Fund" $2 R3) showed only ONE horse name despite being tagged
// EXACTA BOX. Root cause: the Value Play card's bet button
// (updateTopPicksCard, onclick="openBetAmountPicker(..., v.horse.name,
// v.horse.pp, 'Exacta Box', 'value')") passes only the Value Play's own
// horse -- never the paired partner horse the card visibly promises
// ("$2 EX Box with #2"). handleTicketBetClick then splits horseName/horsePp
// on '/' to build the exotic selections array; with no '/' present, that
// array has exactly one entry. resolveExoticBet's box-mode logic requires
// `boxSelections.length >= needed` (2 for an exacta) before it will even
// attempt a match -- a 1-name box permanently fails that check and returns
// {result:'loss'} unconditionally, regardless of the real finish. This is
// not a bad pick; the bet was never capable of grading as a win.
test('v2.49.30 regression: a 1-horse "Exacta Box" bet (the un-fixed Value Play button shape) can never win, even when that horse wins', () => {
  const src = GRADING_HELPERS_SRC;
  const ctx = makeSandbox({});
  vm.runInContext(src, ctx);

  // Exactly what handleTicketBetClick produces when horseName/horsePp arrive
  // WITHOUT a slash-joined partner (today's live bug shape).
  const brokenBet = { type: 'Exacta Box', mode: 'box', amount: 2, selections: ['Pauillac'] };
  const raceResult = {
    results: [
      { position: 1, pp: 3, horseName: 'Pauillac' },   // the picked horse DID win
      { position: 2, pp: 7, horseName: 'Sorrentino' },
    ],
    exotics: [{ type: 'exacta', payout: 42.50 }],
  };
  const result = vm.runInContext('resolveExoticBet(brokenBet, raceResult)', Object.assign(ctx, { brokenBet, raceResult }));
  assert.equal(result.result, 'loss', 'a 1-name "box" must grade as a loss unconditionally -- there is no valid 2-horse combination to check, even though the one named horse actually won');
  assert.equal(result.payout, 0);
});

test('v2.49.30 regression: the same bet correctly grades as a win once both horses are present (the fixed 2-horse shape)', () => {
  const src = GRADING_HELPERS_SRC;
  const ctx = makeSandbox({});
  vm.runInContext(src, ctx);

  // What handleTicketBetClick produces once the caller passes the slash-
  // joined partner, matching the already-working "Exotic of the Day" button
  // (app.html ~line 17236): 'Pauillac/Sorrentino'.split('/') -> 2 names.
  const fixedBet = { type: 'Exacta Box', mode: 'box', amount: 2, selections: ['Pauillac', 'Sorrentino'] };
  const raceResult = {
    results: [
      { position: 1, pp: 3, horseName: 'Pauillac' },
      { position: 2, pp: 7, horseName: 'Sorrentino' },
    ],
    exotics: [{ type: 'exacta', payout: 42.50 }],
  };
  const result = vm.runInContext('resolveExoticBet(fixedBet, raceResult)', Object.assign(ctx, { fixedBet, raceResult }));
  assert.equal(result.result, 'win', 'with both horses present, the exact same real outcome must grade as a win');
  assert.ok(result.payout > 0);
});

// ── Confirms the actual bug site: the onclick template must include the
// paired partner horse, mirroring the already-correct "Exotic of the Day"
// button pattern (app.html ~line 17236), not just the Value Play's own horse.
test('v2.49.30 regression: the Value Play bet button\'s onclick includes the paired partner horse (slash-joined), not just the Value Play\'s own horse', () => {
  const start = INDEX.indexOf('// ── Value Plays ──');
  assert.ok(start > -1, 'Value Plays section not found');
  const end = INDEX.indexOf('// ── Action Bets', start);
  assert.ok(end > -1, 'Action Bets section not found');
  const block = INDEX.slice(start, end);
  const onclickLineMatch = block.match(/onclick="openBetAmountPicker\(event, \$\{v\.race\.num\}, .*?'Exacta Box', 'value'\)"/);
  assert.ok(onclickLineMatch, 'Value Play bet button onclick not found in expected shape');
  const onclickLine = onclickLineMatch[0];
  assert.match(onclickLine, /secondHorse\.horse\.name/, 'the horse-name argument must include the partner horse\'s name (the v2.49.30 bug: only v.horse.name -- the Value Play\'s own horse -- was ever passed, silently building a 1-horse "box" that can never win)');
  assert.match(onclickLine, /secondHorse\.horse\.pp/, 'the pp argument must include the partner horse\'s pp for the same reason');
});
