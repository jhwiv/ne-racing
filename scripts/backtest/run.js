#!/usr/bin/env node
'use strict';

/**
 * run.js — main backtest entry point.
 *
 * Usage:
 *   node scripts/backtest/run.js [--versions v1,v2] [--include-fixtures]
 *                                [--require-results] [--out report.json]
 *                                [--track AQU] [--from 2026-04-01] [--to 2026-05-31]
 *
 * Compares one or more engine versions on every race in the corpus and writes
 * a JSON report with aggregate + per-version metrics, calibration curves, and
 * a coverage summary so it's obvious what we can and can't measure today.
 *
 * It will run on whatever data is on disk. If no result-bearing data is
 * present, it still scores all races and reports prediction stats — it just
 * cannot compute outcome-dependent metrics (log-loss, ROI, etc.) and will
 * say so prominently in the report.
 */

const fs = require('fs');
const path = require('path');
const { loadCorpus } = require('./load_corpus');
const M = require('./metrics');
const S = require('../lib/scoring');

function parseArgs(argv) {
  const out = {
    versions: ['v1', 'v2'],
    includeFixtures: false,
    requireResults: false,
    out: null,
    track: null,
    from: null,
    to: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--versions')           { out.versions = v.split(','); i++; }
    else if (k === '--include-fixtures') { out.includeFixtures = true; }
    else if (k === '--require-results')  { out.requireResults = true; }
    else if (k === '--out')           { out.out = v; i++; }
    else if (k === '--track')         { out.track = v; i++; }
    else if (k === '--from')          { out.from = v; i++; }
    else if (k === '--to')            { out.to = v; i++; }
  }
  return out;
}

function inRange(race, args) {
  if (args.track && race.track !== args.track) return false;
  if (args.from && race.date < args.from) return false;
  if (args.to   && race.date > args.to)   return false;
  return true;
}

function winnerOf(race) {
  if (!race.results || !Array.isArray(race.results.finish_positions)) return null;
  const w = race.results.finish_positions.find(x => x.position === 1);
  return w ? w.pp : null;
}

function evaluateVersion(version, races) {
  const perRace = [];
  const allPredictions = []; // for calibration; each row {prob, y}
  let scoredCount = 0;

  for (const race of races) {
    const scored = S.scoreRace(race, { version, today: race.date });
    if (!scored.length) continue;
    scoredCount++;

    const winnerPp = winnerOf(race);
    const measurable = winnerPp != null;

    const row = {
      race_id: race.id, track: race.track, date: race.date, num: race.num,
      version, field: scored.length, measurable,
      top_pick_pp: scored[0].horse.pp,
      top_pick_prob: scored[0].modelProb,
      top_pick_ml: scored[0].horse.ml,
    };

    if (measurable) {
      row.winner_pp = winnerPp;
      row.log_loss = M.logLossRace(scored, winnerPp);
      row.brier    = M.brierRace(scored, winnerPp);
      row.top1     = M.top1Hit(scored, winnerPp);
      row.top3     = M.topKHit(scored, winnerPp, 3);
      row.top4     = M.topKHit(scored, winnerPp, 4);
      row.flat_top_pick_roi = M.flatTopPickROI(scored, race);
      const overlay = M.flatOverlayROI(scored, race);
      row.overlay_bets = overlay;

      for (const s of scored) {
        allPredictions.push({
          prob: s.modelProb || 0,
          y: (s.horse.pp === winnerPp) ? 1 : 0,
        });
      }
    }

    perRace.push(row);
  }

  const measurableRows = perRace.filter(r => r.measurable);
  const summary = {
    version,
    races_scored: scoredCount,
    races_measurable: measurableRows.length,
    log_loss_mean: M.mean(measurableRows.map(r => r.log_loss)),
    brier_mean:    M.mean(measurableRows.map(r => r.brier)),
    top1_rate:     M.mean(measurableRows.map(r => r.top1)),
    top3_rate:     M.mean(measurableRows.map(r => r.top3)),
    top4_rate:     M.mean(measurableRows.map(r => r.top4)),
    flat_top_pick_net: M.sum(measurableRows.map(r => r.flat_top_pick_roi)),
    flat_top_pick_roi_pct: (() => {
      const n = measurableRows.filter(r => r.flat_top_pick_roi != null).length;
      if (!n) return null;
      return 100 * M.sum(measurableRows.map(r => r.flat_top_pick_roi)) / (2 * n);
    })(),
    overlay_bets_placed: M.sum(measurableRows.map(r => r.overlay_bets ? r.overlay_bets.bets : 0)),
    overlay_net:         M.sum(measurableRows.map(r => r.overlay_bets ? r.overlay_bets.net  : 0)),
  };

  const calibration = M.calibrationBuckets(allPredictions);

  return { summary, calibration, per_race: perRace };
}

