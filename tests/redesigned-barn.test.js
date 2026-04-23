'use strict';

// v2.21.6 — Redesigned Barn contract.
//
// Locks the structural invariants of the redesigned Barn tab:
//   1. My Barn section renders BEFORE the drawer.
//   2. The lookup/search input lives ONLY inside the drawer — never on the
//      main Barn surface.
//   3. The drawer is hidden by default (no 'open' class on initial render).
//   4. The empty state uses the correct copy and shows a "Choose a horse" CTA.
//   5. There is no inline "barn-lookup-panel" rendered above My Barn.
//   6. The hero exposes "Add horse" / "Choose a horse" CTA that opens the drawer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function extractBarnRender() {
  const start = INDEX.indexOf('function barn_renderBarnTab()');
  assert.ok(start > -1, 'barn_renderBarnTab not found');
  // Heuristic end: first occurrence of "function barn_openDrawer" after start.
  const end = INDEX.indexOf('function barn_openDrawer', start);
  assert.ok(end > -1, 'barn_openDrawer not found');
  return INDEX.slice(start, end);
}

test('redesign: barn_renderBarnTab renders My Barn section before the drawer', () => {
  const src = extractBarnRender();
  const myBarnPos = src.indexOf('myBarnHtml');
  const drawerPos = src.indexOf('drawerHtml');
  assert.ok(myBarnPos > -1, 'myBarnHtml missing');
  assert.ok(drawerPos > -1, 'drawerHtml missing');
  const assignPos = src.indexOf('container.innerHTML');
  const assignSlice = src.slice(assignPos, assignPos + 400);
  const pMyBarn = assignSlice.indexOf('myBarnHtml');
  const pDrawer = assignSlice.indexOf('drawerHtml');
  assert.ok(pMyBarn > -1 && pDrawer > -1, 'innerHTML concat missing segments');
  assert.ok(pMyBarn < pDrawer, 'My Barn must render before the drawer');
});

test('redesign: no inline lookup panel is rendered above My Barn', () => {
  const src = extractBarnRender();
  const innerHtmlAssign = src.match(/container\.innerHTML\s*=\s*[^;]+;/);
  assert.ok(innerHtmlAssign, 'innerHTML assignment missing');
  const s = innerHtmlAssign[0];
  // The old design had `lookupHtml` inlined before `horsesSection`. It must be
  // gone from the main innerHTML assembly.
  assert.ok(!/\blookupHtml\b/.test(s), 'lookupHtml should not be in main render');
  // And no barn-lookup-panel shell outside the drawer.
  assert.ok(!/id="barn-lookup-panel"/.test(s), 'barn-lookup-panel id must not be rendered on main surface');
});

test('redesign: drawer starts closed by default', () => {
  const src = extractBarnRender();
  // drawerOpen toggle is based on window.__barnDrawerOpen. On a fresh page
  // load, window.__barnDrawerOpen is falsy, so the drawer has NO 'open' class.
  assert.match(src, /window\.__barnDrawerOpen\s*\?\s*'\s*open'\s*:\s*''/);
});

test('redesign: lookup input is declared only inside the drawer', () => {
  const src = extractBarnRender();
  // There should be exactly one `id="barn-lookup-input"` in the barn render,
  // and it must appear in the drawer body block.
  const matches = src.match(/id="barn-lookup-input"/g) || [];
  assert.equal(matches.length, 1, 'barn-lookup-input must appear exactly once');
  const drawerHtmlBlock = src.slice(src.indexOf('var drawerHtml'), src.indexOf('var hint ='));
  assert.ok(drawerHtmlBlock.includes('id="barn-lookup-input"'),
    'barn-lookup-input must live inside drawerHtml');
});

test('redesign: empty-state copy + CTA present', () => {
  const src = extractBarnRender();
  // buildMyBarnSection must include the empty-state copy per spec.
  const fnStart = INDEX.indexOf('function buildMyBarnSection');
  const fnEnd = INDEX.indexOf('function barn_wireStallCards');
  assert.ok(fnStart > -1 && fnEnd > -1, 'buildMyBarnSection / wireStallCards not found');
  const fnSrc = INDEX.slice(fnStart, fnEnd);
  assert.match(fnSrc, /Your barn is quiet\./, 'empty state headline missing');
  assert.match(fnSrc, /Choose a horse/, 'Choose a horse CTA missing');
  assert.match(fnSrc, /class="my-barn-empty-cta"/, 'empty CTA class missing');
});

test('redesign: hero CTA button uses drawer-open handler', () => {
  const src = extractBarnRender();
  assert.match(src, /id="barn-open-add"/, 'hero Add button missing');
  assert.match(src, /barn_openDrawer\(\)/, 'barn_openDrawer should be wired to CTA');
});

test('redesign: stall cards render saved horses only (not lookup candidates)', () => {
  // Contract: buildMyBarnSection takes `horses` (the persisted barn list) —
  // never a lookup candidate list. Read the function signature.
  const fnStart = INDEX.indexOf('function buildMyBarnSection(');
  const sig = INDEX.slice(fnStart, fnStart + 120);
  assert.match(sig, /function buildMyBarnSection\(horses,\s*todayMatches\)/);
  // And it's invoked only with `barn.horses`.
  const src = extractBarnRender();
  assert.match(src, /buildMyBarnSection\(barn\.horses,\s*matches\.horses\)/);
});

test('redesign: no "Suggested horses" label is emitted into the main render', () => {
  const src = extractBarnRender();
  // The suggestion label is part of barn_renderLookupResults (drawer-only).
  // Main render must not include the string "Suggested horses" as literal text.
  const innerHtmlAssign = src.match(/container\.innerHTML\s*=\s*[^;]+;/);
  assert.ok(innerHtmlAssign);
  assert.ok(!/Suggested horses/.test(innerHtmlAssign[0]),
    'Suggested horses must not appear in main Barn render');
});

test('redesign: version bumped to v2.21.6', () => {
  const versionJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8'));
  assert.match(versionJson.version, /v2\.21\.6|2\.21\.6/);
});
