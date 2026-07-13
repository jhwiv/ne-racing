'use strict';

// End-to-end regression coverage for scripts/daily_pick_settle.js -- re-
// derives the day's picks deterministically (same entries + expert-picks +
// selection logic as daily_pick_log.js), fetches the real archived result
// (RACE_HISTORY via /api/history/{TRACK}/{DATE}), grades each pick with
// scripts/lib/pick_settlement.js, and posts the verdict.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'daily_pick_settle.js');

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
            if (result === 404) { res.writeHead(404); res.end('not found'); return; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }
          return;
        }
      }
      res.writeHead(404); res.end('not found');
    });
    server.listen(0, () => resolve(server));
  });
}

// Same 4-horse Race 1 fixture as daily-pick-log.test.js's end-to-end test:
// engine picks Alpha (pp 1), market favorite is Bravo (pp 2, 3-1 vs 9-2),
// and 2 handicappers also agree on Bravo -- so v2/baseline_ml/crowd all get
// logged, with baseline_ml and crowd differing from the engine's pick.
function entriesFixture() {
  return {
    races: [{
      raceNumber: 1,
      entries: [
        { pp: 1, horseName: 'Alpha', ml: '9-2', speedFigs: [90, 90, 90], runningStyle: 'E', jockeyPct: 20, trainerPct: 18, lastClass: 'ALW', status: 'RUNNER' },
        { pp: 2, horseName: 'Bravo', ml: '3-1', speedFigs: [60, 60, 60], runningStyle: 'P', jockeyPct: 10, trainerPct: 10, lastClass: 'ALW', status: 'RUNNER' },
        { pp: 3, horseName: 'Charlie', ml: '8-1', speedFigs: [55, 55, 55], runningStyle: 'S', jockeyPct: 8, trainerPct: 8, lastClass: 'ALW', status: 'RUNNER' },
        { pp: 4, horseName: 'Delta', ml: '10-1', speedFigs: [50, 50, 50], runningStyle: 'S', jockeyPct: 5, trainerPct: 5, lastClass: 'ALW', status: 'RUNNER' },
      ],
    }],
  };
}

test('daily_pick_settle.js settles v2 as a loss and baseline_ml/crowd (Bravo) as a win, real finish: Bravo 1st, Alpha 2nd', async () => {
  const settled = [];
  const server = await startMockWorker([
    ['/api/entries', () => entriesFixture()],
    ['/api/expert-picks', () => ({ expertPicks: [{ race: 1, picks: [{ source: 'A', pick: 2 }, { source: 'B', pick: 2 }] }] })],
    ['/api/history/SAR/2026-07-12', () => ({
      track: 'SAR', date: '2026-07-12',
      races: [{
        raceNumber: 1,
        finishOrder: [
          { pp: 2, position: 1, horseName: 'Bravo', winPayoff: 8.4 },
          { pp: 1, position: 2, horseName: 'Alpha' },
        ],
        payouts: {},
      }],
    })],
    ['/api/picks/settle', (url, body) => { settled.push(body); return { ok: true }; },
    ],
  ]);
  const port = server.address().port;

  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--date', '2026-07-12', '--worker-url', `http://localhost:${port}`], {
      timeout: 10000,
    });
    assert.match(stdout, /settled/);

    // The settle payload (unlike the log payload) has no betTag -- there's
    // exactly one pick per engine in this fixture, so engine alone is a
    // unique key here.
    const byEngine = Object.fromEntries(settled.filter(s => s.race === 1).map(s => [s.engine, s]));
    assert.ok(byEngine.v2, 'the engine\'s Best Bet pick (Alpha) must be settled');
    assert.equal(byEngine.v2.won, false, 'Alpha finished 2nd, not 1st -- a Win-type pick loses');
    assert.equal(byEngine.v2.position, 2);

    assert.ok(byEngine.baseline_ml, 'the market favorite (Bravo) must be settled');
    assert.equal(byEngine.baseline_ml.won, true, 'Bravo actually won -- the market favorite was right this time');
    assert.equal(byEngine.baseline_ml.payout, 8.4);

    assert.ok(byEngine.crowd, 'the crowd consensus (also Bravo) must be settled');
    assert.equal(byEngine.crowd.won, true);
  } finally {
    server.close();
  }
});

test('daily_pick_settle.js skips cleanly (no error) when the date has no archived results yet', async () => {
  const server = await startMockWorker([
    ['/api/entries', () => entriesFixture()],
    ['/api/expert-picks', () => ({ expertPicks: [] })],
    ['/api/history/SAR/2026-07-13', () => 404],
  ]);
  const port = server.address().port;
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--date', '2026-07-13', '--worker-url', `http://localhost:${port}`], {
      timeout: 10000,
    });
    assert.match(stdout, /nothing to settle/);
  } finally {
    server.close();
  }
});
