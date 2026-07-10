'use strict';

// v2.48.14 — Bets-tab bug (bankroll ghost / orphaned locked bets / AQU fallback).
//
// Executes the actual patched functions (extracted from index.html) inside a
// sandboxed vm context with mocked DOM/storage helpers, rather than just
// asserting on source text. Covers the three scenarios from the handoff wiki
// (§4.3) that correspond to fixed defects A, B, C. DEFECT D (Follow Expert
// Picks pre-locking) is not covered here — its root cause is still
// unconfirmed and out of scope for this patch.

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
  assert.ok(end > -1, 'end marker ' + endMarker + ' not found');
  return INDEX.slice(start, end);
}

const TODAY = '2026-07-09';

function makeSandbox(overrides) {
  const elMap = new Map();
  function el(id) {
    if (!elMap.has(id)) elMap.set(id, { textContent: '', className: '', innerHTML: '' });
    return elMap.get(id);
  }
  const sandbox = {
    el,
    elMap,
    console,
    getStore: () => sandbox.__store,
    getTrackData: () => sandbox.__data,
    saveTrackData: (data) => { sandbox.__data = data; },
    getTodayStr: () => TODAY,
    getActiveTrack: () => 'SAR',
    getStraightBetAmount: (betId) => sandbox.__straightAmounts[betId],
    renderStraightBets: () => {},
    renderTodayTab: () => {},
    renderTodaysLockedBets: () => {},
    renderLockedExotics: () => {},
    updateBankrollBanner: () => {},
    fmt$: (n) => '$' + Number(n).toFixed(2),
  };
  Object.assign(sandbox, overrides);
  return vm.createContext(sandbox);
}

test('DEFECT A: bankroll banner excludes unlocked straights from wagered/committed, and excludes yesterday\'s exotics', () => {
  const src = sliceFn('updateBankrollBanner', 'function checkBudgetWarning');
  const ctx = makeSandbox({
    __store: { settings: { startingBankroll: 1000 } },
    __straightAmounts: {},
    __data: {
      races: [],
      bets: [
        // Unlocked straight queued today — must NOT reduce "current" or count as wagered.
        { isExotic: false, locked: false, amount: 50, date: TODAY, payout: 0 },
        // Locked straight from today — must count as wagered and committed.
        { isExotic: false, locked: true, amount: 20, date: TODAY, payout: 0 },
        // Locked exotic from YESTERDAY — must not appear in committed (DEFECT A3).
        { isExotic: true, locked: true, cost: 18, date: '2026-07-08' },
      ],
    },
  });
  vm.runInContext(src + '\nupdateBankrollBanner();', ctx);

  const current = ctx.el('bb-bankroll').textContent;
  const committed = ctx.el('bb-committed').textContent;

  // starting(1000) + payout(0) - wagered(locked straight $20 + locked exotic's
  // REAL cost $18, v2.49.32: previously read exotic wager via bare b.amount,
  // which this fixture doesn't even set -- silently counting the exotic's
  // true $18 outlay as $0 and overstating "current" by exactly that amount) = 962
  assert.equal(current, '$962.00', 'current must subtract LOCKED bets using their real cost (b.cost for exotics, not bare b.amount), not just locked straights (DEFECT A1 + v2.49.32)');
  // committed = locked today straight ($20) ; no h.wps entries, yesterday exotic excluded (DEFECT A2/A3)
  assert.equal(committed, '$20.00', 'committed must include today\'s locked straight and exclude yesterday\'s exotic');
});

test('DEFECT A: unlocked straights still show up in "committed" via h.wps (pre-lock working state)', () => {
  const src = sliceFn('updateBankrollBanner', 'function checkBudgetWarning');
  const ctx = makeSandbox({
    __store: { settings: { startingBankroll: 1000 } },
    __straightAmounts: { 'r1_h1_W': 10 },
    __data: {
      races: [{ id: 'r1', horses: [{ id: 'h1', wps: ['W'] }] }],
      bets: [],
    },
  });
  vm.runInContext(src + '\nupdateBankrollBanner();', ctx);
  assert.equal(ctx.el('bb-committed').textContent, '$10.00');
  assert.equal(ctx.el('bb-bankroll').textContent, '$1000.00', 'unlocked queued bet must not touch current bankroll');
});

test('DEFECT B: removeStraightBet clears the matching TODAY locked entry from data.bets, preserves history', () => {
  const src = sliceFn('removeStraightBet', 'function clearAllStraight');
  const ctx = makeSandbox({
    __data: {
      races: [{ id: 'r1', num: 1, horses: [{ id: 'h1', name: 'Testaverde', wps: ['W'] }] }],
      bets: [
        { raceNum: '1', type: 'Win', selections: ['Testaverde'], date: TODAY, locked: true, isExotic: false },
        { raceNum: '1', type: 'Win', selections: ['Testaverde'], date: '2026-07-01', locked: true, isExotic: false },
      ],
    },
  });
  vm.runInContext(src + "\nremoveStraightBet('r1', 'h1', 'W');", ctx);

  assert.equal(ctx.__data.races[0].horses[0].wps.length, 0, 'horse.wps must still be cleared');
  assert.equal(ctx.__data.bets.length, 1, 'only the TODAY locked bet should be removed from data.bets');
  assert.equal(ctx.__data.bets[0].date, '2026-07-01', 'prior-day history must be preserved');
});

test('DEFECT C: legacy bets missing track get backfilled to SAR by the migration', () => {
  // Slice stops right before the `else` branch's `const store = {...}` (new-user
  // path, irrelevant here); close the still-open function body manually.
  const src = sliceFn('initStore', '\n  const store = {') + '\n}\n';
  const existing = {
    settings: { activeTrack: 'SAR', sarLockV1: true, ctMigrationV25: true, workerUrl: 'https://example.invalid' },
    tracks: {
      SAR: {
        bets: [
          { id: 'b1', track: undefined },
          { id: 'b2', track: 'SAR' },
        ],
      },
    },
  };
  const ctx = makeSandbox({
    getStore: () => existing,
    isTrackEnabled: (code) => code === 'SAR',
    saveStore: () => {},
  });
  vm.runInContext(src + '\nglobalThis.__result = initStore();', ctx);
  assert.equal(ctx.__result.tracks.SAR.bets[0].track, 'SAR', 'bet missing track must be backfilled to SAR');
  assert.equal(ctx.__result.tracks.SAR.bets[1].track, 'SAR', 'bet with existing track must be untouched');
  assert.equal(ctx.__result.settings.betsTrackBackfillV1, true, 'migration flag must be set so it runs only once');
});

test('version integrity: NE_APP_VERSION (index.html) matches app.html and sw.js CACHE_VERSION', () => {
  const APP = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');
  const SW = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  const neIndex = INDEX.match(/var NE_APP_VERSION = '([^']+)'/)[1];
  const neApp = APP.match(/var NE_APP_VERSION = '([^']+)'/)[1];
  const cacheVersion = SW.match(/const CACHE_VERSION = '([^']+)'/)[1];
  assert.equal(neIndex, neApp, 'NE_APP_VERSION must match between index.html and app.html');
  assert.equal(neIndex, cacheVersion, 'NE_APP_VERSION must match sw.js CACHE_VERSION or the SW triggers a reload loop');
});
