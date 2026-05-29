'use strict';

/**
 * scoring.js — pure scoring + probability engine for the Railbird advice system.
 *
 * Extracted from runAdviceEngine() in index.html so that:
 *   1. The engine can be unit-tested in isolation (`node --test`).
 *   2. The same code runs in the browser PWA and in the offline backtest harness.
 *   3. v1 (heuristic) and v2 (methodology-fixed) implementations live side-by-side
 *      and can be A/B compared on identical inputs.
 *
 * No DOM, no fetch, no storage. Inputs are plain objects; outputs are plain objects.
 *
 * ─── v1 vs v2 ────────────────────────────────────────────────────────────────
 * v1 = exact replication of the current index.html math (for parity tests).
 * v2 = methodology fixes from the May 2026 peer review:
 *   - Real probability via temperature-scaled softmax (NOT score/Σscore).
 *   - Field-strength normalization so composites are comparable across cards.
 *   - Trainer & jockey treated as INDEPENDENT features (not averaged), avoiding
 *     the double-count in races where a leading barn uses the leading rider.
 *   - Bias modifiers are explicitly capped and ordered (style FIRST, rail bump
 *     SECOND, with a single cap) so two boosts can't compound past 100.
 *   - Expert-consensus modifier is OFF in the composite by default (it's still
 *     surfaced separately as a benchmark). Caller can re-enable via opts.
 *   - Data-completeness penalty is unchanged in v2 (already sound).
 *
 *  Both implementations accept the SAME race/horse shape, so callers (UI,
 *  backtest) can swap engines by changing one string.
 */

// ── Class scale (mirrors CLASS_SCALE in index.html) ──────────────────────────
const CLASS_SCALE = {
  'STK-G1': 100, 'STK-G2': 85, 'STK-G3': 72, 'STK-L': 62,
  'AOC': 52, 'ALW': 48, 'MSW': 42, 'MCL': 28, 'CLM': 30,
};

function classValueFor(raceType) {
  if (!raceType) return 40;
  if (CLASS_SCALE[raceType] != null) return CLASS_SCALE[raceType];
  // Lightweight fuzzy match — mirrors mapRaceTypeToCode() in index.html.
  const s = String(raceType).toLowerCase();
  if (s.includes('grade 1') || s.includes('g1')) return CLASS_SCALE['STK-G1'];
  if (s.includes('grade 2') || s.includes('g2')) return CLASS_SCALE['STK-G2'];
  if (s.includes('grade 3') || s.includes('g3')) return CLASS_SCALE['STK-G3'];
  if (s.includes('listed') || s.includes('stakes')) return CLASS_SCALE['STK-L'];
  if (s.includes('optional')) return CLASS_SCALE['AOC'];
  if (s.includes('allowance')) return CLASS_SCALE['ALW'];
  if (s.includes('maiden claim')) return CLASS_SCALE['MCL'];
  if (s.includes('maiden')) return CLASS_SCALE['MSW'];
  if (s.includes('claim')) return CLASS_SCALE['CLM'];
  return 40;
}

// ── Odds parsing (mirrors parseOddsToNum in advice-utils.js) ─────────────────
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

// ── Expert-pick matching (mirrors advice-utils.js) ───────────────────────────
function expertPickMatchesHorse(ep, horse) {
  if (!ep || !horse) return false;
  const hasPp = (ep.pick != null && ep.pick !== '');
  if (hasPp) return ep.pick === horse.pp;
  return !!ep.horseName && !!horse.name && ep.horseName === horse.name;
}

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

// ── Per-factor sub-scores (shared between v1 and v2) ─────────────────────────
function speedSubScore(horse) {
  const figs = (horse.speedFigs || []).filter(f => f != null);
  if (!figs.length) return { score: 50, n: 0 };
  const avg = figs.reduce((a, b) => a + b, 0) / figs.length;
  let s = Math.min(100, Math.max(0, ((avg - 45) / 45) * 100));
  const latest = figs[figs.length - 1];
  const highest = Math.max(...figs);
  if (latest === highest && figs.length > 1) s = Math.min(100, s + 8);
  const lowest = Math.min(...figs);
  if (latest === lowest && figs.length > 1) s = Math.max(0, s - 5);
  return { score: s, n: figs.length };
}

