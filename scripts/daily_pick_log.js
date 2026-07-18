#!/usr/bin/env node
'use strict';

/**
 * daily_pick_log.js — computes and logs the day's picks to the server-side
 * ENGINE_ACCURACY system, independent of whether any user ever opens the
 * app. Closes a real gap: previously, picks only got logged when a user's
 * browser happened to render the Today tab (storeTicketPicks/
 * logTicketPicksToEngine, index.html), so a day nobody opened the app was
 * invisible to the server-side tracker.
 *
 * Also logs two control-group alternatives for the day's Best Bet, using
 * the SAME already-built pick/settle/stats system (worker.js's PICK_ENGINES
 * already includes "baseline_ml" and "crowd" for exactly this):
 *   - baseline_ml: the market's own favorite in that race -- a genuinely
 *     independent opinion (unlike comparing v1 vs v2, which are both
 *     hand-tuned heuristics built with the same reasoning and likely share
 *     the same blind spots).
 *   - crowd: the NYRA handicapper-consensus pick (data/entries-*.json's
 *     scraped expertPicks), when at least 2 handicappers agree.
 * v2.49.40: logged on EVERY race with a valid signal, regardless of
 * whether it matches the engine's own pick. The original version only
 * logged these when they DIFFERED from our pick ("avoiding redundant
 * noise") -- but that silently discards every race where they agreed with
 * us, leaving a tiny, biased sample that can't fairly answer "does our
 * engine actually add value." A control group has to track the full
 * population, not just the disagreement cases.
 * Scoped to the Best Bet slot only (the headline recommendation) -- not
 * every Value Play/Action Bet -- to keep this comparison focused and the
 * script's surface area manageable; the engine's own picks are still fully
 * logged for every slot, matching what a user opening the app would see.
 *
 * Real network access required (calls the worker's already-licensed
 * /api/entries, /api/expert-picks, /api/picks/log) -- run from
 * .github/workflows/daily-pick-log.yml, not interactively in this sandbox.
 *
 * Usage:
 *   node scripts/daily_pick_log.js --track SAR [--date 2026-07-13] [--worker-url https://...]
 */

const { scoreCard, parseOddsToNum, countExpertPicks } = require('./lib/scoring');
const { selectPicks, flattenScoredCard } = require('./lib/pick_selection');

const DEFAULT_WORKER_URL = 'https://cloudflare-worker.jhwiv-online.workers.dev';

function parseArgs(argv) {
  const out = { track: 'SAR', date: null, workerUrl: DEFAULT_WORKER_URL };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--track') { out.track = v.toUpperCase(); i++; }
    else if (k === '--date') { out.date = v; i++; }
    else if (k === '--worker-url') { out.workerUrl = v; i++; }
  }
  if (!out.date) out.date = new Date().toISOString().slice(0, 10);
  return out;
}

/**
 * Transform GET /api/entries's response shape (raceNumber, entries:[...])
 * into the shape scoreCard()/selectPicks() expect (num, horses:[...]).
 * The entries endpoint's runners already carry real speedFigs/runningStyle/
 * jockeyPct/trainerPct/lastClass -- worker.js enriches + merges the Brisnet
 * PP overlay server-side before this ever reaches a caller (see
 * handleEntries's enrichEntriesWithScoringFields/mergeBrisnetIntoEntries).
 */
function transformEntriesToRaces(entriesBody, track, date) {
  const races = (entriesBody && entriesBody.races) || [];
  return races.map(rc => {
    const num = rc.raceNumber;
    const horses = (rc.entries || []).map(e => ({
      pp: e.pp,
      name: e.horseName,
      ml: e.ml,
      jockey: e.jockey,
      trainer: e.trainer,
      speedFigs: Array.isArray(e.speedFigs) ? e.speedFigs : [null, null, null],
      runningStyle: e.runningStyle || '',
      jockeyPct: e.jockeyPct || 0,
      trainerPct: e.trainerPct || 0,
      lastClass: e.lastClass || null,
      scratched: e.status === 'SCRATCHED',
    }));
    return {
      id: `${track}-${date.replace(/-/g, '')}-R${num}`,
      track, date, num,
      type: rc.raceTypeCode || null,
      horses,
      expertPicks: [], // attached separately once /api/expert-picks is fetched
    };
  });
}

/** Merge GET /api/expert-picks's { expertPicks: [{race, picks}] } onto races[].expertPicks. */
function attachExpertPicks(races, expertPicksBody) {
  const byRace = new Map((expertPicksBody && expertPicksBody.expertPicks || []).map(r => [r.race, r.picks]));
  races.forEach(race => {
    race.expertPicks = byRace.get(race.num) || [];
  });
  return races;
}

/** The NYRA handicapper-consensus pick for a race: the horse >=2 sources agree on, if any. */
function computeCrowdPick(race) {
  let best = null, bestCount = 0;
  (race.horses || []).forEach(h => {
    const c = countExpertPicks(race, h);
    if (c > bestCount) { bestCount = c; best = h; }
  });
  return (bestCount >= 2 && best) ? { horse: best, matchCount: bestCount } : null;
}

