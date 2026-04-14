/**
 * Cloudflare Worker — NE Racing Proxy
 *
 * Serves horse racing data to the NE Racing companion app.
 * Supports two data source modes, selected by the DATA_SOURCE env var:
 *
 *   DATA_SOURCE = "free" (default)
 *   ────────────────────────────────────────────────────────────────────
 *   • Entries  — Static JSON files hosted on GitHub Pages
 *                https://jhwiv.github.io/ne-racing/data/entries-{TRACK}-{DATE}.json
 *   • Scratches — Live XML feed from Equibase (free, no auth required)
 *                 https://www.equibase.com/premium/eqbLateChangeXMLDownload.cfm
 *   • Odds     — Not available; returns graceful empty response
 *   • Results  — Not available; returns graceful empty response
 *
 *   DATA_SOURCE = "theracingapi"  (requires API_KEY secret)
 *   ────────────────────────────────────────────────────────────────────
 *   • All four endpoints served via The Racing API (https://api.theracingapi.com/v1)
 *   • Full odds, results, and racecard data available
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * wrangler.toml example
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * name = "ne-racing"
 * main = "worker.js"
 * compatibility_date = "2024-09-23"
 *
 * [vars]
 * DATA_SOURCE    = "free"          # or "theracingapi"
 * DEFAULT_TRACK  = "AQU"
 * ALLOWED_ORIGIN = "*"
 *
 * # Secrets — set via CLI, never committed to source control:
 * #   wrangler secret put API_KEY   (only required for DATA_SOURCE=theracingapi)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Endpoints exposed by this Worker
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   GET /api/entries?track=AQU&date=2026-04-14
 *   GET /api/scratches?track=AQU&date=2026-04-14
 *   GET /api/odds?track=AQU&date=2026-04-14&race=5
 *   GET /api/results?track=AQU&date=2026-04-14
 *
 * All track codes follow Equibase conventions (AQU, SAR, MTH, PRX, …).
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Track code → venue name mapping ────────────────────────────────────────
// Maps Equibase track abbreviations to human-readable venue names.
// Used for both filtering The Racing API responses and labelling free-source
// responses.
const TRACK_TO_VENUE = {
  AQU: "Aqueduct",
  BEL: "Aqueduct",    // Belmont at Big A runs at Aqueduct (Big A)
  SAR: "Saratoga",
  MTH: "Monmouth Park",
  PRX: "Parx Racing",
  FL:  "Finger Lakes",
  DEL: "Delaware Park",
  PIM: "Pimlico",
  LRL: "Laurel Park",
  CT:  "Charles Town",
  PEN: "Penn National",
  BTP: "Belmont Park",
};

// ─── Cache TTL constants (seconds) ──────────────────────────────────────────
// Free sources:
//   entries  — 5 minutes (static files change only once per day)
//   scratches — 60 seconds (Equibase updates throughout the morning)
// The Racing API sources:
//   odds/results — 60 s (live data)
const CACHE_TTL = {
  entries:   300,   // 5 min for free static files
  scratches:  60,   // 60 s for Equibase live feed
  odds:        60,
  results:   120,
};

// ─── Upstream base URL (The Racing API) ─────────────────────────────────────
const THERACINGAPI_BASE = "https://api.theracingapi.com/v1";

// ─── Static entries base URL (GitHub Pages) ─────────────────────────────────
// File name pattern: entries-{TRACK}-{DATE}.json
// e.g. entries-AQU-2026-04-16.json
const STATIC_ENTRIES_BASE = "https://jhwiv.github.io/ne-racing/data";

// ─── Equibase late-changes XML feed URL ─────────────────────────────────────
const EQUIBASE_SCRATCHES_URL =
  "https://www.equibase.com/premium/eqbLateChangeXMLDownload.cfm";

// ─── CORS headers helper ─────────────────────────────────────────────────────
/**
 * Builds a Headers object containing CORS + caching directives.
 * @param {string} origin  — Value for Access-Control-Allow-Origin
 * @param {number} maxAge  — Cache-Control max-age in seconds (0 = no-store)
 */
function corsHeaders(origin, maxAge = 0) {
  const h = new Headers({
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  });
  if (maxAge > 0) {
    h.set("Cache-Control", `public, max-age=${maxAge}, s-maxage=${maxAge}`);
  } else {
    h.set("Cache-Control", "no-store");
  }
  return h;
}

// ─── JSON response helpers ───────────────────────────────────────────────────
function jsonOk(body, origin, maxAge) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: corsHeaders(origin, maxAge),
  });
}

function jsonError(message, status = 500, origin = "*") {
  const body = {
    error: "upstream_unavailable",
    fallback: "manual",
    message,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders(origin, 0),
  });
}

// ─── Cloudflare Cache API helpers ────────────────────────────────────────────
/**
 * Attempts to read a cached response for the given cache key URL.
 * Returns null on a cache miss.
 */
