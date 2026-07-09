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

// v2.49.27: real live page shape, confirmed 2026-07-09 against
// nyra.com/saratoga/racing/talking-horses/ via a GitHub Actions debug run
// (see CHANGELOG.md). The page is a multi-panelist show, not just Andy
// Serling -- each named contributor gives ranked program numbers per race,
// no horse names. This is the exact text shape captured live (trimmed).
test('parseNyraPicksHtml extracts every named panelist\'s picks from the real NYRA Talking Horses format', () => {
  const html = `<html><body><p>Thursday, July 9 Andy Serling | @AndySerling Race 1 3 - 5 Race 2 6 - 2 - 3 - 8 Race 3 5 - 4 - 3 - 7 Megan Burgess | @TheMeganBurgess Race 1 5 - 6 - 1 - 3 Race 2 7 - 3 - 2 - 5 Race 3 5 - 3 - 4 - 7</p></body></html>`;
  const result = parseNyraPicksHtml(html);
  assert.equal(result.strategy, 'handicapper-panel');
  assert.equal(result.picks.length, 6, 'two panelists x three races = 6 independent picks');

  const serlingRace1 = result.picks.find((p) => p.source === 'Talking Horses - Andy Serling' && p.race === 1);
  assert.ok(serlingRace1, 'Andy Serling\'s race 1 pick must be attributed by name');
  assert.equal(serlingRace1.pick, 3, 'top pick is the first program number in the dash-separated list');
  assert.equal(serlingRace1.horseName, null, 'this format gives no horse name, only program numbers');

  const burgessRace2 = result.picks.find((p) => p.source === 'Talking Horses - Megan Burgess' && p.race === 2);
  assert.ok(burgessRace2, 'a second, differently-named panelist on the same page must be attributed independently, not collapsed into Serling\'s picks');
  assert.equal(burgessRace2.pick, 7);
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