function evaluateBaseline(races) {
  // Morning-line baseline: treat impliedProb (after normalization) as the model.
  const predictions = [];
  let measurable = 0;
  let logLoss = 0, brier = 0, top1 = 0, n = 0;
  for (const race of races) {
    const winnerPp = winnerOf(race);
    if (winnerPp == null) continue;
    // Build implied probs from ML for non-scratched horses; normalize so they sum to 1.
    const live = (race.horses || []).filter(h => !h.scratched);
    const implied = live.map(h => {
      const o = S.parseOddsToNum(h.ml);
      return o > 0 ? 1 / (o + 1) : 0;
    });
    const sum = implied.reduce((a, b) => a + b, 0) || 1;
    const probs = implied.map(p => p / sum);

    // Log-loss + Brier on winner
    const idx = live.findIndex(h => h.pp === winnerPp);
    if (idx < 0) continue;
    measurable++;
    const p = Math.max(1e-6, Math.min(1 - 1e-6, probs[idx]));
    logLoss += -Math.log(p);
    for (let i = 0; i < probs.length; i++) {
      const y = (live[i].pp === winnerPp) ? 1 : 0;
      brier += (probs[i] - y) * (probs[i] - y);
      predictions.push({ prob: probs[i], y });
    }
    // Top-1 = ML favorite
    const favIdx = probs.indexOf(Math.max(...probs));
    if (live[favIdx].pp === winnerPp) top1++;
    n++;
  }
  return {
    version: 'baseline_ml',
    summary: {
      version: 'baseline_ml',
      races_measurable: measurable,
      log_loss_mean: n ? logLoss / n : null,
      brier_mean:    n ? brier   / n : null,
      top1_rate:     n ? top1    / n : null,
    },
    calibration: M.calibrationBuckets(predictions),
  };
}

function formatTable(rows, cols) {
  const widths = cols.map(c => Math.max(c.header.length,
    ...rows.map(r => String(r[c.key] == null ? '—' : c.fmt ? c.fmt(r[c.key]) : r[c.key]).length)));
  const sep = '  ';
  const header = cols.map((c, i) => c.header.padEnd(widths[i])).join(sep);
  const line   = cols.map((_, i) => '─'.repeat(widths[i])).join(sep);
  const body = rows.map(r => cols.map((c, i) => {
    const v = r[c.key];
    const txt = (v == null) ? '—' : (c.fmt ? c.fmt(v) : String(v));
    return txt.padEnd(widths[i]);
  }).join(sep));
  return [header, line, ...body].join('\n');
}

