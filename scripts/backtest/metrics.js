'use strict';

/**
 * metrics.js — scoring metrics for race-level probabilistic predictions.
 *
 * Conventions:
 *   For each race we have an array of horses scored with `modelProb` ∈ [0,1].
 *   The "outcome" is the program-number (pp) of the winner.
 *   Each horse i in the race has:
 *     - modelProb_i  (what our engine said)
 *     - mlImpliedProb_i  (what the morning line implied; baseline)
 *     - y_i ∈ {0, 1}  (1 if this horse won, 0 otherwise)
 *
 * We compute several aggregate metrics so we can compare v1 vs v2 head-to-head
 * AND compare both against the morning-line baseline.
 */

/**
 * Log-loss for a single race using one-hot encoding on the winner.
 * Lower is better. ML baseline (favorites in tough fields) usually ≈ 1.6–2.2
 * for thoroughbred racing.
 */
function logLossRace(scored, winnerPp) {
  const w = scored.find(s => s.horse.pp === winnerPp);
  if (!w) return null; // winner not in scored set (scratched / unknown)
  const p = Math.max(1e-6, Math.min(1 - 1e-6, w.modelProb || 0));
  return -Math.log(p);
}

/**
 * Brier score for a race: sum over all horses of (modelProb_i - y_i)^2.
 * Multi-class form; lower is better. Bounded above by ~2.
 */
function brierRace(scored, winnerPp) {
  let total = 0;
  for (const s of scored) {
    const y = (s.horse.pp === winnerPp) ? 1 : 0;
    const p = s.modelProb || 0;
    total += (p - y) * (p - y);
  }
  return total;
}

/** 1 if model's top pick won, else 0. */
function top1Hit(scored, winnerPp) {
  if (!scored.length) return null;
  return (scored[0].horse.pp === winnerPp) ? 1 : 0;
}

/** 1 if winner is in model's top-k. */
function topKHit(scored, winnerPp, k) {
  if (!scored.length) return null;
  return scored.slice(0, k).some(s => s.horse.pp === winnerPp) ? 1 : 0;
}

/**
 * 1 if the model's top-2-by-score pair (scored[0], scored[1]) are exactly
 * the real top-2 finishers, in either order -- i.e. would this pairing have
 * cashed as an Exacta Box. This is the exact same pairing rule production
 * uses for both "Value Play" and "Exotic of the Day" (see index.html's
 * updateTopPicksCard: `raceGroup[0]`/`raceGroup[1]`, `raceGroup` being
 * scored horses sorted by score descending).
 *
 * Returns null (not measurable) unless both position 1 AND position 2 are
 * present in results.finish_positions -- a plain win-only result (the shape
 * every other metric in this file accepts) cannot answer an exacta question.
 */
function exactaBoxHit(scored, race) {
  if (!scored || scored.length < 2) return null;
  const fp = (race && race.results && race.results.finish_positions) || [];
  const first = fp.find(x => x.position === 1);
  const second = fp.find(x => x.position === 2);
  if (!first || !second) return null;
  const boxPps = new Set([scored[0].horse.pp, scored[1].horse.pp]);
  const finishPps = new Set([first.pp, second.pp]);
  if (boxPps.size !== 2 || finishPps.size !== 2) return null;
  return (boxPps.has(first.pp) && boxPps.has(second.pp)) ? 1 : 0;
}

/**
 * ROI of a flat $2 win bet on the model's top pick.
 * Returns net profit per race in dollars. Requires `win_payout` on the
 * winning row of results.finish_positions (standard $2 payout, e.g. 8.40).
 */
function flatTopPickROI(scored, race) {
  if (!scored.length || !race.results) return null;
  const fp = race.results.finish_positions || [];
  const winner = fp.find(x => x.position === 1);
  if (!winner) return null;
  const pick = scored[0];
  if (pick.horse.pp === winner.pp && winner.win_payout != null) {
    return Number(winner.win_payout) - 2;
  }
  return -2;
}

/**
 * ROI of a "value bet": $2 win on every horse with overlay > threshold AND
 * composite score ≥ minScore (matches the production UI rule).
 */
function flatOverlayROI(scored, race, opts) {
  const overlayMin = (opts && opts.overlayMin) != null ? opts.overlayMin : 0.08;
  const scoreMin   = (opts && opts.scoreMin)   != null ? opts.scoreMin   : 55;
  if (!race.results) return null;
  const fp = race.results.finish_positions || [];
  const winner = fp.find(x => x.position === 1);
  if (!winner) return null;

  let net = 0;
  let placed = 0;
  for (const s of scored) {
    if ((s.overlay || 0) > overlayMin && s.score >= scoreMin) {
      placed++;
      if (s.horse.pp === winner.pp && winner.win_payout != null) {
        net += Number(winner.win_payout) - 2;
      } else {
        net -= 2;
      }
    }
  }
  return placed ? { net, bets: placed, roi_pct: 100 * net / (2 * placed) } : null;
}

/**
 * Calibration: bucket modelProb predictions into deciles and report the
 * empirical hit rate in each bucket. A well-calibrated model has empirical ≈
 * predicted across all deciles.
 */
function calibrationBuckets(predictions, opts) {
  const nBuckets = (opts && opts.nBuckets) || 10;
  const buckets = Array.from({ length: nBuckets }, () => ({ n: 0, sumP: 0, wins: 0 }));
  for (const { prob, y } of predictions) {
    const p = Math.max(0, Math.min(1, prob));
    let idx = Math.floor(p * nBuckets);
    if (idx >= nBuckets) idx = nBuckets - 1;
    buckets[idx].n++;
    buckets[idx].sumP += p;
    buckets[idx].wins += y;
  }
  return buckets.map((b, i) => ({
    bucket: i,
    range: [i / nBuckets, (i + 1) / nBuckets],
    n: b.n,
    avg_predicted: b.n ? b.sumP / b.n : 0,
    empirical: b.n ? b.wins / b.n : 0,
    abs_error: b.n ? Math.abs((b.wins / b.n) - (b.sumP / b.n)) : 0,
  }));
}

function mean(arr) {
  const xs = arr.filter(x => x != null && !Number.isNaN(x));
  if (!xs.length) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sum(arr) {
  return arr.filter(x => x != null && !Number.isNaN(x)).reduce((a, b) => a + b, 0);
}

module.exports = {
  logLossRace,
  brierRace,
  top1Hit,
  topKHit,
  exactaBoxHit,
  flatTopPickROI,
  flatOverlayROI,
  calibrationBuckets,
  mean,
  sum,
};
