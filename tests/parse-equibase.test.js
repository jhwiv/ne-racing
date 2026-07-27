'use strict';

// Regression coverage for the Equibase 2023 dataset ingestion pipeline:
// scripts/ingest/lib/tiny_xml_parser.js, parse_equibase_pp.js,
// parse_equibase_chart.js, and build_2023_corpus.js. These parse a real,
// large (owner-provided) historical dataset -- covers the pure logic with
// small hand-built fixtures rather than re-parsing the full real files here
// (those are exercised directly via the CLI scripts, not committed to the
// repo).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseXml, child, children, childText } = require('../scripts/ingest/lib/tiny_xml_parser');
const { parseEquibasePP, classCodeFor, classifyRunningStyle } = require('../scripts/ingest/parse_equibase_pp');
const { parseEquibaseChart } = require('../scripts/ingest/parse_equibase_chart');
const { dateFromPpFilename, dateFromChartFilename, mergeDate, attachRollingConnectionsStats } = require('../scripts/ingest/build_2023_corpus');

test('tiny_xml_parser: parses nested elements, attributes, and self-closing tags', () => {
  const root = parseXml('<?xml version="1.0"?><Root a="1"><Child>text</Child><Empty/><Child>two</Child></Root>');
  assert.equal(root.tag, 'Root');
  assert.equal(root.attrs.a, '1');
  const kids = children(root, 'Child');
  assert.equal(kids.length, 2);
  assert.equal(kids[0].children[0], 'text');
  assert.equal(kids[1].children[0], 'two');
  assert.equal(child(root, 'Empty').children.length, 0);
});

test('tiny_xml_parser: throws on mismatched tags instead of silently producing a wrong tree', () => {
  assert.throws(() => parseXml('<A><B></A></B>'));
});

test('tiny_xml_parser: decodes the five predefined XML entities', () => {
  const root = parseXml('<Root>Smith &amp; Sons &lt;quoted&gt; &apos;x&apos; &quot;y&quot;</Root>');
  assert.equal(root.children[0], `Smith & Sons <quoted> 'x' "y"`);
});

test('classCodeFor: direct codes pass through; STK+grade builds the CLASS_SCALE key; ungraded STK falls back to STK-L', () => {
  assert.equal(classCodeFor('AOC', ''), 'AOC');
  assert.equal(classCodeFor('MSW', ''), 'MSW');
  assert.equal(classCodeFor('STK', '3'), 'STK-G3');
  assert.equal(classCodeFor('STK', ''), 'STK-L');
  assert.equal(classCodeFor('STR', ''), 'STR'); // no exact CLASS_SCALE key; scoring.js's own fallback handles this
});

function startElWithCalls(calls, numStarters) {
  // Build a minimal <Start> node shape compatible with classifyRunningStyle.
  return {
    tag: 'Start',
    children: calls.map(([label, pos]) => ({
      tag: 'PointOfCall',
      children: [
        { tag: 'PointOfCall', children: [label] },
        { tag: 'Position', children: [String(pos)] },
      ],
    })),
  };
}

test('classifyRunningStyle: front-runner (near the lead early, small field) classifies as E', () => {
  const start = startElWithCalls([['S', 1], ['1', 1]], 8);
  assert.equal(classifyRunningStyle(start, 8), 'E');
});

test('classifyRunningStyle: deep closer (far off the pace early) classifies as SS', () => {
  const start = startElWithCalls([['S', 8], ['1', 8]], 8);
  assert.equal(classifyRunningStyle(start, 8), 'SS');
});

test('classifyRunningStyle: falls back to the start call when call "1" is unrecorded (position 0)', () => {
  const start = startElWithCalls([['S', 2], ['1', 0]], 10);
  assert.equal(classifyRunningStyle(start, 10), 'E'); // 2/10 = 0.2 -> E
});

test('classifyRunningStyle: returns null with no usable call or no field size', () => {
  assert.equal(classifyRunningStyle(startElWithCalls([['1', 0]], 8), 8), null);
  assert.equal(classifyRunningStyle(startElWithCalls([['1', 3]], 8), 0), null);
  assert.equal(classifyRunningStyle(null, 8), null);
});

