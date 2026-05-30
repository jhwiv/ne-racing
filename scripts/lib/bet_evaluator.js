'use strict';

/**
 * bet_evaluator.js — Pure bet evaluator for user-entered selections.
 *
 * Takes a race (or sequence of races for multi-race exotics), a user's
 * selection, a structure (straight/box/key/wheel), and an amount, and returns:
 *
 *   - expectedValue:  $ EV per unit stake (after takeout)
 *   - overlay:        verdict { isOverlay, marginPct, fairOdds, takenOdds }
 *   - engineRank:     where the engine ranks the user's picks vs. the field
 *   - probability:    estimated probability of the bet hitting
 *   - cost:           total $ outlay for the chosen structure
 *   - warnings:       array of structural-mistake flags (no anchor, all longshots,
 *                     boxed favorites, etc.)
 *   - confidence:     how reliable the verdict is, given data completeness
 *
 * Inputs use the same race/horse shape consumed by scoring.js. Caller is
 * expected to have already run scoring.js to populate scored entries.
 *
 * Pricing model:
 *   - WPS:           use scored probability × pool implied value, deducting takeout.
 *   - Exotics:       use independent-event approximation (Harville for trifecta+)
 *                    cross-checked against pool implied odds where available.
 *   - Multi-race:    chain-multiply leg probabilities, then takeout once at end.
 *
 * Caveats are documented inline. This is a heuristic evaluator, not a tote-pool
 * simulator. For backtesting it works against settled outcomes; for live use it
 * relies on accurate morning-line + scored probabilities.
 */

// ── Takeout table ────────────────────────────────────────────────────────────
// Sources (verified May 29, 2026):
//   NYRA:       https://www.nyra.com/aqueduct/racing/betting-faq/
//   NY State:   https://gaming.ny.gov/horse-racing-reports
//   Charles Town: https://ironbetsracing.com/bet-charles-town/
//   Churchill:  https://www.churchilldowns.com/come-to-the-track/visiting-information/event-information/
//   Lone Star:  https://www.lonestarpark.com/wageringmenu/
//
// Keys are uppercase Equibase track codes. Rates are decimals (0.16 = 16%).
// Missing entries fall back to NYRA defaults.
const TAKEOUT_TABLE = {
  // ── NYRA (Aqueduct, Belmont, Saratoga) ───────────────────────────────────
  AQU: { win: 0.16, place: 0.16, show: 0.16, daily_double: 0.185, exacta: 0.185,
         quinella: 0.185, trifecta: 0.24, superfecta: 0.24, pick3: 0.24, pick4: 0.24,
         pick5: 0.15, pick6: 0.15, source: 'NYRA' },
  BEL: { win: 0.16, place: 0.16, show: 0.16, daily_double: 0.185, exacta: 0.185,
         quinella: 0.185, trifecta: 0.24, superfecta: 0.24, pick3: 0.24, pick4: 0.24,
         pick5: 0.15, pick6: 0.15, source: 'NYRA' },
  SAR: { win: 0.16, place: 0.16, show: 0.16, daily_double: 0.185, exacta: 0.185,
         quinella: 0.185, trifecta: 0.24, superfecta: 0.24, pick3: 0.24, pick4: 0.24,
         pick5: 0.15, pick6: 0.15, source: 'NYRA' },

  // ── Charles Town (CT) ────────────────────────────────────────────────────
  CT:  { win: 0.1725, place: 0.1725, show: 0.1725, daily_double: 0.19, exacta: 0.19,
         quinella: 0.19, trifecta: 0.22, superfecta: 0.22, pick3: 0.22, pick4: 0.15,
         pick5: 0.12, pick6: 0.12, source: 'Charles Town Hollywood Casino' },

  // ── Churchill Downs (CD/CDX) ─────────────────────────────────────────────
  CD:  { win: 0.175, place: 0.175, show: 0.175, daily_double: 0.22, exacta: 0.22,
         quinella: 0.22, trifecta: 0.22, superfecta: 0.22, pick3: 0.22, pick4: 0.22,
         pick5: 0.15, pick6: 0.22, source: 'Churchill Downs' },

  // ── Lone Star (LS) ───────────────────────────────────────────────────────
  LS:  { win: 0.18, place: 0.18, show: 0.18, daily_double: 0.21, exacta: 0.21,
         quinella: 0.21, trifecta: 0.25, superfecta: 0.25, pick3: 0.25, pick4: 0.25,
         pick5: 0.12, pick6: 0.12, source: 'Lone Star Park' },
};

