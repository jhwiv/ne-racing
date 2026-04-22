'use strict';

// v2.21.4 — Lookup Barn: migration + lookup candidate separation + heart semantics.
//
// Mirrors the logic inlined in index.html so we can regression-lock the
// contract even though the source is in the page bundle.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const STOCK_DEMO_REASON = 'Prepopulated from 2026 Saratoga sample card — use to explore the Virtual Barn.';

function norm(n) { return String(n || '').trim().toLowerCase().replace(/\s+/g, ' '); }
function findIdx(list, name) {
  const n = norm(name);
  for (let i = 0; i < list.length; i++) if (norm(list[i].name) === n) return i;
  return -1;
}

// Pure port of migrateDemoHorsesToLookup.
function migrate(store) {
  if (!store.barn) store.barn = { horses: [], jockeys: [], trainers: [] };
  if (!Array.isArray(store.barn.lookupDemoHidden)) store.barn.lookupDemoHidden = [];
  let migrated = 0, kept = 0;
  const surviving = [];
  (store.barn.horses || []).forEach((h) => {
    const isDemo = h && h.source === 'demo-saratoga-2025';
    if (!isDemo) { surviving.push(h); return; }
    const hasNotes = !!(h.notes && String(h.notes).trim());
    const isFav = !!h.favorite;
    const customTags = (Array.isArray(h.tags) ? h.tags : [])
      .filter((t) => t !== 'demo' && t !== 'saratoga');
    const customReason = h.watchReason && String(h.watchReason).trim() !== STOCK_DEMO_REASON.trim();
    if (hasNotes || isFav || customTags.length || customReason) {
      surviving.push(h);
      kept += 1;
    } else {
      store.barn.lookupDemoHidden.push(h);
      migrated += 1;
    }
  });
  store.barn.horses = surviving;
  return { migrated, kept };
}

test('migration: untouched demo horses move to lookupDemoHidden', () => {
  const store = { barn: { horses: [
    { name: 'Demo Horse A', source: 'demo-saratoga-2025', favorite: false, tags: ['demo','saratoga'], watchReason: STOCK_DEMO_REASON },
    { name: 'Demo Horse B', source: 'demo-saratoga-2025', favorite: false, tags: ['demo','saratoga'], watchReason: STOCK_DEMO_REASON }
  ]}};
  const res = migrate(store);
  assert.equal(res.migrated, 2);
  assert.equal(res.kept, 0);
  assert.equal(store.barn.horses.length, 0);
  assert.equal(store.barn.lookupDemoHidden.length, 2);
});

test('migration: favorite demo horse stays in personal barn', () => {
  const store = { barn: { horses: [
    { name: 'Demo Fav', source: 'demo-saratoga-2025', favorite: true, tags: ['demo'], watchReason: STOCK_DEMO_REASON }
  ]}};
  const res = migrate(store);
  assert.equal(res.migrated, 0);
  assert.equal(res.kept, 1);
  assert.equal(store.barn.horses.length, 1);
});

test('migration: demo horse with user notes is preserved', () => {
  const store = { barn: { horses: [
    { name: 'Noted Demo', source: 'demo-saratoga-2025', favorite: false, notes: 'my angle', tags: ['demo'], watchReason: STOCK_DEMO_REASON }
  ]}};
  const res = migrate(store);
  assert.equal(res.kept, 1);
  assert.equal(store.barn.horses.length, 1);
  assert.equal(store.barn.horses[0].notes, 'my angle');
});

test('migration: demo horse with custom (non-demo/non-saratoga) tag is preserved', () => {
  const store = { barn: { horses: [
    { name: 'Tagged Demo', source: 'demo-saratoga-2025', favorite: false, tags: ['demo','saratoga','myangle'], watchReason: STOCK_DEMO_REASON }
  ]}};
  const res = migrate(store);
  assert.equal(res.kept, 1);
  assert.equal(store.barn.horses.length, 1);
});

test('migration: demo horse with edited watchReason is preserved', () => {
  const store = { barn: { horses: [
    { name: 'Custom-reason Demo', source: 'demo-saratoga-2025', favorite: false, tags: ['demo','saratoga'], watchReason: 'I want to watch this one on the turf.' }
  ]}};
  const res = migrate(store);
  assert.equal(res.kept, 1);
  assert.equal(store.barn.horses.length, 1);
});

