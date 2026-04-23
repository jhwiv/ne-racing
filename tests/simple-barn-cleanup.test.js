'use strict';

// v2.22.1 — Simple Barn cleanup invariants.
//
// After v2.22.0 the stall card already dropped its favorite control, but the
// wider Barn UI still surfaced star/favorite semantics in several visible
// places: a "★ 0 FAVORITES" hero stat, a footer tip referencing the heart,
// a heart/star button on the lookup drawer, a .vb-fav button and Favorite
// chip inside the rich profile modal, and a dedicated vb-fav-row highlight
// on race-form rows. The rule, per the user: "If a horse is in the barn,
// it is by definition a favorite." Every one of those surfaces collapses
// to simple membership — either the horse is In Barn, or it is not.
//
// These tests lock the active rendered markup. They inspect specific
// render functions rather than the whole file so changelog entries that
// describe historical favorite behavior do not trip the assertions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceFn(startMarker, endMarker) {
  const start = INDEX.indexOf(startMarker);
  assert.ok(start > -1, 'start marker not found: ' + startMarker);
  const end = INDEX.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > -1, 'end marker not found: ' + endMarker);
  return INDEX.slice(start, end);
}

// --- 1. Hero stats + footer tip ----------------------------------------

test('barn_renderBarnTab: hero stats have no Favorites chip or star', () => {
  const src = sliceFn('function barn_renderBarnTab', 'function barn_openDrawer');
  // No FAVORITES copy, no star glyph in stats.
  assert.ok(!/Favorites/.test(src.match(/var statsHtml[\s\S]*?'<\/div>';/)[0]),
    'hero statsHtml must not mention Favorites');
  assert.ok(!/barn-stat-fav/.test(src.match(/var statsHtml[\s\S]*?'<\/div>';/)[0]),
    'barn-stat-fav chip class must not be emitted');
  assert.ok(!/\\u2605/.test(src.match(/var statsHtml[\s\S]*?'<\/div>';/)[0]),
    'hero statsHtml must not contain a star glyph');
  // Positive: Connections chip is present.
  assert.match(src, /In barn/);
  assert.match(src, /Running today/);
  assert.match(src, /Connections<\/span>/);
});

test('barn_renderBarnTab: footer tip is simple-barn copy (no heart/favorite wording)', () => {
  const src = sliceFn('function barn_renderBarnTab', 'function barn_openDrawer');
  const hintBlock = src.match(/var hint\s*=[\s\S]*?'<\/p>';/);
  assert.ok(hintBlock, 'footer tip assignment not found');
  const hint = hintBlock[0];
  assert.ok(!/heart/i.test(hint), 'footer tip must not mention heart');
  assert.ok(!/favorite/i.test(hint), 'footer tip must not mention favorite');
  assert.match(hint, /Tap a horse to open its profile/);
  assert.match(hint, /Add horse/);
});

test('barn_renderBarnTab: drawer sub-copy no longer mentions heart/favorite', () => {
  const src = sliceFn('function barn_renderBarnTab', 'function barn_openDrawer');
  // Match the actual subtitle <p> element (skip the CSS rule that also
  // contains the class name). The rendered string starts with `<p class="`.
  const drawerSub = src.match(/<p class="barn-drawer-sub">[\s\S]*?<\/p>/);
  assert.ok(drawerSub, 'drawer subtitle <p> not found');
  assert.ok(!/heart/i.test(drawerSub[0]),
    'drawer subtitle must not mention heart');
  assert.ok(!/favorite/i.test(drawerSub[0]),
    'drawer subtitle must not mention favorite');
});

// --- 2. Lookup drawer markup -------------------------------------------

test('barn_renderLookupResults: no heart button, no Favorite badge', () => {
  const src = sliceFn('function barn_renderLookupResults', 'window.__barnRenderLookupResults');
  assert.ok(!/barn-lookup-heart/.test(src),
    'lookup row must not render a .barn-lookup-heart button');
  assert.ok(!/barn-lookup-badge-fav/.test(src),
    'lookup row must not render the favorite badge');
  assert.ok(!/Mark .* as favorite/.test(src),
    'lookup row must not render "Mark ... as favorite" label');
  assert.ok(!/Unfavorite/.test(src),
    'lookup row must not render Unfavorite label');
  assert.ok(!/barnLookupHeart\(/.test(src),
    'lookup row must not wire the barnLookupHeart handler');
  // Positive: Add to Barn / In Barn are the only add actions.
  assert.match(src, /Add to Barn/);
  assert.match(src, /In Barn/);
});

// --- 3. Stall card markup ----------------------------------------------

test('buildMyBarnSection: stall card has no favorite/star wording', () => {
  const src = sliceFn('function buildMyBarnSection', 'function barn_wireStallCards');
  // Strip JS comments so we only inspect rendered markup. Multi-line (/* */)
  // and single-line (//...) comments can legitimately discuss historical
  // favorite behavior without it appearing in the DOM.
  const active = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/Favorite/i.test(active),
    'stall card must not render Favorite copy');
  assert.ok(!/stall-card-fav/.test(active));
  assert.ok(!/badge-fav/.test(active));
  assert.ok(!/\bis-fav\b/.test(active),
    'stall card must not emit is-fav class');
  // Positive: exactly one In Barn membership badge.
  assert.match(src, /class="stall-card-badge badge-in-barn"/);
});

