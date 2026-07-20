'use strict';

/**
 * pick_selection.js — the engine's own recommendation logic (Best Bet, Value
 * Play, Action Bet, Exotic of the Day, Pass), extracted so it can run
 * headlessly (a scheduled job, a backtest) instead of only ever running
 * inside updateTopPicksCard() when a user's browser happens to render the
 * Today tab.
 *
 * This is a faithful, line-for-line port of the selection logic in
 * index.html's updateTopPicksCard() (NOT a reimplementation or
 * simplification) -- the goal is that a headless run produces the exact
 * same picks a user would have seen, so server-side tracking reflects
 * reality. Only the DOM/HTML-building half of updateTopPicksCard is left
 * behind; every decision (who's Best Bet, which two horses get boxed,
 * which races Pass) is reproduced exactly.
 *
 * scoreRace()/scoreCard() (scripts/lib/scoring.js) already produce the
 * per-horse scores this operates on; this module picks up from there.
 */

const { parseOddsToNum } = require('./scoring');

/** Verbatim port of index.html's relativeConfidence(). */
function relativeConfidence(scored, fieldSize) {
  if (!scored || !scored.length) return 'lean';
  if (fieldSize == null) fieldSize = scored.length;
  if (fieldSize < 4) return 'lean';
  const scores = scored.map(s => s.score || 0);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) * (b - mean), 0) / scores.length;
  const std = Math.sqrt(Math.max(variance, 0.0001));
  const topZ = (scores[0] - mean) / std;
  const gap2 = scores.length > 1 ? (scores[0] - scores[1]) / std : topZ;
  const gap2Pct = (mean > 0 && scores.length > 1) ? (scores[0] - scores[1]) / mean : 0;
  if (topZ >= 1.20 && gap2 >= 0.45 && fieldSize >= 5) return 'high';
  if (topZ >= 0.65 && fieldSize >= 4) return 'medium';
  if (gap2Pct >= 0.08 && fieldSize >= 4) return 'medium';
  return 'lean';
}

/** Verbatim port of index.html's isTruePass(). */
function isTruePass(race, scored) {
  if (!scored || !scored.length) return true;
  const live = scored.length;
  if (live <= 3) return true;
  const fullField = (race && Array.isArray(race.horses)) ? race.horses.length : live;
  const scratchedCount = fullField - live;
  if (fullField > 0 && (scratchedCount / fullField) > 0.50) return true;
  const withOdds = scored.filter(s => {
    const ml = s.horse && s.horse.ml;
    return ml && parseOddsToNum(ml) > 0;
  }).length;
  if (withOdds === 0) return true;
  return false;
}

/**
 * Flatten scoreCard()'s [{race, scored}] output into the flat, race+rank
 * annotated shape updateTopPicksCard's `allScores` is built from
 * (runAdviceEngine: `scored.forEach((s, idx) => allScores.push({...s, race, rank: idx+1}))`).
 */
function flattenScoredCard(cardResults) {
  const allScores = [];
  for (const { race, scored } of (cardResults || [])) {
    (scored || []).forEach((s, idx) => {
      allScores.push(Object.assign({}, s, { race, rank: idx + 1 }));
    });
  }
  return allScores;
}

/**
 * Select the day's picks from a flat, race+rank annotated score list (the
 * exact `allScores` shape updateTopPicksCard operates on). Verbatim port of
 * that function's selection logic (lines ~16956-17070 and ~17208-17224 as
 * of this port) -- NOT the HTML-rendering half.
 *
 * @returns {{
 *   bestBet: (scored entry)|null,
 *   valuePlays: Array<scored entry>,   // each may carry ._exactaPartner (scored entry)|null
 *   actionBets: Array<{entry, gap, confidence}>,
 *   exoticOfDay: {race, ex1, ex2}|null,
 *   passRaceNums: number[],
 *   raceInfo: { [raceId]: {gap, confidence, topCompleteness, truePass} },
 * }}
 */
