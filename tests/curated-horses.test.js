'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CURATED = path.join(__dirname, '..', 'data', 'curated-horses.json');

test('curated-horses.json loads and is well-formed', () => {
  const raw = fs.readFileSync(CURATED, 'utf8');
  const doc = JSON.parse(raw);
  assert.ok(doc.meta, 'meta present');
  assert.match(String(doc.meta.data_status || ''), /curated/i);
  assert.ok(Array.isArray(doc.horses) && doc.horses.length > 0, 'horses array non-empty');
});

test('curated horse Inspeightofcharlie has all required profile fields', () => {
  const doc = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
  const h = doc.horses.find((x) => x.name === 'Inspeightofcharlie');
  assert.ok(h, 'Inspeightofcharlie is present');
  assert.equal(h.sire, 'Speightster');
  assert.equal(h.dam, 'Untaken');
  assert.equal(h.damsire, 'Noonmark');
  assert.equal(h.trainer, 'Barclay Tagg');
  assert.equal(h.owner, 'Two Lions Farm');
  // v2.36.1 — equibaseRefno '11094587' was confirmed wrong (pointed at an unrelated older horse).
  // Field is intentionally absent until re-verified; the UI falls back to a name search.
  assert.equal(h.equibaseRefno, undefined, 'no unverified refno on file');
  assert.ok(h.equibaseRefnoNote, 'has note explaining refno absence');
  assert.equal(h.source, 'curated-public-profile');
  assert.ok(Array.isArray(h.sources) && h.sources.length >= 3, 'has multi sources');
  assert.ok(h.stats && h.stats.career && h.stats.career.starts >= 7, 'career stats');
  assert.ok(h.stats.season2026 && h.stats.season2026.firsts === 1, '2026 stats');
  assert.ok(Array.isArray(h.history) && h.history.length >= 5, 'at least 5 form rows');
  // v2.36.1 — every dated row that we know finishing position for should carry estimated earnings.
  const rowsWithFinish = h.history.filter((r) => r.finish);
  rowsWithFinish.forEach((row, i) => {
    assert.ok(typeof row.earnings === 'number', `history row ${i} (date ${row.date}) has numeric earnings`);
    assert.ok(row.earningsEstimated === true, `history row ${i} marked as estimated`);
    assert.ok(row.earningsMethod, `history row ${i} has earnings method string`);
  });
  // Every source row must have a URL.
  h.sources.forEach((s, i) => {
    assert.ok(s.url && /^https?:\/\//.test(s.url), `source[${i}] has URL`);
    assert.ok(s.label, `source[${i}] has label`);
  });
});

test('curated horse history rows are labeled with a source', () => {
  const doc = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
  const h = doc.horses.find((x) => x.name === 'Inspeightofcharlie');
  h.history.forEach((row, i) => {
    assert.ok(row.date, `history[${i}] has date`);
    assert.ok(row.source, `history[${i}] has source label`);
  });
});

test('upsert merge semantics: non-destructive of user fields (simulated)', () => {
  // Mirror the simplified upsert logic from index.html: never overwrite
  // non-empty user fields, but fill blank curated fields.
  const existing = {
    name: 'Inspeightofcharlie',
    notes: 'Watch at Saratoga — my note',
    favorite: true,
    tags: ['myTag'],
    addedAt: '2026-04-20T00:00:00Z'
  };
  const curated = {
    name: 'Inspeightofcharlie',
    sire: 'Speightster',
    dam: 'Untaken',
    stats: { career: { starts: 7 } },
    tags: ['curated', 'tagg'],
    source: 'curated-public-profile'
  };
  // Apply same rules as upsertHorse: existing wins for notes/favorite;
  // blank curated fields are filled; tags merge (set union).
  const merged = Object.assign({}, existing);
  const curatedKeys = ['suffix','breed','color','sex','colorSex','age','foaled',
    'sire','dam','damsire','breeder','equibaseRefno','speedFigureLatest',
    'stats','sources','caveats'];
  curatedKeys.forEach((k) => {
    if ((merged[k] === undefined || merged[k] === null || merged[k] === '') && curated[k] !== undefined) {
      merged[k] = curated[k];
    }
  });
  const tagSet = {};
  (merged.tags || []).forEach((t) => { tagSet[t] = 1; });
  (curated.tags || []).forEach((t) => { tagSet[t] = 1; });
  merged.tags = Object.keys(tagSet);
  if (!merged.source && curated.source) merged.source = curated.source;

  assert.equal(merged.notes, 'Watch at Saratoga — my note', 'user notes preserved');
  assert.equal(merged.favorite, true, 'favorite preserved');
  assert.equal(merged.sire, 'Speightster', 'curated sire filled');
  assert.equal(merged.stats.career.starts, 7, 'curated stats filled');
  assert.ok(merged.tags.includes('myTag') && merged.tags.includes('curated'), 'tags merged');
});
