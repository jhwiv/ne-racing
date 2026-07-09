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

  // Merged rather than tried as mutually-exclusive alternatives -- confirmed
  // necessary against the real NYRA Bets DeSantis page (2026-07-09): it has
  // BOTH a full per-race numeric picks table (every race, no names) AND a
  // handful of featured-pick callouts elsewhere on the page with real horse
  // names for only some races. Picking whichever strategy found anything
  // first (as a prior version of this function did) silently dropped every
  // race the other one would have caught -- e.g. visible-text alone found
  // named picks for only 4 of 9 races, discarding the other 5 the broader
  // race-number-list strategy would have filled in. race-number-list's
  // entries seed the map first (broad coverage, no names); visible-text's
  // richer entries (real horse name) overwrite them where both cover the
  // same race, so a name is never dropped in favor of a bare number either.
  const fromText = tryExtractFromVisibleText(html);
  const fromRaceList = tryExtractFromRaceNumberList(html);
  if (fromText.length || fromRaceList.length) {
    const byRace = new Map();
    fromRaceList.forEach((p) => byRace.set(p.race, p));
    fromText.forEach((p) => byRace.set(p.race, p));
    const strategy = fromText.length && fromRaceList.length
      ? 'visible-text+race-number-list'
      : (fromText.length ? 'visible-text' : 'race-number-list');
    return {
      picks: Array.from(byRace.values()).sort((a, b) => a.race - b.race),
      strategy,
    };
  }

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
 * Strategy 2: a named-contributor panel format, confirmed against two real
 * live pages (2026-07-09): Talking Horses (multiple contributors -- Andy
 * Serling, Megan Burgess) and Hablan Los Caballos (one contributor, Darwin
 * Vizcaya) -- both list each contributor as "{Name} | @{twitter_handle}"
 * followed by that person's own picks for every race as
 * "Race N {pp}-{pp}-{pp}-{pp}" (ranked program numbers, no horse names
 * available in this format). e.g.:
 *   "Andy Serling | @AndySerling Race 1 3 - 5 Race 2 6 - 2 - 3 - 8 ...
 *    Megan Burgess | @TheMeganBurgess Race 1 5 - 6 - 1 - 3 ..."
 * Each named contributor is treated as an independent expert vote (tagged
 * via the per-pick `source` field, the bare name only -- NOT prefixed with
 * a page title here, since this same panel shape recurs across different
 * shows; the caller combines it with whichever page-specific label it
 * configured, e.g. "Talking Horses - Andy Serling" vs. "Hablan Los
 * Caballos - Darwin Vizcaya") rather than collapsed into one vote per page
 * -- more accurate, and yields more consensus signal per page.
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
        source: markers[i].name,
      });
    }
  }
  return picks;
}

/**
 * Strategy 4: single-handicapper pages using the same "Race N
 * {pp}-{pp}-{pp}" ranked-list shape as the panel format above, but with no
 * "{Name} | @{handle}" markers separating multiple contributors -- e.g. NYRA
 * Bets' DeSantis picks table, confirmed live (2026-07-09):
 *   "Race 1 1:10 PM ET 6-3 Race 2 1:44 PM ET 5-6-4-2 ..."
 * The whole page is attributed to whichever `source.label` the caller
 * configured for that URL, since there's only one implicit contributor.
 *
 * The post time between "Race N" and the actual picks ("1:10 PM ET") is
 * explicitly modeled and skipped, rather than tolerating any generic gap --
 * confirmed necessary against the real page: a generic "skip up to N
 * non-digit characters" gap can't skip a post time at all, since a clock
 * time itself contains digits, and an earlier version of this function
 * matched the "1" in "1:10" as the pick instead of the real "6-3" for
 * every single race. Recognizing the exact real-world clutter (post time,
 * AM/PM, "ET") instead of generically tolerating "some gap" avoids that
 * ambiguity entirely, and also naturally avoids the "Race N - 0MTP"
 * minutes-to-post nav widget (seen on Talking Horses and the dead
 * TimeformUS page) being misread as a pick of 0, since neither the literal
 * "-" nor "MTP" match anything this pattern recognizes as skippable.
 */
function tryExtractFromRaceNumberList(html) {
  const text = stripToVisibleText(html);
  const picks = [];
  const raceRe = /\bRace\s+(\d{1,2})\b\s*(?:\d{1,2}:\d{2}\s*(?:AM|PM)?\s*(?:ET)?\s*)?((?:\d{1,2}\s*-\s*)+\d{1,2}|\d{1,2})(?![A-Za-z0-9:])/g;
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
  const matches = [];
  let raceMatch;
  while ((raceMatch = raceRe.exec(text)) !== null) {
    matches.push({ index: raceMatch.index, end: raceRe.lastIndex, race: parseInt(raceMatch[1], 10) });
  }
  for (let i = 0; i < matches.length; i++) {
    // Bounded to the NEXT "Race N" occurrence (or a 200-char cap, whichever
    // is closer), not a flat 200-char window -- confirmed necessary against
    // a real page shape: a numeric picks table for every race followed
    // later by a single separate "Best Bet" callout for just one race. A
    // flat window let that one later callout's name bleed backward onto
    // every earlier race's "Race N" mention that happened to fall within
    // 200 characters of it, since nothing stopped the search at the next
    // race's own heading.
    const boundEnd = i + 1 < matches.length ? matches[i + 1].index : text.length;
    const windowText = text.slice(matches[i].end, Math.min(boundEnd, matches[i].end + 200));
    // Capture a run of 1-4 consecutive Capitalized-word tokens right after
    // the program number -- this naturally stops at the first lowercase-
    // leading word (e.g. "looks", "has") without needing a lookahead that
    // would otherwise also stop at the second word of a two-word horse name.
    const pickMatch = windowText.match(/(?:No\.?\s*|#\s*)(\d{1,2})\s+((?:[A-Z][A-Za-z'.-]*\s*){1,4})/);
    if (pickMatch) {
      picks.push({
        race: matches[i].race,
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