function classSubScore(horse, raceClassVal) {
  const lastClassVal = (horse.lastClass && CLASS_SCALE[horse.lastClass] != null)
    ? CLASS_SCALE[horse.lastClass]
    : raceClassVal;
  const diff = lastClassVal - raceClassVal;
  if (diff > 20) return 90;
  if (diff > 10) return 75;
  if (diff > 0)  return 60;
  if (diff === 0) return 50;
  if (diff > -10) return 35;
  return 20;
}

function paceSubScore(horse, paceContext) {
  const style = horse.runningStyle || '';
  const { loneSpeed, hotPace } = paceContext;
  if (loneSpeed && (style === 'E' || style === 'EP')) return 80;
  if (hotPace && (style === 'S' || style === 'SS')) return 70;
  if (hotPace && (style === 'E' || style === 'EP')) return 30;
  return 50;
}

// v1: average of (jockey%, trainer%) then bucketize. Double-counts when a leading
//     barn uses a leading rider, which is the most common scenario at SAR/BEL/AQU.
function trainerJockeySubScore_v1(horse) {
  const jky = parseFloat(horse.jockeyPct) || 0;
  const trn = parseFloat(horse.trainerPct) || 0;
  const avg = (jky + trn) / 2;
  if (avg >= 22) return 95;
  if (avg >= 18) return 80;
  if (avg >= 14) return 65;
  if (avg >= 10) return 50;
  if (avg >= 6)  return 35;
  return 20;
}

// v2: score jockey and trainer independently, then take a soft-max blend so a
//     hot rider on a cold barn still gets credit, and the same hot rider on the
//     same hot barn does NOT get scored ~2× as much as either alone.
function trainerJockeySubScore_v2(horse) {
  const jky = parseFloat(horse.jockeyPct) || 0;
  const trn = parseFloat(horse.trainerPct) || 0;
  const bucket = (pct) => {
    if (pct >= 22) return 95;
    if (pct >= 18) return 80;
    if (pct >= 14) return 65;
    if (pct >= 10) return 50;
    if (pct >= 6)  return 35;
    return 20;
  };
  const jScore = bucket(jky);
  const tScore = bucket(trn);
  // Blend: 60% the better of the two, 40% the worse. Avoids double-counting
  // while still rewarding two-strong setups slightly over one-strong.
  const hi = Math.max(jScore, tScore);
  const lo = Math.min(jScore, tScore);
  return 0.6 * hi + 0.4 * lo;
}

// v1: apply style bonus, then rail bonus on top — can stack to 95 with no cap on the
//     intermediate step. v2: cap each step explicitly and apply rail as a smaller
//     additive shift rather than +15 on the already-boosted value.
function biasSubScore_v1(horse, bias) {
  if (!bias) return 50;
  const style = horse.runningStyle || '';
  const pp = horse.pp || 0;
  let s = 50;
  if (bias.style === 'Speed' && (style === 'E' || style === 'EP')) s = 80;
  else if (bias.style === 'Closers' && (style === 'S' || style === 'SS')) s = 80;
  if (bias.rail === 'Inside' && pp <= 3) s = Math.min(100, s + 15);
  else if (bias.rail === 'Outside' && pp >= 7) s = Math.min(100, s + 15);
  return s;
}

function biasSubScore_v2(horse, bias) {
  if (!bias) return 50;
  const style = horse.runningStyle || '';
  const pp = horse.pp || 0;
  // Style component: -15..+25 around 50.
  let styleBump = 0;
  if (bias.style === 'Speed' && (style === 'E' || style === 'EP')) styleBump = 25;
  else if (bias.style === 'Closers' && (style === 'S' || style === 'SS')) styleBump = 25;
  else if (bias.style === 'Speed' && (style === 'S' || style === 'SS')) styleBump = -15;
  else if (bias.style === 'Closers' && (style === 'E' || style === 'EP')) styleBump = -15;
  // Rail component: independent additive, smaller magnitude than v1.
  let railBump = 0;
  if (bias.rail === 'Inside' && pp <= 3) railBump = 10;
  else if (bias.rail === 'Outside' && pp >= 7) railBump = 10;
  else if (bias.rail === 'Inside' && pp >= 9) railBump = -8;
  else if (bias.rail === 'Outside' && pp <= 2) railBump = -8;
  return Math.max(0, Math.min(100, 50 + styleBump + railBump));
}

