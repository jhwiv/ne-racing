'use strict';

/**
 * pick_settlement.js — grades a logged pick against a real race result.
 * Mirrors index.html's settleEnginePicksForRace() exactly (Win-type: does
 * this one horse's pp show up in position 1; Exacta-Box-type: do BOTH named
 * horses occupy the top two, either order, paid at the real exacta payout)
 * so headless settlement (a scheduled job) grades identically to what the
 * live client would compute.
 *
 * Operates on the { finish_positions, exotics } shape
 * scripts/backtest/load_corpus.js's normalizeWorkerRace() already produces
 * from a RACE_HISTORY-archived race.
 */

/**
 * @param {{pp: number, partnerPp?: number|null}} payload - a logged pick (or
 *   the payload about to be logged -- same shape either way).
 * @param {{finish_positions: Array<{pp:number,position:number,win_payout?:number}>, exotics?: Array<{type:string,payout:number}>}} raceResult
 * @returns {{position:number|null, won:boolean, payout:number, betType:string}|null}
 *   null only if there's no result at all yet (race not official). Once a
 *   race IS official, a horse absent from finish_positions is graded as a
 *   confirmed loss (see v2.49.41 note below), never returned as null.
 */
function gradePick(payload, raceResult) {
  if (!raceResult || !Array.isArray(raceResult.finish_positions) || !raceResult.finish_positions.length) return null;

  const finisher = raceResult.finish_positions.find(f => f.pp === payload.pp);
  const position = finisher ? finisher.position : null;

  if (payload.partnerPp) {
    const top2 = raceResult.finish_positions.filter(f => f.position === 1 || f.position === 2);
    const won = top2.length === 2
      && top2.some(f => f.pp === payload.pp)
      && top2.some(f => f.pp === payload.partnerPp);
    const exoticPayout = won ? (raceResult.exotics || []).find(e => e.type === 'exacta') : null;
    return { position, won, payout: exoticPayout ? (parseFloat(exoticPayout.payout) || 0) : 0, betType: 'Exacta Box' };
  }

  // v2.49.41: if this horse isn't among the recorded finishers, the race
  // IS official (finish_positions is non-empty, so the winner is known
  // for certain) -- so this horse definitively did NOT win. Previously
  // this returned null ("can't grade") whenever a pick's horse wasn't
  // found, which silently discarded every real loss for a horse that
  // finished out of the recorded spots -- the vast majority of losses,
  // since typically only the top few finishers get recorded at all. That
  // inflated every tracked source's reported win rate/ROI, since only
  // wins (and rare recorded near-misses) ever counted as settled.
  const won = position === 1;
  const payout = (won && finisher.win_payout != null) ? (parseFloat(finisher.win_payout) || 0) : 0;
  return { position, won, payout, betType: 'Win' };
}

module.exports = { gradePick };
