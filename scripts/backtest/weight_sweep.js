#!/usr/bin/env node
'use strict';

/**
 * weight_sweep.js — vary the v2 composite-score weights (Speed/Class/Pace/
 * Trainer-Jockey/Bias/Freshness) and check whether any alternative weighting
 * predicts real historical races better than the current hand-picked
 * DEFAULT_V2_WEIGHTS (35/20/15/15/10/5), measured against real results only.
 *
 * Honesty safeguards (this is a small-sample real-money-adjacent question,
 * not a toy):
 *   1. NEVER touches synthetic/fixture data -- requireResults + real horses
 *      only. If the corpus is too small to say anything, this says so
 *      loudly instead of printing a number that looks precise.
 *   2. Chronological train/holdout split (not random) -- a candidate weight
 *      vector is only judged on races it did NOT see. Sweeping thousands of
 *      random weight vectors and picking the in-sample winner would just be
 *      curve-fitting the sample's own noise; every "which is better" claim
 *      in the printed report is an OUT-OF-SAMPLE (holdout) number.
 *   3. Primary metric is log-loss (a proper scoring rule for probabilistic
 *      predictions -- rewards calibrated confidence, not just picking
 *      winners). Top-1 rate and flat ROI are reported alongside as the
 *      business-relevant secondary numbers, but log-loss is what decides
 *      "better," matching the backtest README's stated metric hierarchy.
 *
 * Usage:
 *   node scripts/backtest/weight_sweep.js [--track SAR] [--trials 2000]
 *                                          [--train-frac 0.7] [--seed 42]
 *                                          [--out /tmp/weight_sweep.json]
 */

const fs = require('fs');
const path = require('path');
const { loadCorpus } = require('./load_corpus');
const M = require('./metrics');
const S = require('../lib/scoring');

function parseArgs(argv) {
  const out = { track: null, trials: 2000, trainFrac: 0.7, seed: 42, out: null };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v.toUpperCase(); i++; }
    else if (k === '--trials') { out.trials = parseInt(v, 10); i++; }
    else if (k === '--train-frac') { out.trainFrac = parseFloat(v); i++; }
    else if (k === '--seed') { out.seed = parseInt(v, 10); i++; }
    else if (k === '--out') { out.out = v; i++; }
  }
  return out;
}

// Deterministic PRNG (mulberry32) so a reported run can be reproduced exactly.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FACTORS = ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'];

/** Sample a random point on the 6-simplex (Dirichlet(alpha=1) via normalized -log(uniform)). */
function randomWeights(rng) {
  const draws = FACTORS.map(() => -Math.log(1 - rng())); // Exp(1)
  const sum = draws.reduce((a, b) => a + b, 0);
  const w = {};
  FACTORS.forEach((f, i) => { w[f] = draws[i] / sum; });
  return w;
}

/** Perturb one weight vector: nudge each factor by up to ±maxDelta, renormalize onto the simplex. */
function perturb(base, rng, maxDelta) {
  const raw = {};
  let sum = 0;
  for (const f of FACTORS) {
    const v = Math.max(0.001, base[f] + (rng() * 2 - 1) * maxDelta);
    raw[f] = v; sum += v;
  }
  const w = {};
  for (const f of FACTORS) w[f] = raw[f] / sum;
  return w;
}

function winnerOf(race) {
  if (!race.results || !Array.isArray(race.results.finish_positions)) return null;
  const w = race.results.finish_positions.find(x => x.position === 1);
  return w ? w.pp : null;
}

