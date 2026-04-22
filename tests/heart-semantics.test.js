'use strict';

// v2.21.3 — HEART = FAVORITE semantics on horses.
//
// Mirrors the logic in index.html toggleFollow('horses', name) so we can
// catch regressions even though the source is inline in index.html. The
// contract these tests lock in:
//
//   Horse NOT in barn  → tap heart: add + set favorite=true (action 'added-fav')
//   Horse in barn, not favorite → tap heart: favorite=true (action 'fav-on')
//   Horse in barn, favorite → tap heart: favorite=false BUT horse stays (action 'fav-off')
//
// The user's complaint was that tapping heart "did nothing". Under the prior
// add-or-remove semantics, tapping heart on an auto-seeded curated horse
// silently removed it — the curated horse would then re-seed, making the
// click look like a no-op. The new semantics always produce a visible state
// change (add-with-favorite, or fav toggle) and never remove on heart tap.

const { test } = require('node:test');
const assert = require('node:assert/strict');

function norm(n) { return String(n || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function findIdx(list, name) {
  const n = norm(name);
  for (let i = 0; i < list.length; i++) if (norm(list[i].name) === n) return i;
  return -1;
}

// Pure port of the v2.21.3 horses branch of toggleFollow. Returns { action, list }.
function heartToggleHorses(list, name) {
  const idx = findIdx(list, name);
  let action;
  if (idx < 0) {
    list.push({ name: String(name).trim(), addedAt: 'now', favorite: true, source: 'heart-tap' });
    action = 'added-fav';
  } else {
    const h = list[idx];
    h.favorite = !h.favorite;
    action = h.favorite ? 'fav-on' : 'fav-off';
  }
  return { action, list };
}

test('heart on a horse NOT in barn: adds + marks favorite', () => {
  const list = [];
  const { action } = heartToggleHorses(list, 'Inspeightofcharlie');
  assert.equal(action, 'added-fav');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'Inspeightofcharlie');
  assert.equal(list[0].favorite, true);
});

test('heart on a horse already in barn (not favorite): toggles favorite ON, does NOT remove', () => {
  const list = [{ name: 'Inspeightofcharlie', favorite: false, source: 'curated-public-profile' }];
  const { action } = heartToggleHorses(list, 'Inspeightofcharlie');
  assert.equal(action, 'fav-on');
  assert.equal(list.length, 1, 'horse NOT removed on heart tap');
  assert.equal(list[0].favorite, true);
});

test('heart on a favorite horse: turns favorite OFF, still keeps horse', () => {
  const list = [{ name: 'Inspeightofcharlie', favorite: true, source: 'curated-public-profile' }];
  const { action } = heartToggleHorses(list, 'Inspeightofcharlie');
  assert.equal(action, 'fav-off');
  assert.equal(list.length, 1, 'horse stays in barn when favorite is turned off');
  assert.equal(list[0].favorite, false);
});

test('heart on curated Inspeightofcharlie preserves curated profile data (never removes)', () => {
  const list = [{
    name: 'Inspeightofcharlie',
    favorite: false,
    source: 'curated-public-profile',
    sire: 'Speightster',
    stats: { career: { starts: 7 } }
  }];
  heartToggleHorses(list, 'Inspeightofcharlie');
  assert.equal(list.length, 1);
  assert.equal(list[0].sire, 'Speightster', 'curated sire preserved across heart tap');
  assert.equal(list[0].stats.career.starts, 7, 'curated stats preserved across heart tap');
});

test('three successive heart taps on the same horse cycle through add→fav-off→fav-on, horse never removed', () => {
  const list = [];
  const r1 = heartToggleHorses(list, 'Sweet Caroline');
  const r2 = heartToggleHorses(list, 'Sweet Caroline');
  const r3 = heartToggleHorses(list, 'Sweet Caroline');
  assert.equal(r1.action, 'added-fav');
  assert.equal(r2.action, 'fav-off');
  assert.equal(r3.action, 'fav-on');
  assert.equal(list.length, 1);
});
