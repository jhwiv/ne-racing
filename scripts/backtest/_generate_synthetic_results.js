#!/usr/bin/env node
// _generate_synthetic_results.js — produce a synthetic-results fixture used
// ONLY by the backtest demo + tests. NOT real-world race results.
//
// We take the existing saratoga_2025_sample.json (which is itself a
// hand-authored placeholder), and append a results.finish_positions for each
// race by drawing a winner from the morning-line implied distribution. This
// lets the backtest demonstrate end-to-end output without touching any
// licensed source data.
'use strict';
const fs = require('fs');
const path = require('path');

function parseOdds(s) {
  if (!s) return NaN;
  const m = String(s).match(/^(\d+)[-\/](\d+)$/);
  if (!m) return parseFloat(s);
  return parseInt(m[1],10) / parseInt(m[2],10);
}

// Deterministic PRNG for reproducibility
let seed = 20260529;
function rand() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

const src = path.resolve(__dirname, '..', '..', 'data/fixtures/saratoga_2025_sample.json');
const dst = path.resolve(__dirname, '..', '..', 'data/fixtures/with_results/saratoga_2025_with_synthetic_results.json');
const doc = JSON.parse(fs.readFileSync(src, 'utf8'));

doc.meta = Object.assign({}, doc.meta, {
  data_status: 'placeholder_sample_with_synthetic_results',
  synthetic_results: true,
  generator_note: 'Winners drawn from ML implied probs. NOT real outcomes. Demo only.',
});

let measurable = 0;
for (const race of doc.races) {
  const live = (race.horses || []).filter(h => !h.scratched);
  if (!live.length) continue;
  const implied = live.map(h => {
    const o = parseOdds(h.ml);
    return o > 0 ? 1 / (o + 1) : 0;
  });
  const sum = implied.reduce((a, b) => a + b, 0);
  if (sum <= 0) continue;
  const probs = implied.map(p => p / sum);

  // Sample a winner, then a 2nd-place finisher from the remaining field
  // (same noisy-ML-implied draw, without replacement). No result source in
  // this repo has ever recorded a 2nd-place finisher before -- this is what
  // makes an Exacta Box hit-rate metric measurable at all, even only as a
  // synthetic sanity check.
  function drawFrom(pool, probs) {
    const noise = probs.map(p => p + (rand() - 0.5) * 0.1);
    const total = noise.reduce((a, b) => Math.max(a, 0) + b, 0);
    const r = rand() * total;
    let cum = 0, idx = 0;
    for (let i = 0; i < pool.length; i++) {
      cum += Math.max(0, noise[i]);
      if (r <= cum) { idx = i; break; }
    }
    return idx;
  }

  const winIdx = drawFrom(live, probs);
  const winner = live[winIdx];
  const winOdds = parseOdds(winner.ml);
  const payout = isFinite(winOdds) ? Math.max(2.20, +(2 * (winOdds + 1)).toFixed(2)) : 6.40;

  const finish_positions = [{
    pp: winner.pp,
    horseName: winner.name,
    position: 1,
    win_payout: payout,
  }];

  if (live.length > 1) {
    const remaining = live.filter((_, i) => i !== winIdx);
    const remainingImplied = remaining.map(h => {
      const o = parseOdds(h.ml);
      return o > 0 ? 1 / (o + 1) : 0;
    });
    const remainingSum = remainingImplied.reduce((a, b) => a + b, 0);
    if (remainingSum > 0) {
      const remainingProbs = remainingImplied.map(p => p / remainingSum);
      const secondIdx = drawFrom(remaining, remainingProbs);
      const second = remaining[secondIdx];
      finish_positions.push({ pp: second.pp, horseName: second.name, position: 2 });
    }
  }

  race.results = { finish_positions };
  measurable++;
}

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify(doc, null, 2));
console.log(`Wrote ${dst}  (${measurable} races with synthetic results)`);