async function readCache(cacheKey) {
  const cache = caches.default;
  return cache.match(cacheKey);
}

/**
 * Stores a cloned copy of `response` in Cloudflare's default cache.
 * We clone because a Response body can only be consumed once.
 */
async function writeCache(cacheKey, response) {
  const cache = caches.default;
  await cache.put(cacheKey, response.clone());
}

// ─── Upstream fetch helper (The Racing API) ──────────────────────────────────
/**
 * Fetches `path` from The Racing API with the provided Bearer token.
 * Returns parsed JSON on success; throws on HTTP error.
 *
 * @param {string} path    — e.g. "/racecards/standard?date=2026-04-14"
 * @param {string} apiKey  — Bearer token
 */
async function fetchUpstream(path, apiKey) {
  const url = `${THERACINGAPI_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(
      `Upstream responded ${res.status} ${res.statusText} for ${url}`
    );
  }

  return res.json();
}

// ─── Utility: format fractional odds ─────────────────────────────────────────
/**
 * Converts a decimal odds string/number to a fractional representation.
 * e.g. "6.00" → "5-1", "3.50" → "5-2"
 * Falls back to the raw value when conversion is not clean.
 */
function decimalToFractional(decimal) {
  if (!decimal) return "N/A";
  const d = parseFloat(decimal);
  if (isNaN(d)) return String(decimal);

  // Common clean fractions racing bettors expect:
  const commonFractions = [
    [1, 5], [1, 4], [2, 7], [1, 3], [2, 5], [4, 9], [1, 2], [4, 7],
    [4, 6], [8, 13], [8, 11], [4, 5], [10, 11], [1, 1], [11, 10], [6, 5],
    [5, 4], [11, 8], [6, 4], [13, 8], [7, 4], [15, 8], [2, 1], [9, 4],
    [5, 2], [11, 4], [3, 1], [10, 3], [7, 2], [4, 1], [9, 2], [5, 1],
    [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [12, 1], [14, 1], [16, 1],
    [20, 1], [25, 1], [33, 1],
  ];

  for (const [num, den] of commonFractions) {
    if (Math.abs((num / den + 1) - d) < 0.01) {
      return `${num}-${den}`;
    }
  }

  // Fallback: express as X-1
  const approx = Math.round(d - 1);
  return `${approx}-1`;
}

/**
 * Picks the "best" odds from a runner's odds array.
 * Prefers the first entry (often morning-line / tote) and returns fractional.
 */
function bestFractional(oddsArray) {
  if (!oddsArray || oddsArray.length === 0) return "N/A";
  const first = oddsArray[0];
  if (first.fractional) {
    // Normalise "/" separators to "-" for consistency
    return String(first.fractional).replace("/", "-");
  }
  return decimalToFractional(first.decimal);
}

// ─── Utility: format currency ─────────────────────────────────────────────────
function formatPurse(prize) {
  if (!prize) return "N/A";
  // Already formatted (e.g. "$40,000") — return as-is
  return String(prize).trim();
}

// ─── Utility: format post time ───────────────────────────────────────────────
/**
 * Converts an ISO datetime string or "H:MM" string into "H:MM AM/PM" format.
 * e.g. "2026-04-14T13:10:00-04:00" → "1:10 PM"
 *      "13:10" → "1:10 PM"
 */
function formatPostTime(offDt, offTime) {
  // Prefer the full ISO timestamp when available
  if (offDt) {
    try {
      const d = new Date(offDt);
      return d.toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: "America/New_York",
      });
    } catch (_) {
      // fall through
    }
  }
  // Fall back to the simple "H:MM" string
  if (offTime) {
    const [hStr, mStr] = offTime.split(":");
    const h = parseInt(hStr, 10);
    const m = parseInt(mStr, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    const mm = String(m).padStart(2, "0");
    return `${h12}:${mm} ${ampm}`;
  }
  return "N/A";
}

// ─── Utility: format distance ─────────────────────────────────────────────────
/**
 * Converts a distance_f (furlongs as decimal string) to a human-readable string.
 * e.g. "6.0" → "6 Furlongs", "8.5" → "1 Mile 1/2 Furlong"
 */
function formatDistance(distanceF, distanceRaw) {
  if (distanceRaw) return String(distanceRaw).trim(); // e.g. "6f", "1m2f"
  if (!distanceF) return "N/A";
  const f = parseFloat(distanceF);
  if (isNaN(f)) return String(distanceF);
  if (f < 8) return `${f} Furlongs`;
  const miles = Math.floor(f / 8);
  const rem = f % 8;
  if (rem === 0) return miles === 1 ? "1 Mile" : `${miles} Miles`;
  return `${miles} Mile${miles > 1 ? "s" : ""} ${rem} Furlongs`;
}

// ═════════════════════════════════════════════════════════════════════════════
// FREE SOURCE: ENTRIES (GitHub Pages static JSON)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetches the static entries JSON file from GitHub Pages and transforms it
 * into the normalised /api/entries response shape.
 *
 * Static file URL: https://jhwiv.github.io/ne-racing/data/entries-{TRACK}-{DATE}.json
 *
 * Input schema (static file):
 *   { track, date, races: [{ race_number, post_time, purse, race_type,
 *     conditions, distance, surface, entries: [{ pp, name, jockey, trainer,
 *     weight, scratched }] }] }
 *
 * Output schema (normalised):
 *   { track, date, venue, lastUpdated, races: [{ raceNumber, postTime,
 *     raceType, raceClass, distance, surface, going, purse,
 *     entries: [{ pp, horseName, ml, jockey, trainer, status }] }] }
 *
 * @param {string} track — Equibase track code (e.g. "AQU")
 * @param {string} date  — YYYY-MM-DD
 * @param {string} venue — Human-readable venue name (e.g. "Aqueduct")
 */
async function fetchFreeEntries(track, date, venue) {
  const fileUrl = `${STATIC_ENTRIES_BASE}/entries-${track}-${date}.json`;

  const res = await fetch(fileUrl, {
    headers: {
      Accept: "application/json",
      // GitHub Pages serves static files; no auth needed
    },
    // Bypass Cloudflare's own cache for this outbound fetch so we control TTL
    cf: { cacheTtl: CACHE_TTL.entries },
  });

  if (res.status === 404) {
    throw new NotFoundError(
      `No entries file found for ${track} on ${date}. ` +
      `Entries are updated daily on race days.`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Failed to fetch static entries from GitHub Pages: ` +
      `${res.status} ${res.statusText} for ${fileUrl}`
    );
  }

  const data = await res.json();
  return transformStaticEntries(data, track, venue, date);
}

