#!/usr/bin/env node
/**
 * scripts/qa/backtest.mjs
 *
 * Back-test all recommended bets from a given track-day against settled results.
 *
 * Loads the live app's exact scoring + Jim's Way logic by booting index.html
 * in a headless browser, then settles every recommendation (top pick to WIN,
 * suggested Exacta / Exacta Box / Trifecta, and Jim's Way PLACE/WIN fallback)
 * against /api/results.
 *
 * Usage:
 *   node scripts/qa/backtest.mjs                     # SAR today
 *   node scripts/qa/backtest.mjs --track SAR --date 2026-06-03
 *   node scripts/qa/backtest.mjs --track BEL --date 2026-06-04 --json out.json
 *
 * Requirements:
 *   - scripts/qa/node_modules/playwright must be installed
 *   - Run from the repo root (so it can serve index.html on a local port)
 *
 * Exit codes:
 *   0  back-test ran (regardless of hit rate)
 *   1  could not fetch data or load scorer
 */
import { chromium, devices } from './node_modules/playwright/index.mjs';
import { spawn } from 'child_process';
import { existsSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

// ── CLI args ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { track: 'SAR', date: null, json: null, port: 8769, worker: null, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--track')   out.track   = argv[++i];
    else if (a === '--date')    out.date    = argv[++i];
    else if (a === '--json')    out.json    = argv[++i];
    else if (a === '--port')    out.port    = parseInt(argv[++i], 10);
    else if (a === '--worker')  out.worker  = argv[++i];
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!out.date) {
    // Default to today in America/New_York (race-day timezone)
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
    out.date = fmt.format(new Date());
  }
  if (!out.worker) out.worker = 'https://cloudflare-worker.jhwiv-online.workers.dev';
  return out;
}

function printHelp() {
  console.log(`Usage: node scripts/qa/backtest.mjs [options]

Options:
  --track CODE      Equibase track code (default: SAR)
  --date YYYY-MM-DD Race date (default: today in America/New_York)
  --worker URL      Worker base URL (default: prod worker)
  --json PATH       Write full report JSON to this path
  --port N          Local server port for app load (default: 8769)
  --verbose, -v     Print full report JSON to stdout
  --help, -h        Show this help`);
}

// ── Fetch helpers ───────────────────────────────────────────────────────────
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
  return res.json();
}

// ── Main ────────────────────────────────────────────────────────────────────
const args = parseArgs(process.argv);
const { track, date, worker, port, verbose } = args;

console.log(`\n┌─ Railbird back-test ───────────────────────────────────`);
console.log(`│  Track: ${track}    Date: ${date}`);
console.log(`│  Worker: ${worker}`);
console.log(`└────────────────────────────────────────────────────────\n`);

let entries, results;
try {
  console.log('Fetching entries…');
  entries = await fetchJson(`${worker}/api/entries?track=${track}&date=${date}`);
  console.log(`  ${entries.races?.length || 0} races, ` +
              (entries.races || []).reduce((n, r) => n + (r.entries?.length || 0), 0) +
              ' entries, source=' + entries.source);
  console.log('Fetching results…');
  results = await fetchJson(`${worker}/api/results?track=${track}&date=${date}`);
  console.log(`  ${results.races?.length || 0} settled races, source=` + results.source);
} catch (e) {
  console.error('Fetch failed:', e.message);
  process.exit(1);
}

if (!entries.races?.length) {
  console.error('No entries for', track, date, '— nothing to back-test.');
  process.exit(1);
}

// Boot local server so we can load the live app's scoring code
const indexPath = resolve(REPO_ROOT, 'index.html');
if (!existsSync(indexPath)) {
  console.error('index.html not found at', indexPath);
  process.exit(1);
}
const srv = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'],
  { cwd: REPO_ROOT, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 800));

