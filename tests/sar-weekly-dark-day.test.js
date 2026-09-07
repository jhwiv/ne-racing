'use strict';

// SAR weekly dark-day helper: Mon/Tue are typically dark, but 2026-09-07
// (Summer Meet closing day, a Monday) is Chip-confirmed OPEN. Without the
// exception, fetchLiveEntries() skips /api/entries entirely and paints
// "Dark day at Saratoga".

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(__dirname, '..', 'app.html'), 'utf8');

function extractHelper(src) {
  const start = src.indexOf('var SAR_WEEKLY_DARK_DAYS');
  assert.ok(start > -1, 'SAR_WEEKLY_DARK_DAYS not found');
  const end = src.indexOf('function isKnownWeeklyDarkDay');
  assert.ok(end > -1, 'isKnownWeeklyDarkDay not found');
  const fnEnd = src.indexOf('\n}', end);
  assert.ok(fnEnd > -1);
  return src.slice(start, fnEnd + 2);
}

function loadHelper(src) {
  const ctx = vm.createContext({});
  vm.runInContext(extractHelper(src), ctx);
  return ctx;
}

test('index.html: Monday 2026-09-07 is NOT a known weekly dark day (closing-day exception)', () => {
  const { isKnownWeeklyDarkDay } = loadHelper(INDEX);
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-09-07'), false);
});

test('index.html: a typical Monday/Tuesday remains dark; Wednesday does not', () => {
  const { isKnownWeeklyDarkDay } = loadHelper(INDEX);
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-08-31'), true);  // Monday
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-09-01'), true);  // Tuesday
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-09-02'), false); // Wednesday
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-09-06'), false); // Sunday
  assert.equal(isKnownWeeklyDarkDay('AQU', '2026-08-31'), false);
});

test('app.html mirrors the 2026-09-07 closing-day exception', () => {
  const { isKnownWeeklyDarkDay } = loadHelper(APP);
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-09-07'), false);
  assert.equal(isKnownWeeklyDarkDay('SAR', '2026-09-08'), true); // Tuesday after close
});
