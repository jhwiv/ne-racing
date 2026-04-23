'use strict';

// v2.22.0 — Stall-card profile-open invariants.
//
// Locks the wiring for the bug: "clicking a horse in the barn just highlights
// it, no profile expansion". The Barn stall card must open the rich horse
// profile modal on click, on Enter/Space, and on the explicit View chevron.
// Only the Remove button short-circuits the card click.
//
// Simple-barn semantics (v2.22.0) also removes the star/favorite control from
// the stall card, so this test asserts that .stall-card-fav is gone.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

function sliceFn(name, endMarker) {
  const start = INDEX.indexOf('function ' + name);
  assert.ok(start > -1, name + ' not found');
  const end = INDEX.indexOf(endMarker, start);
  assert.ok(end > -1, 'end marker ' + endMarker + ' not found');
  return INDEX.slice(start, end);
}

test('stall card: rendered markup has no favorite/star control', () => {
  const src = sliceFn('buildMyBarnSection', 'function barn_wireStallCards');
  assert.ok(!/class="stall-card-fav"/.test(src),
    'stall-card-fav button must be removed from stall card markup');
  assert.ok(!/data-fav-for=/.test(src),
    'data-fav-for attribute must not be emitted by stall card');
  assert.ok(!/badge-fav/.test(src),
    'favorite badge must not be rendered on the stall card');
});

test('stall card: rendered markup exposes View chevron and Remove button', () => {
  const src = sliceFn('buildMyBarnSection', 'function barn_wireStallCards');
  assert.match(src, /class="stall-card-view"/,
    'stall card must render a View chevron button');
  assert.match(src, /data-view-for="/,
    'stall card View button must carry data-view-for');
  assert.match(src, /class="stall-card-remove"/,
    'stall card must render a Remove button');
  assert.match(src, /role="button"/,
    'stall card container must be role=button for a11y');
  assert.match(src, /aria-label="Open profile for /,
    'stall card must announce itself as "Open profile for <name>"');
});

test('stall card wiring: card click routes to barnOpenHorseProfile', () => {
  const src = sliceFn('barn_wireStallCards', '// v2.21.4:');
  // Card click listener must call barnOpenHorseProfile(name).
  assert.match(src, /card\.addEventListener\(\s*'click'/,
    'card click handler must be attached');
  assert.match(src, /barnOpenHorseProfile\(name\)/,
    'card click must invoke barnOpenHorseProfile(name)');
});

test('stall card wiring: Enter/Space keyboard opens profile', () => {
  const src = sliceFn('barn_wireStallCards', '// v2.21.4:');
  assert.match(src, /ev\.key === 'Enter' \|\| ev\.key === ' '/,
    'keyboard handler must listen for Enter and Space');
  // The keydown branch also calls barnOpenHorseProfile.
  const kd = src.slice(src.indexOf("ev.key === 'Enter'"));
  assert.match(kd, /barnOpenHorseProfile\(name\)/,
    'Enter/Space must invoke barnOpenHorseProfile');
});

test('stall card wiring: View chevron opens profile, stops propagation', () => {
  const src = sliceFn('barn_wireStallCards', '// v2.21.4:');
  assert.match(src, /querySelectorAll\('\.stall-card-view'\)/,
    'view-button query must target .stall-card-view');
  // Its click handler must stopPropagation (so card click doesn't re-fire)
  // and call barnOpenHorseProfile.
  const viewBlock = src.slice(src.indexOf(".stall-card-view"));
  assert.match(viewBlock, /ev\.stopPropagation\(\)/,
    'View button must stopPropagation');
  assert.match(viewBlock, /barnOpenHorseProfile\(/,
    'View button must invoke barnOpenHorseProfile');
});

test('stall card wiring: Remove button does NOT open the profile', () => {
  const src = sliceFn('barn_wireStallCards', '// v2.21.4:');
  // The card click handler must explicitly short-circuit when the target is
  // within .stall-card-remove — that's the "Remove never opens profile"
  // invariant.
  assert.match(src,
    /closest\('\.stall-card-remove'\)\s*\)\s*return/,
    'card click must return early if target is inside .stall-card-remove');
  // And the remove button's own handler (scoped to the rmBtns.forEach block)
  // must NOT reference barnOpenHorseProfile.
  const rmStart = src.indexOf("querySelectorAll('.stall-card-remove')");
  assert.ok(rmStart > -1, 'rmBtns query not found');
  const rmBlock = src.slice(rmStart);
  assert.ok(!/barnOpenHorseProfile/.test(rmBlock),
    'Remove button handler must not open the profile');
  assert.match(rmBlock, /barnRemoveHorse/,
    'Remove button must call barnRemoveHorse');
});

test('stall card wiring: barnOpenHorseProfile helper is defined and wired', () => {
  // The centralized helper is what every stall-card handler calls. It must
  // exist and must dispatch to openHorseProfile / openVirtualBarnProfile.
  const helperStart = INDEX.indexOf('function barnOpenHorseProfile');
  assert.ok(helperStart > -1, 'barnOpenHorseProfile helper missing');
  const helperEnd = INDEX.indexOf('window.barnOpenHorseProfile', helperStart);
  assert.ok(helperEnd > -1, 'window.barnOpenHorseProfile binding missing');
  const helperSrc = INDEX.slice(helperStart, helperEnd);
  assert.match(helperSrc, /openHorseProfile\(name\)/,
    'helper must call closure-local openHorseProfile');
  assert.match(helperSrc, /window\.openVirtualBarnProfile/,
    'helper must fall back to window.openVirtualBarnProfile');
});

test('stall card: drawer "Add to Barn" does not invoke profile unexpectedly', () => {
  // Sanity: the drawer pathway (barn_renderLookupResults) should NOT call
  // barnOpenHorseProfile — adding a horse from the lookup drawer is its own
  // flow. Locking this keeps the "Add to Barn" button from double-acting.
  const lookupStart = INDEX.indexOf('function barn_renderLookupResults');
  const lookupEnd = INDEX.indexOf('function barn_closeDrawer');
  // It's fine if the lookup code calls openHorseProfile via add-and-open,
  // but it must not call barnOpenHorseProfile (the stall-card path). This
  // test just documents the separation.
  if (lookupStart > -1 && lookupEnd > -1 && lookupEnd > lookupStart) {
    const lookupSrc = INDEX.slice(lookupStart, lookupEnd);
    assert.ok(!/\bbarnOpenHorseProfile\b/.test(lookupSrc),
      'lookup drawer must not call the stall-card profile helper');
  }
});

test('curated: Inspeightofcharlie profile data is available for the profile modal', () => {
  const curated = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'curated-horses.json'), 'utf8')
  );
  const charlie = (curated.horses || []).find(function(h){
    return String(h.name || '').toLowerCase() === 'inspeightofcharlie';
  });
  assert.ok(charlie, 'Inspeightofcharlie must be in curated-horses.json');
  // Profile modal needs overview, stats, history, and sources to render its
  // sections. Lock that the curated record carries them.
  assert.ok(charlie.trainer, 'curated record missing trainer');
  assert.ok(charlie.jockey, 'curated record missing jockey');
  assert.ok(charlie.owner, 'curated record missing owner');
  assert.ok(Array.isArray(charlie.sources) && charlie.sources.length,
    'curated record must carry at least one source');
});
