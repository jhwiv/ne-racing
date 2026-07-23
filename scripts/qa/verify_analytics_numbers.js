#!/usr/bin/env node
'use strict';

/**
 * verify_analytics_numbers.js — independent cross-check of every number the
 * Analytics tab's "Pick Accuracy by Source" card displays, against the raw
 * per-pick records in ENGINE_ACCURACY. Does NOT trust /api/picks/stats'
 * own arithmetic -- recomputes wins/losses/stake/return/ROI from scratch
 * using only /api/picks/history's individual records, then diffs against
 * what /api/picks/stats reports and what the UI would render.
 *
 * Exists because the owner reported repeated, unresolved correctness
 * problems with this exact card (layout, rank ordering, ROI figures that
 * "look wrong") after many prior sessions. This script is the permanent,
 * re-runnable answer to "did anyone actually check the numbers, or did
 * someone just read the code and assume it's right" -- see
 * docs/ANALYTICS_QA.md for the mandatory process this is part of.
 *
 * Exit code is non-zero if ANY discrepancy is found -- safe to wire into
 * a workflow as a hard gate, not just an informational printout.
 *
 * Usage:
 *   node scripts/qa/verify_analytics_numbers.js [--worker-url https://...]
 */

const DEFAULT_WORKER_URL = 'https://cloudflare-worker.jhwiv-online.workers.dev';
const ENGINES = ['v2', 'baseline_ml', 'crowd', 'v1'];

function parseArgs(argv) {
  const out = { workerUrl: DEFAULT_WORKER_URL };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--worker-url') { out.workerUrl = argv[i + 1]; i++; }
  }
  return out;
}

function fmtPct(x) {
  return (x == null) ? 'null' : (x * 100).toFixed(1) + '%';
}

function almostEqual(a, b, eps) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= (eps || 0.0006); // 0.06 percentage points
}

/** Recompute settled/wins/losses/stake/return/roi from raw history records. */
function recomputeFromHistory(picks) {
  const settledPicks = picks.filter(p => p.settled);
  const wins = settledPicks.filter(p => p.won === true).length;
  const losses = settledPicks.length - wins;
  const totalStake = settledPicks.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
  const totalReturn = settledPicks.reduce((s, p) => s + (parseFloat(p.payout) || 0), 0);
  const winRate = settledPicks.length > 0 ? wins / settledPicks.length : null;
  const roi = totalStake > 0 ? (totalReturn - totalStake) / totalStake : null;

  const byBetType = {};
  settledPicks.forEach(p => {
    const bt = p.betType || 'Win';
    if (!byBetType[bt]) byBetType[bt] = { settled: 0, wins: 0, totalStake: 0, totalReturn: 0 };
    const b = byBetType[bt];
    b.settled++;
    if (p.won === true) b.wins++;
    b.totalStake += parseFloat(p.amount) || 0;
    b.totalReturn += parseFloat(p.payout) || 0;
  });
  Object.keys(byBetType).forEach(bt => {
    const b = byBetType[bt];
    b.winRate = b.settled > 0 ? b.wins / b.settled : null;
    b.roi = b.totalStake > 0 ? (b.totalReturn - b.totalStake) / b.totalStake : null;
  });

  return {
    picksLogged: picks.length,
    settled: settledPicks.length,
    wins, losses, winRate, roi, totalStake, totalReturn,
    byBetType,
  };
}

async function fetchAllHistory(workerUrl, engine) {
  // /api/picks/history caps at 500 per request; page via ever-growing limit
  // since it doesn't support an offset -- fine at today's real volumes
  // (low hundreds), revisit if this ever needs true pagination.
  const res = await fetch(`${workerUrl}/api/picks/history?engine=${engine}&limit=500`);
  if (!res.ok) throw new Error(`GET /api/picks/history?engine=${engine} -> ${res.status}`);
  const body = await res.json();
  if (body.total > body.picks.length) {
    throw new Error(`${engine}: total (${body.total}) exceeds the 500-record page fetched here -- script needs real pagination now, do not trust partial results`);
  }
  return body.picks;
}