function freshnessSubScore(horse, today) {
  if (!horse.lastRaceDate) return 50;
  const ref = today ? new Date(today + 'T12:00:00') : new Date();
  const daysSince = Math.floor((ref - new Date(horse.lastRaceDate + 'T12:00:00')) / 86400000);
  if (daysSince >= 14 && daysSince <= 28) return 80;
  if (daysSince >= 7 && daysSince < 14)   return 65;
  if (daysSince > 28 && daysSince <= 60)  return 55;
  if (daysSince > 60 && daysSince <= 90)  return 35;
  if (daysSince > 90) return 20;
  return 50;
}

function dataCompleteness(horse) {
  let n = 0;
  const figs = (horse.speedFigs || []).filter(f => f != null);
  if (figs.length >= 1) n++;
  if (figs.length >= 2) n++;
  if (figs.length >= 3) n++;
  if (horse.runningStyle) n++;
  if ((parseFloat(horse.jockeyPct) || 0) > 0) n++;
  if ((parseFloat(horse.trainerPct) || 0) > 0) n++;
  if (horse.lastClass) n++;
  return n / 7;
}

// ── Pace context (shared) ────────────────────────────────────────────────────
function buildPaceContext(horses) {
  const styles = horses.map(h => h.runningStyle || '');
  const frontRunners = styles.filter(s => s === 'E' || s === 'EP').length;
  return { frontRunners, loneSpeed: frontRunners === 1, hotPace: frontRunners >= 3 };
}

// ── Field-strength normalization (v2 only) ───────────────────────────────────
// Returns a multiplier that pulls composites toward 50 when the field is weak
// (so a 75 in a 5-horse MCL is not treated like a 75 in a 12-horse stakes).
function fieldStrengthMultiplier(scoredArr) {
  const speeds = scoredArr.map(s => s.speedScore).filter(v => v != null);
  if (!speeds.length) return 1;
  const avg = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const max = Math.max(...speeds);
  // Strong field: high avg AND high max. Weak field: low avg.
  // Multiplier ranges roughly 0.92..1.08.
  const strength = (avg / 60 + max / 90) / 2; // ~1.0 at avg=60, max=90
  return Math.max(0.92, Math.min(1.08, strength));
}

// ── Composite scoring ────────────────────────────────────────────────────────
// Hand-picked v2 defaults (the 6-vector originally hard-coded in compositeForHorse).
// Sum to 1.0 by construction so the composite stays on the same 0..100 scale.
const DEFAULT_V2_WEIGHTS = Object.freeze({
  speed: 0.35, class: 0.20, pace: 0.15, tj: 0.15, bias: 0.10, fresh: 0.05,
});

/**
 * Validate and accept a fitted-weights payload (the data/weights/v2.json shape
 * written by scripts/training/fit_logit.py).
 *
 * Returns `{ weights, n_races, status }` when the payload is usable, else null.
 * Callers may further gate on n_races (the engine wires this with a 200-race
 * threshold, matching --min-races in the fitter).
 */
function loadFittedWeights(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.status && payload.status !== 'fitted') return null;
  const arr = Array.isArray(payload.weights_normalized) ? payload.weights_normalized : null;
  const feats = Array.isArray(payload.features) ? payload.features : null;
  if (!arr || !feats || arr.length !== 6 || feats.length !== 6) return null;
  // Build a {speed,class,pace,tj,bias,fresh} object from the fitted features.
  const required = ['speed', 'class', 'pace', 'tj', 'bias', 'fresh'];
  const w = {};
  for (let i = 0; i < required.length; i++) {
    const featIdx = feats.indexOf(required[i]);
    if (featIdx < 0) return null;
    const v = Number(arr[featIdx]);
    if (!isFinite(v)) return null;
    w[required[i]] = v;
  }
  // Normalize sign + magnitude: take absolute values then renormalize so weights sum to 1.
  // (Conditional logit can produce negative coefficients when a sub-score is
  // mis-signed in the training data — we treat them as pure magnitudes here, on
  // the assumption that the v2 sub-scores are oriented "higher = better".)
  let absSum = 0;
  for (const k of required) { w[k] = Math.abs(w[k]); absSum += w[k]; }
  if (absSum === 0) return null;
  for (const k of required) w[k] /= absSum;
  return {
    weights: w,
    n_races: Number(payload.n_races) || 0,
    status: payload.status || 'fitted',
    trained_at: payload.trained_at || null,
  };
}