function printReport(report) {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log('  Railbird Backtest Report');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`  Generated: ${report.generated_at}`);
  console.log(`  Filters: ${JSON.stringify(report.filters)}`);
  console.log('');
  console.log('  Corpus');
  console.log('  ──────');
  const s = report.corpus;
  console.log(`  Total races loaded     : ${s.total_loaded}`);
  console.log(`  With results           : ${s.with_results}`);
  console.log(`  Without results        : ${s.without_results}`);
  console.log(`  Duplicates de-duped    : ${s.duplicates_dropped}`);
  console.log(`  Sources: normalized=${s.from_normalized}, entries=${s.from_entries}, fixtures=${s.from_fixtures}`);

  if (s.with_results === 0) {
    console.log('');
    console.log('  ⚠ No result-bearing races found. Outcome-dependent metrics are');
    console.log('    unavailable. The engine still produced predictions, but we cannot');
    console.log('    measure log-loss, Brier, hit rate, or ROI until result data is');
    console.log('    ingested (see scripts/ingest/theracingapi_adapter.js).');
  }

  console.log('');
  console.log('  Summary by version');
  console.log('  ──────────────────');
  const fmtPct = v => (v == null ? '—' : (100 * v).toFixed(1) + '%');
  const fmtNum = v => (v == null ? '—' : v.toFixed(4));
  const fmtMoney = v => (v == null ? '—' : '$' + v.toFixed(2));
  const cols = [
    { header: 'Version',    key: 'version' },
    { header: 'Scored',     key: 'races_scored' },
    { header: 'Measurable', key: 'races_measurable' },
    { header: 'LogLoss',    key: 'log_loss_mean', fmt: fmtNum },
    { header: 'Brier',      key: 'brier_mean',    fmt: fmtNum },
    { header: 'Top-1',      key: 'top1_rate',     fmt: fmtPct },
    { header: 'Top-3',      key: 'top3_rate',     fmt: fmtPct },
    { header: 'Flat ROI',   key: 'flat_top_pick_roi_pct', fmt: v => v == null ? '—' : v.toFixed(1) + '%' },
    { header: 'Overlay net',key: 'overlay_net',   fmt: fmtMoney },
  ];
  console.log(formatTable(report.versions.map(v => v.summary), cols));

  // Calibration: show only when we have measurable rows.
  const anyMeasurable = report.versions.some(v => (v.summary.races_measurable || 0) > 0);
  if (anyMeasurable) {
    console.log('');
    console.log('  Calibration (predicted vs empirical hit rate)');
    console.log('  ──────────────────────────────────────────────');
    for (const v of report.versions) {
      console.log(`\n  ${v.summary.version}`);
      console.log(formatTable(v.calibration.filter(b => b.n > 0), [
        { header: 'Bucket',    key: 'bucket' },
        { header: 'Range',     key: 'range', fmt: r => `${(r[0]*100).toFixed(0)}–${(r[1]*100).toFixed(0)}%` },
        { header: 'n',         key: 'n' },
        { header: 'Predicted', key: 'avg_predicted', fmt: fmtPct },
        { header: 'Empirical', key: 'empirical',     fmt: fmtPct },
        { header: '|Δ|',       key: 'abs_error',     fmt: v => (100*v).toFixed(1) + 'pp' },
      ]));
    }
  }
  console.log('');
}

function main() {
  const args = parseArgs(process.argv);
  const { races: allRaces, stats } = loadCorpus({
    includeFixtures: args.includeFixtures,
    requireResults: args.requireResults,
  });
  const filtered = allRaces.filter(r => inRange(r, args));

  const versions = args.versions.map(v => Object.assign(
    { version: v }, evaluateVersion(v, filtered)
  ));
  const baseline = evaluateBaseline(filtered);

  const report = {
    generated_at: new Date().toISOString(),
    filters: { track: args.track, from: args.from, to: args.to,
               include_fixtures: args.includeFixtures,
               require_results: args.requireResults },
    corpus: Object.assign({}, stats, { in_range: filtered.length }),
    versions: [...versions, baseline],
  };

  printReport(report);

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out
      : path.resolve(process.cwd(), args.out);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`  Full report → ${outPath}`);
  }
}

if (require.main === module) main();

module.exports = { evaluateVersion, evaluateBaseline, winnerOf };
