'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FIXTURE = path.join(__dirname, '..', 'data', 'fixtures', 'saratoga_2025_sample.json');

test('saratoga sample fixture loads and is well-formed', () => {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const doc = JSON.parse(raw);
  assert.ok(doc.meta, 'meta present');
  assert.ok(doc.meet, 'meet present');
  assert.equal(doc.meet.track, 'SAR');
  assert.ok(Array.isArray(doc.races), 'races is array');
  assert.ok(doc.races.length > 0, 'has at least one race');

  // Every race needs id, date, num, horses[].
  doc.races.forEach((r, i) => {
    assert.ok(r.id, `race[${i}] has id`);
    assert.ok(r.date, `race[${i}] has date`);
    assert.ok(typeof r.num === 'number', `race[${i}] num is number`);
    assert.ok(Array.isArray(r.horses), `race[${i}] horses is array`);
  });
});

test('saratoga sample fixture is explicitly labeled as placeholder sample', () => {
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  // Schema-lite assertion — the app labels demo horses with this status.
  assert.match(String(doc.meta.data_status || ''), /placeholder|sample|demo/i);
});

test('demo horse builder picks horses with history (fixture shape)', () => {
  // Mirror the logic in index.html's buildDemoHorsesFromFixture to ensure
  // the fixture would actually yield at least a few multi-start horses.
  const doc = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const byName = {};
  doc.races.forEach((r) => {
    (r.horses || []).forEach((h) => {
      if (!h.name) return;
      if (!byName[h.name]) byName[h.name] = 0;
      byName[h.name] += 1;
    });
  });
  const multi = Object.values(byName).filter((n) => n >= 2).length;
  assert.ok(multi >= 8, `expected 8+ horses with 2+ scheduled starts, got ${multi}`);
});
