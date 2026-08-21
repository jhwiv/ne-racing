#!/usr/bin/env node
'use strict';

/**
 * overlay_threshold_sweep.js — the same honest, chronological-holdout method
 * as weight_sweep.js, applied to the OTHER never-validated magic numbers in
 * the engine: the Value Play gate (`overlay > 0.08 && score >= 55`, hardcoded
 * in scripts/lib/pick_selection.js's Value Play selection and mirrored in
 * metrics.js's flatOverlayROI for backtesting).
 *
 * This exists because Value Play has been the single worst-performing bet
 * category in live pick history (0-12, -100% ROI as of 2026-08-14) even
 * after the v2.49.72 sign fix -- and unlike the composite weights, these two
 * numbers were never backtested at all; they were picked by hand and never
 * revisited.
 *
 * Honesty safeguards (same as weight_sweep.js, this is real-money-adjacent):
 *   1. Real results only, no fixtures.
 *   2. Chronological train/holdout split -- a candidate threshold pair is
 *      only judged on races it did NOT see.
 *   3. Primary metric is holdout ROI (that's literally what the threshold
 *      controls -- which bets get placed) but bet COUNT is always printed
 *      alongside so a reader can judge how much to trust it; a threshold
 *      that "wins" on 4 holdout bets is noise, not a finding.
 *
 * Usage:
 *   node scripts/backtest/overlay_threshold_sweep.js [--train-frac 0.7]
 */

const path = require('path');
const { loadCorpus } = require('./load_corpus');
const M = require('./metrics');
const S = require('../lib/scoring');
const fs = require('fs');

function parseArgs(argv) {
  const out = { trainFrac: 0.7 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--train-frac') { out.trainFrac = parseFloat(argv[++i]); }
  }
  return out;
}

function evaluateOverlay(races, fittedWeights, overlayMin, scoreMin) {
  let net = 0, bets = 0, wins = 0;
  for (const race of races) {
    const scored = S.scoreRace(race, { version: 'v2', today: race.date, fittedWeights });
    if (!scored.length || !race.results) continue;
    const ov = M.flatOverlayROI(scored, race, { overlayMin, scoreMin });
    if (!ov) continue;
    net += ov.net;
    bets += ov.bets;
    // Recount wins from the same scan flatOverlayROI does, for a hit-rate readout.
    const fp = race.results.finish_positions || [];
    const winner = fp.find(x => x.position === 1);
    if (!winner) continue;
    for (const s of scored) {
      if ((s.overlay || 0) > overlayMin && s.score >= scoreMin && s.horse.pp === winner.pp) wins++;
    }
  }
  return { net, bets, wins, roiPct: bets ? 100 * net / (2 * bets) : null };
}

function main() {
  const args = parseArgs(process.argv);
  const { races: allRaces } = loadCorpus({ includeFixtures: false, requireResults: true });
  let races = allRaces.filter(r => (r.horses || []).length > 0);
  races.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.num || 0) - (b.num || 0)));

  console.log(`Scoreable, result-bearing races found: ${races.length}`);
  if (races.length < 30) {
    console.log('\n⚠ Fewer than 30 races -- not enough to trust any threshold comparison. Stopping.');
    return;
  }

  const splitIdx = Math.floor(races.length * args.trainFrac);
  const train = races.slice(0, splitIdx);
  const holdout = races.slice(splitIdx);
  console.log(`Chronological split: ${train.length} train (up to ${train[train.length - 1].date}), ` +
    `${holdout.length} holdout (from ${holdout[0].date}).`);

  // Use the shipped (v2.49.72, sign-fixed) fitted weights -- this sweep is
  // about the DOWNSTREAM selection gate, not the composite score itself.
  const weightsPath = path.resolve(__dirname, '..', '..', 'data', 'weights', 'v2.json');
  const payload = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
  const loaded = S.loadFittedWeights(payload);
  const fittedWeights = loaded ? loaded.weights : null;

  const overlayCandidates = [0.02, 0.04, 0.06, 0.08, 0.10, 0.12, 0.15, 0.20];
  const scoreCandidates = [45, 50, 55, 60, 65, 70];

  console.log('\n=== Grid search on TRAIN only (selecting the pair with the best TRAIN roi_pct, min 15 train bets) ===');
  let best = null;
  const trainResults = [];
  for (const overlayMin of overlayCandidates) {
    for (const scoreMin of scoreCandidates) {
      const r = evaluateOverlay(train, fittedWeights, overlayMin, scoreMin);
      trainResults.push({ overlayMin, scoreMin, ...r });
      if (r.bets >= 15 && (!best || r.roiPct > best.roiPct)) {
        best = { overlayMin, scoreMin, ...r };
      }
    }
  }
  if (!best) {
    console.log('No candidate reached 15 train bets -- corpus too small to tune this safely. Stopping.');
    return;
  }
  console.log(`Best on train: overlay>${best.overlayMin} score>=${best.scoreMin} -> ` +
    `${best.bets} bets, ${best.wins} wins, net $${best.net.toFixed(2)}, roi=${best.roiPct.toFixed(1)}%`);

  const current = { overlayMin: 0.08, scoreMin: 55 };
  console.log('\n=== Current production gate vs. best-on-train, evaluated on TRAIN and HOLDOUT ===');
  for (const [label, cfg] of [['Current (overlay>0.08, score>=55)', current], [`Best-on-train (overlay>${best.overlayMin}, score>=${best.scoreMin})`, best]]) {
    const t = evaluateOverlay(train, fittedWeights, cfg.overlayMin, cfg.scoreMin);
    const h = evaluateOverlay(holdout, fittedWeights, cfg.overlayMin, cfg.scoreMin);
    console.log(`\n${label}`);
    console.log(`  train   : ${t.bets} bets, ${t.wins} wins, net $${t.net.toFixed(2)}, roi=${t.roiPct != null ? t.roiPct.toFixed(1) + '%' : 'n/a'}`);
    console.log(`  holdout : ${h.bets} bets, ${h.wins} wins, net $${h.net.toFixed(2)}, roi=${h.roiPct != null ? h.roiPct.toFixed(1) + '%' : 'n/a'}`);
    if (h.bets < 15) {
      console.log(`  ⚠ only ${h.bets} holdout bets -- treat this holdout number as directional noise, not a decision.`);
    }
  }

  console.log('\n=== Full grid (train), for reference ===');
  console.log('overlay  score  bets  wins  net$      roi%');
  trainResults.forEach(r => {
    console.log(`${String(r.overlayMin).padEnd(7)}  ${String(r.scoreMin).padEnd(5)}  ${String(r.bets).padEnd(4)}  ${String(r.wins).padEnd(4)}  ${r.net.toFixed(2).padStart(8)}  ${r.roiPct != null ? r.roiPct.toFixed(1) : '—'}`);
  });
}

main();