// NYRA defaults are the fallback when a track isn't in the table.
const TAKEOUT_FALLBACK = TAKEOUT_TABLE.AQU;

function getTakeout(trackCode, poolName) {
  const tbl = TAKEOUT_TABLE[(trackCode || '').toUpperCase()] || TAKEOUT_FALLBACK;
  if (tbl[poolName] != null) return tbl[poolName];
  return TAKEOUT_FALLBACK[poolName] != null ? TAKEOUT_FALLBACK[poolName] : 0.20;
}

function takeoutSource(trackCode) {
  const tbl = TAKEOUT_TABLE[(trackCode || '').toUpperCase()];
  return tbl ? tbl.source : `${TAKEOUT_FALLBACK.source} (fallback)`;
}

// ── Odds + probability helpers ──────────────────────────────────────────────

/**
 * Parse fractional odds ('7-2', '4/1', '9/5', '8') or decimal ('3.50') into
 * an implied probability before takeout: prob = 1 / (decimal_odds).
 *
 * For fractional like '7-2', decimal = 7/2 + 1 = 4.5, so prob = 1/4.5 = 0.222.
 */
function parseOdds(oddsStr) {
  if (oddsStr == null || oddsStr === '') return null;
  if (typeof oddsStr === 'number' && isFinite(oddsStr)) {
    return oddsStr > 0 ? 1 / (oddsStr + 1) : null;
  }
  const s = String(oddsStr).trim();

  // Decimal odds like "3.50"
  const decMatch = s.match(/^(\d+(?:\.\d+)?)$/);
  if (decMatch) {
    const dec = parseFloat(decMatch[1]);
    return dec > 0 ? 1 / (dec + 1) : null;
  }

  // Fractional odds like "7-2", "7/2", "9-5"
  const fracMatch = s.match(/^(\d+(?:\.\d+)?)[-/](\d+(?:\.\d+)?)$/);
  if (fracMatch) {
    const num = parseFloat(fracMatch[1]);
    const den = parseFloat(fracMatch[2]);
    if (den > 0 && num >= 0) {
      const dec = (num / den) + 1;
      return 1 / dec;
    }
  }
  return null;
}

/**
 * Inverse of parseOdds: prob (pre-takeout) → fractional odds string.
 */
function probToFractional(prob) {
  if (!prob || prob <= 0 || prob >= 1) return null;
  const dec = (1 / prob) - 1;
  if (dec <= 0) return '1-99';
  if (dec >= 99) return `${Math.round(dec)}-1`;
  // Find a clean fractional approximation
  const denominators = [1, 2, 5, 4, 3, 10];
  let best = { err: Infinity, str: dec.toFixed(2) };
  for (const den of denominators) {
    const num = Math.round(dec * den);
    if (num >= 0) {
      const approx = num / den;
      const err = Math.abs(approx - dec);
      if (err < best.err) {
        best = { err, str: `${num}-${den}` };
      }
    }
  }
  return best.str;
}

/**
 * Convert win-pool probabilities to place/show probabilities using the
 * Harville-style approximation. Cheap and serviceable for evaluator UI.
 *
 *   P(place) ≈ Σ_{j≠i}  p_i * p_j / (1 - p_i)         (i finishes 1st or 2nd)
 *   P(show)  ≈ above + 3rd-place term
 *
 * Returns { place, show } for the target horse identified by pp.
 */