test('migration: curated and user-added horses are NEVER moved out', () => {
  const store = { barn: { horses: [
    { name: 'Inspeightofcharlie', source: 'curated-public-profile', favorite: false, tags: ['curated','tagg'] },
    { name: 'User Horse', source: 'user', favorite: false },
    { name: 'Demo Untouched', source: 'demo-saratoga-2025', favorite: false, tags: ['demo','saratoga'], watchReason: STOCK_DEMO_REASON }
  ]}};
  const res = migrate(store);
  assert.equal(res.migrated, 1);
  assert.equal(res.kept, 0);
  const names = store.barn.horses.map(h => h.name).sort();
  assert.deepEqual(names, ['Inspeightofcharlie', 'User Horse']);
});

// ---- Lookup candidate separation: curated wins over demo on same name.
function mergeCandidates(curated, demo) {
  const byName = {};
  (curated || []).forEach(h => {
    byName[norm(h.name)] = { name: h.name, source: 'curated', profile: h };
  });
  (demo || []).forEach(h => {
    const k = norm(h.name);
    if (byName[k]) return;
    byName[k] = { name: h.name, source: 'demo', profile: h };
  });
  return Object.keys(byName).map(k => byName[k]);
}

test('lookup: curated + demo horses merge into a single candidate pool; curated wins duplicates', () => {
  const curated = [{ name: 'Inspeightofcharlie', trainer: 'Barclay Tagg' }];
  const demo = [
    { name: 'Inspeightofcharlie', trainer: 'Someone else' },
    { name: 'Sample Horse', trainer: 'Demo Trainer' }
  ];
  const cands = mergeCandidates(curated, demo);
  assert.equal(cands.length, 2);
  const ins = cands.find(c => c.name === 'Inspeightofcharlie');
  assert.equal(ins.source, 'curated');
  assert.equal(ins.profile.trainer, 'Barclay Tagg');
  const samp = cands.find(c => c.name === 'Sample Horse');
  assert.equal(samp.source, 'demo');
});

// ---- Lookup heart semantics: same contract as the Today-tab heart.
function lookupHeart(barnHorses, name, lookupProfile) {
  const idx = findIdx(barnHorses, name);
  if (idx < 0) {
    barnHorses.push(Object.assign({}, lookupProfile, { name, favorite: true, addedAt: 'now' }));
    return 'added-fav';
  }
  barnHorses[idx].favorite = !barnHorses[idx].favorite;
  return barnHorses[idx].favorite ? 'fav-on' : 'fav-off';
}

test('lookup heart: horse NOT in barn → add + favorite', () => {
  const list = [];
  const action = lookupHeart(list, 'New Horse', { source: 'curated-public-profile', sire: 'Somebody' });
  assert.equal(action, 'added-fav');
  assert.equal(list.length, 1);
  assert.equal(list[0].favorite, true);
  assert.equal(list[0].sire, 'Somebody');
});

test('lookup heart: horse already in barn (not fav) → fav ON, never removes', () => {
  const list = [{ name: 'Demo H', favorite: false, source: 'demo-saratoga-2025' }];
  const action = lookupHeart(list, 'Demo H', {});
  assert.equal(action, 'fav-on');
  assert.equal(list.length, 1);
  assert.equal(list[0].favorite, true);
});

test('lookup heart: fav horse → fav OFF but horse stays', () => {
  const list = [{ name: 'Demo H', favorite: true, source: 'demo-saratoga-2025' }];
  const action = lookupHeart(list, 'Demo H', {});
  assert.equal(action, 'fav-off');
  assert.equal(list.length, 1);
  assert.equal(list[0].favorite, false);
});

// ---- Favorite-highlight classification (applyBarnHighlights behavior).
function highlightClass(barnHorses, rowName) {
  const n = norm(rowName);
  const hit = barnHorses.find(h => norm(h.name) === n);
  if (!hit) return '';
  if (hit.favorite) return 'in-virtual-barn vb-fav-row';
  return 'in-virtual-barn';
}

test('highlight: favorite barn horse row classified with in-virtual-barn + vb-fav-row', () => {
  const barn = [{ name: 'Inspeightofcharlie', favorite: true, source: 'curated-public-profile' }];
  assert.equal(highlightClass(barn, 'Inspeightofcharlie'), 'in-virtual-barn vb-fav-row');
});

test('highlight: non-fav barn horse gets subtler in-virtual-barn class only', () => {
  const barn = [{ name: 'Just Saved', favorite: false }];
  assert.equal(highlightClass(barn, 'Just Saved'), 'in-virtual-barn');
});

test('highlight: not-in-barn horse gets no class', () => {
  const barn = [{ name: 'Other', favorite: true }];
  assert.equal(highlightClass(barn, 'Not Known'), '');
});

test('highlight: name normalization — case + extra spacing + punctuation-preserving', () => {
  const barn = [{ name: '  inspeightofcharlie  ', favorite: true }];
  assert.equal(highlightClass(barn, 'INSPEIGHTOFCHARLIE'), 'in-virtual-barn vb-fav-row');
});
