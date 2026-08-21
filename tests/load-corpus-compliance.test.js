'use strict';

// Regression lock for a real data-compliance bug found 2026-08-21: worker.js's
// mergeBrisnetIntoEntries() (v2.46.0) overlays real Brisnet PP data onto live
// entries for the 6 SAR dates data/brisnet-{TRACK}-{DATE}.json exists for.
// That overlaid data gets archived into RACE_HISTORY (no source_provenance
// tag) and pulled into data/normalized/ by pull-race-history.yml -- landing
// in the exact training corpus scripts/training/fit_logit.py fits on.
//
// docs/DATA_WISHLIST.md's own "Rules" section: "Never enter Equibase,
// Brisnet, or TimeformUS data into `training/` output unless a signed
// agreement explicitly permits it," and separately labels Brisnet "BLOCKED
// BY TOS ... regardless of subscription." Confirmed by exact-match
// comparison against the source files: 56 of 559 training races (10%)
// carried Brisnet-derived jockeyPct/trainerPct before this fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadCorpus } = require('../scripts/backtest/load_corpus');

const BRISNET_DATES = ['2026-06-05', '2026-06-06', '2026-06-07', '2026-07-04', '2026-07-05', '2026-07-09'];

test('loadCorpus excludes every known Brisnet-overlay-contaminated date, unconditionally', () => {
  const { races } = loadCorpus({ includeFixtures: false });
  const leaked = races.filter(r => r.track === 'SAR' && BRISNET_DATES.includes(r.date));
  assert.equal(leaked.length, 0,
    `${leaked.length} race(s) from known Brisnet-contaminated dates leaked into loadCorpus() output: ` +
    `${leaked.map(r => r.id).join(', ')} -- these must never reach the training pipeline (docs/DATA_WISHLIST.md)`);
});

test('loadCorpus reports the exclusion count in stats, not silently', () => {
  const { stats } = loadCorpus({ includeFixtures: false });
  assert.ok(stats.brisnet_excluded_for_compliance > 0,
    'expected a nonzero exclusion count given the known-contaminated dates are present on disk -- ' +
    'if this is ever 0 on real data, verify the contaminated files/dates still exist as expected');
});

test('the exclusion only touches the specific known dates, not SAR races generally', () => {
  const { races } = loadCorpus({ includeFixtures: false });
  const otherSarRaces = races.filter(r => r.track === 'SAR' && !BRISNET_DATES.includes(r.date));
  assert.ok(otherSarRaces.length > 100,
    'expected the vast majority of the real SAR corpus to remain -- this exclusion must be narrowly scoped to the 6 known dates, not a blanket SAR ban');
});