/**
 * Transforms a static entries JSON object into the normalised shape.
 *
 * @param {object} data  — Parsed static JSON (entries-{TRACK}-{DATE}.json)
 * @param {string} track — Equibase track code
 * @param {string} venue — Human-readable venue name
 * @param {string} date  — YYYY-MM-DD
 */
function transformStaticEntries(data, track, venue, date) {
  const races = (data.races || []).map((race) => {
    const entries = (race.entries || []).map((entry) => ({
      pp:        entry.pp,
      horseName: entry.name || "Unknown",
      ml:        "N/A",   // Morning line not in static file; populated by Equibase/manual
      jockey:    entry.jockey || "N/A",
      trainer:   entry.trainer || "N/A",
      // Honour the scratched flag in the static file
      status: entry.scratched ? "SCRATCHED" : "RUNNER",
    }));

    return {
      raceNumber: race.race_number,
      postTime:   race.post_time || "N/A",
      raceType:   race.race_type || "N/A",
      raceClass:  null,                    // not in static schema
      distance:   race.distance || "N/A",
      surface:    race.surface || "N/A",
      going:      null,                    // not in static schema
      purse:      formatPurse(race.purse),
      conditions: race.conditions || null, // extra field; harmless to include
      entries,
    };
  });

  return {
    track,
    date:        data.date || date,
    venue,
    lastUpdated: new Date().toISOString(),
    source:      "github-pages-static",
    races,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// FREE SOURCE: SCRATCHES (Equibase XML late-changes feed)
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Fetches the Equibase late-changes XML feed and extracts scratches for the
 * requested track and date.
 *
 * The feed URL has no required parameters — it returns the current day's
 * scratch list for all tracks.  We filter to the requested track.
 *
 * NOTE: Equibase requires a browser-like User-Agent header; without it the
 * feed returns an empty or error response.
 *
 * XML structure (simplified):
 *   <late_changes>
 *     <race_date>04/16/2026</race_date>
 *     <track track_name="AQUEDUCT" id="AQU" country="USA">
 *       <race race_number="3">
 *         <start_changes>
 *           <horse horse_name="Bold Runner" program_number="5">
 *             <change>
 *               <change_description>Scratched</change_description>
 *               <date_changed>2026-04-16 09:30:00.0</date_changed>
 *             </change>
 *           </horse>
 *         </start_changes>
 *       </race>
 *     </track>
 *   </late_changes>
 *
 * @param {string} track — Equibase track code (e.g. "AQU")
 * @param {string} date  — YYYY-MM-DD  (used to validate feed date)
 * @param {string} venue — Human-readable venue name
 */
async function fetchFreeScratches(track, date, venue) {
  const res = await fetch(EQUIBASE_SCRATCHES_URL, {
    headers: {
      // Equibase requires a real-ish User-Agent to return data
      "User-Agent": "Mozilla/5.0 (compatible; RacingCompanion/1.0)",
      Accept: "text/xml, application/xml, */*",
    },
    cf: { cacheTtl: CACHE_TTL.scratches },
  });

  if (!res.ok) {
    throw new Error(
      `Equibase scratches feed returned ${res.status} ${res.statusText}`
    );
  }

  const xml = await res.text();
  return parseEquibaseScratches(xml, track, date, venue);
}

/**
 * Parses the Equibase late-changes XML using regex.
 *
 * Cloudflare Workers don't include DOMParser, so we use regex against the
 * well-known flat/predictable structure of the Equibase feed.
 *
 * Strategy:
 *   1. Extract the <track id="AQU"> block for the requested track.
 *   2. Within that block, iterate over <race race_number="N"> elements.
 *   3. Within each race, iterate over <horse> elements.
 *   4. For each horse, extract change_description and date_changed.
 *
 * @param {string} xml   — Raw XML text from Equibase
 * @param {string} track — Equibase track code (e.g. "AQU")
 * @param {string} date  — YYYY-MM-DD
 * @param {string} venue — Human-readable venue name
 */
function parseEquibaseScratches(xml, track, date, venue) {
  const scratches = [];

  // ── 1. Find the <track> block matching our track code ────────────────────
  // The id attribute may be lower or upper case; match case-insensitively.
  // We look for: <track ... id="AQU" ...> ... </track>
  const trackBlockRe = new RegExp(
    `<track[^>]+id="${track}"[^>]*>([\\s\\S]*?)</track>`,
    "i"
  );
  const trackMatch = xml.match(trackBlockRe);

  if (!trackMatch) {
    // Track not present in today's feed — no scratches
    return {
      track,
      date,
      venue,
      lastUpdated: new Date().toISOString(),
      source: "equibase-live",
      feedDate: extractFeedDate(xml),
      scratches: [],
    };
  }

  const trackBlock = trackMatch[1];

  // ── 2. Iterate over <race race_number="N"> blocks ────────────────────────
  const raceBlockRe = /<race\s+race_number="(\d+)"[^>]*>([\s\S]*?)<\/race>/gi;
  let raceMatch;

  while ((raceMatch = raceBlockRe.exec(trackBlock)) !== null) {
    const raceNumber = parseInt(raceMatch[1], 10);
    const raceBlock  = raceMatch[2];

    // ── 3. Iterate over <horse> elements in this race ─────────────────────
    const horseRe = /<horse\s+horse_name="([^"]*)"(?:\s+program_number="([^"]*)")?[^>]*>([\s\S]*?)<\/horse>/gi;
    let horseMatch;

    while ((horseMatch = horseRe.exec(raceBlock)) !== null) {
      const horseName     = unescapeXml(horseMatch[1]);
      const programNumber = horseMatch[2] ? parseInt(horseMatch[2], 10) : null;
      const horseBlock    = horseMatch[3];

      // ── 4. Extract change details from each <change> block ───────────────
      // A horse may have multiple changes; we capture all of them.
      const changeRe = /<change>([\s\S]*?)<\/change>/gi;
      let changeMatch;

      while ((changeMatch = changeRe.exec(horseBlock)) !== null) {
        const changeBlock = changeMatch[1];

        const descMatch = changeBlock.match(
          /<change_description>([^<]*)<\/change_description>/i
        );
        const dateMatch = changeBlock.match(
          /<date_changed>([^<]*)<\/date_changed>/i
        );

        const description = descMatch ? unescapeXml(descMatch[1].trim()) : "Change";
        const changedAt   = dateMatch ? dateMatch[1].trim() : new Date().toISOString();

        // Normalise the Equibase timestamp "2026-04-16 09:30:00.0" → ISO
        const timestamp = normaliseEquibaseTimestamp(changedAt);

        scratches.push({
          raceNumber,
          pp:        programNumber,
          horseName,
          reason:    description,
          timestamp,
        });
      }
    }
  }

  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
    source:      "equibase-live",
    feedDate:    extractFeedDate(xml),
    scratches,
  };
}