/** Score every race in `races` under a fixed weight vector; return aggregate metrics. */
function evaluate(races, weights) {
  const perRace = [];
  const allPredictions = [];
  for (const race of races) {
    const scored = S.scoreRace(race, { version: 'v2', today: race.date, fittedWeights: weights });
    if (!scored.length) continue;
    const winnerPp = winnerOf(race);
    if (winnerPp == null) continue;
    const row = {
      log_loss: M.logLossRace(scored, winnerPp),
      brier: M.brierRace(scored, winnerPp),
      top1: M.top1Hit(scored, winnerPp),
      top3: M.topKHit(scored, winnerPp, 3),
      roi: M.flatTopPickROI(scored, race),
    };
    perRace.push(row);
    for (const s of scored) allPredictions.push({ prob: s.modelProb || 0, y: s.horse.pp === winnerPp ? 1 : 0 });
  }
  return {
    n: perRace.length,
    log_loss_mean: M.mean(perRace.map(r => r.log_loss)),
    brier_mean: M.mean(perRace.map(r => r.brier)),
    top1_rate: M.mean(perRace.map(r => r.top1)),
    top3_rate: M.mean(perRace.map(r => r.top3)),
    flat_roi_pct: (() => {
      const withRoi = perRace.filter(r => r.roi != null);
      if (!withRoi.length) return null;
      return 100 * M.sum(withRoi.map(r => r.roi)) / (2 * withRoi.length);
    })(),
  };
}

function fmtW(w) {
  return FACTORS.map(f => `${f}=${(w[f] * 100).toFixed(1)}%`).join(' ');
}

