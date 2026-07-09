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