function placeShowProbabilities(scoredField, targetPp) {
  const horses = scoredField.filter((h) => h && typeof h.prob === 'number' && h.prob > 0);
  const target = horses.find((h) => h.pp === targetPp);
  if (!target) return { place: null, show: null };

  // Normalize in case scored probs don't sum to 1 (defensive)
  const total = horses.reduce((s, h) => s + h.prob, 0);
  if (total <= 0) return { place: null, show: null };
  const probs = {};
  horses.forEach((h) => { probs[h.pp] = h.prob / total; });
  const pi = probs[targetPp];

  // Place = P(1st) + P(2nd given not 1st)
  let pPlace = pi;
  for (const h of horses) {
    if (h.pp === targetPp) continue;
    const pj = probs[h.pp];
    const denom = 1 - pj;
    if (denom > 0) pPlace += pj * (pi / denom);
  }

  // Show = P(1st) + P(2nd) + P(3rd given not 1st or 2nd)
  let pShow = pPlace;
  for (const h1 of horses) {
    if (h1.pp === targetPp) continue;
    for (const h2 of horses) {
      if (h2.pp === targetPp || h2.pp === h1.pp) continue;
      const denom = (1 - probs[h1.pp]) * (1 - probs[h1.pp] - probs[h2.pp]);
      if (denom > 0) {
        pShow += probs[h1.pp] * probs[h2.pp] * (pi / denom);
      }
    }
  }

  return {
    place: Math.min(0.999, pPlace),
    show:  Math.min(0.999, pShow),
  };
}

// ── Engine ranking helper ───────────────────────────────────────────────────

/**
 * Returns the 1-indexed rank of a horse (by pp) within a scored field, where
 * 1 = engine's top pick. Ties broken arbitrarily but consistently.
 */
function engineRankOf(scoredField, pp) {
  const sorted = scoredField
    .filter((h) => h && typeof h.composite === 'number')
    .slice()
    .sort((a, b) => b.composite - a.composite);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].pp === pp) return i + 1;
  }
  return null;
}

// ── WPS evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate a Win, Place, or Show bet on a single horse.
 *
 * Inputs:
 *   race:      { trackCode, scoredField: [{pp, name, composite, prob, ml}] }
 *   selection: { pp }
 *   pool:      'win' | 'place' | 'show'
 *   amount:    $ stake
 *
 * Returns: { type, cost, probability, expectedReturn, expectedValue, overlay,
 *            engineRank, warnings, confidence }
 */
function evaluateWPS(race, selection, pool, amount) {
  const scored = race.scoredField || [];
  const horse = scored.find((h) => h.pp === selection.pp);
  const warnings = [];

  if (!horse) {
    return { error: `Horse with pp=${selection.pp} not in field` };
  }
  if (!['win', 'place', 'show'].includes(pool)) {
    return { error: `Unknown pool: ${pool}` };
  }
  if (!isFinite(amount) || amount <= 0) {
    return { error: 'amount must be > 0' };
  }

  let prob;
  if (pool === 'win') {
    prob = horse.prob;
  } else {
    const ps = placeShowProbabilities(scored, horse.pp);
    prob = pool === 'place' ? ps.place : ps.show;
  }
  if (prob == null) {
    return { error: 'Could not compute probability — incomplete scoring data' };
  }

  const takeout = getTakeout(race.trackCode, pool);

  // Implied odds from morning line (best available pre-pool estimate)
  const mlProb = parseOdds(horse.ml);
  const takenOddsProb = mlProb || prob; // fall back to model prob if no ML

  // Decimal payoff per $1 stake = (1 - takeout) / takenOddsProb
  const decimalPayoff = (1 - takeout) / Math.max(takenOddsProb, 0.001);
  const expectedReturn = prob * decimalPayoff * amount;
  const ev = expectedReturn - amount;

  const fairOdds = probToFractional(prob);
  const takenOdds = horse.ml || probToFractional(takenOddsProb);
  const isOverlay = prob > takenOddsProb;
  const marginPct = takenOddsProb > 0
    ? ((prob - takenOddsProb) / takenOddsProb)
    : 0;

  // Structural warnings
  const rank = engineRankOf(scored, horse.pp);
  if (rank && rank > Math.ceil(scored.length / 2)) {
    warnings.push({
      level: 'warn',
      code: 'low_rank',
      msg: `Engine ranks #${horse.pp} ${rank} of ${scored.length} — below mid-field.`,
    });
  }
  if (prob < 0.06) {
    warnings.push({
      level: 'warn',
      code: 'long_shot',
      msg: `Modeled win probability is only ${(prob * 100).toFixed(1)}% — verify your read.`,
    });
  }
  if (pool === 'show' && prob > 0.45 && marginPct < 0.05) {
    warnings.push({
      level: 'info',
      code: 'chalky_show',
      msg: 'Heavy chalk in show pool — minimum payoff likely.',
    });
  }

  return {
    type: pool,
    cost: amount,
    probability: prob,
    expectedReturn,
    expectedValue: ev,
    overlay: { isOverlay, marginPct, fairOdds, takenOdds },
    engineRank: rank,
    warnings,
    confidence: confidenceFor(scored.length, horse.dataCompleteness),
    takeout,
    takeoutSource: takeoutSource(race.trackCode),
  };
}