function main() {
  const args = parseArgs(process.argv);
  const rng = mulberry32(args.seed);

  const { races: allRaces } = loadCorpus({ includeFixtures: false, requireResults: true });
  let races = allRaces.filter(r => (r.horses || []).length > 0);
  if (args.track) races = races.filter(r => r.track === args.track);
  // Chronological order so the train/holdout split is a real forward split,
  // not an information-leaking shuffle.
  races.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.num || 0) - (b.num || 0)));

  console.log(`Scoreable, result-bearing races found: ${races.length}` +
    (args.track ? ` (track=${args.track})` : ' (all tracks)'));

  if (races.length < 30) {
    console.log('\n⚠ Fewer than 30 scoreable real races on disk. This is NOT enough to draw any');
    console.log('  conclusion about whether a different weighting is better -- both the default');
    console.log('  and any alternative would be well within noise of each other at this sample');
    console.log('  size. Run scripts/backtest/pull_entries_history.js (via its GitHub Action)');
    console.log('  to backfill more real entries+results, then re-run this.');
    if (!races.length) return;
  }

  const splitIdx = Math.floor(races.length * args.trainFrac);
  const train = races.slice(0, splitIdx);
  const holdout = races.slice(splitIdx);
  console.log(`Chronological split: ${train.length} train races (up to ${train.length ? train[train.length - 1].date : '—'}), ` +
    `${holdout.length} holdout races (from ${holdout.length ? holdout[0].date : '—'}).`);

  if (holdout.length < 10) {
    console.log('\n⚠ Holdout set has fewer than 10 races. Any "better" result below is not');
    console.log('  statistically trustworthy -- treat this run as directional only.');
  }

  // ── Candidates ──────────────────────────────────────────────────────────
  const candidates = [{ label: 'DEFAULT_V2_WEIGHTS (current production)', weights: S.DEFAULT_V2_WEIGHTS }];

  const weightsPath = path.resolve(__dirname, '..', '..', 'data', 'weights', 'v2.json');
  if (fs.existsSync(weightsPath)) {
    const payload = JSON.parse(fs.readFileSync(weightsPath, 'utf8'));
    const loaded = S.loadFittedWeights(payload);
    if (loaded) {
      candidates.push({ label: `MLE-fitted (n_races=${loaded.n_races}, trained_at=${loaded.trained_at})`, weights: loaded.weights });
    } else {
      console.log(`\n(data/weights/v2.json present but not usable: status="${payload.status}", n_races=${payload.n_races} -- ` +
        `below the fitter's own --min-races threshold, so it's excluded as a candidate.)`);
    }
  }

  // Random search (fit ON TRAIN ONLY) + local perturbations around the best
  // train-set finds, so the search isn't purely random-or-nothing.
  let bestTrain = null;
  const searched = [];
  for (let i = 0; i < args.trials; i++) {
    const w = i < args.trials * 0.6 ? randomWeights(rng)
      : perturb(bestTrain ? bestTrain.weights : S.DEFAULT_V2_WEIGHTS, rng, 0.08);
    const trainMetrics = evaluate(train, w);
    if (trainMetrics.log_loss_mean == null) continue;
    searched.push({ weights: w, trainMetrics });
    if (!bestTrain || trainMetrics.log_loss_mean < bestTrain.trainMetrics.log_loss_mean) {
      bestTrain = { weights: w, trainMetrics };
    }
  }
  if (bestTrain) {
    candidates.push({ label: `Best of ${args.trials} searched (chosen on TRAIN log-loss only)`, weights: bestTrain.weights });
  }

  // ── Evaluate every candidate on train AND holdout ────────────────────────
  console.log('\n=== Candidate weight vectors ===');
  const results = candidates.map(c => {
    const trainEval = evaluate(train, c.weights);
    const holdoutEval = evaluate(holdout, c.weights);
    const allEval = evaluate(races, c.weights);
    console.log(`\n${c.label}`);
    console.log(`  weights: ${fmtW(c.weights)}`);
    console.log(`  train    (n=${trainEval.n}):   log-loss=${trainEval.log_loss_mean?.toFixed(4)}  top1=${(100 * (trainEval.top1_rate||0)).toFixed(1)}%  flatROI=${trainEval.flat_roi_pct?.toFixed(1)}%`);
    console.log(`  holdout  (n=${holdoutEval.n}):   log-loss=${holdoutEval.log_loss_mean?.toFixed(4)}  top1=${(100 * (holdoutEval.top1_rate||0)).toFixed(1)}%  flatROI=${holdoutEval.flat_roi_pct?.toFixed(1)}%`);
    console.log(`  full corpus (n=${allEval.n}):  log-loss=${allEval.log_loss_mean?.toFixed(4)}  top1=${(100 * (allEval.top1_rate||0)).toFixed(1)}%  flatROI=${allEval.flat_roi_pct?.toFixed(1)}%`);
    return { label: c.label, weights: c.weights, train: trainEval, holdout: holdoutEval, full: allEval };
  });

  console.log('\n=== Verdict (ranked by HOLDOUT log-loss -- lower is better; this is the only fair comparison) ===');
  const ranked = results.filter(r => r.holdout.log_loss_mean != null)
    .slice().sort((a, b) => a.holdout.log_loss_mean - b.holdout.log_loss_mean);
  ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.label}: holdout log-loss=${r.holdout.log_loss_mean.toFixed(4)}`));

  const defaultResult = results.find(r => r.label.startsWith('DEFAULT_V2_WEIGHTS'));
  const bestOther = ranked.find(r => r !== defaultResult);
  if (defaultResult && bestOther && defaultResult.holdout.log_loss_mean != null) {
    const improvement = defaultResult.holdout.log_loss_mean - bestOther.holdout.log_loss_mean;
    console.log(`\nBest alternative vs. current default, on holdout: Δlog-loss = ${improvement >= 0 ? '-' : '+'}${Math.abs(improvement).toFixed(4)} ` +
      `(${improvement > 0 ? 'alternative is better' : improvement < 0 ? 'default is better' : 'no difference'}).`);
    if (holdout.length < 30) {
      console.log(`With only ${holdout.length} holdout races, treat this as a directional signal, not a decision -- ` +
        'this needs a bigger real corpus before changing production weights on the strength of it alone.');
    }
  }

  if (args.out) {
    const outPath = path.isAbsolute(args.out) ? args.out : path.resolve(process.cwd(), args.out);
    fs.writeFileSync(outPath, JSON.stringify({
      generated_at: new Date().toISOString(),
      args, corpus_size: races.length, train_size: train.length, holdout_size: holdout.length,
      results,
    }, null, 2));
    console.log(`\nFull report → ${outPath}`);
  }
}

if (require.main === module) main();

module.exports = { parseArgs, mulberry32, randomWeights, perturb, evaluate, winnerOf, FACTORS };