/** The market's own favorite (lowest ML odds) in a race. */
function computeMlFavorite(race) {
  let best = null, bestOdds = Infinity;
  (race.horses || []).forEach(h => {
    if (h.scratched) return;
    const o = parseOddsToNum(h.ml);
    if (isFinite(o) && o > 0 && o < bestOdds) { bestOdds = o; best = h; }
  });
  return best ? { horse: best } : null;
}

/**
 * Build the full set of /api/picks/log payloads for a scored, picked card.
 * Engine picks (v2) are logged for every slot, matching what a live user
 * would generate; baseline_ml/crowd alternatives are scoped to Best Bet only
 * (see file header).
 */
function buildLogPayloads(races, track, date) {
  const cardResults = scoreCard(races, { version: 'v2', today: date });
  const allScores = flattenScoredCard(cardResults);
  const picks = selectPicks(allScores);
  const payloads = [];

  function push(engine, betTag, entry, extra) {
    payloads.push(Object.assign({
      engine, track, date, race: entry.race.num, pp: entry.horse.pp,
      horseName: entry.horse.name, betType: 'Win', betTag,
      amount: 2, score: entry.score != null ? entry.score : null,
      prob: entry.modelProb != null ? entry.modelProb : null,
      ml: entry.horse.ml || null,
      deviceId: 'server-cron',
    }, extra || {}));
  }

  if (picks.bestBet) {
    push('v2', 'best', picks.bestBet);
    // v2.49.40: log baseline_ml/crowd on EVERY race with a valid signal,
    // regardless of whether it matches our own pick. These exist to act as
    // an independent control group -- only logging them when they DIFFER
    // from our pick (the original v2.49.34 design) silently throws away
    // every race where they agreed with us, leaving a tiny, biased sample
    // that can't fairly answer "does our engine actually add value over
    // the market/crowd." A control has to track the full population.
    const mlFav = computeMlFavorite(picks.bestBet.race);
    if (mlFav) {
      push('baseline_ml', 'best', { race: picks.bestBet.race, horse: mlFav.horse });
    }
    const crowd = computeCrowdPick(picks.bestBet.race);
    if (crowd) {
      push('crowd', 'best', { race: picks.bestBet.race, horse: crowd.horse });
    }
  }
  picks.valuePlays.forEach(v => {
    const partner = v._exactaPartner;
    push('v2', 'value', v, partner ? {
      betType: 'Exacta Box', partnerPp: partner.horse.pp, partnerName: partner.horse.name, amount: 4,
    } : {});
  });
  picks.actionBets.forEach(a => push('v2', 'action', a.entry));

  return payloads;
}

async function postPick(workerUrl, payload) {
  const res = await fetch(workerUrl + '/api/picks/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`POST /api/picks/log -> ${res.status} for ${payload.engine}:${payload.betTag}:R${payload.race}`);
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`Logging picks for track=${args.track} date=${args.date} ...`);

  const entriesRes = await fetch(`${args.workerUrl}/api/entries?track=${args.track}&date=${args.date}`);
  if (entriesRes.status === 404) {
    // handleEntries returns 404 with "No NA meet for {track} on {date}" when
    // there's simply no race card scheduled that day (e.g. a dark day) --
    // not a failure, same as the zero-races case below.
    console.log(`No meet scheduled for ${args.track} on ${args.date} -- nothing to log.`);
    return;
  }
  if (!entriesRes.ok) throw new Error(`GET /api/entries -> ${entriesRes.status}`);
  const entriesBody = await entriesRes.json();

  let races = transformEntriesToRaces(entriesBody, args.track, args.date);
  if (!races.length) {
    console.log('No races found for this date -- nothing to log.');
    return;
  }

  try {
    const epRes = await fetch(`${args.workerUrl}/api/expert-picks?track=${args.track}&date=${args.date}`);
    if (epRes.ok) races = attachExpertPicks(races, await epRes.json());
  } catch (e) {
    console.warn(`expert-picks fetch failed (continuing without crowd data): ${e.message}`);
  }

  const payloads = buildLogPayloads(races, args.track, args.date);
  console.log(`Posting ${payloads.length} picks (engine v2: ${payloads.filter(p => p.engine === 'v2').length}, ` +
    `baseline_ml: ${payloads.filter(p => p.engine === 'baseline_ml').length}, crowd: ${payloads.filter(p => p.engine === 'crowd').length}) ...`);

  let failures = 0;
  for (const payload of payloads) {
    try { await postPick(args.workerUrl, payload); }
    catch (e) { failures++; console.error(e.message); }
  }
  console.log(`Done. ${payloads.length - failures}/${payloads.length} logged successfully.`);
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().then(() => process.exit(process.exitCode || 0))
        .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { parseArgs, transformEntriesToRaces, attachExpertPicks, computeCrowdPick, computeMlFavorite, buildLogPayloads };