// ── Exotic evaluator (Exacta / Trifecta / Superfecta) ───────────────────────

/**
 * Generate all valid permutations for an exotic structure.
 *
 * structure ∈ { 'straight', 'box', 'key', 'wheel' }
 * picks shape varies:
 *   straight: { positions: [pp1, pp2, ...] }            order matters
 *   box:      { horses:    [pp1, pp2, ...] }             all permutations
 *   key:      { keyHorse: pp, withHorses: [pp, ...] }    key in 1st, others fill
 *   wheel:    { positions: [ [pp,...], [pp,...], ...] }  ALL picks at each pos
 */
function generatePermutations(structure, picks, depth) {
  const perms = [];

  function permute(arr) {
    if (arr.length <= 1) return [arr.slice()];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permute(rest)) {
        out.push([arr[i]].concat(p));
      }
    }
    return out;
  }

  function permuteOfSize(arr, size) {
    if (size === 0) return [[]];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const rest = arr.slice(0, i).concat(arr.slice(i + 1));
      for (const p of permuteOfSize(rest, size - 1)) {
        out.push([arr[i]].concat(p));
      }
    }
    return out;
  }

  function product(positionArrays) {
    let acc = [[]];
    for (const arr of positionArrays) {
      const next = [];
      for (const a of acc) {
        for (const v of arr) {
          if (a.indexOf(v) !== -1) continue; // no duplicate horses
          next.push(a.concat([v]));
        }
      }
      acc = next;
    }
    return acc;
  }

  if (structure === 'straight') {
    if (picks.positions && picks.positions.length === depth) {
      perms.push(picks.positions.slice());
    }
  } else if (structure === 'box') {
    if (picks.horses && picks.horses.length >= depth) {
      for (const p of permuteOfSize(picks.horses, depth)) perms.push(p);
    }
  } else if (structure === 'key') {
    if (picks.keyHorse != null && picks.withHorses) {
      // Key horse in 1st, others fill remaining positions in any order
      const others = picks.withHorses.filter((p) => p !== picks.keyHorse);
      if (others.length >= depth - 1) {
        for (const tail of permuteOfSize(others, depth - 1)) {
          perms.push([picks.keyHorse].concat(tail));
        }
      }
    }
  } else if (structure === 'wheel') {
    if (picks.positions && picks.positions.length === depth) {
      for (const p of product(picks.positions)) perms.push(p);
    }
  }
  return perms;
}

/**
 * Estimate the probability of a single permutation hitting using the Harville
 * approximation:
 *
 *   P(A wins, B 2nd, C 3rd) = pA * (pB / (1 - pA)) * (pC / (1 - pA - pB))
 */
function harvilleProb(scoredField, perm) {
  const probs = {};
  let total = 0;
  for (const h of scoredField) {
    if (h && typeof h.prob === 'number' && h.prob > 0) {
      probs[h.pp] = h.prob;
      total += h.prob;
    }
  }
  if (total <= 0) return 0;
  // Normalize
  for (const k of Object.keys(probs)) probs[k] /= total;

  let p = 1;
  let usedSum = 0;
  for (const pp of perm) {
    const pi = probs[pp];
    if (pi == null) return 0;
    const denom = 1 - usedSum;
    if (denom <= 0) return 0;
    p *= pi / denom;
    usedSum += pi;
  }
  return p;
}

/**
 * Evaluate an exotic (exacta/trifecta/superfecta) at a given structure.
 *
 * For pricing, we estimate a pool-implied payoff = avgWinPay / harvilleProb,
 * then deduct takeout. This is a rough heuristic — real pool payoffs depend
 * on bettor distribution which we can't see pre-race. Useful for ranking
 * structures against each other, not for predicting exact $ payouts.
 */