function compositeForHorse(horse, race, paceCtx, bias, opts) {
  const version = opts.version;
  const raceClassVal = classValueFor(race.type);

  const speedRes = speedSubScore(horse);
  const speedScore = speedRes.score;
  const classScore = classSubScore(horse, raceClassVal);
  const paceScore  = paceSubScore(horse, paceCtx);
  const tjScore    = version === 'v2'
    ? trainerJockeySubScore_v2(horse)
    : trainerJockeySubScore_v1(horse);
  const biasScore  = version === 'v2'
    ? biasSubScore_v2(horse, bias)
    : biasSubScore_v1(horse, bias);
  const freshScore = freshnessSubScore(horse, opts.today);
  const completeness = dataCompleteness(horse);

  // Use fitted v2 weights when supplied (and only for v2 engine); else fall
  // back to the hand-picked defaults. Both shapes are {speed,class,pace,tj,bias,fresh}
  // and both sum to 1 by construction.
  const w = (version === 'v2' && opts.fittedWeights) ? opts.fittedWeights : DEFAULT_V2_WEIGHTS;
  let composite = speedScore * w.speed + classScore * w.class + paceScore * w.pace
                + tjScore   * w.tj    + biasScore  * w.bias  + freshScore * w.fresh;

  // Equipment change (both versions keep this; small directional effect).
  if (horse.equipmentChanges) composite = Math.min(100, composite + 5);

  // Data completeness penalty (both versions).
  if (completeness < 3 / 7) composite *= 0.70;
  else if (completeness < 4 / 7) composite *= 0.85;

  // Expert consensus:
  //   v1 = add into composite (legacy double-counting concern)
  //   v2 = OFF by default (still surfaced as a separate benchmark in the UI)
  const expertCount = countExpertPicks(race, horse);
  const includeExpertInComposite = opts.includeExpertInComposite === true
    || (version === 'v1' && opts.includeExpertInComposite !== false);

  if (includeExpertInComposite) {
    if (expertCount >= 4) composite = Math.min(100, composite + 14);
    else if (expertCount === 3) composite = Math.min(100, composite + 10);
    else if (expertCount === 2) composite = Math.min(100, composite + 6);
    else if (expertCount === 1) composite = Math.min(100, composite + 3);
  }

  return {
    horse,
    score: composite,
    speedScore, classScore, paceScore, tjScore, biasScore, freshnessScore: freshScore,
    completeness,
    expertMatchCount: expertCount,
    modelProb: 0, impliedProb: 0, overlay: 0,
  };
}

// ── Probability normalization ────────────────────────────────────────────────
// v1: score-share. Mathematically not a probability (just a normalization of
//     positive numbers); kept for parity with current production.
// v2: temperature-scaled softmax over composites. Temperature is chosen so the
//     dispersion of model probabilities roughly matches the dispersion of
//     morning-line implied probabilities in the same race (calibrated default
//     T=12 produces sensible spreads for fields of 6–12 horses).
function probabilityNormalizeV1(scored) {
  const sum = scored.reduce((acc, s) => acc + Math.max(s.score, 1), 0);
  scored.forEach(s => { s.modelProb = Math.max(s.score, 1) / sum; });
}

function probabilityNormalizeV2(scored, temperature) {
  const T = temperature || 12;
  // Softmax with numerical stability.
  const maxS = Math.max(...scored.map(s => s.score));
  const exps = scored.map(s => Math.exp((s.score - maxS) / T));
  const sum = exps.reduce((a, b) => a + b, 0) || 1;
  scored.forEach((s, i) => { s.modelProb = exps[i] / sum; });
}

// ── Overlay (shared) ─────────────────────────────────────────────────────────
function attachOverlay(scored) {
  scored.forEach(s => {
    const mlOdds = parseOddsToNum(s.horse.ml);
    const liveOdds = s.horse.liveOdds ? parseOddsToNum(s.horse.liveOdds) : 0;
    const marketOdds = liveOdds > 0 ? liveOdds : mlOdds;
    s.impliedProb = marketOdds > 0 ? 1 / (marketOdds + 1) : 0;
    s.overlay = s.impliedProb > 0 ? s.modelProb - s.impliedProb : 0;
    s.mlImpliedProb = mlOdds > 0 ? 1 / (mlOdds + 1) : 0;
    s.mlOverlay = s.mlImpliedProb > 0 ? s.modelProb - s.mlImpliedProb : 0;
    s.usedLiveOdds = liveOdds > 0;
  });
}

