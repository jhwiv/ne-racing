#!/usr/bin/env node
'use strict';

/**
 * backfill_control_history.js — one-time backfill for the baseline_ml/crowd
 * control-group history that predates the every-race fix in
 * daily_pick_log.js (buildLogPayloads() used to only compute a control pick
 * for the Best Bet's single race per day; real production data showed the
 * damage: 35 graded picks for the engine's own picks vs. 1 for baseline_ml
 * and 2 for crowd -- nowhere near enough sample to mean anything).
 *
 * That fix only affects logging GOING FORWARD. This script re-derives what
 * baseline_ml/crowd WOULD have logged on every past day since entries data
 * became available, and settles each one immediately against the real
 * archived result -- turning weeks of dead time into real sample size today
 * instead of waiting for it to accumulate day-by-day.
 *
 * Reuses the exact same machinery as the daily cron scripts (buildLogPayloads,
 * gradePick) so backfilled records are computed identically to what a live
 * run would have produced -- this is not a separate, parallel code path.
 *
 * Entries source per date: tries the live /api/entries first (in case the
 * upstream API happens to still serve that historical date), then falls
 * back to GET /api/entries/r2, which reads the Cloudflare R2 mirror the
 * scheduled pre-warmer has been writing one snapshot per (track, date) to
 * since v2.47.0 shipped (2026-06-05) and never deletes. For most of the
 * date range, the R2 fallback is the one that actually has data -- the live
 * API is not expected to serve odds for dates that far in the past.
 *
 * v2's own picks are deliberately excluded from what gets posted -- this
 * backfill exists to fix the control-group sample-size gap, not to touch or
 * duplicate the engine's own historical record.
 *
 * Idempotent: /api/picks/log and /api/picks/settle both write to
 * deterministic keys (track:date:race:engine:pp) -- safe to re-run for a
 * range that's partially already been backfilled.
 *
 * Usage:
 *   node scripts/backfill_control_history.js --track SAR [--from 2026-06-05] [--to 2026-07-20] [--worker-url https://...] [--dry-run]
 */

const { transformEntriesToRaces, attachExpertPicks, buildLogPayloads } = require('./daily_pick_log');
const { normalizeWorkerRace } = require('./backtest/load_corpus');
const { gradePick } = require('./lib/pick_settlement');

const DEFAULT_WORKER_URL = 'https://cloudflare-worker.jhwiv-online.workers.dev';
// Earliest date the R2 entries mirror could possibly have anything -- the
// pre-warmer that populates it didn't exist before this (see file header).
const EARLIEST_POSSIBLE_DATE = '2026-06-05';

function parseArgs(argv) {
  const out = { track: 'SAR', from: null, to: null, workerUrl: DEFAULT_WORKER_URL, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v.toUpperCase(); i++; }
    else if (k === '--from') { out.from = v; i++; }
    else if (k === '--to') { out.to = v; i++; }
    else if (k === '--worker-url') { out.workerUrl = v; i++; }
    else if (k === '--dry-run') { out.dryRun = true; }
  }
  if (!out.from) out.from = EARLIEST_POSSIBLE_DATE;
  if (!out.to) out.to = new Date().toISOString().slice(0, 10);
  return out;
}

/** Inclusive list of YYYY-MM-DD strings from `from` to `to`. */
function dateRange(from, to) {
  const dates = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Fetches a date's entries, preferring the live endpoint and falling back
 * to the R2 mirror. Returns null (not throw) when neither has anything --
 * a normal, expected outcome for a dark day or a date outside R2's coverage,
 * not a failure.
 */
async function fetchEntries(workerUrl, track, date, fetchImpl) {
  const f = fetchImpl || fetch;
  let res = await f(`${workerUrl}/api/entries?track=${track}&date=${date}`);
  if (res.ok) {
    const body = await res.json();
    if (body && Array.isArray(body.races) && body.races.length) return body;
  }
  res = await f(`${workerUrl}/api/entries/r2?track=${track}&date=${date}`);
  if (res.ok) {
    const body = await res.json();
    if (body && Array.isArray(body.races) && body.races.length) return body;
  }
  return null;
}

async function postJson(workerUrl, path, body, fetchImpl) {
  const f = fetchImpl || fetch;
  const res = await f(`${workerUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}`);
  return res.json();
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Backfilling baseline_ml/crowd control history for track=${args.track}, ${args.from}..${args.to}` +
    `${args.dryRun ? ' (DRY RUN -- no writes)' : ''} ...`);

  const dates = dateRange(args.from, args.to);
  const totals = { logged: 0, settled: 0, skippedNoEntries: 0, skippedNoResults: 0, skippedNoGrade: 0, failed: 0 };

  for (const date of dates) {
    const entriesBody = await fetchEntries(args.workerUrl, args.track, date);
    if (!entriesBody) { totals.skippedNoEntries++; continue; }

    let races = transformEntriesToRaces(entriesBody, args.track, date);
    if (!races.length) { totals.skippedNoEntries++; continue; }

    try {
      const epRes = await fetch(`${args.workerUrl}/api/expert-picks?track=${args.track}&date=${date}`);
      if (epRes.ok) races = attachExpertPicks(races, await epRes.json());
    } catch (e) {
      console.warn(`${date}: expert-picks fetch failed (continuing without crowd data): ${e.message}`);
    }

    const historyRes = await fetch(`${args.workerUrl}/api/history/${args.track}/${date}`);
    if (!historyRes.ok) { totals.skippedNoResults++; continue; }
    const historyBody = await historyRes.json();
    const resultsByRaceNum = new Map(
      (historyBody.races || []).map(r => {
        const normalized = normalizeWorkerRace(r, args.track, date);
        return [normalized.num, normalized.results];
      })
    );

    // Control engines only -- see file header on why v2 is out of scope.
    const payloads = buildLogPayloads(races, args.track, date)
      .filter(p => p.engine === 'baseline_ml' || p.engine === 'crowd');

    for (const payload of payloads) {
      const raceResult = resultsByRaceNum.get(payload.race);
      const grade = gradePick(payload, raceResult);
      if (!grade) { totals.skippedNoGrade++; continue; }

      const verdict = grade.won ? `WON $${grade.payout.toFixed(2)}` : 'lost';
      console.log(`${args.dryRun ? '[dry-run] ' : ''}${date} R${payload.race} ${payload.engine}: ${payload.horseName} (pp${payload.pp}) -> ${verdict}`);

      if (args.dryRun) { totals.logged++; totals.settled++; continue; }
      try {
        await postJson(args.workerUrl, '/api/picks/log', payload);
        totals.logged++;
        await postJson(args.workerUrl, '/api/picks/settle', {
          engine: payload.engine, track: payload.track, date: payload.date, race: payload.race, pp: payload.pp,
          position: grade.position, payout: grade.payout, won: grade.won, betType: grade.betType,
        });
        totals.settled++;
      } catch (e) {
        totals.failed++;
        console.error(`Failed ${payload.engine} R${payload.race} ${date}: ${e.message}`);
      }
    }
  }

  console.log(`Done. ${totals.logged} logged, ${totals.settled} settled, ` +
    `${totals.skippedNoEntries} date(s) with no entries source, ` +
    `${totals.skippedNoResults} date(s) with no archived results, ` +
    `${totals.skippedNoGrade} pick(s) skipped (no grade), ${totals.failed} failed.`);
  if (totals.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0))
        .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, dateRange, fetchEntries, postJson };