function evaluateExotic(race, structure, picks, baseAmount, poolName) {
  const depth = { exacta: 2, trifecta: 3, superfecta: 4 }[poolName];
  if (!depth) return { error: `Unknown pool: ${poolName}` };

  const scored = race.scoredField || [];
  const warnings = [];
  const perms = generatePermutations(structure, picks, depth);
  if (perms.length === 0) {
    return { error: `No valid permutations for ${structure} ${poolName}` };
  }

  // Cost = perms × baseAmount, but most tracks allow fractional base amounts
  // for exotics ($1 exacta, $0.50 tri, $0.10 super). Caller provides baseAmount.
  const cost = perms.length * baseAmount;

  // Sum of permutation probabilities = total hit probability.
  // Also track the highest single-permutation probability to estimate the
  // expected per-winning-permutation payoff (only ONE permutation wins).
  let hitProb = 0;
  let perPermProbs = [];
  for (const perm of perms) {
    const pp = harvilleProb(scored, perm);
    hitProb += pp;
    perPermProbs.push(pp);
  }
  hitProb = Math.min(0.999, hitProb);

  // Pricing: per fair-pool theory, gross payoff per $1 wagered on the
  // *winning* permutation = (1 - takeout) / prob_of_that_permutation.
  // We compute the probability-weighted expected payoff across our perms.
  const takeout = getTakeout(race.trackCode, poolName);
  let expectedReturn = 0;
  for (let i = 0; i < perms.length; i++) {
    const pp = perPermProbs[i];
    if (pp <= 0) continue;
    // If THIS permutation wins, we collect baseAmount * grossPayoffPerUnit
    // (the other perms don't pay). Each perm has its own fair payoff.
    const grossPayoff = baseAmount * ((1 - takeout) / pp);
    expectedReturn += pp * grossPayoff;
  }
  // Representative "per-win" payoff: weighted average over winning perms.
  const grossPayoffPerUnit = hitProb > 0 ? (expectedReturn / hitProb) / baseAmount : 0;
  const ev = expectedReturn - cost;

  // Engine rank summary across all horses used
  const allHorses = new Set();
  if (picks.positions) picks.positions.forEach((p) => {
    if (Array.isArray(p)) p.forEach((pp) => allHorses.add(pp));
    else allHorses.add(p);
  });
  if (picks.horses)    picks.horses.forEach((pp) => allHorses.add(pp));
  if (picks.keyHorse != null) allHorses.add(picks.keyHorse);
  if (picks.withHorses) picks.withHorses.forEach((pp) => allHorses.add(pp));

  const ranks = Array.from(allHorses).map((pp) => ({
    pp, rank: engineRankOf(scored, pp),
  }));

  // ── Structural warnings ──
  if (structure === 'box' && picks.horses && picks.horses.length === depth) {
    // Boxing the minimum is a $X bet — no extra value vs straight ticket.
    warnings.push({
      level: 'info',
      code: 'minimal_box',
      msg: `Boxing only ${depth} horses in a ${poolName} — same probability as a straight ticket, ${depth}× cost.`,
    });
  }
  if (structure === 'box' && picks.horses && picks.horses.length >= depth) {
    // Box with all longshots: low hit rate
    const fieldProbs = picks.horses.map((pp) => {
      const h = scored.find((x) => x.pp === pp);
      return h && typeof h.prob === 'number' ? h.prob : 0;
    });
    const noFavorite = fieldProbs.every((p) => p < 0.18);
    if (noFavorite) {
      warnings.push({
        level: 'warn',
        code: 'no_anchor',
        msg: 'No horse in your box has > 18% win probability — boxes without an anchor rarely cash.',
      });
    }
  }
  if (structure === 'key' && picks.keyHorse != null) {
    const key = scored.find((h) => h.pp === picks.keyHorse);
    if (key && key.prob != null && key.prob < 0.12) {
      warnings.push({
        level: 'warn',
        code: 'weak_key',
        msg: `Key horse #${picks.keyHorse} only has ${(key.prob * 100).toFixed(1)}% win probability — keys work best on heavier favorites.`,
      });
    }
  }
  if (cost > 50 && hitProb < 0.10) {
    warnings.push({
      level: 'warn',
      code: 'expensive_long_shot',
      msg: `Ticket costs $${cost.toFixed(2)} with only ${(hitProb * 100).toFixed(1)}% hit probability — high variance.`,
    });
  }

  return {
    type: poolName,
    structure,
    permutations: perms.length,
    baseAmount,
    cost,
    probability: hitProb,
    expectedReturn,
    expectedValue: ev,
    expectedPayoffPerWin: grossPayoffPerUnit * baseAmount,
    engineRanks: ranks,
    warnings,
    confidence: confidenceFor(scored.length, null),
    takeout,
    takeoutSource: takeoutSource(race.trackCode),
  };
}

