'use strict';

// Regression coverage for scripts/backtest/pull_entries_history.js -- the
// script that merges real pre-race horses data (from the ENTRIES_R2 mirror)
// onto the results-only data/normalized/{year}/{track}/{date}.json files
// pull_race_history.js already writes. Without this, every race in the
// on-disk corpus has horses:[] for any date after the daily-entries pipeline
// was disabled, and the backtest harness can score nothing real.
//
// Runs an actual local HTTP server (rather than mocking fetch), same pattern
// as tests/pull-race-history.test.js, so the test exercises the real
// fetchEntries() network path end-to-end.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backtest', 'pull_entries_history.js');
// A date not already committed under data/normalized/2026/SAR/ -- picked so
// this test creates and cleans up its own file rather than touching real data.
const TEST_DATE = '2026-06-10';
const OUT_PATH = path.join(__dirname, '..', 'data', 'normalized', '2026', 'SAR', `${TEST_DATE}.json`);

function startMockWorker(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handler(req.url)));
    });
    server.listen(0, () => resolve(server));
  });
}

function seedResultsOnlyFile() {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({
    track: 'SAR', date: TEST_DATE, source: 'test seed', races: [
      {
        id: `SAR-${TEST_DATE.replace(/-/g, '')}-R1`, track: 'SAR', date: TEST_DATE, num: 1,
        type: 'ALW', horses: [], expertPicks: [],
        results: { finish_positions: [{ pp: 3, horseName: 'Seeded Winner', position: 1, win_payout: 9.2 }] },
      },
    ],
  }, null, 2));
}

test('pull_entries_history.js merges real horses data onto an existing results-only file', async () => {
  const server = await startMockWorker((url) => {
    if (url.includes('/api/entries?')) return { races: [] }; // force the R2 fallback, matching production shape for old dates
    assert.match(url, new RegExp(`/api/entries/r2\\?track=SAR&date=${TEST_DATE}`));
    return {
      races: [{
        raceNumber: 1,
        entries: [
          { pp: 3, horseName: 'Seeded Winner', ml: '5/2', jockey: 'J. Rider', trainer: 'T. Barn',
            speedFigs: [78, 80, 82], runningStyle: 'E', jockeyPct: 20, trainerPct: 18, lastClass: 'ALW', status: 'ACTIVE' },
          { pp: 5, horseName: 'Other Horse', ml: '3/1', jockey: 'A. Jock', trainer: 'B. Barn',
            speedFigs: [70, 72, 74], runningStyle: 'S', jockeyPct: 12, trainerPct: 10, lastClass: 'ALW', status: 'ACTIVE' },
        ],
      }],
    };
  });
  const port = server.address().port;
  const existedBefore = fs.existsSync(OUT_PATH);
  seedResultsOnlyFile();

  try {
    const { stdout } = await execFileAsync('node', [
      SCRIPT, '--track', 'SAR', '--from', TEST_DATE, '--to', TEST_DATE,
      '--worker-url', `http://localhost:${port}`,
    ], { cwd: path.join(__dirname, '..'), timeout: 10000 });

    assert.match(stdout, /Merged real horses data onto 1 race/);

    const doc = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    const r1 = doc.races.find(r => r.num === 1);
    assert.ok(r1, 'race 1 must still be present');
    assert.equal(r1.horses.length, 2, 'must have both horses merged in from the entries snapshot');
    assert.ok(r1.results, 'must keep the pre-existing real results, not drop them');
    assert.equal(r1.results.finish_positions[0].pp, 3);

    const winner = r1.horses.find(h => h.pp === 3);
    assert.equal(winner.name, 'Seeded Winner');
    assert.deepEqual(winner.speedFigs, [78, 80, 82]);
    assert.equal(winner.runningStyle, 'E');
    assert.equal(winner.jockeyPct, 20);
  } finally {
    if (!existedBefore) { try { fs.rmSync(OUT_PATH, { force: true }); } catch (_) {} }
    server.close();
  }
});

test('pull_entries_history.js reports cleanly when no entries snapshot exists for the range', async () => {
  const server = await startMockWorker(() => ({ races: [] }));
  const port = server.address().port;

  try {
    const { stdout } = await execFileAsync('node', [
      SCRIPT, '--track', 'SAR', '--from', '2026-06-11', '--to', '2026-06-11',
      '--worker-url', `http://localhost:${port}`,
    ], { cwd: path.join(__dirname, '..'), timeout: 10000 });
    assert.match(stdout, /Nothing to write/);
  } finally {
    server.close();
  }
});