let report;
try {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], timezoneId: 'America/New_York' });
  const page = await ctx.newPage();
  await page.addInitScript(() => { localStorage.setItem('railbird-beta-unlocked-v1', '1'); });
  await page.goto(`http://127.0.0.1:${port}/?t=` + Date.now(), { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(1500);

  // Confirm scorer is loaded
  const hasScorer = await page.evaluate(() => typeof RailbirdScoring !== 'undefined' && typeof RailbirdScoring.scoreRace === 'function');
  if (!hasScorer) throw new Error('RailbirdScoring not exposed by app — did the bundle change?');

  report = await page.evaluate(({ entries, results, track, date }) => {
    // ── Normalize: /api/entries → race+horses shape the scorer expects
    function toRaceShape(r) {
      const horses = (r.entries || []).map(e => ({
        pp: e.programNumber || e.pp,
        name: e.horseName || e.name,
        ml: e.morningLine || e.ml,
        jockey: e.jockey,
        trainer: e.trainer,
        weight: e.weight,
        age: e.age,
        sex: e.sex,
        scratched: e.scratched || false,
        ...e,
      }));
      return {
        num: r.raceNumber,
        id: r.raceId || ('R' + r.raceNumber),
        raceName: r.raceName,
        purse: r.purse,
        distance: r.distance,
        surface: r.surface,
        raceType: r.raceType || r.type,
        postTime: r.postTime,
        horses,
      };
    }

    // Mirror the Jim's Way logic exactly (v2.39.2 → v2.39.4)
    function buildJimsWay(scored) {
      if (!scored?.length) return null;
      const top = scored[0];
      let pick = top;
      for (let i = 1; i < Math.min(scored.length, 4); i++) {
        const s = scored[i];
        if ((s.overlay || 0) > 0.05 && (top.score - s.score) <= 6) { pick = s; break; }
      }
      const mode = (scored.length <= 5 || top.score < 50) ? 'place' : 'win';
      return { horse: pick.horse, mode, amount: 2 };
    }

    const races = (entries.races || []).map(toRaceShape);
    const opts = { version: 'v2', today: date };

    // Index results by race number for quick lookup
    const resByNum = {};
    (results.races || []).forEach(r => { resByNum[r.raceNumber] = r; });

    const races_out = [];
    const counts = {
      topWin:  { hit: 0, n: 0, profitOnUnit: 0 },
      exacta:  { hit: 0, n: 0 },
      exBox:   { hit: 0, n: 0 },
      tri:     { hit: 0, n: 0 },
      jimWin:  { hit: 0, n: 0, profitOnUnit: 0 },
      jimPlace:{ hit: 0, n: 0, profitOnUnit: 0 },
    };

    for (const race of races) {
      const result = resByNum[race.num];
      const finishOrder = result?.finishOrder || [];
      const winner = finishOrder[0] || null;
      const second = finishOrder[1] || null;
      const third  = finishOrder[2] || null;
      const winPP   = winner ? String(winner.programNumber) : null;
      const secPP   = second ? String(second.programNumber) : null;
      const thirdPP = third  ? String(third.programNumber)  : null;
      const placePPs = [winPP, secPP].filter(Boolean);
      const showPPs  = [winPP, secPP, thirdPP].filter(Boolean);
      const payouts = result?.payouts || {};

      let scored;
      try { scored = RailbirdScoring.scoreRace(race, opts); }
      catch (e) { scored = []; }

      if (!scored.length) {
        races_out.push({ num: race.num, name: race.raceName, settled: !!result, error: 'no scored entries' });
        continue;
      }

      const top = scored[0];
      const confidence = RailbirdScoring.confidenceFor(scored);
      const isAutoPass = confidence === 'low' && top.score < 60;

      const recs = [];
      if (!isAutoPass) {
        recs.push({ type: 'TOP_WIN', pp: String(top.horse.pp), name: top.horse.name, score: Math.round(top.score), ml: top.horse.ml, confidence });
        if (scored.length >= 2) {
          const valueHorses = scored.filter(s => (s.overlay || 0) > 0.08);
          const ex = valueHorses.length >= 2 ? valueHorses.slice(0,2) : scored.slice(0,2);
          recs.push({ type: 'EXACTA',     pps: [String(ex[0].horse.pp), String(ex[1].horse.pp)] });
          recs.push({ type: 'EXACTA_BOX', pps: [String(ex[0].horse.pp), String(ex[1].horse.pp)] });
          if (scored.length >= 3) {
            const tri = valueHorses.length >= 3 ? valueHorses.slice(0,3) : scored.slice(0,3);
            recs.push({ type: 'TRIFECTA', pps: tri.map(s => String(s.horse.pp)) });
          }
        }
      } else {
        const fb = buildJimsWay(scored);
        if (fb) recs.push({
          type: 'JIMS_WAY_' + fb.mode.toUpperCase(),
          pp: String(fb.horse.pp), name: fb.horse.name, ml: fb.horse.ml, amount: fb.amount,
        });
      }

      // Settle
      const settledRecs = recs.map(rec => {
        const out = { ...rec };
        if (!result || !finishOrder.length) { out.settled = false; out.note = 'race not yet final'; return out; }
        out.settled = true;
        if (rec.type === 'TOP_WIN' || rec.type === 'JIMS_WAY_WIN') {
          out.hit = rec.pp === winPP;
          out.payout = out.hit && payouts.win?.[rec.pp] != null ? payouts.win[rec.pp] : (out.hit ? null : 0);
        } else if (rec.type === 'JIMS_WAY_PLACE') {
          out.hit = placePPs.includes(rec.pp);
          out.payout = out.hit && payouts.place?.[rec.pp] != null ? payouts.place[rec.pp] : (out.hit ? null : 0);
        } else if (rec.type === 'EXACTA') {
          out.hit = rec.pps[0] === winPP && rec.pps[1] === secPP;
        } else if (rec.type === 'EXACTA_BOX') {
          const s = new Set(rec.pps);
          out.hit = s.has(winPP) && s.has(secPP);
        } else if (rec.type === 'TRIFECTA') {
          out.hit = rec.pps[0] === winPP && rec.pps[1] === secPP && rec.pps[2] === thirdPP;
        }
        return out;
      });

      // Aggregate
      for (const r of settledRecs) {
        if (!r.settled) continue;
        if (r.type === 'TOP_WIN')        { counts.topWin.n++;   if (r.hit) { counts.topWin.hit++;   if (r.payout) counts.topWin.profitOnUnit += (r.payout - 2); } else { counts.topWin.profitOnUnit -= 2; } }
        if (r.type === 'EXACTA')         { counts.exacta.n++;   if (r.hit) counts.exacta.hit++; }
        if (r.type === 'EXACTA_BOX')     { counts.exBox.n++;    if (r.hit) counts.exBox.hit++; }
        if (r.type === 'TRIFECTA')       { counts.tri.n++;      if (r.hit) counts.tri.hit++; }
        if (r.type === 'JIMS_WAY_WIN')   { counts.jimWin.n++;   if (r.hit) { counts.jimWin.hit++;   if (r.payout) counts.jimWin.profitOnUnit += (r.payout - 2); } else { counts.jimWin.profitOnUnit -= 2; } }
        if (r.type === 'JIMS_WAY_PLACE') { counts.jimPlace.n++; if (r.hit) { counts.jimPlace.hit++; if (r.payout) counts.jimPlace.profitOnUnit += (r.payout - 2); } else { counts.jimPlace.profitOnUnit -= 2; } }
      }

      races_out.push({
        num: race.num,
        name: race.raceName,
        autoPassed: isAutoPass,
        topScore: Math.round(top.score),
        confidence,
        recs: settledRecs,
        winner: winner ? `#${winPP} ${winner.horseName}` : null,
        finished: !!result && finishOrder.length > 0,
      });
    }

    return {
      track,
      date,
      generatedAt: new Date().toISOString(),
      entriesSource: entries.source,
      resultsSource: results.source,
      races: races_out,
      summary: counts,
    };
  }, { entries, results, track, date });

  await browser.close();
} catch (e) {
  console.error('Back-test failed inside browser:', e.message);
  srv.kill();
  process.exit(1);
} finally {
  srv.kill();
}

// ── Pretty print ────────────────────────────────────────────────────────────
function fmtPct(hit, n) {
  if (!n) return ' — ';
  return ((hit / n) * 100).toFixed(0) + '%';
}
function fmtPL(p) {
  if (p == null) return '   —  ';
  const sign = p >= 0 ? '+' : '';
  return `${sign}$${p.toFixed(2)}`;
}

const finished = report.races.filter(r => r.finished).length;
const passed   = report.races.filter(r => r.autoPassed).length;

console.log('\nPer-race results');
console.log('────────────────────────────────────────────────────────────────────');
console.log('  R  Auto-PASS  Score  Conf    Rec                Pick     Winner      Result');
console.log('  ─  ─────────  ─────  ──────  ─────────────────  ───────  ──────────  ────────');
for (const race of report.races) {
  if (!race.finished) {
    console.log(`  ${String(race.num).padStart(2)}  ${'pending'.padEnd(9)}  ${String(race.topScore ?? '—').padStart(5)}  ${(race.confidence||'—').padEnd(6)}  ${'(not yet final)'}`);
    continue;
  }
  for (const rec of race.recs || []) {
    const pick = rec.pp ? `#${rec.pp}` : (rec.pps ? rec.pps.map(p=>'#'+p).join('/') : '—');
    const result = !rec.settled ? 'pending' : (rec.hit ? 'HIT' : 'miss');
    const win = (race.winner || '').slice(0, 10);
    console.log(`  ${String(race.num).padStart(2)}  ${String(race.autoPassed).padEnd(9)}  ${String(race.topScore).padStart(5)}  ${race.confidence.padEnd(6)}  ${rec.type.padEnd(17)}  ${pick.padEnd(7)}  ${win.padEnd(10)}  ${result}`);
  }
}

const s = report.summary;
console.log('\nSummary');
console.log('────────────────────────────────────────────────────────────────────');
console.log(`  Races finished:      ${finished} / ${report.races.length}`);
console.log(`  Auto-PASSed:         ${passed} / ${report.races.length}`);
console.log('');
console.log(`  ${'Pool'.padEnd(20)} ${'Hits'.padStart(7)} ${'Tries'.padStart(7)} ${'Rate'.padStart(6)} ${'P/L @ $2 unit'.padStart(15)}`);
console.log(`  ${'─'.repeat(20)} ${'─'.repeat(7)} ${'─'.repeat(7)} ${'─'.repeat(6)} ${'─'.repeat(15)}`);
console.log(`  ${'Top pick to WIN'.padEnd(20)} ${String(s.topWin.hit).padStart(7)} ${String(s.topWin.n).padStart(7)} ${fmtPct(s.topWin.hit, s.topWin.n).padStart(6)} ${fmtPL(s.topWin.profitOnUnit).padStart(15)}`);
console.log(`  ${'Suggested Exacta'.padEnd(20)} ${String(s.exacta.hit).padStart(7)} ${String(s.exacta.n).padStart(7)} ${fmtPct(s.exacta.hit, s.exacta.n).padStart(6)} ${'(no $)'.padStart(15)}`);
console.log(`  ${'Exacta Box'.padEnd(20)} ${String(s.exBox.hit).padStart(7)} ${String(s.exBox.n).padStart(7)} ${fmtPct(s.exBox.hit, s.exBox.n).padStart(6)} ${'(no $)'.padStart(15)}`);
console.log(`  ${'Trifecta'.padEnd(20)} ${String(s.tri.hit).padStart(7)} ${String(s.tri.n).padStart(7)} ${fmtPct(s.tri.hit, s.tri.n).padStart(6)} ${'(no $)'.padStart(15)}`);
console.log(`  ${"Jim's Way WIN".padEnd(20)} ${String(s.jimWin.hit).padStart(7)} ${String(s.jimWin.n).padStart(7)} ${fmtPct(s.jimWin.hit, s.jimWin.n).padStart(6)} ${fmtPL(s.jimWin.profitOnUnit).padStart(15)}`);
console.log(`  ${"Jim's Way PLACE".padEnd(20)} ${String(s.jimPlace.hit).padStart(7)} ${String(s.jimPlace.n).padStart(7)} ${fmtPct(s.jimPlace.hit, s.jimPlace.n).padStart(6)} ${fmtPL(s.jimPlace.profitOnUnit).padStart(15)}`);
console.log('');

if (args.json) {
  writeFileSync(args.json, JSON.stringify(report, null, 2));
  console.log(`Full report written to ${args.json}`);
}
if (verbose) {
  console.log('\nFull report:');
  console.log(JSON.stringify(report, null, 2));
}