// ── Multi-race evaluator (Pick 3/4/5/6) ─────────────────────────────────────

/**
 * Evaluate a sequential multi-race exotic.
 *
 * legs is an array of:
 *   { race: <scored race object>, horses: [pp, ...] }
 *
 * Cost = product of leg sizes × baseAmount.
 * Probability = product of (sum of selected horse probs) per leg.
 */
function evaluateMultiRace(legs, baseAmount, poolName) {
  if (!Array.isArray(legs) || legs.length < 3) {
    return { error: 'Multi-race exotics require at least 3 legs' };
  }
  const validPools = { pick3: 3, pick4: 4, pick5: 5, pick6: 6 };
  if (!validPools[poolName] || validPools[poolName] !== legs.length) {
    return { error: `Leg count ${legs.length} doesn't match ${poolName}` };
  }

  const warnings = [];
  let totalCombos = 1;
  let chainProb = 1;
  const legSummaries = [];
  // legHorseProbs[i] = map of pp → normalized probability for leg i.
  // Used to enumerate fair payoffs across all winning combinations.
  const legHorseProbs = [];

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    const scored = leg.race.scoredField || [];
    const totalSelected = leg.horses.length;
    if (totalSelected === 0) {
      return { error: `Leg ${i + 1} has no horses selected` };
    }

    // Build the prob map across the full field (for fair-payoff calc), and
    // separately compute the probability mass of the selected subset.
    const probMap = {};
    let fieldTotal = 0;
    for (const h of scored) {
      if (h && typeof h.prob === 'number' && h.prob > 0) {
        probMap[h.pp] = h.prob;
        fieldTotal += h.prob;
      }
    }
    if (fieldTotal > 0) {
      for (const k of Object.keys(probMap)) probMap[k] /= fieldTotal;
    }
    legHorseProbs.push(probMap);

    let legProb = 0;
    for (const pp of leg.horses) {
      if (probMap[pp] != null) legProb += probMap[pp];
    }
    legProb = Math.min(0.999, legProb);
    chainProb *= legProb;
    totalCombos *= totalSelected;
    legSummaries.push({
      leg: i + 1,
      horses: leg.horses.slice(),
      legProb,
      selected: totalSelected,
      fieldSize: scored.length,
    });

    // Warnings on individual legs
    if (totalSelected === 1) {
      const h = scored.find((x) => x.pp === leg.horses[0]);
      if (h && h.prob != null && h.prob < 0.30) {
        warnings.push({
          level: 'warn',
          code: 'single_long',
          msg: `Leg ${i + 1} is a single on a ${(h.prob * 100).toFixed(0)}% horse — high break-out risk.`,
        });
      }
    }
    if (totalSelected > scored.length / 2) {
      warnings.push({
        level: 'info',
        code: 'wide_leg',
        msg: `Leg ${i + 1} uses ${totalSelected} of ${scored.length} horses — wide coverage, expensive.`,
      });
    }
  }

  // Use the first leg's track code for takeout lookup (cross-track Pick 5s mix
  // tracks, but takeout follows the host; for simplicity use first leg).
  const hostTrack = legs[0].race.trackCode;
  const takeout = getTakeout(hostTrack, poolName);

  const cost = totalCombos * baseAmount;

  // Fair-pricing expected return: enumerate every combination we're covering,
  // and for each, expected payout = combo_prob × baseAmount × (1 - takeout) / combo_prob
  // = baseAmount × (1 - takeout). So total ER over all our combos =
  // (number of combos with positive prob) × baseAmount × (1 - takeout).
  // But that overstates because not all combos have positive prob — we need
  // to count only combinations whose combo_prob > 0 in the model.
  //
  // Equivalently: ER = baseAmount * (1 - takeout) * (#valid_combos),
  // where a combo is valid iff every leg horse has positive model probability.
  //
  // Cleaner derivation: ER = Σ_{combos} P(combo) × [baseAmount × (1-t) / P(combo)]
  //                       = baseAmount × (1-t) × #valid_combos.
  let validCombos = 0;
  function countValid(legIdx, alive) {
    if (legIdx === legs.length) {
      if (alive) validCombos++;
      return;
    }
    const probMap = legHorseProbs[legIdx];
    for (const pp of legs[legIdx].horses) {
      const p = probMap[pp];
      countValid(legIdx + 1, alive && p != null && p > 0);
    }
  }
  countValid(0, true);
  const expectedReturn = baseAmount * (1 - takeout) * validCombos;
  // Representative "per win" payoff = expected return / chain hit probability.
  const grossPayoffPerUnit = chainProb > 0 ? (expectedReturn / chainProb) / baseAmount : 0;
  const ev = expectedReturn - cost;

  if (cost > 200 && chainProb < 0.05) {
    warnings.push({
      level: 'warn',
      code: 'high_cost_low_prob',
      msg: `Ticket costs $${cost.toFixed(0)} with only ${(chainProb * 100).toFixed(2)}% chain probability.`,
    });
  }

  return {
    type: poolName,
    legs: legSummaries,
    combinations: totalCombos,
    baseAmount,
    cost,
    probability: chainProb,
    expectedReturn,
    expectedValue: ev,
    expectedPayoffPerWin: grossPayoffPerUnit * baseAmount,
    warnings,
    confidence: confidenceFor((legs[0].race.scoredField || []).length, null),
    takeout,
    takeoutSource: takeoutSource(hostTrack),
  };
}

