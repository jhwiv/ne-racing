'use strict';

/**
 * Parses a NYRA public handicapper-picks page into a race-number -> pick
 * mapping. NYRA's site markup is not a documented, versioned public API --
 * this was built without live access to fetch and inspect the real pages
 * (sandboxed dev environment, no outbound network), so it tries a few
 * independent strategies and reports which one (if any) worked, rather than
 * silently guessing. Never throws; always returns an array (possibly empty).
 *
 * IMPORTANT: the first real run against each of the four live URLs must be
 * checked by hand (see scripts/fetch-nyra-expert-picks.js --dry-run) before
 * trusting the scheduled job -- these strategies are best-effort, not
 * verified against production markup.
 */

/**
 * @param {string} html
 * @returns {{ picks: Array<{race:number, pick:number|null, horseName:string|null}>, strategy: string, reason?: string }}
 */
function parseNyraPicksHtml(html) {
  if (!html || typeof html !== 'string') {
    return { picks: [], strategy: 'none', reason: 'empty or non-string input' };
  }

  const fromJson = tryExtractFromEmbeddedJson(html);
  if (fromJson.length) return { picks: fromJson, strategy: 'embedded-json' };

  const fromText = tryExtractFromVisibleText(html);
  if (fromText.length) return { picks: fromText, strategy: 'visible-text' };

  return { picks: [], strategy: 'none', reason: 'no recognizable pick data found by any strategy' };
}

/**
 * Strategy 1: many modern sites (Next.js and similar frameworks) embed the
 * page's full data model as JSON in a <script> tag before hydration. This is
 * far more robust than scraping rendered markup because it doesn't depend on
 * CSS class names or DOM layout at all -- if present, it's a direct data
 * dump. Recursively scans the parsed object for anything shaped like a race
 * pick (a race-number-ish field alongside a horse-name-ish or
 * program-number-ish field).
 */
function tryExtractFromEmbeddedJson(html) {
  const picks = [];
  const scriptBlocks = [];

  const nextDataRe = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
  const nextMatch = html.match(nextDataRe);
  if (nextMatch) scriptBlocks.push(nextMatch[1]);

  // Generic fallback: any <script type="application/json"> block.
  const genericRe = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = genericRe.exec(html)) !== null) scriptBlocks.push(m[1]);

  for (const block of scriptBlocks) {
    let data;
    try { data = JSON.parse(block); } catch (e) { continue; }
    walkForPicks(data, picks, new Set(), 0);
  }

  return dedupePicks(picks);
}

function walkForPicks(node, picks, seen, depth) {
  if (!node || typeof node !== 'object' || depth > 14 || seen.has(node)) return;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) walkForPicks(item, picks, seen, depth + 1);
    return;
  }

  const raceNum = firstDefined(node.raceNumber, node.race_number, node.raceNo, node.race);
  const horseName = firstDefined(node.horseName, node.horse_name, node.selection, node.pickHorse, node.horse);
  const programNumber = firstDefined(node.programNumber, node.program_number, node.pp, node.postPosition, node.number);

  const raceNumInt = parseInt(raceNum, 10);
  if (Number.isFinite(raceNumInt) && (horseName || programNumber != null) && typeof horseName !== 'object') {
    picks.push({
      race: raceNumInt,
      pick: programNumber != null && !isNaN(parseInt(programNumber, 10)) ? parseInt(programNumber, 10) : null,
      horseName: horseName ? String(horseName).trim() : null,
    });
  }

  for (const key of Object.keys(node)) walkForPicks(node[key], picks, seen, depth + 1);
}

function firstDefined() {
  for (let i = 0; i < arguments.length; i++) {
    if (arguments[i] != null) return arguments[i];
  }
  return null;
}

/**
 * Strategy 2 (fallback): strip tags down to visible text and look for
 * "Race N" followed shortly by a "#N Horse Name" / "No. N Horse Name"
 * pattern -- the common plain-text shape of a handicapper's top selection.
 * Much more fragile than strategy 1; only used when no embedded JSON model
 * was found.
 */
function tryExtractFromVisibleText(html) {
  const picks = [];
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');

  const raceRe = /\bRace\s*#?\s*(\d{1,2})\b/gi;
  let raceMatch;
  while ((raceMatch = raceRe.exec(text)) !== null) {
    const raceNum = parseInt(raceMatch[1], 10);
    const windowText = text.slice(raceMatch.index, raceMatch.index + 200);
    // Capture a run of 1-4 consecutive Capitalized-word tokens right after
    // the program number -- this naturally stops at the first lowercase-
    // leading word (e.g. "looks", "has") without needing a lookahead that
    // would otherwise also stop at the second word of a two-word horse name.
    const pickMatch = windowText.match(/(?:No\.?\s*|#\s*)(\d{1,2})\s+((?:[A-Z][A-Za-z'.-]*\s*){1,4})/);
    if (pickMatch) {
      picks.push({
        race: raceNum,
        pick: parseInt(pickMatch[1], 10),
        horseName: pickMatch[2].trim(),
      });
    }
  }
  return dedupePicks(picks);
}

function dedupePicks(picks) {
  const byRace = new Map();
  for (const p of picks) {
    if (!byRace.has(p.race)) byRace.set(p.race, p);
  }
  return Array.from(byRace.values());
}

module.exports = { parseNyraPicksHtml, tryExtractFromEmbeddedJson, tryExtractFromVisibleText };
