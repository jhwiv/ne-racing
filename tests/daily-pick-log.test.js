'use strict';

// Regression coverage for scripts/daily_pick_log.js -- the script that logs
// the day's picks to the server-side ENGINE_ACCURACY system on a schedule,
// independent of whether any user opens the app, plus two "peer review"
// alternatives (baseline_ml market favorite, crowd NYRA-consensus pick) for
// the Best Bet slot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const {
  transformEntriesToRaces, attachExpertPicks, computeCrowdPick, computeMlFavorite, buildLogPayloads,
} = require('../scripts/daily_pick_log');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'daily_pick_log.js');

test('transformEntriesToRaces maps /api/entries shape into scoreCard-ready races', () => {
  const entriesBody = {
    races: [{
      raceNumber: 1,
      raceTypeCode: 'MSW',
      entries: [
        { pp: 1, horseName: 'Alpha', ml: '5-2', jockey: 'J1', trainer: 'T1', speedFigs: [80, 82, 84], runningStyle: 'E', jockeyPct: 20, trainerPct: 18, lastClass: 'MSW', status: 'RUNNER' },
        { pp: 2, horseName: 'Bravo', ml: '9-2', jockey: 'J2', trainer: 'T2', status: 'SCRATCHED' },
      ],
    }],
  };
  const races = transformEntriesToRaces(entriesBody, 'SAR', '2026-07-13');
  assert.equal(races.length, 1);
  assert.equal(races[0].id, 'SAR-20260713-R1');
  assert.equal(races[0].num, 1);
  assert.equal(races[0].horses.length, 2);
  assert.equal(races[0].horses[0].name, 'Alpha');
  assert.deepEqual(races[0].horses[0].speedFigs, [80, 82, 84]);
  assert.equal(races[0].horses[1].scratched, true, 'SCRATCHED status must map to scratched: true');
  assert.equal(races[0].horses[0].scratched, false);
});

test('attachExpertPicks merges by race number', () => {
  const races = [{ num: 1, expertPicks: [] }, { num: 2, expertPicks: [] }];
  attachExpertPicks(races, { expertPicks: [{ race: 2, picks: [{ source: 'X', pick: 3, horseName: null }] }] });
  assert.deepEqual(races[0].expertPicks, []);
  assert.equal(races[1].expertPicks.length, 1);
  assert.equal(races[1].expertPicks[0].pick, 3);
});

test('computeCrowdPick requires at least 2 independent sources to agree', () => {
  const race = {
    horses: [{ pp: 1, name: 'Alpha' }, { pp: 2, name: 'Bravo' }],
    expertPicks: [{ source: 'A', pick: 1 }],
  };
  assert.equal(computeCrowdPick(race), null, 'a single source picking a horse must not count as consensus');

  race.expertPicks.push({ source: 'B', pick: 1 });
  const crowd = computeCrowdPick(race);
  assert.ok(crowd);
  assert.equal(crowd.horse.pp, 1);
  assert.equal(crowd.matchCount, 2);
});

test('computeMlFavorite picks the lowest odds and skips scratched horses', () => {
  const race = {
    horses: [
      { pp: 1, ml: '9-2', scratched: false },
      { pp: 2, ml: '3-1', scratched: false },
      { pp: 3, ml: '1-5', scratched: true }, // best odds but scratched -- must be skipped
    ],
  };
  const fav = computeMlFavorite(race);
  assert.equal(fav.horse.pp, 2);
});

test('buildLogPayloads logs v2 for every slot, and baseline_ml/crowd for Best Bet when they differ from it', () => {
  function race(num, size) {
    return { id: `SAR-20260713-R${num}`, track: 'SAR', date: '2026-07-13', num, horses: new Array(size).fill(0).map((_, i) => ({ pp: i + 1 })), expertPicks: [] };
  }
  const r1 = race(1, 5);
  r1.horses = [
    { pp: 1, name: 'Alpha', ml: '9-2', speedFigs: [90, 90, 90], runningStyle: 'E', jockeyPct: 20, trainerPct: 18, lastClass: 'ALW' },
    { pp: 2, name: 'Bravo', ml: '3-1', speedFigs: [60, 60, 60], runningStyle: 'P', jockeyPct: 10, trainerPct: 10, lastClass: 'ALW' }, // ML favorite, NOT the engine's pick
    { pp: 3, name: 'Charlie', ml: '8-1', speedFigs: [55, 55, 55], runningStyle: 'S', jockeyPct: 8, trainerPct: 8, lastClass: 'ALW' },
    { pp: 4, name: 'Delta', ml: '10-1', speedFigs: [50, 50, 50], runningStyle: 'S', jockeyPct: 5, trainerPct: 5, lastClass: 'ALW' },
    { pp: 5, name: 'Echo', ml: '12-1', speedFigs: [45, 45, 45], runningStyle: 'S', jockeyPct: 5, trainerPct: 5, lastClass: 'ALW' },
  ];
  // 2 handicappers agree on Bravo (pp 2) -- a real crowd consensus, different from the engine's Alpha pick.
  r1.expertPicks = [{ source: 'Handicapper A', pick: 2 }, { source: 'Handicapper B', pick: 2 }];

  const payloads = buildLogPayloads([r1], 'SAR', '2026-07-13');
  const byEngine = {};
  payloads.forEach(p => { (byEngine[p.engine] = byEngine[p.engine] || []).push(p); });

  assert.ok(byEngine.v2 && byEngine.v2.length >= 1, 'the engine\'s own pick(s) must always be logged');
  assert.ok(byEngine.baseline_ml, 'the market favorite must be logged');
  assert.equal(byEngine.baseline_ml[0].pp, 2, 'baseline_ml must be the actual ML favorite (Bravo, pp 2)');
  assert.ok(byEngine.crowd, 'the crowd consensus must be logged since 2 handicappers agree');
  assert.equal(byEngine.crowd[0].pp, 2);
});

