'use strict';

// Regression coverage for scripts/backfill_control_history.js -- the
// one-time backfill that re-derives baseline_ml/crowd control-group picks
// for past dates and settles them against real archived results, fixing
// the control-group sample-size gap (35 graded picks for the engine's own
// picks vs. 1 for baseline_ml and 2 for crowd) without waiting weeks for it
// to accumulate day-by-day under the every-race logging fix.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { dateRange, fetchEntries, parseArgs } = require('../scripts/backfill_control_history');

test('parseArgs defaults --from to the R2 mirror\'s earliest possible date and --to to today', () => {
  const args = parseArgs(['node', 'backfill_control_history.js', '--track', 'sar']);
  assert.equal(args.track, 'SAR');
  assert.equal(args.from, '2026-06-05');
  assert.equal(args.to, new Date().toISOString().slice(0, 10));
  assert.equal(args.dryRun, false);
});

test('parseArgs honors explicit --from/--to/--dry-run', () => {
  const args = parseArgs(['node', 'backfill_control_history.js', '--from', '2026-07-01', '--to', '2026-07-03', '--dry-run']);
  assert.equal(args.from, '2026-07-01');
  assert.equal(args.to, '2026-07-03');
  assert.equal(args.dryRun, true);
});

test('dateRange produces an inclusive, ordered list of dates', () => {
  assert.deepEqual(dateRange('2026-07-01', '2026-07-04'), ['2026-07-01', '2026-07-02', '2026-07-03', '2026-07-04']);
  assert.deepEqual(dateRange('2026-07-01', '2026-07-01'), ['2026-07-01']);
});

function makeFetchStub(routes) {
  // routes: array of [urlSubstring, () => ({status, body})]
  return async (url) => {
    for (const [pattern, handler] of routes) {
      if (String(url).includes(pattern)) {
        const { status, body } = handler();
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () => body,
        };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('fetchEntries prefers the live /api/entries endpoint when it has real data', async () => {
  const stub = makeFetchStub([
    ['/api/entries?', () => ({ status: 200, body: { races: [{ raceNumber: 1, entries: [] }] } })],
    ['/api/entries/r2?', () => ({ status: 200, body: { races: [{ raceNumber: 99, entries: [] }] } })],
  ]);
  const body = await fetchEntries('http://x', 'SAR', '2026-07-10', stub);
  assert.equal(body.races[0].raceNumber, 1, 'the live endpoint\'s data must win when it has real races, not the R2 fallback');
});

test('fetchEntries falls back to /api/entries/r2 when the live endpoint has nothing (expected for older historical dates)', async () => {
  const stub = makeFetchStub([
    ['/api/entries?', () => ({ status: 404, body: {} })],
    ['/api/entries/r2?', () => ({ status: 200, body: { races: [{ raceNumber: 1, entries: [] }] } })],
  ]);
  const body = await fetchEntries('http://x', 'SAR', '2026-06-10', stub);
  assert.ok(body, 'must fall back to the R2 mirror instead of giving up');
  assert.equal(body.races[0].raceNumber, 1);
});

test('fetchEntries returns null (not throw) when neither source has data -- a dark day or out-of-coverage date', async () => {
  const stub = makeFetchStub([
    ['/api/entries?', () => ({ status: 404, body: {} })],
    ['/api/entries/r2?', () => ({ status: 404, body: {} })],
  ]);
  const body = await fetchEntries('http://x', 'SAR', '2026-05-01', stub);
  assert.equal(body, null);
});

// ── End-to-end against a real local HTTP server ─────────────────────────────
function startMockWorker(handlers) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      for (const [pattern, handler] of handlers) {
        if (req.url.includes(pattern)) {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
              const result = handler(req.url, JSON.parse(body || '{}'));
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            });
          } else {
            const result = handler(req.url);
            res.writeHead(result === null ? 404 : 200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result === null ? { error: 'not found' } : result));
          }
          return;
        }
      }
      res.writeHead(404); res.end('not found');
    });
    server.listen(0, () => resolve(server));
  });
}

test('backfill_control_history.js runs end-to-end via R2 fallback: logs+settles baseline_ml/crowd, skips v2', async () => {
  const logged = [];
  const settled = [];
  const server = await startMockWorker([
    ['/api/entries?', () => null], // live entries: nothing for this old date
    ['/api/entries/r2', () => ({
      races: [{
        raceNumber: 1,
        entries: [
          { pp: 1, horseName: 'Alpha', ml: '9-2', speedFigs: [90, 90, 90], runningStyle: 'E', jockeyPct: 20, trainerPct: 18, lastClass: 'ALW', status: 'RUNNER' },
          { pp: 2, horseName: 'Bravo', ml: '3-1', speedFigs: [60, 60, 60], runningStyle: 'P', jockeyPct: 10, trainerPct: 10, lastClass: 'ALW', status: 'RUNNER' },
          { pp: 3, horseName: 'Charlie', ml: '8-1', speedFigs: [55, 55, 55], runningStyle: 'S', jockeyPct: 8, trainerPct: 8, lastClass: 'ALW', status: 'RUNNER' },
        ],
      }],
    })],
    ['/api/expert-picks', () => ({ expertPicks: [{ race: 1, picks: [{ source: 'A', pick: 2 }, { source: 'B', pick: 2 }] }] })],
    [`/api/history/SAR/2026-06-10`, () => ({
      races: [{
        raceNumber: 1,
        finishOrder: [
          { pp: 2, horseName: 'Bravo', position: 1, winPayoff: 8.4 },
          { pp: 1, horseName: 'Alpha', position: 2 },
          { pp: 3, horseName: 'Charlie', position: 3 },
        ],
        payoffs: [],
      }],
    })],
    ['/api/picks/log', (url, body) => { logged.push(body); return { ok: true }; }],
    ['/api/picks/settle', (url, body) => { settled.push(body); return { ok: true }; }],
  ]);
  const port = server.address().port;
  const workerUrl = `http://localhost:${port}`;

  try {
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const execFileAsync = promisify(execFile);
    const path = require('node:path');
    const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill_control_history.js');

    const { stdout } = await execFileAsync('node', [
      SCRIPT, '--track', 'SAR', '--from', '2026-06-10', '--to', '2026-06-10', '--worker-url', workerUrl,
    ], { timeout: 10000 });

    assert.match(stdout, /2 logged, 2 settled/, `expected one baseline_ml + one crowd pick logged+settled, got: ${stdout}`);
    assert.equal(logged.length, 2);
    // Both engines pick the same horse here (Bravo, pp2, is both the ML
    // favorite and the 2-expert crowd consensus) -- distinct engine keys
    // mean both still get logged separately, exactly as they would live.
    assert.deepEqual(logged.map(p => p.engine).sort(), ['baseline_ml', 'crowd']);
    assert.ok(logged.every(p => p.pp === 2 && p.horseName === 'Bravo'));
    assert.ok(logged.every(p => p.engine !== 'v2'), 'v2 must never be posted by this backfill -- only the two control engines');
    assert.equal(settled.length, 2);
    assert.ok(settled.every(p => p.won === true), 'Bravo (pp2) actually won this race in the mocked result');
    assert.ok(settled.every(p => p.payout === 8.4));
  } finally {
    server.close();
  }
});
