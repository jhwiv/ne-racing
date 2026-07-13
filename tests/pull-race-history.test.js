'use strict';

// Regression coverage for scripts/backtest/pull_race_history.js -- the
// script that pulls the worker's real, already-archived RACE_HISTORY data
// into data/normalized/{year}/{track}/{date}.json. Runs an actual local HTTP
// server (rather than mocking fetch) so the test exercises the real
// loadCorpusFromWorker() network path end-to-end, the same way the script
// will really be invoked from the pull-race-history.yml GitHub Action.
//
// Uses the ASYNC execFile (promisified), not execFileSync: the mock server
// below lives in this SAME test process, and execFileSync blocks this
// process's event loop for its entire duration -- which would prevent the
// mock server from ever accepting/answering the child's request, deadlocking
// the test (confirmed: execFileSync here hangs until it times out).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backtest', 'pull_race_history.js');

function startMockWorker(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(handler(req.url)));
    });
    server.listen(0, () => resolve(server));
  });
}

test('pull_race_history.js writes a normalized file with real results, merged with local horses data', async () => {
  const server = await startMockWorker((url) => {
    assert.match(url, /\/api\/history\/list\?track=SAR/);
    return {
      track: 'SAR', count: 1,
      races: [{
        track: 'SAR', date: '2026-07-03',
        races: [{
          raceNumber: 1,
          finishOrder: [
            { pp: 1, position: 1, horseName: 'Westfield', winPayoff: 8.4 },
            { pp: 4, position: 2, horseName: 'Second Choice' },
          ],
          payouts: { exacta: 31.6 },
        }],
      }],
    };
  });
  const port = server.address().port;

  // pull_race_history.js resolves data/ relative to its own location (not
  // cwd), so this runs against the real repo's data/entries-SAR-2026-07-03.json
  // (already committed, real pre-race field data) and cleans up the one
  // output file it should produce afterward.
  const outDir = path.join(__dirname, '..', 'data', 'normalized');
  const outPath = path.join(outDir, '2026', 'SAR', '2026-07-03.json');
  const existedBefore = fs.existsSync(outDir);
  try { fs.rmSync(outPath, { force: true }); } catch (_) {}

  try {
    await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--worker-url', `http://localhost:${port}`], {
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });

    assert.ok(fs.existsSync(outPath), 'must write data/normalized/2026/SAR/2026-07-03.json');
    const doc = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(doc.track, 'SAR');
    assert.equal(doc.races.length, 10, 'must include every race from the local entries file (all 10), not just the one with results');

    const r1 = doc.races.find(r => r.num === 1);
    assert.ok(r1, 'race 1 must be present');
    assert.equal(r1.id, 'SAR-20260703-R1');
    assert.ok(r1.horses.length > 0, 'must keep the real pre-race horses data from the local entries file');
    assert.ok(r1.results, 'must have real results merged in from RACE_HISTORY');
    assert.deepEqual(r1.results.finish_positions.map(f => f.pp), [1, 4]);
    assert.equal(r1.results.exotics.find(e => e.type === 'exacta').payout, 31.6);

    const r2 = doc.races.find(r => r.num === 2);
    assert.ok(r2 && r2.horses.length > 0 && !r2.results, 'races the worker never archived must keep their horses data and simply have no results, not get dropped');
  } finally {
    if (!existedBefore) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {} }
    else { try { fs.rmSync(outPath, { force: true }); } catch (_) {} }
    server.close();
  }
});

test('pull_race_history.js reports (and exits cleanly) when nothing is archived yet', async () => {
  const server = await startMockWorker(() => ({ track: 'SAR', count: 0, races: [] }));
  const port = server.address().port;
  const outDir = path.join(__dirname, '..', 'data', 'normalized');
  const existedBefore = fs.existsSync(outDir);

  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--worker-url', `http://localhost:${port}`], {
      cwd: path.join(__dirname, '..'),
      timeout: 10000,
    });
    assert.match(stdout, /Nothing archived yet/);
  } finally {
    if (!existedBefore) { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) {} }
    server.close();
  }
});