test('buildLogPayloads v2.49.40: DOES log baseline_ml/crowd even when they agree with the engine\'s pick (control group needs full coverage, not just disagreement cases)', () => {
  const r1 = {
    id: 'SAR-20260713-R1', track: 'SAR', date: '2026-07-13', num: 1,
    horses: [
      { pp: 1, name: 'Alpha', ml: '9-4', speedFigs: [95, 95, 95], runningStyle: 'E', jockeyPct: 25, trainerPct: 20, lastClass: 'ALW' },
      { pp: 2, name: 'Bravo', ml: '6-1', speedFigs: [60, 60, 60], runningStyle: 'P', jockeyPct: 10, trainerPct: 10, lastClass: 'ALW' },
      { pp: 3, name: 'Charlie', ml: '8-1', speedFigs: [55, 55, 55], runningStyle: 'S', jockeyPct: 8, trainerPct: 8, lastClass: 'ALW' },
      { pp: 4, name: 'Delta', ml: '10-1', speedFigs: [50, 50, 50], runningStyle: 'S', jockeyPct: 5, trainerPct: 5, lastClass: 'ALW' },
    ],
    // Alpha is both the shortest price AND the (2-source) crowd consensus --
    // i.e. every source agrees with the engine's own pick this race.
    expertPicks: [{ source: 'A', pick: 1 }, { source: 'B', pick: 1 }],
  };
  const payloads = buildLogPayloads([r1], 'SAR', '2026-07-13');
  const baselineMl = payloads.filter(p => p.engine === 'baseline_ml');
  const crowd = payloads.filter(p => p.engine === 'crowd');
  assert.equal(baselineMl.length, 1, 'baseline_ml must still be logged even though it agrees with the engine -- a control group needs every race, not just the disagreements');
  assert.equal(baselineMl[0].pp, 1);
  assert.equal(crowd.length, 1, 'crowd must still be logged even though it agrees with the engine, for the same reason');
  assert.equal(crowd[0].pp, 1);
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(handler(req.url)));
          }
          return;
        }
      }
      res.writeHead(404); res.end('not found');
    });
    server.listen(0, () => resolve(server));
  });
}

test('daily_pick_log.js runs end-to-end: fetches entries + expert-picks, posts picks', async () => {
  const loggedPicks = [];
  const server = await startMockWorker([
    ['/api/entries', () => ({
      races: [{
        raceNumber: 1,
        entries: [
          { pp: 1, horseName: 'Alpha', ml: '9-2', speedFigs: [90, 90, 90], runningStyle: 'E', jockeyPct: 20, trainerPct: 18, lastClass: 'ALW', status: 'RUNNER' },
          { pp: 2, horseName: 'Bravo', ml: '3-1', speedFigs: [60, 60, 60], runningStyle: 'P', jockeyPct: 10, trainerPct: 10, lastClass: 'ALW', status: 'RUNNER' },
          { pp: 3, horseName: 'Charlie', ml: '8-1', speedFigs: [55, 55, 55], runningStyle: 'S', jockeyPct: 8, trainerPct: 8, lastClass: 'ALW', status: 'RUNNER' },
          { pp: 4, horseName: 'Delta', ml: '10-1', speedFigs: [50, 50, 50], runningStyle: 'S', jockeyPct: 5, trainerPct: 5, lastClass: 'ALW', status: 'RUNNER' },
        ],
      }],
    })],
    ['/api/expert-picks', () => ({ expertPicks: [{ race: 1, picks: [{ source: 'A', pick: 2 }, { source: 'B', pick: 2 }] }] })],
    ['/api/picks/log', (url, body) => { loggedPicks.push(body); return { ok: true, key: 'x' }; }],
  ]);
  const port = server.address().port;

  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--date', '2026-07-13', '--worker-url', `http://localhost:${port}`], {
      timeout: 10000,
    });
    assert.match(stdout, /logged successfully/);
    assert.ok(loggedPicks.length >= 1);
    assert.ok(loggedPicks.some(p => p.engine === 'v2' && p.betTag === 'best'));
    assert.ok(loggedPicks.some(p => p.engine === 'baseline_ml'), 'the market favorite (Bravo) differs from the engine pick (Alpha) and must be logged');
    assert.ok(loggedPicks.every(p => p.track === 'SAR' && p.date === '2026-07-13'));
  } finally {
    server.close();
  }
});

test('daily_pick_log.js exits cleanly when there are no races for the date', async () => {
  const server = await startMockWorker([
    ['/api/entries', () => ({ races: [] })],
  ]);
  const port = server.address().port;
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--date', '2026-07-13', '--worker-url', `http://localhost:${port}`], {
      timeout: 10000,
    });
    assert.match(stdout, /nothing to log/);
  } finally {
    server.close();
  }
});

test('daily_pick_log.js exits cleanly (not exit code 1) when /api/entries 404s -- a dark day with no meet scheduled', async () => {
  // No handlers registered -- startMockWorker's catch-all returns 404 for
  // any URL, exactly like the real worker's handleEntries does for
  // "No NA meet for {track} on {date}" (e.g. Saratoga dark days).
  const server = await startMockWorker([]);
  const port = server.address().port;
  try {
    const { stdout } = await execFileAsync('node', [SCRIPT, '--track', 'SAR', '--date', '2026-07-14', '--worker-url', `http://localhost:${port}`], {
      timeout: 10000,
    });
    assert.match(stdout, /No meet scheduled/);
  } finally {
    server.close();
  }
});