test('dateFromPpFilename / dateFromChartFilename: extract YYYY-MM-DD, reject non-matching names', () => {
  assert.equal(dateFromPpFilename('SIMD20230713SAR_USA.xml', 'SAR'), '2023-07-13');
  assert.equal(dateFromPpFilename('SIMD20230713BEL_USA.xml', 'SAR'), null);
  assert.equal(dateFromChartFilename('sar20230713tch.xml', 'SAR'), '2023-07-13');
  assert.equal(dateFromChartFilename('aik20230713tch.xml', 'SAR'), null);
});

test('parseEquibasePP: minimal fixture round-trips pp/name/ml/lastClass/speedFigs correctly, drops scratches', () => {
  const xml = `<?xml version="1.0"?>
  <EntryRaceCard>
    <Race>
      <RaceNumber>1</RaceNumber>
      <RaceType><RaceType>AOC</RaceType></RaceType>
      <Grade/>
      <Starters>
        <Horse><HorseName>Test Horse</HorseName></Horse>
        <ProgramNumber>3</ProgramNumber>
        <WeightCarried>120</WeightCarried>
        <Equipment><Value>B</Value></Equipment>
        <ScratchIndicator><Value/></ScratchIndicator>
        <Jockey><ExternalPartyId>J1</ExternalPartyId><FirstName>Joe</FirstName><LastName>Jockey</LastName></Jockey>
        <Trainer><ExternalPartyId>T1</ExternalPartyId><FirstName>Tara</FirstName><LastName>Trainer</LastName></Trainer>
        <Odds>7/2</Odds>
        <PastPerformance>
          <RaceDate>2023-07-01+00:00</RaceDate>
          <RaceType><RaceType>MSW</RaceType></RaceType>
          <NumberOfStarters>8</NumberOfStarters>
          <Start>
            <SpeedFigure>750</SpeedFigure>
            <Equipment><Value/></Equipment>
            <PointOfCall><PointOfCall>S</PointOfCall><Position>2</Position></PointOfCall>
          </Start>
        </PastPerformance>
      </Starters>
      <Starters>
        <Horse><HorseName>Scratched Horse</HorseName></Horse>
        <ProgramNumber>4</ProgramNumber>
        <ScratchIndicator><Value>Y</Value></ScratchIndicator>
        <Odds>5/1</Odds>
      </Starters>
    </Race>
  </EntryRaceCard>`;
  const result = parseEquibasePP(xml, 'SAR', '2023-07-13');
  assert.equal(result.races.length, 1);
  const race = result.races[0];
  assert.equal(race.type, 'AOC');
  assert.equal(race.horses.length, 1, 'the scratched horse must be dropped');
  const h = race.horses[0];
  assert.equal(h.pp, 3);
  assert.equal(h.name, 'Test Horse');
  assert.equal(h.ml, '7/2');
  assert.equal(h.lastClass, 'MSW');
  assert.equal(h.lastRaceDate, '2023-07-01');
  assert.deepEqual(h.speedFigs, [null, null, 75]);
  assert.equal(h.equipmentChanges, true, 'blinkers B now vs. none last time out is a real equipment change');
  assert.equal(h.jockeyId, 'J1');
  assert.equal(h.trainerId, 'T1');
});

test('parseEquibaseChart: minimal fixture extracts finish positions, win payout, and exotics', () => {
  const xml = `<?xml version="1.0"?>
  <CHART RACE_DATE="2023-07-13">
    <TRACK><CODE>SAR</CODE></TRACK>
    <RACE NUMBER="1">
      <EXOTIC_WAGERS>
        <WAGER NUMBER="1"><WAGER_TYPE>Exacta</WAGER_TYPE><PAYOFF>7.80</PAYOFF><WINNERS> 5-1</WINNERS></WAGER>
      </EXOTIC_WAGERS>
      <ENTRY><PROGRAM_NUM>5</PROGRAM_NUM><NAME>Winner Horse</NAME><OFFICIAL_FIN>1</OFFICIAL_FIN><WIN_PAYOFF>5.40</WIN_PAYOFF><DOLLAR_ODDS>1.70</DOLLAR_ODDS></ENTRY>
      <ENTRY><PROGRAM_NUM>1</PROGRAM_NUM><NAME>Second Horse</NAME><OFFICIAL_FIN>2</OFFICIAL_FIN><WIN_PAYOFF>0.00</WIN_PAYOFF><DOLLAR_ODDS>2.25</DOLLAR_ODDS></ENTRY>
      <SCRATCH><NAME>Scratched Horse</NAME></SCRATCH>
    </RACE>
  </CHART>`;
  const result = parseEquibaseChart(xml);
  assert.equal(result.track, 'SAR');
  assert.equal(result.date, '2023-07-13');
  const race = result.races[0];
  assert.deepEqual(race.results.finish_positions, [
    { pp: 5, horseName: 'Winner Horse', position: 1, win_payout: 5.4 },
    { pp: 1, horseName: 'Second Horse', position: 2, win_payout: undefined },
  ]);
  assert.equal(race.results.exotics[0].payout, 7.8);
  assert.deepEqual([...race.actualStarterPps].sort(), [1, 5]);
});