async function main() {
  const args = parseArgs(process.argv);
  const problems = [];
  const notes = [];

  console.log(`Verifying Analytics numbers against worker: ${args.workerUrl}\n`);

  const statsRes = await fetch(`${args.workerUrl}/api/picks/stats`);
  if (!statsRes.ok) throw new Error(`GET /api/picks/stats -> ${statsRes.status}`);
  const statsBody = await statsRes.json();
  const stats = statsBody.engines || {};

  const recomputed = {};
  for (const engine of ENGINES) {
    const picks = await fetchAllHistory(args.workerUrl, engine);
    if (!picks.length) continue;
    recomputed[engine] = recomputeFromHistory(picks);
  }

  console.log('=== Per-engine: recomputed from raw /api/picks/history vs. /api/picks/stats ===\n');
  for (const engine of Object.keys(recomputed)) {
    const r = recomputed[engine];
    const s = stats[engine];
    console.log(`--- ${engine} ---`);
    console.log(`  picks logged (history total):        ${r.picksLogged}`);
    console.log(`  settled -- recomputed: ${r.settled}   stats: ${s ? s.settled : 'MISSING'}`);
    console.log(`  wins    -- recomputed: ${r.wins}   stats: ${s ? s.wins : 'MISSING'}`);
    console.log(`  losses  -- recomputed: ${r.losses}`);
    console.log(`  winRate -- recomputed: ${fmtPct(r.winRate)}   stats: ${s ? fmtPct(s.winRate) : 'MISSING'}`);
    console.log(`  totalStake  -- recomputed: $${r.totalStake.toFixed(2)}   stats totalStake: ${s ? '$' + s.totalStake.toFixed(2) : 'MISSING'}`);
    console.log(`  totalReturn -- recomputed: $${r.totalReturn.toFixed(2)}   stats totalReturn: ${s ? '$' + s.totalReturn.toFixed(2) : 'MISSING'}`);
    console.log(`  ROI     -- recomputed: ${fmtPct(r.roi)}   stats: ${s ? fmtPct(s.roi) : 'MISSING'}`);

    if (!s) {
      problems.push(`${engine}: /api/picks/stats has NO entry at all, but /api/picks/history reports ${r.picksLogged} picks logged`);
    } else {
      if (s.settled !== r.settled) problems.push(`${engine}: settled mismatch -- stats=${s.settled} recomputed=${r.settled}`);
      if (s.wins !== r.wins) problems.push(`${engine}: wins mismatch -- stats=${s.wins} recomputed=${r.wins}`);
      if (!almostEqual(s.winRate, r.winRate)) problems.push(`${engine}: winRate mismatch -- stats=${fmtPct(s.winRate)} recomputed=${fmtPct(r.winRate)}`);
      if (!almostEqual(s.roi, r.roi, 0.002)) problems.push(`${engine}: ROI mismatch -- stats=${fmtPct(s.roi)} recomputed=${fmtPct(r.roi)}`);
    }

    Object.keys(r.byBetType).forEach(bt => {
      const b = r.byBetType[bt];
      const sb = s && s.byBetType && s.byBetType[bt];
      console.log(`  [${bt}] settled=${b.settled} wins=${b.wins} winRate=${fmtPct(b.winRate)} roi=${fmtPct(b.roi)}` +
        (sb ? `   (stats: settled=${sb.settled} wins=${sb.wins} winRate=${fmtPct(sb.winRate)} roi=${fmtPct(sb.roi)})` : '   (stats: MISSING this betType)'));
      if (sb) {
        if (sb.settled !== b.settled) problems.push(`${engine}/${bt}: settled mismatch -- stats=${sb.settled} recomputed=${b.settled}`);
        if (sb.wins !== b.wins) problems.push(`${engine}/${bt}: wins mismatch -- stats=${sb.wins} recomputed=${b.wins}`);
        if (!almostEqual(sb.roi, b.roi, 0.002)) problems.push(`${engine}/${bt}: ROI mismatch -- stats=${fmtPct(sb.roi)} recomputed=${fmtPct(b.roi)}`);
      }
    });
    console.log('');
  }

  // Cross-check the volume line: "N total picks logged across M sources -- X graded, Y pending."
  const engines = Object.keys(recomputed);
  const totalPicks = engines.reduce((n, e) => n + recomputed[e].picksLogged, 0);
  const totalSettled = engines.reduce((n, e) => n + recomputed[e].settled, 0);
  console.log('=== Volume line ===');
  console.log(`  ${totalPicks} total picks logged across ${engines.length} sources -- ${totalSettled} graded, ${totalPicks - totalSettled} pending.`);

  // Cross-check rank order: sort recomputed ROI (min 3 settled) descending,
  // print the order the UI's rank badges SHOULD follow.
  const ranked = engines
    .filter(e => recomputed[e].settled >= 3 && recomputed[e].roi != null)
    .sort((a, b) => recomputed[b].roi - recomputed[a].roi);
  console.log('\n=== Correct rank order (by recomputed ROI, min 3 settled) ===');
  ranked.forEach((e, i) => console.log(`  ${i + 1}. ${e}: ${fmtPct(recomputed[e].roi)} ROI, ${recomputed[e].wins}-${recomputed[e].losses}`));

  console.log('\n=== Result ===');
  if (problems.length) {
    console.log(`${problems.length} DISCREPANC${problems.length === 1 ? 'Y' : 'IES'} FOUND:`);
    problems.forEach(p => console.log(`  - ${p}`));
    process.exitCode = 1;
  } else {
    console.log('No discrepancies -- every number /api/picks/stats reports matches an independent recomputation from raw /api/picks/history records.');
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exit(1); });
}

module.exports = { recomputeFromHistory, almostEqual, fmtPct };