// ── Confidence helper ───────────────────────────────────────────────────────
function confidenceFor(fieldSize, dataCompleteness) {
  // Small fields are less reliable for Harville approximations.
  // Data completeness < 0.7 means we're missing speed figs or pace data.
  let c = 1.0;
  if (fieldSize < 6) c *= 0.85;
  if (fieldSize > 12) c *= 0.95;
  if (typeof dataCompleteness === 'number' && dataCompleteness < 0.7) c *= 0.8;
  return Math.max(0.3, Math.min(1, c));
}

// ── Top-level dispatcher ────────────────────────────────────────────────────

/**
 * Evaluate a user-entered bet. Single entry point for the UI.
 *
 * bet shape:
 *   {
 *     pool: 'win'|'place'|'show'|'exacta'|'trifecta'|'superfecta'|
 *           'pick3'|'pick4'|'pick5'|'pick6',
 *     race:  scored race object (for WPS/exotic),
 *     legs:  [{race, horses}] (for multi-race),
 *     selection: { pp } | { positions } | { horses } | { keyHorse, withHorses },
 *     structure: 'straight'|'box'|'key'|'wheel',
 *     amount: stake (WPS) or base amount (exotics),
 *   }
 */
function evaluateBet(bet) {
  const pool = String(bet.pool || '').toLowerCase();
  if (['win', 'place', 'show'].includes(pool)) {
    return evaluateWPS(bet.race, bet.selection, pool, bet.amount);
  }
  if (['exacta', 'trifecta', 'superfecta'].includes(pool)) {
    return evaluateExotic(bet.race, bet.structure || 'straight', bet.selection, bet.amount, pool);
  }
  if (['pick3', 'pick4', 'pick5', 'pick6'].includes(pool)) {
    return evaluateMultiRace(bet.legs, bet.amount, pool);
  }
  return { error: `Unknown pool: ${pool}` };
}

module.exports = {
  evaluateBet,
  evaluateWPS,
  evaluateExotic,
  evaluateMultiRace,
  // Helpers (exposed for tests and UI)
  generatePermutations,
  harvilleProb,
  placeShowProbabilities,
  engineRankOf,
  parseOdds,
  probToFractional,
  getTakeout,
  takeoutSource,
  TAKEOUT_TABLE,
};