function selectPicks(allScores) {
  const raceMap = {};
  (allScores || []).forEach(s => {
    if (!raceMap[s.race.id]) raceMap[s.race.id] = [];
    raceMap[s.race.id].push(s);
  });

  const raceInfo = {};
  Object.entries(raceMap).forEach(([raceId, group]) => {
    const gap = group.length >= 2 ? group[0].score - group[1].score : 0;
    const topCompleteness = group[0].completeness || 0;
    const fieldSize = group.length;
    const raceObj = group[0] && group[0].race ? group[0].race : { id: raceId };
    const truePass = isTruePass(raceObj, group);
    const confidence = truePass ? 'low' : relativeConfidence(group, fieldSize);
    raceInfo[raceId] = { gap, confidence, topCompleteness, truePass };
  });

  // Best Bet: High conviction wins; else Medium; else any non-Pass, by gap.
  // v2.49.42: within each tier, prefer a race where the model disagrees
  // profitably with the market (overlay > 0) over a same-tier race the
  // market already prices fairly -- see the matching comment in
  // updateTopPicksCard() (app.html/index.html) for the full rationale.
  // Never changes which tier wins, and never leaves Best Bet unpicked
  // when a same-tier candidate exists.
  let bestBetEntry = null;
  let bestGap = -1;
  function scanBestBetTier(matchesTier, requireOverlay) {
    Object.entries(raceMap).forEach(([raceId, group]) => {
      const info = raceInfo[raceId];
      if (info.truePass) return;
      if (!matchesTier(info)) return;
      if (requireOverlay && (group[0].overlay || 0) <= 0) return;
      if (info.gap > bestGap) { bestGap = info.gap; bestBetEntry = group[0]; }
    });
  }
  scanBestBetTier(info => info.confidence === 'high', true);
  if (!bestBetEntry) scanBestBetTier(info => info.confidence === 'high', false);
  if (!bestBetEntry) scanBestBetTier(info => info.confidence === 'medium', true);
  if (!bestBetEntry) scanBestBetTier(info => info.confidence === 'medium', false);
  if (!bestBetEntry) scanBestBetTier(() => true, true);
  if (!bestBetEntry) scanBestBetTier(() => true, false);

  // Value Plays: overlay > 0.08 AND score >= 55, one per race, top 2 by overlay.
  const bestBetRaceId = bestBetEntry ? bestBetEntry.race.id : null;
  const valuePlayCandidatesByRace = {};
  (allScores || []).forEach(s => {
    if ((s.overlay || 0) <= 0.08 || s.score < 55 || s.race.id === bestBetRaceId) return;
    if (raceInfo[s.race.id] && raceInfo[s.race.id].truePass) return;
    const existing = valuePlayCandidatesByRace[s.race.id];
    if (!existing || s.score > existing.score) valuePlayCandidatesByRace[s.race.id] = s;
  });
  const valuePlays = Object.values(valuePlayCandidatesByRace)
    .sort((a, b) => (b.overlay || 0) - (a.overlay || 0))
    .slice(0, 2);
  // Stash the paired Exacta Box partner on each Value Play, same rule the
  // client uses at ticket-render time: pair with whichever of the race's
  // top-2-by-score isn't already the Value Play horse itself.
  valuePlays.forEach(v => {
    const raceGroup = raceMap[v.race.id];
    v._exactaPartner = raceGroup && raceGroup.length > 1 ? raceGroup[v.rank === 1 ? 1 : 0] : null;
  });

  // Action Bets: every non-Pass race that didn't claim Best Bet or a Value Play slot.
  const valueRaceIds = new Set(valuePlays.map(v => v.race.id));
  const actionBets = [];
  Object.entries(raceMap).forEach(([raceId, group]) => {
    const info = raceInfo[raceId];
    if (raceId === bestBetRaceId || valueRaceIds.has(raceId)) return;
    if (info.truePass) return;
    actionBets.push({ entry: group[0], gap: info.gap, confidence: info.confidence });
  });
  actionBets.sort((a, b) => b.entry.score - a.entry.score);
  const topActionBets = actionBets.slice(0, 5);
  const actionRaceIds = new Set(topActionBets.map(a => a.entry.race.id));

  // Pass: only races isTruePass() actually flagged, and that didn't already
  // claim a slot above.
  const passRaceNums = [];
  Object.entries(raceMap).forEach(([raceId, group]) => {
    if (raceId === bestBetRaceId) return;
    if (valueRaceIds.has(raceId)) return;
    if (actionRaceIds.has(raceId)) return;
    if (raceInfo[raceId].truePass) passRaceNums.push(group[0].race.num);
  });

  // Exotic of the Day: the highest-top-score race (2+ live horses, not
  // True-Pass) gets its top-2-by-score boxed, independent of Best Bet/Value
  // Play/Action Bet slot assignment above.
  let bestExoticRace = null;
  let bestExoticScore = -1;
  Object.entries(raceMap).forEach(([raceId, group]) => {
    if (raceInfo[raceId] && raceInfo[raceId].truePass) return;
    if (group.length >= 2 && group[0].score > bestExoticScore) {
      bestExoticScore = group[0].score;
      bestExoticRace = { raceId, group };
    }
  });
  const exoticOfDay = (bestExoticRace && bestExoticRace.group.length >= 2)
    ? { race: bestExoticRace.group[0].race, ex1: bestExoticRace.group[0], ex2: bestExoticRace.group[1] }
    : null;

  return { bestBet: bestBetEntry, valuePlays, actionBets: topActionBets, exoticOfDay, passRaceNums, raceInfo };
}

/** Convenience: score a full card (scoreCard's races[] input) and select picks in one call. */
function selectPicksForCard(races, scoreOpts) {
  const S = require('./scoring');
  const cardResults = S.scoreCard(races, scoreOpts);
  return selectPicks(flattenScoredCard(cardResults));
}

module.exports = { relativeConfidence, isTruePass, flattenScoredCard, selectPicks, selectPicksForCard };
