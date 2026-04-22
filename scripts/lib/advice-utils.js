'use strict';

/**
 * Small pure utility module extracted for unit-testing.
 *
 * These functions mirror logic embedded in index.html:
 *   - countExpertPicks / getExpertNames (expert consensus matching)
 *   - overlay / classifyOverlay (value/overlay badge thresholds)
 *   - exoticBoxCost (exotic ticket combinatorics)
 *
 * Anything surface-level (DOM, storage, fetch) stays in index.html.
 * Keep this file dependency-free so it can run under plain `node --test`.
 */

/**
 * Return true if the expert pick row matches the given horse.
 * Prefers program-number (pp) match; falls back to horse name match.
 * This is AND-with-fallback: we never count a single pick via both keys.
 */
function expertPickMatchesHorse(ep, horse) {
  if (!ep || !horse) return false;
  const hasPp = (ep.pick != null && ep.pick !== '');
  if (hasPp) return ep.pick === horse.pp;
  return !!ep.horseName && !!horse.name && ep.horseName === horse.name;
}

/** Count distinct experts backing `horse`, deduped by source string. */
function countExpertPicks(race, horse) {
  if (!race || !race.expertPicks || !race.expertPicks.length) return 0;
  const seen = Object.create(null);
  let n = 0;
  race.expertPicks.forEach((ep, i) => {
    if (!expertPickMatchesHorse(ep, horse)) return;
    const key = ep.source || ('__' + i);
    if (seen[key]) return;
    seen[key] = 1;
    n++;
  });
  return n;
}

/** Names of experts backing `horse`, deduped. */
function getExpertNames(race, horse) {
  if (!race || !race.expertPicks || !race.expertPicks.length) return [];
  const seen = Object.create(null);
  const out = [];
  race.expertPicks.forEach((ep) => {
    if (!expertPickMatchesHorse(ep, horse)) return;
    const src = (ep.source || '').replace('NYRA - ', '');
    if (seen[src]) return;
    seen[src] = 1;
    out.push(src);
  });
  return out;
}

/**
 * Parse a fractional ML odds string ("5-1", "5/1", "5-2", "6/5") into a
 * decimal-style number (the payout-to-1 ratio). Returns NaN on failure.
 */
function parseOddsToNum(ml) {
  if (ml == null) return NaN;
  const s = String(ml).trim();
  const m = s.match(/^(\d+)\s*[\-\/]\s*(\d+)$/);
  if (!m) {
    const n = parseFloat(s);
    return isFinite(n) ? n : NaN;
  }
  const num = parseInt(m[1], 10), den = parseInt(m[2], 10);
  if (!den) return NaN;
  return num / den;
}

/**
 * Overlay = (modelProb - impliedProb) / impliedProb
 * Both probs in [0,1]. Returns 0 when impliedProb is non-positive.
 */
function overlay(modelProb, impliedProb) {
  if (!impliedProb || impliedProb <= 0) return 0;
  return (modelProb - impliedProb) / impliedProb;
}

/**
 * Classify overlay into a badge bucket. Thresholds match index.html:
 *   > 0.15 → big-overlay
 *   > 0.08 → overlay
 *   < -0.05 → underlay
 *   else   → neutral
 */
function classifyOverlay(o) {
  if (o > 0.15) return 'big-overlay';
  if (o > 0.08) return 'overlay';
  if (o < -0.05) return 'underlay';
  return 'neutral';
}

/**
 * Cost of a boxed exotic ticket at $base per base-unit.
 * key = number of horses boxed; type = 'EX'|'TRI'|'SUPER'.
 */
function exoticBoxCost(type, nHorses, base) {
  const k = Math.max(0, Math.floor(nHorses));
  const b = (base == null) ? 1 : Number(base);
  let legs;
  if (type === 'EX') legs = 2;
  else if (type === 'TRI') legs = 3;
  else if (type === 'SUPER') legs = 4;
  else throw new Error('Unknown exotic type: ' + type);
  if (k < legs) return 0;
  // Permutations P(k, legs)
  let p = 1;
  for (let i = 0; i < legs; i++) p *= (k - i);
  return p * b;
}

module.exports = {
  expertPickMatchesHorse,
  countExpertPicks,
  getExpertNames,
  parseOddsToNum,
  overlay,
  classifyOverlay,
  exoticBoxCost,
};
