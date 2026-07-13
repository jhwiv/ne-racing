#!/usr/bin/env node
'use strict';

/**
 * daily_pick_settle.js — settles the picks scripts/daily_pick_log.js logged
 * for a given date against the real archived result (RACE_HISTORY), once
 * available. Re-derives the exact same picks deterministically (same
 * entries + expert-picks + selection logic) rather than requiring a
 * separate "list what was logged" KV query, then grades each one with
 * scripts/lib/pick_settlement.js (the same rules the live client uses) and
 * posts the verdict via the existing POST /api/picks/settle. Idempotent --
 * safe to re-run for a date whose races haven't all gone official yet
 * (unsettleable races are skipped, not errored) or that's already fully
 * settled (settle overwrites with the same values).
 *
 * Usage:
 *   node scripts/daily_pick_settle.js --track SAR --date 2026-07-12 [--worker-url https://...]
 */

const { transformEntriesToRaces, attachExpertPicks, buildLogPayloads } = require('./daily_pick_log');
const { normalizeWorkerRace } = require('./backtest/load_corpus');
const { gradePick } = require('./lib/pick_settlement');

const DEFAULT_WORKER_URL = 'https://cloudflare-worker.jhwiv-online.workers.dev';

function parseArgs(argv) {
  const out = { track: 'SAR', date: null, workerUrl: DEFAULT_WORKER_URL };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v.toUpperCase(); i++; }
    else if (k === '--date') { out.date = v; i++; }
    else if (k === '--worker-url') { out.workerUrl = v; i++; }
  }
  if (!out.date) {
    // Default to yesterday (ET-naive: UTC date minus 1 day) -- races logged
    // this morning have almost certainly finished by the next day.
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    out.date = d.toISOString().slice(0, 10);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Settling picks for track=${args.track} date=${args.date} ...`);

  const entriesRes = await fetch(`${args.workerUrl}/api/entries?track=${args.track}&date=${args.date}`);
  if (!entriesRes.ok) throw new Error(`GET /api/entries -> ${entriesRes.status}`);
  const entriesBody = await entriesRes.json();
  let races = transformEntriesToRaces(entriesBody, args.track, args.date);
  if (!races.length) {
    console.log('No races found for this date -- nothing to settle.');
    return;
  }
  try {
    const epRes = await fetch(`${args.workerUrl}/api/expert-picks?track=${args.track}&date=${args.date}`);
    if (epRes.ok) races = attachExpertPicks(races, await epRes.json());
  } catch (e) {
    console.warn(`expert-picks fetch failed (continuing without crowd data): ${e.message}`);
  }
  const payloads = buildLogPayloads(races, args.track, args.date);

  const historyRes = await fetch(`${args.workerUrl}/api/history/${args.track}/${args.date}`);
  if (historyRes.status === 404) {
    console.log('No archived results for this date yet -- nothing to settle. Re-run once races are official.');
    return;
  }
  if (!historyRes.ok) throw new Error(`GET /api/history/${args.track}/${args.date} -> ${historyRes.status}`);
  const historyBody = await historyRes.json();
  const resultsByRaceNum = new Map(
    (historyBody.races || []).map(r => {
      const normalized = normalizeWorkerRace(r, args.track, args.date);
      return [normalized.num, normalized.results];
    })
  );

  let settled = 0, skipped = 0, failed = 0;
  for (const payload of payloads) {
    const raceResult = resultsByRaceNum.get(payload.race);
    const grade = gradePick(payload, raceResult);
    if (!grade) { skipped++; continue; }
    try {
      const res = await fetch(`${args.workerUrl}/api/picks/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          engine: payload.engine, track: payload.track, date: payload.date, race: payload.race, pp: payload.pp,
          position: grade.position, payout: grade.payout, won: grade.won, betType: grade.betType,
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      settled++;
    } catch (e) {
      failed++;
      console.error(`Settle failed for ${payload.engine}:${payload.betTag}:R${payload.race}: ${e.message}`);
    }
  }
  console.log(`Done. ${settled} settled, ${skipped} skipped (race not yet official or horse not in result), ${failed} failed.`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0))
        .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs };
