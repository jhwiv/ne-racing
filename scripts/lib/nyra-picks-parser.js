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
 * @returns {{ picks: Array<{race:number, pick:number|null, horseName:string|null, source?:string}>, strategy: string, reason?: string }}
 */
function parseNyraPicksHtml(html) {
  if (!html || typeof html !== 'string') {
    return { picks: [], strategy: 'none', reason: 'empty or non-string input' };
  }

  const fromJson = tryExtractFromEmbeddedJson(html);
  if (fromJson.length) return { picks: fromJson, strategy: 'embedded-json' };

  const fromPanel = tryExtractFromHandicapperPanel(html);
  if (fromPanel.length) return { picks: fromPanel, strategy: 'handicapper-panel' };

  // Tried before race-number-list deliberately: this requires an explicit
  // "#N"/"No. N" marker plus an actual horse name, which is more specific
  // (and richer) than the bare-number pattern below -- trying it first
  // means a page that DOES give real horse names doesn't lose them to the
  // more generic strategy just because a number happens to follow shortly
  // after a race heading too.
  const fromText = tryExtractFromVisibleText(html);
  if (fromText.length) return { picks: fromText, strategy: 'visible-text' };

  const fromRaceList = tryExtractFromRaceNumberList(html);
  if (fromRaceList.length) return { picks: fromRaceList, strategy: 'race-number-list' };

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

function stripToVisibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
}

/**
 * Strategy 2: NYRA's "Talking Horses" panel format, confirmed against the
 * real live page (2026-07-09): a list of named contributors, each as
 * "{Name} | @{twitter_handle}" followed by that person's own picks for every
 * race as "Race N {pp}-{pp}-{pp}-{pp}" (ranked program numbers, no horse
 * names available in this format). e.g.:
 *   "Andy Serling | @AndySerling Race 1 3 - 5 Race 2 6 - 2 - 3 - 8 ...
 *    Megan Burgess | @TheMeganBurgess Race 1 5 - 6 - 1 - 3 ..."
 * Each named contributor is treated as an independent expert vote (tagged
 * via the per-pick `source` field) rather than collapsed into a single
 * "NYRA - Serling" vote -- the page is a multi-handicapper panel, not just
 * Serling's own picks, so attributing each panelist by name is both more
 * accurate and yields more consensus signal.
 */
function tryExtractFromHandicapperPanel(html) {
  const text = stripToVisibleText(html);
  const picks = [];
  const panelistRe = /([A-Z][A-Za-z'.\- ]{1,40}?)\s*\|\s*@([A-Za-z0-9_]+)/g;
  const markers = [];
  let pm;
  while ((pm = panelistRe.exec(text)) !== null) {
    markers.push({ index: pm.index, end: panelistRe.lastIndex, name: pm[1].trim() });
  }
  if (!markers.length) return picks;

  const seen = new Set();
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].end;
    const end = i + 1 < markers.length ? markers[i + 1].index : text.length;
    const block = text.slice(start, end);
    const raceRe = /\bRace\s+(\d{1,2})\s+((?:\d{1,2}\s*-\s*)+\d{1,2}|\d{1,2})\b/g;
    let rm;
    while ((rm = raceRe.exec(block)) !== null) {
      const raceNum = parseInt(rm[1], 10);
      const firstPick = parseInt(rm[2].split('-')[0].trim(), 10);
      const key = markers[i].name + ':' + raceNum;
      if (seen.has(key)) continue;
      seen.add(key);
      picks.push({
        race: raceNum,
        pick: firstPick,
        horseName: null,
        source: `Talking Horses - ${markers[i].name}`,
      });
    }
  }
  return picks;
}

/**
 * Strategy 4 (tried after visible-text): single-handicapper pages that use
 * the same "Race N {pp}-{pp}-{pp}" ranked-list shape as the Talking Horses
 * panel, but
 * without "{Name} | @{handle}" markers separating multiple contributors --
 * e.g. NYRA Bets' DeSantis picks table ("MATTHEW'S FULL CARD PICKS...
 * Race 1 ... 6-3") and the Spanish-language "Hablan Los Caballos" page
 * (per Perplexity Computer's live check, 2026-07-09). The whole page is
 * attributed to whichever `source.label` the caller configured for that
 * URL, since there's only one implicit contributor. Reported per Perplexity
 * as plain text / a plain HTML table -- tag-stripping handles both the same
 * way. Not yet verified against this pipeline's own captured raw HTML (see
 * SOURCES comment in fetch-nyra-expert-picks.js) -- confirm via a debug run
 * before trusting on the schedule.
 */
function tryExtractFromRaceNumberList(html) {
  const text = stripToVisibleText(html);
  const picks = [];
  // The trailing (?![A-Za-z]) matters: NYRA pages carry a "Race N - 0MTP"
  // minutes-to-post nav widget (confirmed present on both Talking Horses
  // and the dead TimeformUS page) that would otherwise false-positive as a
  // pick of "0" -- rejecting a match immediately followed by a letter skips
  // that specific false positive without needing to know the exact markup.
  const raceRe = /\bRace\s+(\d{1,2})\b[^0-9]{0,20}?((?:\d{1,2}\s*-\s*)+\d{1,2}|\d{1,2})(?![A-Za-z])/g;
  let m;
  while ((m = raceRe.exec(text)) !== null) {
    const raceNum = parseInt(m[1], 10);
    const firstPick = parseInt(m[2].split('-')[0].trim(), 10);
    picks.push({ race: raceNum, pick: firstPick, horseName: null });
  }
  return dedupePicks(picks);
}

/**
 * Strategy 3: strip tags down to visible text and look for
 * "Race N" followed shortly by a "#N Horse Name" / "No. N Horse Name"
 * pattern -- a plain-text shape of a handicapper's top selection. Much more
 * fragile than strategies 1-2; only used when neither found anything.
 */
function tryExtractFromVisibleText(html) {
  const picks = [];
  const text = stripToVisibleText(html);

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

module.exports = { parseNyraPicksHtml, tryExtractFromEmbeddedJson, tryExtractFromHandicapperPanel, tryExtractFromRaceNumberList, tryExtractFromVisibleText };