// ── Public: score a single race ──────────────────────────────────────────────
/**
 * Score a race.
 *
 * @param {Object} race           — { type, horses[], expertPicks?[] }
 * @param {Object} opts
 * @param {string} opts.version   — 'v1' (parity) | 'v2' (methodology-fixed)
 * @param {Object} opts.bias      — { style, rail } or null
 * @param {string} opts.today     — 'YYYY-MM-DD' for freshness calc; defaults to now
 * @param {number} opts.temperature — softmax temperature (v2 only); default 12
 * @param {boolean} opts.includeExpertInComposite — override default per-version
 * @returns {Array} scored — sorted by composite desc, with modelProb / overlay attached
 */
function scoreRace(race, opts) {
  opts = opts || {};
  const version = opts.version === 'v2' ? 'v2' : 'v1';
  const horses = (race.horses || []).filter(h => !h.scratched);
  if (!horses.length) return [];

  // Resolve fitted weights (v2-only). Caller may pass either a parsed
  // weights-file payload (we normalize it) or an already-normalized weights map.
  let fittedWeights = null;
  if (version === 'v2' && opts.fittedWeights) {
    if (opts.fittedWeights.weights_normalized) {
      // raw weights-file payload
      const loaded = loadFittedWeights(opts.fittedWeights);
      if (loaded) fittedWeights = loaded.weights;
    } else if (typeof opts.fittedWeights.speed === 'number') {
      fittedWeights = opts.fittedWeights;
    }
  }

  const paceCtx = buildPaceContext(horses);
  let scored = horses.map(h => compositeForHorse(h, race, paceCtx, opts.bias, {
    version, today: opts.today,
    includeExpertInComposite: opts.includeExpertInComposite,
    fittedWeights,
  }));

  if (version === 'v2') {
    const mult = fieldStrengthMultiplier(scored);
    scored.forEach(s => {
      // Pull weak-field scores toward 50; boost strong-field scores slightly.
      s.score = 50 + (s.score - 50) * mult;
      s.fieldStrengthMult = mult;
    });
    probabilityNormalizeV2(scored, opts.temperature);
  } else {
    probabilityNormalizeV1(scored);
  }

  attachOverlay(scored);
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ── Public: score every race on a card ───────────────────────────────────────
function scoreCard(races, opts) {
  return (races || []).map(race => ({
    race,
    scored: scoreRace(race, opts),
  }));
}

// ── Public: grade + confidence (shared) ──────────────────────────────────────
function scoreToGrade(score) {
  if (score >= 90) return 'A+';
  if (score >= 80) return 'A';
  if (score >= 73) return 'B+';
  if (score >= 65) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

function confidenceFor(scored) {
  if (!scored.length) return 'low';
  const top = scored[0];
  const gap = scored.length > 1 ? scored[0].score - scored[1].score : 0;
  const topCompleteness = top.completeness || 0;
  const fieldSize = scored.length;
  if (gap > 12 && topCompleteness >= 0.70 && fieldSize >= 5) return 'high';
  if (gap > 6  && topCompleteness >= 0.50) return 'medium';
  return 'low';
}

module.exports = {
  // public
  scoreRace,
  scoreCard,
  scoreToGrade,
  confidenceFor,
  loadFittedWeights,
  DEFAULT_V2_WEIGHTS,
  // pure pieces (exposed for tests and reuse)
  classValueFor,
  parseOddsToNum,
  expertPickMatchesHorse,
  countExpertPicks,
  speedSubScore,
  classSubScore,
  paceSubScore,
  trainerJockeySubScore_v1,
  trainerJockeySubScore_v2,
  biasSubScore_v1,
  biasSubScore_v2,
  freshnessSubScore,
  dataCompleteness,
  buildPaceContext,
  fieldStrengthMultiplier,
  probabilityNormalizeV1,
  probabilityNormalizeV2,
  attachOverlay,
  CLASS_SCALE,
};
