'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseNyraPicksHtml } = require('../scripts/lib/nyra-picks-parser.js');

test('parseNyraPicksHtml extracts picks from an embedded __NEXT_DATA__ JSON blob', () => {
  const html = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      props: {
        pageProps: {
          picks: [
            { raceNumber: 1, programNumber: 4, horseName: 'Midnight Cowboy Kid' },
            { raceNumber: 2, programNumber: 7, horseName: 'Fancy Footwork' },
          ],
        },
      },
    })}</script>
  </body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.equal(result.strategy, 'embedded-json');
  assert.equal(result.picks.length, 2);
  assert.deepEqual(result.picks.find((p) => p.race === 1), { race: 1, pick: 4, horseName: 'Midnight Cowboy Kid' });
  assert.deepEqual(result.picks.find((p) => p.race === 2), { race: 2, pick: 7, horseName: 'Fancy Footwork' });
});

test('parseNyraPicksHtml falls back to visible-text extraction when no embedded JSON is present', () => {
  const html = `<html><body>
    <div class="pick-card"><h3>Race 4</h3><p>Top selection: #7 Fancy Footwork looks best on paper.</p></div>
    <div class="pick-card"><h3>Race 5</h3><p>Top selection: No. 2 Quiet Storm has the edge.</p></div>
  </body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.equal(result.strategy, 'visible-text');
  assert.deepEqual(result.picks.find((p) => p.race === 4), { race: 4, pick: 7, horseName: 'Fancy Footwork' });
  assert.deepEqual(result.picks.find((p) => p.race === 5), { race: 5, pick: 2, horseName: 'Quiet Storm' });
});

test('parseNyraPicksHtml returns an empty array (never throws) when nothing recognizable is found', () => {
  const result = parseNyraPicksHtml('<html><body><p>Coming soon.</p></body></html>');
  assert.deepEqual(result.picks, []);
  assert.equal(result.strategy, 'none');
  assert.ok(result.reason);
});

test('parseNyraPicksHtml handles empty/non-string input without throwing', () => {
  assert.deepEqual(parseNyraPicksHtml('').picks, []);
  assert.deepEqual(parseNyraPicksHtml(null).picks, []);
  assert.deepEqual(parseNyraPicksHtml(undefined).picks, []);
});

// v2.49.27/28: real live page shape, confirmed 2026-07-09 against both
// nyra.com/saratoga/racing/talking-horses/ AND hablan-los-caballos/ via
// GitHub Actions debug runs (see CHANGELOG.md). This exact panel shape
// recurs across different NYRA shows -- the parser returns each
// contributor's BARE name in `source` (no page title baked in); the CLI
// caller (fetch-nyra-expert-picks.js) is responsible for combining it with
// whichever page-specific label it configured for that URL, since the same
// parser function serves multiple differently-branded pages.
test('parseNyraPicksHtml extracts every named panelist\'s picks from the real NYRA panel format', () => {
  const html = `<html><body><p>Thursday, July 9 Andy Serling | @AndySerling Race 1 3 - 5 Race 2 6 - 2 - 3 - 8 Race 3 5 - 4 - 3 - 7 Megan Burgess | @TheMeganBurgess Race 1 5 - 6 - 1 - 3 Race 2 7 - 3 - 2 - 5 Race 3 5 - 3 - 4 - 7</p></body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.equal(result.strategy, 'handicapper-panel');
  assert.equal(result.picks.length, 6, 'two panelists x three races = 6 independent picks');

  const serlingRace1 = result.picks.find((p) => p.source === 'Andy Serling' && p.race === 1);
  assert.ok(serlingRace1, 'Andy Serling\'s race 1 pick must be attributed by his bare name, not a hardcoded page title');
  assert.equal(serlingRace1.pick, 3, 'top pick is the first program number in the dash-separated list');
  assert.equal(serlingRace1.horseName, null, 'this format gives no horse name, only program numbers');

  const burgessRace2 = result.picks.find((p) => p.source === 'Megan Burgess' && p.race === 2);
  assert.ok(burgessRace2, 'a second, differently-named panelist on the same page must be attributed independently, not collapsed into Serling\'s picks');
  assert.equal(burgessRace2.pick, 7);
});