// --- 4. buildListSection (jockeys / trainers only) ---------------------

test('buildListSection: no favorite heart button, no Favorite badge, no fav count', () => {
  const src = sliceFn('function buildListSection', '// v2.21.3: separate explicit Remove handler');
  assert.ok(!/barn-stall-heart/.test(src),
    'list section must not render the .barn-stall-heart button');
  assert.ok(!/vb-stall-fav/.test(src),
    'list section must not render the vb-stall-fav badge');
  assert.ok(!/barn-count-fav/.test(src),
    'list section must not render a favorite count header');
  assert.ok(!/Favorite/.test(src),
    'list section must not render Favorite copy');
});

// --- 5. Race-form highlight (applyBarnHighlights) ----------------------

test('applyBarnHighlights: emits only the membership pill, never a favorite pill', () => {
  const src = sliceFn('function applyBarnHighlights', '// Add pill styles');
  // Must not branch on favorite to emit a Favorite pill or add vb-fav-row.
  assert.ok(!/vb-row-pill-fav/.test(src),
    'applyBarnHighlights must not emit a favorite pill');
  assert.ok(!/\\u2605 Favorite/.test(src),
    'applyBarnHighlights must not emit a star/Favorite label');
  // Must strip any lingering legacy fav-row class on rerender.
  assert.match(src, /row\.classList\.remove\(\s*'vb-fav-row'\s*\)/);
  // Membership pill is still emitted.
  assert.match(src, /inPill\.textContent\s*=\s*'In Barn'/);
});

// --- 6. Profile modal (openHorseProfile) -------------------------------

test('openHorseProfile: no .vb-fav button, no Favorite chip, no favorite ribbon', () => {
  const src = sliceFn('function openHorseProfile', '  window.openVirtualBarnProfile');
  const active = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/class="vb-fav /.test(active),
    'profile modal must not render a .vb-fav toggle button');
  assert.ok(!/data-act="fav"/.test(active),
    'profile modal must not wire the data-act="fav" handler');
  assert.ok(!/\\u2605 Favorite/.test(active),
    'profile modal must not render a "★ Favorite" chip or label');
  assert.ok(!/vb-chip-fav/.test(active),
    'profile modal must not emit the vb-chip-fav overview chip');
  // Ribbon must not concat a Favorite suffix into vb-ownership-text.
  assert.ok(!/ownership-text[\s\S]{0,120}Favorite/.test(active),
    'ownership ribbon must not append Favorite to "In your Virtual Barn"');
});

test('openHorseProfile: modal carries an observable open marker for Playwright', () => {
  const src = sliceFn('function openHorseProfile', '  window.openVirtualBarnProfile');
  assert.match(src, /modal\.className\s*=\s*'vb-profile-modal is-open'/,
    'modal must get a stable is-open class');
  assert.match(src, /modal\.setAttribute\(\s*'data-open'\s*,\s*'true'\s*\)/,
    'modal must expose data-open="true" for visibility assertions');
  assert.match(src, /aria-modal/);
});

// --- 7. Stall card wiring still opens profile (regression lock) --------

test('barn_wireStallCards: card click and chevron both call barnOpenHorseProfile', () => {
  const src = sliceFn('function barn_wireStallCards', '// v2.21.4:');
  assert.match(src, /card\.addEventListener\(\s*'click'/);
  // Card path calls helper, Remove short-circuits.
  assert.match(src, /barnOpenHorseProfile\(name\)/);
  assert.match(src, /closest\('\.stall-card-remove'\)\s*\)\s*return/);
  // Chevron path also calls helper and stops propagation.
  assert.match(src, /querySelectorAll\('\.stall-card-view'\)/);
});

// --- 8. Version sync ---------------------------------------------------

test('version: version.json tracks at least v2.22.1', () => {
  const v = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')
  );
  assert.match(v.version, /v2\.2[2-9]\.[1-9]\d*|v2\.2[3-9]\.\d+|v2\.[3-9]\d*\.\d+|v[3-9]\./,
    'version.json must be at v2.22.1 or later');
});