/**
 * Extracts the <race_date> value from the Equibase XML.
 * Returns the raw string (e.g. "04/16/2026") or null if not found.
 */
function extractFeedDate(xml) {
  const m = xml.match(/<race_date>([^<]*)<\/race_date>/i);
  return m ? m[1].trim() : null;
}

/**
 * Converts "2026-04-16 09:30:00.0" → "2026-04-16T09:30:00.000Z"
 * Falls back to the original string if it can't be parsed.
 */
function normaliseEquibaseTimestamp(raw) {
  if (!raw) return new Date().toISOString();
  // Replace space separator and strip fractional seconds suffix
  const cleaned = raw.replace(" ", "T").replace(/\.\d+$/, "") + "Z";
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? raw : d.toISOString();
}

/**
 * Unescapes basic XML entities in attribute values / text content.
 */
function unescapeXml(str) {
  if (!str) return str;
  return str
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ═════════════════════════════════════════════════════════════════════════════
// FREE SOURCE: ODDS — not available; graceful stub
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns a graceful "unavailable" response for live odds in free mode.
 * The frontend should detect source === "unavailable" and show an appropriate
 * message in the UI.
 *
 * @param {string} track      — Equibase track code
 * @param {string} date       — YYYY-MM-DD
 * @param {string} venue      — Human-readable venue name
 * @param {number} raceNumber — Race number (1-based)
 */
function buildFreeOddsResponse(track, date, venue, raceNumber) {
  return {
    track,
    date,
    venue,
    raceNumber,
    lastUpdated: new Date().toISOString(),
    source:  "unavailable",
    message: "Live odds require a The Racing API subscription. " +
             "Configure DATA_SOURCE=theracingapi and set API_KEY in Settings.",
    odds: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// FREE SOURCE: RESULTS — not available; graceful stub
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Returns a graceful "unavailable" response for results in free mode.
 *
 * @param {string} track — Equibase track code
 * @param {string} date  — YYYY-MM-DD
 * @param {string} venue — Human-readable venue name
 */
function buildFreeResultsResponse(track, date, venue) {
  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
    source:  "unavailable",
    message: "Race results require a The Racing API subscription. " +
             "Configure DATA_SOURCE=theracingapi and set API_KEY in Settings.",
    races: [],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// THE RACING API: Normalisation helpers
// ═════════════════════════════════════════════════════════════════════════════
// These functions are used when DATA_SOURCE=theracingapi. They are kept
// intact from the original worker so it's easy to switch back.

// ─── Normalisation: racecards → entries response ──────────────────────────────
/**
 * Filters a list of racecards to those matching the requested venue, then
 * normalises into the /api/entries response shape.
 *
 * The Racing API `/racecards` endpoint returns ALL races for a date/region.
 * We filter by `course` field matching the mapped venue name.
 *
 * @param {object[]} racecards   — Array from upstream `racecards` key
 * @param {string}   track       — Equibase track code (e.g. "AQU")
 * @param {string}   venue       — Human-readable venue name (e.g. "Aqueduct")
 * @param {string}   date        — YYYY-MM-DD
 */
function normaliseEntries(racecards, track, venue, date) {
  const venueLC = venue.toLowerCase();
  const matching = racecards.filter(
    (rc) => rc.course && rc.course.toLowerCase().includes(venueLC)
  );

  matching.sort((a, b) => {
    const tA = a.off_dt || a.off_time || "";
    const tB = b.off_dt || b.off_time || "";
    return tA.localeCompare(tB);
  });

  const races = matching.map((rc, idx) => {
    const runners = (rc.runners || []).map((r) => ({
      pp: parseInt(r.number || r.draw || idx + 1, 10),
      horseName: r.horse || "Unknown",
      ml: bestFractional(r.odds) || (r.sp ? String(r.sp).replace("/", "-") : "N/A"),
      jockey: r.jockey || "N/A",
      trainer: r.trainer || "N/A",
      status: r.scratched ? "SCRATCHED" : "RUNNER",
    }));

    return {
      raceNumber: idx + 1,
      raceId:     rc.race_id || null,
      postTime:   formatPostTime(rc.off_dt, rc.off_time),
      raceType:   rc.race_name || rc.type || "N/A",
      raceClass:  rc.race_class || null,
      distance:   formatDistance(rc.distance_f, rc.distance),
      surface:    rc.surface || "N/A",
      going:      rc.going || null,
      purse:      formatPurse(rc.prize),
      entries:    runners,
    };
  });

  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi",
    races,
  };
}

// ─── Normalisation: racecards → scratches response ───────────────────────────
/**
 * Extracts scratched/non-running horses from the racecard data.
 *
 * The Racing API surfaces scratches in two ways:
 *   1. `non_runners` — a comma-separated string on the racecard object
 *   2. `runner.scratched` — a boolean (or truthy value) on a runner object
 *
 * We consolidate both into the /api/scratches shape.
 */
function normaliseScratches(racecards, track, venue, date) {
  const venueLC = venue.toLowerCase();
  const matching = racecards.filter(
    (rc) => rc.course && rc.course.toLowerCase().includes(venueLC)
  );

  matching.sort((a, b) => {
    const tA = a.off_dt || a.off_time || "";
    const tB = b.off_dt || b.off_time || "";
    return tA.localeCompare(tB);
  });

  const scratches = [];

  matching.forEach((rc, idx) => {
    const raceNumber = idx + 1;

    // 1. Per-runner scratched flag
    (rc.runners || []).forEach((r) => {
      if (r.scratched) {
        scratches.push({
          raceNumber,
          pp:        parseInt(r.number || r.draw || 0, 10),
          horseName: r.horse || "Unknown",
          reason:    r.scratched_reason || "Scratched",
          timestamp: r.scratched_at || new Date().toISOString(),
        });
      }
    });

    // 2. non_runners string (e.g. "Diamonds Diva (reserve), Great Rainbow")
    if (rc.non_runners && typeof rc.non_runners === "string") {
      const parts = rc.non_runners
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      parts.forEach((entry) => {
        const match = entry.match(/^(.+?)\s*(?:\((.+?)\))?$/);
        const horseName = match ? match[1].trim() : entry;
        const reason    = match && match[2] ? match[2].trim() : "Non-Runner";
        scratches.push({
          raceNumber,
          pp:        null,
          horseName,
          reason,
          timestamp: new Date().toISOString(),
        });
      });
    }
  });

  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi",
    scratches,
  };
}

// ─── Normalisation: racecard race → odds response ────────────────────────────
/**
 * Builds the /api/odds response for a specific race number.
 * Odds are embedded in the standard racecard runners' `odds` arrays.
 */
function normaliseOdds(racecards, track, venue, date, raceNumber) {
  const venueLC = venue.toLowerCase();
  const matching = racecards.filter(
    (rc) => rc.course && rc.course.toLowerCase().includes(venueLC)
  );

  matching.sort((a, b) => {
    const tA = a.off_dt || a.off_time || "";
    const tB = b.off_dt || b.off_time || "";
    return tA.localeCompare(tB);
  });

  const raceIdx = raceNumber - 1;
  const rc = matching[raceIdx] || null;

  if (!rc) {
    return {
      track,
      date,
      venue,
      raceNumber,
      lastUpdated: new Date().toISOString(),
      odds:  [],
      error: `Race ${raceNumber} not found at ${venue} on ${date}`,
    };
  }

  const odds = (rc.runners || []).map((r) => {
    const liveOdds   = bestFractional(r.odds) || (r.sp ? String(r.sp).replace("/", "-") : "N/A");
    const firstOdds  = r.odds && r.odds[0];
    const pool       = firstOdds && firstOdds.decimal
      ? Math.round(10000 / parseFloat(firstOdds.decimal))
      : null;

    return {
      pp:        parseInt(r.number || r.draw || 0, 10),
      horseName: r.horse || "Unknown",
      liveOdds,
      pool,
      allOdds:   (r.odds || []).map((o) => ({
        bookmaker: o.bookmaker,
        fractional: o.fractional ? String(o.fractional).replace("/", "-") : null,
        decimal:    o.decimal ? parseFloat(o.decimal) : null,
        updated:    o.updated || null,
      })),
    };
  });

  return {
    track,
    date,
    venue,
    raceNumber,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi",
    odds,
  };
}

// ─── Normalisation: results → results response ───────────────────────────────
/**
 * Converts upstream results into the /api/results shape.
 */
function parsePayoutAmount(raw) {
  if (!raw) return null;
  const stripped = String(raw).replace(/[£€$,]/g, "").trim();
  const num = parseFloat(stripped);
  return isNaN(num) ? null : num;
}

/**
 * `tote_pl` is a space-separated string like "€2.30 €5.80 €4.20"
 * We return the first value as `place` and second as `show`.
 */
function parsePlacePayouts(totePl) {
  if (!totePl) return { place: null, show: null };
  const parts = String(totePl)
    .split(/\s+/)
    .map((s) => parsePayoutAmount(s))
    .filter((n) => n !== null);
  return {
    place: parts[0] ?? null,
    show:  parts[1] ?? null,
  };
}

function normaliseResults(results, track, venue, date) {
  const venueLC = venue.toLowerCase();
  const matching = results.filter(
    (r) => r.course && r.course.toLowerCase().includes(venueLC)
  );

  matching.sort((a, b) => {
    const tA = a.off_dt || a.off || "";
    const tB = b.off_dt || b.off || "";
    return tA.localeCompare(tB);
  });

  const races = matching.map((rc, idx) => {
    const runners = (rc.runners || []).slice().sort((a, b) => {
      const posA = parseInt(a.position, 10) || 9999;
      const posB = parseInt(b.position, 10) || 9999;
      return posA - posB;
    });

    const finishOrder = runners.map((r) => ({
      position:  parseInt(r.position, 10) || null,
      pp:        parseInt(r.number || r.draw || 0, 10),
      horseName: r.horse || "Unknown",
      jockey:    r.jockey || "N/A",
      trainer:   r.trainer || "N/A",
      liveOdds:  r.sp ? String(r.sp).replace("/", "-") : decimalToFractional(r.bsp),
      btn:       r.btn || null,
      comment:   r.comment || null,
    }));

    const { place, show } = parsePlacePayouts(rc.tote_pl);

    return {
      raceNumber: idx + 1,
      raceId:     rc.race_id || null,
      raceName:   rc.race_name || null,
      official:   !!rc.winning_time_detail,
      finishOrder,
      payouts: {
        win:      parsePayoutAmount(rc.tote_win),
        place,
        show,
        exacta:   parsePayoutAmount(rc.tote_ex),
        trifecta: parsePayoutAmount(rc.tote_trifecta),
        tricast:  parsePayoutAmount(rc.tote_tricast),
        csf:      parsePayoutAmount(rc.tote_csf),
      },
      winningTime: rc.winning_time_detail || null,
    };
  });

  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi",
    races,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Custom error class for 404 / "file not found" situations
// ═════════════════════════════════════════════════════════════════════════════
class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "NotFoundError";
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Route handlers
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Determines whether to use the free source stack or The Racing API.
 * Returns true when DATA_SOURCE === "theracingapi" AND API_KEY is set.
 *
 * @param {object} env — Worker env bindings
 */
function usePaidSource(env) {
  return (
    (env.DATA_SOURCE || "").toLowerCase() === "theracingapi" &&
    !!env.API_KEY
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/entries?track=AQU&date=2026-04-16
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Free mode:  Fetches static JSON from GitHub Pages and transforms it.
 * Paid mode:  Fetches from The Racing API /racecards/standard endpoint.
 *
 * The response shape is identical in both modes.
 */
async function handleEntries(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || env.DEFAULT_TRACK || "AQU").toUpperCase();
  const date  = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const venue = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(
      `Unknown track code: ${track}. Supported: ${Object.keys(TRACK_TO_VENUE).join(", ")}`,
      400,
      origin
    );
  }

  const cacheKey = new Request(`https://ne-racing-cache/entries/${track}/${date}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    let body;

    if (usePaidSource(env)) {
      // ── The Racing API path ───────────────────────────────────────────────
      const data = await fetchUpstream(
        `/racecards/standard?date=${date}&region=USA`,
        env.API_KEY
      );
      body = normaliseEntries(data.racecards || [], track, venue, date);
    } else {
      // ── Free / GitHub Pages path ──────────────────────────────────────────
      body = await fetchFreeEntries(track, date, venue);
    }

    const response = jsonOk(body, origin, CACHE_TTL.entries);
    await writeCache(cacheKey, response);
    return response;

  } catch (err) {
    if (err instanceof NotFoundError) {
      return jsonError(err.message, 404, origin);
    }
    return jsonError(`Entries fetch failed: ${err.message}`, 503, origin);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/scratches?track=AQU&date=2026-04-16
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Free mode:  Fetches and parses the Equibase late-changes XML feed.
 * Paid mode:  Derives scratches from The Racing API racecard data.
 *
 * The response shape is identical in both modes.
 *
 * Note: The Equibase feed only contains the *current* day's changes.
 * Requesting scratches for a past date in free mode will likely return an
 * empty list (the feed has rolled over to the current day).
 */
async function handleScratches(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || env.DEFAULT_TRACK || "AQU").toUpperCase();
  const date  = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const venue = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}`, 400, origin);
  }

  // Scratches are live — use a short-lived cache key
  const cacheKey = new Request(`https://ne-racing-cache/scratches/${track}/${date}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    let body;

    if (usePaidSource(env)) {
      // ── The Racing API path ───────────────────────────────────────────────
      const data = await fetchUpstream(
        `/racecards/standard?date=${date}&region=USA`,
        env.API_KEY
      );
      body = normaliseScratches(data.racecards || [], track, venue, date);
    } else {
      // ── Free / Equibase XML path ──────────────────────────────────────────
      body = await fetchFreeScratches(track, date, venue);
    }

    const response = jsonOk(body, origin, CACHE_TTL.scratches);
    await writeCache(cacheKey, response);
    return response;

  } catch (err) {
    return jsonError(`Scratches fetch failed: ${err.message}`, 503, origin);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/odds?track=AQU&date=2026-04-16&race=5
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Free mode:  Returns a graceful "unavailable" response.
 * Paid mode:  Fetches odds from The Racing API racecard data.
 *
 * The `race` parameter is 1-based (race 1, race 2, …).
 */
async function handleOdds(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track      = (searchParams.get("track") || env.DEFAULT_TRACK || "AQU").toUpperCase();
  const date       = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const raceNumber = parseInt(searchParams.get("race") || "1", 10);
  const venue      = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}`, 400, origin);
  }
  if (isNaN(raceNumber) || raceNumber < 1) {
    return jsonError("Invalid race number. Must be a positive integer.", 400, origin);
  }

  // Free mode: return the stub immediately; no caching needed for a static stub
  if (!usePaidSource(env)) {
    const body = buildFreeOddsResponse(track, date, venue, raceNumber);
    return jsonOk(body, origin, 0);
  }

  // Paid mode: fetch from The Racing API
  const cacheKey = new Request(`https://ne-racing-cache/odds/${track}/${date}/${raceNumber}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchUpstream(
      `/racecards/standard?date=${date}&region=USA`,
      env.API_KEY
    );
    const body = normaliseOdds(data.racecards || [], track, venue, date, raceNumber);
    const response = jsonOk(body, origin, CACHE_TTL.odds);
    await writeCache(cacheKey, response);
    return response;

  } catch (err) {
    return jsonError(`Odds fetch failed: ${err.message}`, 503, origin);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/results?track=AQU&date=2026-04-16
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Free mode:  Returns a graceful "unavailable" response.
 * Paid mode:  Fetches results from The Racing API /results endpoint.
 */
async function handleResults(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || env.DEFAULT_TRACK || "AQU").toUpperCase();
  const date  = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const venue = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}`, 400, origin);
  }

  // Free mode: return the stub immediately
  if (!usePaidSource(env)) {
    const body = buildFreeResultsResponse(track, date, venue);
    return jsonOk(body, origin, 0);
  }

  // Paid mode: fetch from The Racing API
  const cacheKey = new Request(`https://ne-racing-cache/results/${track}/${date}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    // The results endpoint accepts start_date / end_date.
    // Query a single day by setting both to the same date.
    const data = await fetchUpstream(
      `/results?start_date=${date}&end_date=${date}&region=USA`,
      env.API_KEY
    );
    const body = normaliseResults(data.results || [], track, venue, date);
    const response = jsonOk(body, origin, CACHE_TTL.results);
    await writeCache(cacheKey, response);
    return response;

  } catch (err) {
    return jsonError(`Results fetch failed: ${err.message}`, 503, origin);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// Main fetch handler (Worker entry point)
// ═════════════════════════════════════════════════════════════════════════════
export default {
  /**
   * Cloudflare Worker entry point.
   *
   * Environment variables (set via wrangler.toml [vars] or `wrangler secret put`):
   *   DATA_SOURCE    — "free" (default) | "theracingapi"
   *   API_KEY        — The Racing API Bearer token (secret; only needed for theracingapi)
   *   DEFAULT_TRACK  — Fallback track code when ?track= is omitted (default: "AQU")
   *   ALLOWED_ORIGIN — Value for Access-Control-Allow-Origin (default: "*")
   *
   * Switching sources:
   *   Free (GitHub Pages + Equibase):  DATA_SOURCE=free  (or unset)
   *   The Racing API (paid):           DATA_SOURCE=theracingapi  +  API_KEY=<token>
   */
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const url    = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, 0),
      });
    }

    // ── Only GET is supported for data endpoints ──────────────────────────
    if (request.method !== "GET") {
      return jsonError("Method not allowed. Use GET.", 405, origin);
    }

    // ── Guard: require API_KEY only when DATA_SOURCE=theracingapi ─────────
    const dataSource = (env.DATA_SOURCE || "free").toLowerCase();
    if (dataSource === "theracingapi" && !env.API_KEY) {
      return jsonError(
        "Worker misconfiguration: DATA_SOURCE is set to 'theracingapi' " +
        "but API_KEY environment variable is not set. " +
        "Either set API_KEY (wrangler secret put API_KEY) or set DATA_SOURCE=free.",
        500,
        origin
      );
    }

    // ── Route dispatch ────────────────────────────────────────────────────
    const { pathname } = url;

    switch (pathname) {
      case "/api/entries":
        return handleEntries(request, env, origin);

      case "/api/scratches":
        return handleScratches(request, env, origin);

      case "/api/odds":
        return handleOdds(request, env, origin);

      case "/api/results":
        return handleResults(request, env, origin);

      // ── Health check / root ───────────────────────────────────────────
      case "/":
      case "/health":
        return jsonOk(
          {
            service:      "ne-racing-proxy",
            status:       "ok",
            dataSource,
            activeSources: {
              entries:  dataSource === "theracingapi" ? "theracingapi"   : "github-pages-static",
              scratches: dataSource === "theracingapi" ? "theracingapi"  : "equibase-live",
              odds:     dataSource === "theracingapi" ? "theracingapi"   : "unavailable",
              results:  dataSource === "theracingapi" ? "theracingapi"   : "unavailable",
            },
            defaultTrack: env.DEFAULT_TRACK || "AQU",
            staticEntriesPattern: `${STATIC_ENTRIES_BASE}/entries-{TRACK}-{DATE}.json`,
            scratchesFeed:        EQUIBASE_SCRATCHES_URL,
            endpoints: [
              "/api/entries?track=AQU&date=YYYY-MM-DD",
              "/api/scratches?track=AQU&date=YYYY-MM-DD",
              "/api/odds?track=AQU&date=YYYY-MM-DD&race=5",
              "/api/results?track=AQU&date=YYYY-MM-DD",
            ],
          },
          origin,
          0
        );

      default:
        return jsonError(`Unknown route: ${pathname}`, 404, origin);
    }
  },
};