// v2.49.29: confirmed live that this same panel format also appears on a
// DIFFERENT NYRA show (Hablan Los Caballos, hosted by Darwin Vizcaya) --
// the parser must not hardcode "Talking Horses" into the source label,
// since the identical shape recurs under other page titles.
test('parseNyraPicksHtml attributes a single panelist by bare name regardless of which show the page is', () => {
  const html = `<html><body><p>July 9 Darwin Vizcaya | @DarwinVizcaya_ Race 1 3 Race 2 6 - 7 Race 8 7 - 6 - 2 - 11</p></body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.equal(result.strategy, 'handicapper-panel');
  const race1 = result.picks.find((p) => p.race === 1);
  assert.equal(race1.source, 'Darwin Vizcaya', 'must be the bare name -- the caller (not the parser) attaches the page-specific show title');
  assert.equal(race1.pick, 3);
});

// v2.49.29: exact real text captured live (2026-07-09, GitHub Actions debug
// run) from NYRA Bets' DeSantis picks page (racing.nyrabets.com), replacing
// the earlier Perplexity-described approximation. This exact text exposed a
// real bug: the post time between "Race N" and the picks ("1:10 PM ET")
// itself contains digits, which broke an earlier version of
// tryExtractFromRaceNumberList that only tolerated a generic non-digit gap
// -- it matched the "1" in "1:10" as the pick instead of the real "6-3" for
// every single race. Fixed by explicitly recognizing and skipping the post-
// time token instead of generically tolerating "some gap".
test('parseNyraPicksHtml extracts every race from the real NYRA Bets DeSantis page despite post times containing digits', () => {
  const html = `<html><body><p>MATTHEW'S FULL CARD PICKS - THURSDAY, JULY 9 Race Post Time (ET) Picks Race 1 1:10 PM ET 6-3 Race 2 1:44 PM ET 5-6-4-2 Race 3 2:18 PM ET 5-3-7-6 Race 4 2:52 PM ET 4-1-6-3 Race 5 3:26 PM ET 3-4-2-1 Race 6 4:01 PM ET 5-7-1-9 Race 7 4:36 PM ET 9-7-2-3 Race 8 5:11 PM ET 9-2-8-7 Race 9 5:46 PM ET 5-10-9-1</p></body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.deepEqual(result.picks.find((p) => p.race === 1), { race: 1, pick: 6, horseName: null }, 'must extract the real pick (6), not "1" from the "1:10" post time');
  assert.deepEqual(result.picks.find((p) => p.race === 2), { race: 2, pick: 5, horseName: null });
  assert.deepEqual(result.picks.find((p) => p.race === 9), { race: 9, pick: 5, horseName: null });
  assert.equal(result.picks.length, 9, 'every one of the 9 races must be captured, not just a subset');
});

// v2.49.29: a real page can have BOTH a full numeric picks table for every
// race AND a separate "Best Bet"-style callout naming a horse for just one
// race. Confirmed as a real bug: an earlier version of tryExtractFromVisibleText
// used a flat 200-char forward window per "Race N" mention with no stop
// condition at the NEXT race's own heading -- a later, unrelated callout's
// name bled backward onto every earlier race that happened to fall within
// 200 characters of it. Fixed by bounding each race's search window to the
// next "Race N" occurrence.
test('parseNyraPicksHtml does not let a later named callout bleed onto earlier unrelated races', () => {
  const html = `<html><body><p>Race 1 1:10 PM ET 6-3 Race 2 1:44 PM ET 5-6-4-2 Race 5 3:26 PM ET 3-4-2-1 Race 6 4:01 PM ET 5-7-1-9</p><p>Best Bet of the Day: Race 5 #3 Brisbane looks primed to rebound.</p></body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.deepEqual(result.picks.find((p) => p.race === 5), { race: 5, pick: 3, horseName: 'Brisbane' }, 'race 5 legitimately gets the named callout');
  assert.deepEqual(result.picks.find((p) => p.race === 1), { race: 1, pick: 6, horseName: null }, 'race 1 must keep its own numeric pick, not inherit race 5\'s horse name');
  assert.deepEqual(result.picks.find((p) => p.race === 2), { race: 2, pick: 5, horseName: null });
  assert.deepEqual(result.picks.find((p) => p.race === 6), { race: 6, pick: 5, horseName: null }, 'race 6 (after the named callout in source order) must also not inherit it');
});

test('parseNyraPicksHtml\'s race-number-list strategy rejects the "Race N - 0MTP" countdown widget as a false pick', () => {
  // Confirmed present on multiple real NYRA pages (Talking Horses, the dead
  // TimeformUS page) as site chrome, not a pick -- without a guard this
  // would be misread as "race 7, pick 0".
  const html = `<html><body><p>Log In Account Race 7 - 0MTP Log In Account Race 7 - 0MTP Hablan Los Caballos Race 1 3 Race 2 6 - 7</p></body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.equal(result.picks.some((p) => p.race === 7), false, 'the MTP countdown widget must not be read as a race 7 pick');
  assert.deepEqual(result.picks.find((p) => p.race === 1), { race: 1, pick: 3, horseName: null });
  assert.deepEqual(result.picks.find((p) => p.race === 2), { race: 2, pick: 6, horseName: null });
});

test('parseNyraPicksHtml dedupes to one pick per race number (first match wins)', () => {
  const html = `<html><body>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
      picks: [
        { race_number: 3, program_number: 1, horse_name: 'First Found' },
        { race_number: 3, program_number: 9, horse_name: 'Should Be Ignored' },
      ],
    })}</script>
  </body></html>`;
  const result = parseNyraPicksHtml(html);
  const race3Matches = result.picks.filter((p) => p.race === 3);
  assert.equal(race3Matches.length, 1);
  assert.equal(race3Matches[0].horseName, 'First Found');
});