test('mergeDate: a horse present in the PP file but absent from the chart\'s actual starters is excluded (late scratch)', () => {
  const ppDoc = {
    races: [{ num: 1, type: 'AOC', horses: [
      { pp: 1, name: 'Runs', ml: '3/1' },
      { pp: 2, name: 'Late Scratch', ml: '5/1' },
    ] }],
  };
  const chartDoc = {
    races: [{ num: 1, actualStarterPps: new Set([1]), closingOdds: { 1: '2.5' },
      results: { finish_positions: [{ pp: 1, position: 1, win_payout: 7 }], exotics: [] } }],
  };
  const races = mergeDate('SAR', '2023-07-13', ppDoc, chartDoc);
  assert.equal(races[0].horses.length, 1);
  assert.equal(races[0].horses[0].pp, 1);
  assert.ok(races[0].results, 'results must be attached');
});

test('mergeDate: PP morning line wins over chart closing odds when both are present; closing odds only fills a gap', () => {
  const ppDoc = { races: [{ num: 1, type: 'AOC', horses: [
    { pp: 1, name: 'Has ML', ml: '3/1' },
    { pp: 2, name: 'No ML', ml: null },
  ] }] };
  const chartDoc = { races: [{ num: 1, actualStarterPps: new Set([1, 2]), closingOdds: { 1: '2.5', 2: '4.0' }, results: undefined }] };
  const races = mergeDate('SAR', '2023-07-13', ppDoc, chartDoc);
  const h1 = races[0].horses.find(h => h.pp === 1);
  const h2 = races[0].horses.find(h => h.pp === 2);
  assert.equal(h1.ml, '3/1', 'real morning line must not be overwritten by closing odds');
  assert.equal(h2.ml, '4.0', 'missing morning line should fall back to closing odds');
});

test('attachRollingConnectionsStats: a connection\'s pct on date N reflects only wins/starts from strictly earlier dates', () => {
  const datedRaces = new Map();
  datedRaces.set('2023-07-01', [{
    horses: [{ jockeyId: 'J1', trainerId: 'T1', pp: 1 }, { jockeyId: 'J2', trainerId: 'T2', pp: 2 }],
    results: { finish_positions: [{ pp: 1, position: 1 }] },
  }]);
  datedRaces.set('2023-07-02', [{
    horses: [{ jockeyId: 'J1', trainerId: 'T1', pp: 1 }],
    results: { finish_positions: [{ pp: 1, position: 1 }] },
  }]);
  attachRollingConnectionsStats(datedRaces);

  const day1Horse = datedRaces.get('2023-07-01')[0].horses[0];
  assert.equal(day1Horse.jockeyPct, null, 'no prior real results exist yet on the very first date -- must not fabricate a percentage');

  const day2Horse = datedRaces.get('2023-07-02')[0].horses[0];
  assert.equal(day2Horse.jockeyPct, 100, 'J1 won their only prior (2023-07-01) start');
  assert.equal(day2Horse.trainerPct, 100);
});

test('attachRollingConnectionsStats: same-day races do not leak into each other\'s stats', () => {
  const datedRaces = new Map();
  datedRaces.set('2023-07-01', [
    { horses: [{ jockeyId: 'J1', trainerId: 'T1', pp: 1 }], results: { finish_positions: [{ pp: 1, position: 1 }] } },
    { horses: [{ jockeyId: 'J1', trainerId: 'T1', pp: 1 }], results: { finish_positions: [{ pp: 1, position: 2 }] } },
  ]);
  attachRollingConnectionsStats(datedRaces);
  const [race1, race2] = datedRaces.get('2023-07-01');
  assert.equal(race1.horses[0].jockeyPct, null);
  assert.equal(race2.horses[0].jockeyPct, null, 'race 2 must not already see race 1\'s same-day result');
});
