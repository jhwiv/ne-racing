/**
 * Cloudflare Worker — NE Racing Proxy
 *
 * Serves horse racing data to the NE Racing companion app.
 * Supports two data source modes, selected by the DATA_SOURCE env var:
 *
 *   DATA_SOURCE = "free" (default)
 *   ────────────────────────────────────────────────────────────────────
 *   • Entries  — Static JSON files + local fixtures bundled with the app
 *                https://jhwiv.github.io/ne-racing/data/entries-{TRACK}-{DATE}.json
 *   • Scratches — Returns empty list (no unauthorized scraping).
 *   • Odds      — Returns empty list; app falls back to morning-line odds.
 *   • Results   — Returns empty list (no unauthorized scraping).
 *
 *   NOTE: The Equibase/NYRA fetch helpers below (fetchFreeScratches,
 *   fetchFreeOdds, fetchFreeResults) are retained as ARCHITECTURE ONLY
 *   for a future licensed adapter. They are NOT called by the free path.
 *
 *   DATA_SOURCE = "theracingapi"  (requires API_USER + API_KEY secrets)
 *   ────────────────────────────────────────────────────────────────────
 *   • All four endpoints served via The Racing API NA add-on
 *     (https://api.theracingapi.com/v1/north-america/...)
 *   • Auth: HTTP Basic (username + password)
 *   • Full entries, scratches, morning-line odds and results data available
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
 * # Secrets — set via CLI or CF REST API, never committed to source control:
 * #   wrangler secret put API_USER  (Racing API username, only for DATA_SOURCE=theracingapi)
 * #   wrangler secret put API_KEY   (Racing API password, only for DATA_SOURCE=theracingapi)
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
  // Northeast / Mid-Atlantic
  AQU: "Aqueduct",
  BEL: "Belmont Park",
  SAR: "Saratoga",
  MTH: "Monmouth Park",
  PRX: "Parx Racing",
  FL:  "Finger Lakes",
  DEL: "Delaware Park",
  PIM: "Pimlico",
  LRL: "Laurel Park",
  CT:  "Charles Town",
  PEN: "Penn National",
  BTP: "Belterra Park",
  TDN: "Thistledown",
  // Midwest / Central
  CD:  "Churchill Downs",
  ELP: "Ellis Park",
  KEE: "Keeneland",
  TP:  "Turfway Park",
  HAW: "Hawthorne",
  AP:  "Arlington Park",
  FG:  "Fair Grounds",
  IND: "Horseshoe Indianapolis",
  // South / Southwest
  GP:  "Gulfstream Park",
  TAM: "Tampa Bay Downs",
  OP:  "Oaklawn Park",
  LS:  "Lone Star Park",
  HOU: "Sam Houston Race Park",
  RP:  "Remington Park",
  EVD: "Evangeline Downs",
  DED: "Delta Downs",
  LAD: "Louisiana Downs",
  // West
  SA:  "Santa Anita Park",
  DMR: "Del Mar",
  GG:  "Golden Gate Fields",
  LRC: "Los Alamitos",
  EMD: "Emerald Downs",
  // Other
  WO:  "Woodbine",
  SWA: "Horseshoe Turf Pick 3",
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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ─── Upstream fetch helper (The Racing API NA — HTTP Basic auth) ─────────────
/**
 * Builds the `Authorization: Basic ...` header from a username + password.
 * Cloudflare Workers runtime exposes `btoa` globally.
 */
function basicAuthHeader(user, pass) {
  return "Basic " + btoa(`${user}:${pass}`);
}

/**
 * Fetches `path` from The Racing API using HTTP Basic auth.
 * Returns parsed JSON on success; throws on HTTP error (with body for context).
 *
 * @param {string} path    — e.g. "/north-america/meets?start_date=...&end_date=..."
 * @param {string} user    — Racing API username (env.API_USER)
 * @param {string} pass    — Racing API password (env.API_KEY)
 */
async function fetchUpstream(path, user, pass) {
  const url = `${THERACINGAPI_BASE}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: basicAuthHeader(user, pass),
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    let body = "";
    try { body = (await res.text()).slice(0, 240); } catch (_) {}
    const e = new Error(
      `Upstream ${res.status} ${res.statusText} for ${url}${body ? " :: " + body : ""}`
    );
    e.upstreamStatus = res.status;
    throw e;
  }

  return res.json();
}

// ─── NA helpers: meet_id lookup, schema mapping ──────────────────────────────
/**
 * Look up the NA meet_id for a given Equibase track code on a given date.
 * Returns { meet_id, track_name } or null when no meet is scheduled.
 *
 * Caches a single date-window meets list in CF cache for a short TTL so
 * repeated handler calls within a request burst share one upstream hit.
 */
async function findMeetId(trackCode, date, user, pass) {
  // Cache key per date so the meets index can be reused across endpoints.
  const meetsCacheKey = new Request(`https://ne-racing-cache/na-meets/${date}`);
  let meetsList = null;

  const cached = await readCache(meetsCacheKey);
  if (cached) {
    try { meetsList = (await cached.json()).meets || []; } catch (_) { meetsList = null; }
  }

  if (!meetsList) {
    const data = await fetchUpstream(
      `/north-america/meets?start_date=${date}&end_date=${date}&limit=50`,
      user, pass
    );
    meetsList = data.meets || [];
    const resp = new Response(JSON.stringify({ meets: meetsList }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
    });
    await writeCache(meetsCacheKey, resp);
  }

  const meet = meetsList.find((m) => (m.track_id || "").toUpperCase() === trackCode.toUpperCase());
  return meet || null;
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
      pp:               entry.pp,
      horseName:        entry.name || "Unknown",
      ml:               entry.ml || "N/A",
      jockey:           entry.jockey || "N/A",
      trainer:          entry.trainer || "N/A",
      status:           entry.scratched ? "SCRATCHED" : "RUNNER",
      speedFigs:        entry.speedFigs || [null, null, null],
      runningStyle:     entry.runningStyle || "",
      jockeyPct:        entry.jockeyPct || 0,
      trainerPct:       entry.trainerPct || 0,
      lastClass:        entry.lastClass || null,
      lastRaceDate:     entry.lastRaceDate || null,
      equipmentChanges: entry.equipmentChanges || "",
      workouts:         entry.workouts || [],
    }));

    return {
      raceNumber:    race.race_number,
      postTime:      race.post_time || "N/A",
      raceType:      race.race_type || "N/A",
      raceClass:     null,                    // not in static schema
      distance:      race.distance || "N/A",
      surface:       race.surface || "N/A",
      going:         null,                    // not in static schema
      purse:         formatPurse(race.purse),
      conditions:    race.conditions || null, // extra field; harmless to include
      expertPicks:   race.expertPicks || [],  // expert handicapper picks
      equibaseUrl:   race.equibaseUrl || null,
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
/**
 * Attempts to fetch live win pool odds from NYRA's live odds page.
 * Falls back to a graceful "unavailable" stub if fetching fails.
 *
 * NYRA exposes tote odds at predictable URLs during live racing hours.
 * We try multiple sources and return whichever succeeds first.
 *
 * @param {string} track       — Equibase track code
 * @param {string} date        — YYYY-MM-DD
 * @param {string} venue       — Human-readable venue name
 * @param {number} raceNumber  — Race number
 */
async function fetchFreeOdds(track, date, venue, raceNumber) {
  // NYRA tracks: try fetching from NYRA's live tote data
  const nyraTrackMap = {
    AQU: 'aqueduct',
    SAR: 'saratoga',
    BEL: 'aqueduct',
    BTP: 'belmont-park',
  };

  const nyraSlug = nyraTrackMap[track];
  if (nyraSlug) {
    try {
      // NYRA provides a JSON odds feed during live racing
      const nyraUrl = `https://www.nyra.com/api/odds/${nyraSlug}/race/${raceNumber}`;
      const resp = await fetch(nyraUrl, {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'NE-Racing-Companion/1.0',
        },
        cf: { cacheTtl: 45 },
      });

      if (resp.ok) {
        const nyraData = await resp.json();
        if (nyraData && nyraData.runners && nyraData.runners.length) {
          return {
            track,
            date,
            venue,
            raceNumber,
            lastUpdated: new Date().toISOString(),
            source: 'nyra',
            mtp: nyraData.mtp || null,
            odds: nyraData.runners.map(r => ({
              pp: parseInt(r.program_number || r.post_position || 0, 10),
              horseName: r.horse_name || r.name || 'Unknown',
              liveOdds: r.odds || r.win_odds || 'N/A',
              pool: r.win_pool ? Math.round(parseFloat(r.win_pool)) : null,
            })),
          };
        }
      }
    } catch (_) {
      // NYRA feed not available — try next source
    }
  }

  // Equibase live odds (HTML scraping as fallback)
  try {
    const dateFormatted = date.replace(/-/g, '').slice(4) + date.slice(0, 4); // MMDDYYYY
    const eqbUrl = `https://www.equibase.com/premium/eqbLiveOddsXMLDownload.cfm?tk=${track}&cy=USA&dt=${dateFormatted}&rn=${raceNumber}`;
    const resp = await fetch(eqbUrl, {
      headers: {
        'Accept': 'text/xml, application/xml',
        'User-Agent': 'NE-Racing-Companion/1.0',
      },
      cf: { cacheTtl: 45 },
    });

    if (resp.ok) {
      const xml = await resp.text();
      // Parse XML odds using regex (no DOMParser in Workers)
      const odds = parseEquibaseOddsXml(xml, track, date, venue, raceNumber);
      if (odds && odds.odds && odds.odds.length) {
        return odds;
      }
    }
  } catch (_) {
    // Equibase odds not available
  }

  // All free sources exhausted — return graceful stub
  return {
    track,
    date,
    venue,
    raceNumber,
    lastUpdated: new Date().toISOString(),
    source: 'unavailable',
    message: 'Live odds are not available right now. Odds are only available during live racing hours.',
    odds: [],
  };
}

/**
 * Parse Equibase live odds XML feed.
 * The Equibase XML format provides runners with program numbers and odds.
 */
function parseEquibaseOddsXml(xml, track, date, venue, raceNumber) {
  if (!xml || !xml.includes('<')) {
    return null;
  }

  const odds = [];
  // Try to match runner entries with odds
  const runnerRegex = /<Runner[^>]*>([\s\S]*?)<\/Runner>/gi;
  let match;
  while ((match = runnerRegex.exec(xml)) !== null) {
    const block = match[1];
    const ppMatch = block.match(/<ProgramNumber[^>]*>(\d+)<\/ProgramNumber>/i) ||
                    block.match(/ProgramNumber="(\d+)"/i);
    const nameMatch = block.match(/<HorseName[^>]*>([^<]+)<\/HorseName>/i) ||
                      block.match(/HorseName="([^"]+)"/i);
    const oddsMatch = block.match(/<Odds[^>]*>([^<]+)<\/Odds>/i) ||
                      block.match(/Odds="([^"]+)"/i) ||
                      block.match(/<WinOdds[^>]*>([^<]+)<\/WinOdds>/i);

    if (ppMatch) {
      odds.push({
        pp: parseInt(ppMatch[1], 10),
        horseName: nameMatch ? nameMatch[1].trim() : 'Unknown',
        liveOdds: oddsMatch ? oddsMatch[1].trim() : 'N/A',
        pool: null,
      });
    }
  }

  // Try simpler format: <Entry> elements
  if (!odds.length) {
    const entryRegex = /<Entry[^>]*>([\s\S]*?)<\/Entry>/gi;
    while ((match = entryRegex.exec(xml)) !== null) {
      const block = match[1];
      const ppMatch = block.match(/<PP[^>]*>(\d+)<\/PP>/i) || block.match(/PP="(\d+)"/i);
      const nameMatch = block.match(/<Name[^>]*>([^<]+)<\/Name>/i) || block.match(/Name="([^"]+)"/i);
      const oddsMatch = block.match(/<Odds[^>]*>([^<]+)<\/Odds>/i) || block.match(/Odds="([^"]+)"/i);
      if (ppMatch) {
        odds.push({
          pp: parseInt(ppMatch[1], 10),
          horseName: nameMatch ? nameMatch[1].trim() : 'Unknown',
          liveOdds: oddsMatch ? oddsMatch[1].trim() : 'N/A',
          pool: null,
        });
      }
    }
  }

  if (!odds.length) return null;

  // Extract MTP if available
  const mtpMatch = xml.match(/<MTP[^>]*>(\d+)<\/MTP>/i) || xml.match(/MTP="(\d+)"/i);
  const mtp = mtpMatch ? parseInt(mtpMatch[1], 10) : null;

  return {
    track,
    date,
    venue,
    raceNumber,
    lastUpdated: new Date().toISOString(),
    source: 'equibase',
    mtp,
    odds,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// FREE SOURCE: RESULTS — Equibase mobile site
// ═════════════════════════════════════════════════════════════════════════════

const EQUIBASE_MOBILE_BASE = "https://mobile.equibase.com/html/results";

/**
 * Fetches race results from the Equibase mobile site for free-mode users.
 *
 * Strategy: The race list page (resultsAQU20260416.html) often returns 404
 * or empty, so we iterate individual race URLs (race 01 through 12) directly.
 * We try the list page first as a quick discovery mechanism, then fall back
 * to probing individual race URLs.
 *
 * @param {string} track — Equibase track code (e.g. "AQU")
 * @param {string} date  — YYYY-MM-DD
 * @param {string} venue — Human-readable venue name
 */
async function fetchFreeResults(track, date, venue) {
  const yyyymmdd = date.replace(/-/g, "");

  // Try the list page first for race number discovery
  let raceNumbers = [];
  try {
    const listUrl = `${EQUIBASE_MOBILE_BASE}${track}${yyyymmdd}.html`;
    const listRes = await fetch(listUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RacingCompanion/1.0)",
        Accept: "text/html",
      },
    });

    if (listRes.ok) {
      const listHtml = await listRes.text();
      const linkPattern = new RegExp(
        `results${track}${yyyymmdd}(\\d{2})\\.html`, "gi"
      );
      let linkMatch;
      while ((linkMatch = linkPattern.exec(listHtml)) !== null) {
        const num = parseInt(linkMatch[1], 10);
        if (!raceNumbers.includes(num)) raceNumbers.push(num);
      }
    }
  } catch (_) {
    // List page failed — we'll iterate individually
  }

  // If list page didn't yield results, iterate races 1-12 directly
  if (!raceNumbers.length) {
    for (let i = 1; i <= 12; i++) raceNumbers.push(i);
  }

  raceNumbers.sort((a, b) => a - b);

  // Fetch each individual race result in parallel
  const racePromises = raceNumbers.map(async (raceNum) => {
    const rr = String(raceNum).padStart(2, "0");
    const raceUrl = `${EQUIBASE_MOBILE_BASE}${track}${yyyymmdd}${rr}.html`;
    try {
      const res = await fetch(raceUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; RacingCompanion/1.0)",
          Accept: "text/html",
        },
      });
      if (!res.ok) return null;
      const html = await res.text();
      return parseEquibaseRaceResult(html, raceNum);
    } catch (_) {
      return null;
    }
  });

  const raceResults = (await Promise.all(racePromises)).filter(Boolean);

  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
    source: "equibase",
    races: raceResults,
  };
}

/**
 * Parses an individual Equibase mobile race result HTML page.
 *
 * Extracts:
 *   - Full finishing order with WPS payouts per horse
 *   - Exotic payouts (Exacta, Trifecta, Superfecta, DD, Pick 3/4/5/6, Quinella)
 *   - Scratched horses
 *
 * Expected structure:
 *   <table bgcolor="#008000">...<b>04/10/2026 Race 1 - Starter Allowance</b>...</table>
 *   <table width="100%">
 *     <tr><td>1 Snide $4.38 $2.92 $2.32</td></tr>       (1st: PP Name $Win $Place $Show)
 *     <tr><td>4 Grace and Grit  $3.66 $2.94</td></tr>    (2nd: PP Name $Place $Show)
 *     <tr><td>2 Racing Colors   $3.58</td></tr>           (3rd: PP Name $Show)
 *   </table>
 *   ... exotic payouts like "Exacta (1-5) $9.85", "Trifecta (1-5-4) $11.62" ...
 *   ... scratched horses listed as "Scratched: Vivienna" or similar ...
 *
 * @param {string} html    — Raw HTML from the race result page
 * @param {number} raceNum — The race number (fallback if parsing header fails)
 */
function parseEquibaseRaceResult(html, raceNum) {
  // Extract race number from the green header: "Race N"
  const raceHeaderMatch = html.match(/Race\s+(\d+)/i);
  const raceNumber = raceHeaderMatch ? parseInt(raceHeaderMatch[1], 10) : raceNum;

  // Find the results table — it comes after the green header table.
  // We look for <tr><td> rows containing a leading number (PP) followed by
  // a horse name and dollar amounts.
  // Pattern: {PP} {HorseName} [$X.XX] [$X.XX] [$X.XX]
  const resultRowPattern = /<tr[^>]*>\s*<td[^>]*>\s*(\d+)\s+([^$<]+?)(\$[\d.]+(?:\s+\$[\d.]+)*)\s*<\/td>\s*<\/tr>/gi;

  const results = [];
  let position = 0;
  let rowMatch;

  while ((rowMatch = resultRowPattern.exec(html)) !== null) {
    position++;
    const pp = parseInt(rowMatch[1], 10);
    const horseName = rowMatch[2].trim();
    const payoutStr = rowMatch[3].trim();

    // Parse dollar amounts
    const payouts = [];
    const dollarPattern = /\$([\d.]+)/g;
    let dollarMatch;
    while ((dollarMatch = dollarPattern.exec(payoutStr)) !== null) {
      payouts.push(parseFloat(dollarMatch[1]));
    }

    const entry = { position, pp, horseName };

    // 1st place: 3 payouts (Win, Place, Show)
    // 2nd place: 2 payouts (Place, Show)
    // 3rd place: 1 payout (Show)
    if (position === 1 && payouts.length >= 3) {
      entry.winPayout = payouts[0];
      entry.placePayout = payouts[1];
      entry.showPayout = payouts[2];
    } else if (position === 1 && payouts.length === 2) {
      entry.winPayout = payouts[0];
      entry.placePayout = payouts[1];
    } else if (position === 1 && payouts.length === 1) {
      entry.winPayout = payouts[0];
    } else if (position === 2 && payouts.length >= 2) {
      entry.placePayout = payouts[0];
      entry.showPayout = payouts[1];
    } else if (position === 2 && payouts.length === 1) {
      entry.placePayout = payouts[0];
    } else if (position === 3 && payouts.length >= 1) {
      entry.showPayout = payouts[0];
    }

    results.push(entry);
  }

  // Also capture finishers listed without payouts (4th+)
  // Pattern: rows with just PP and horse name, no dollar signs
  const alsoRanPattern = /<tr[^>]*>\s*<td[^>]*>\s*(\d+)\s+([^$<]{2,}?)\s*<\/td>\s*<\/tr>/gi;
  let alsoRanMatch;
  while ((alsoRanMatch = alsoRanPattern.exec(html)) !== null) {
    const pp = parseInt(alsoRanMatch[1], 10);
    const horseName = alsoRanMatch[2].trim();
    // Skip if we already captured this horse (has payouts)
    if (results.some(r => r.pp === pp)) continue;
    // Skip if it looks like exotic payout text
    if (/exacta|trifecta|superfecta|daily|pick|quinella/i.test(horseName)) continue;
    position++;
    results.push({ position, pp, horseName });
  }

  if (!results.length) return null;

  // ── Parse exotic payouts ──────────────────────────────────────────────────
  // Look for patterns like "Exacta (1-5) $9.85" or "Trifecta 1-5-4 $11.62"
  // Also handles "Daily Double", "Pick 3", "Pick 4", etc.
  const exotics = [];
  const exoticTypes = [
    { pattern: /(?:Super(?:fecta)?)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'superfecta' },
    { pattern: /(?:Tri(?:fecta)?)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'trifecta' },
    { pattern: /(?:Exacta)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'exacta' },
    { pattern: /(?:Quinella)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'quinella' },
    { pattern: /(?:Daily\s*Double|DD)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'daily_double' },
    { pattern: /(?:Pick\s*3|P3)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'pick3' },
    { pattern: /(?:Pick\s*4|P4)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'pick4' },
    { pattern: /(?:Pick\s*5|P5)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'pick5' },
    { pattern: /(?:Pick\s*6|P6)\s*(?:\()?(\d[\d\-/,]+\d)(?:\))?\s*\$?([\d,]+\.?\d*)/gi, type: 'pick6' },
  ];

  for (const { pattern, type } of exoticTypes) {
    let exMatch;
    while ((exMatch = pattern.exec(html)) !== null) {
      const combo = exMatch[1].replace(/[/,]/g, '-');
      const payout = parseFloat(exMatch[2].replace(/,/g, ''));
      if (!isNaN(payout) && payout > 0) {
        // Avoid duplicate entries
        if (!exotics.some(e => e.type === type && e.combo === combo)) {
          exotics.push({ type, combo, payout });
        }
      }
    }
  }

  // ── Parse scratches ───────────────────────────────────────────────────────
  // Look for "Scratched" or "SCR" followed by horse names
  const scratches = [];
  const scratchPatterns = [
    /[Ss]cratched?:?\s*([^<\n]+)/g,
    /SCR[:\s]+([^<\n]+)/g,
  ];
  for (const sp of scratchPatterns) {
    let scrMatch;
    while ((scrMatch = sp.exec(html)) !== null) {
      const names = scrMatch[1].split(/[,;]/).map(n => n.trim()).filter(Boolean);
      names.forEach(name => {
        // Clean up program numbers if present (e.g., "5 - Vivienna")
        const cleaned = name.replace(/^\d+\s*[-–]\s*/, '').trim();
        if (cleaned && !scratches.includes(cleaned)) {
          scratches.push(cleaned);
        }
      });
    }
  }

  return {
    raceNumber,
    results,
    exotics,
    scratches,
    official: true,
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
// Normalisers — The Racing API NA shape → Railbird response shapes
// ═════════════════════════════════════════════════════════════════════════════
//
// NA entries response shape (verified from /v1/north-america/meets/{id}/entries):
//   { meet_id, track_id, track_name, date, races: [{ race_key:{race_number},
//       post_time, post_time_long (epoch ms), distance_value, distance_unit,
//       distance_description, surface_description, race_type,
//       race_type_description, race_class, race_name, grade, purse,
//       runners: [{ horse_name, jockey:{first_name,last_name,alias},
//                   trainer:{first_name,last_name,alias},
//                   program_number, post_pos, morning_line_odds (e.g. "5-2"),
//                   live_odds, scratch_indicator ("Y"/"N"),
//                   weight, equipment, medication, description, claiming,
//                   sire_name, dam_name, dam_sire_name }] }] }
//
// NA results response shape (verified from /v1/north-america/meets/{id}/results):
//   { meet_id, track_id, track_name, date, races: [{ race_key:{race_number},
//       off_time (epoch ms), fraction:{winning_time:{time_in_hundredths}},
//       total_purse, surface_description, track_condition_description,
//       scratches: ["Horse Name", ...],
//       payoffs: [{wager_name, payoff_amount, total_pool, winning_numbers}],
//       runners: [{ horse_name, program_number, program_number_stripped,
//                   win_payoff, place_payoff, show_payoff,
//                   jockey_first_name, jockey_last_name,
//                   trainer_first_name, trainer_last_name,
//                   weight_carried, sire_name, owner_first_name, owner_last_name,
//                   breeder_name }] }] }

/**
 * Map the short NA time_zone field ("E", "C", "M", "P", "AKST", "HST")
 * to a canonical IANA zone Intl can resolve.
 */
function naTimeZoneToIana(tz) {
  if (!tz) return "America/New_York";
  const map = {
    "E": "America/New_York",
    "ET": "America/New_York",
    "EST": "America/New_York",
    "EDT": "America/New_York",
    "C": "America/Chicago",
    "CT": "America/Chicago",
    "CST": "America/Chicago",
    "CDT": "America/Chicago",
    "M": "America/Denver",
    "MT": "America/Denver",
    "MST": "America/Denver",
    "MDT": "America/Denver",
    "P": "America/Los_Angeles",
    "PT": "America/Los_Angeles",
    "PST": "America/Los_Angeles",
    "PDT": "America/Los_Angeles",
    "AK": "America/Anchorage",
    "AKST": "America/Anchorage",
    "AKDT": "America/Anchorage",
    "H": "Pacific/Honolulu",
    "HST": "Pacific/Honolulu",
  };
  return map[String(tz).toUpperCase()] || (String(tz).includes("/") ? tz : "America/New_York");
}

/**
 * Render an NA HH:MM string from a post_time_long epoch (ms) in the meet's
 * local time zone, falling back to post_time when long form is absent.
 * post_time_long arrives from upstream as a string; coerce to int.
 */
function formatNaPostTime(postTimeLong, postTimeStr, timeZone) {
  if (postTimeLong != null && postTimeLong !== "") {
    const epoch = typeof postTimeLong === "number" ? postTimeLong : parseInt(postTimeLong, 10);
    if (isFinite(epoch) && epoch > 0) {
      try {
        const d = new Date(epoch);
        const fmt = new Intl.DateTimeFormat("en-US", {
          hour: "numeric", minute: "2-digit", hour12: true,
          timeZone: naTimeZoneToIana(timeZone),
        });
        return fmt.format(d);
      } catch (_) {}
    }
  }
  return postTimeStr || "N/A";
}

function formatNaDistance(value, unit, description) {
  if (description) return description;
  if (value && unit) return `${value} ${unit}`;
  return "N/A";
}

function formatNaPurse(purse) {
  if (purse == null) return "N/A";
  const n = typeof purse === "number" ? purse : parseInt(String(purse).replace(/[$,]/g, ""), 10);
  if (!isFinite(n)) return String(purse);
  return "$" + n.toLocaleString("en-US");
}

function naJockeyName(j) {
  if (!j) return "N/A";
  if (j.alias) return j.alias;
  const fi = j.first_name_initial || (j.first_name ? j.first_name[0] : "");
  const ln = j.last_name || "";
  return `${fi ? fi + ". " : ""}${ln}`.trim() || "N/A";
}

function naTrainerName(t) {
  if (!t) return "N/A";
  if (t.alias) return t.alias;
  const fi = t.first_name_initial || (t.first_name ? t.first_name[0] : "");
  const ln = t.last_name || "";
  return `${fi ? fi + ". " : ""}${ln}`.trim() || "N/A";
}

/** Race number lives in race_key.race_number for NA. Falls back to array index+1. */
function naRaceNumber(rc, fallbackIdx) {
  const rk = rc && rc.race_key;
  const n = rk && rk.race_number != null ? parseInt(rk.race_number, 10) : NaN;
  return isFinite(n) && n > 0 ? n : (fallbackIdx + 1);
}

/** Treat scratch_indicator "Y" (any case) as scratched. */
function isNaScratched(runner) {
  const s = runner && runner.scratch_indicator;
  return typeof s === "string" && s.toUpperCase() === "Y";
}

/**
 * NA entries → /api/entries Railbird shape.
 */
function normaliseNaEntries(naData, track, venue, date) {
  const races = (naData && naData.races) || [];
  const racesOut = races.map((rc, idx) => {
    const raceNumber = naRaceNumber(rc, idx);
    const tz = rc.time_zone || "America/New_York";
    const runners = (rc.runners || []).map((r) => ({
      pp: parseInt(r.post_pos != null ? r.post_pos : (r.program_number_stripped || r.program_number || 0), 10),
      programNumber: r.program_number || (r.program_number_stripped != null ? String(r.program_number_stripped) : null),
      horseName: r.horse_name || "Unknown",
      ml: r.morning_line_odds || "N/A",
      liveOdds: r.live_odds || null,
      jockey: naJockeyName(r.jockey),
      trainer: naTrainerName(r.trainer),
      weight: r.weight || null,
      equipment: r.equipment || null,
      medication: r.medication || null,
      description: r.description || null,
      sire: r.sire_name || null,
      dam: r.dam_name || null,
      damSire: r.dam_sire_name || null,
      claimingPrice: r.claiming || null,
      status: isNaScratched(r) ? "SCRATCHED" : "RUNNER",
    }));

    return {
      raceNumber,
      raceId:    rc.race_key && rc.race_key.race_number ? `${naData.meet_id}-R${rc.race_key.race_number}` : null,
      postTime:  formatNaPostTime(rc.post_time_long, rc.post_time, tz),
      postTimeLong: rc.post_time_long != null ? (typeof rc.post_time_long === "number" ? rc.post_time_long : parseInt(rc.post_time_long, 10)) : null,
      raceType:  rc.race_type_description || rc.race_name || rc.race_type || "N/A",
      raceTypeCode: rc.race_type || null,
      raceClass: rc.race_class || null,
      raceName:  rc.race_name || null,
      grade:     rc.grade || null,
      distance:  formatNaDistance(rc.distance_value, rc.distance_unit, rc.distance_description),
      surface:   rc.surface_description || "N/A",
      courseType: rc.course_type || null,
      purse:     formatNaPurse(rc.purse),
      ageRestriction: rc.age_restriction_description || null,
      sexRestriction: rc.sex_restriction_description || null,
      minClaimPrice: rc.min_claim_price || null,
      maxClaimPrice: rc.max_claim_price || null,
      handicapperName: rc.handicapper_name || null,
      // v2.38.7: always emit expertPicks as an array so the client never sees undefined.
      // Racing API NA does not carry handicapper picks; picks come from curated static
      // entries-{TRACK}-{DATE}.json on GitHub Pages and are surfaced via /api/expert-picks.
      expertPicks: [],
      entries:   runners,
    };
  });

  return {
    track,
    date,
    venue: (naData && naData.track_name) || venue,
    meetId: (naData && naData.meet_id) || null,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi-na",
    races: racesOut,
  };
}

/**
 * NA entries → /api/scratches Railbird shape.
 * NA exposes scratches in entries via runner.scratch_indicator === "Y".
 */
function normaliseNaScratches(naData, track, venue, date) {
  const races = (naData && naData.races) || [];
  const scratches = [];
  races.forEach((rc, idx) => {
    const raceNumber = naRaceNumber(rc, idx);
    (rc.runners || []).forEach((r) => {
      if (isNaScratched(r)) {
        scratches.push({
          raceNumber,
          pp: parseInt(r.post_pos != null ? r.post_pos : (r.program_number_stripped || 0), 10),
          programNumber: r.program_number || null,
          horseName: r.horse_name || "Unknown",
          reason: "Scratched",
          timestamp: new Date().toISOString(),
        });
      }
    });
  });
  return {
    track,
    date,
    venue: (naData && naData.track_name) || venue,
    meetId: (naData && naData.meet_id) || null,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi-na",
    scratches,
  };
}

/**
 * NA entries for ONE race → /api/odds Railbird shape.
 * Returns morning_line_odds (and live_odds when present).
 */
function normaliseNaOdds(naData, track, venue, date, raceNumber) {
  const races = (naData && naData.races) || [];
  const rc = races.find((r, idx) => naRaceNumber(r, idx) === raceNumber) || null;
  if (!rc) {
    return {
      track, date,
      venue: (naData && naData.track_name) || venue,
      raceNumber,
      lastUpdated: new Date().toISOString(),
      source: "theracingapi-na",
      odds: [],
      error: `Race ${raceNumber} not found at ${venue} on ${date}`,
    };
  }
  const odds = (rc.runners || []).map((r) => ({
    pp: parseInt(r.post_pos != null ? r.post_pos : (r.program_number_stripped || 0), 10),
    programNumber: r.program_number || null,
    horseName: r.horse_name || "Unknown",
    morningLine: r.morning_line_odds || null,
    liveOdds: r.live_odds || null,
    // Surface morningLine into the legacy `liveOdds` slot when no live yet so
    // older clients still display something meaningful.
    bestOdds: r.live_odds || r.morning_line_odds || "N/A",
    scratched: isNaScratched(r),
  }));
  return {
    track, date,
    venue: (naData && naData.track_name) || venue,
    meetId: (naData && naData.meet_id) || null,
    raceNumber,
    raceName: rc.race_name || null,
    postTime: formatNaPostTime(rc.post_time_long, rc.post_time, rc.time_zone),
    lastUpdated: new Date().toISOString(),
    source: "theracingapi-na",
    odds,
  };
}

/**
 * NA results → /api/results Railbird shape.
 * NA `runners` contains the in-money finishers (win/place/show). Position is
 * inferred from non-zero payoffs (winner: win_payoff>0; place: place_payoff>0
 * but win_payoff==0; show: show_payoff>0 but place_payoff==0).
 * NA `also_ran` is a comma-separated string of also-rans (no payoff data).
 */
function inferFinishPosition(r, idxAmongInMoney) {
  const w = parseFloat(r.win_payoff) || 0;
  const p = parseFloat(r.place_payoff) || 0;
  const s = parseFloat(r.show_payoff) || 0;
  if (w > 0) return 1;
  if (p > 0) return 2;
  if (s > 0) return 3;
  return idxAmongInMoney + 1;
}

function naJockeyFromFlat(r) {
  const fi = r.jockey_first_name_initial || (r.jockey_first_name ? r.jockey_first_name[0] : "");
  const ln = r.jockey_last_name || "";
  return `${fi ? fi + ". " : ""}${ln}`.trim() || "N/A";
}
function naTrainerFromFlat(r) {
  const fi = r.trainer_first_name ? r.trainer_first_name[0] : "";
  const ln = r.trainer_last_name || "";
  return `${fi ? fi + ". " : ""}${ln}`.trim() || "N/A";
}

function findPayoff(payoffs, wagerName) {
  if (!payoffs || !payoffs.length) return null;
  const match = payoffs.find(
    (p) => p.wager_name && p.wager_name.toLowerCase() === wagerName.toLowerCase()
  );
  return match ? parsePayoutAmount(match.payoff_amount) : null;
}

function normaliseNaResults(naData, track, venue, date) {
  const races = (naData && naData.races) || [];
  const racesOut = races.map((rc, idx) => {
    const raceNumber = naRaceNumber(rc, idx);
    const runners = rc.runners || [];
    const finishOrder = runners.map((r, i) => ({
      position: inferFinishPosition(r, i),
      pp: parseInt(r.program_number_stripped != null ? r.program_number_stripped : (r.program_number || 0), 10),
      programNumber: r.program_number || null,
      horseName: r.horse_name || "Unknown",
      jockey: naJockeyFromFlat(r),
      trainer: naTrainerFromFlat(r),
      ownerName: [r.owner_first_name, r.owner_last_name].filter(Boolean).join(" ").trim() || null,
      breederName: r.breeder_name || null,
      sire: r.sire_name || null,
      weightCarried: r.weight_carried || null,
      winPayoff: parsePayoutAmount(r.win_payoff),
      placePayoff: parsePayoutAmount(r.place_payoff),
      showPayoff: parsePayoutAmount(r.show_payoff),
    })).sort((a, b) => a.position - b.position);

    const alsoRanRaw = rc.also_ran;
    const alsoRan = typeof alsoRanRaw === "string"
      ? alsoRanRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(alsoRanRaw) ? alsoRanRaw : [];

    const winningTime = rc.fraction && rc.fraction.winning_time && rc.fraction.winning_time.time_in_hundredths
      ? rc.fraction.winning_time.time_in_hundredths
      : null;

    return {
      raceNumber,
      raceId: rc.race_key && rc.race_key.race_number ? `${naData.meet_id}-R${rc.race_key.race_number}` : null,
      raceName: rc.race_name || null,
      official: finishOrder.length > 0,
      offTime: rc.off_time || null,
      surface: rc.surface_description || null,
      trackCondition: rc.track_condition_description || null,
      totalPurse: rc.total_purse ? formatNaPurse(rc.total_purse) : null,
      finishOrder,
      scratches: rc.scratches || [],
      alsoRan,
      // Top-level payouts are the winner's WPS payoffs. Per-horse WPS payoffs
      // (which differ for 2nd/3rd place runners) live in finishOrder[i].
      payouts: {
        win: finishOrder[0] ? finishOrder[0].winPayoff : null,
        place: finishOrder[0] ? finishOrder[0].placePayoff : null,
        show: finishOrder[0] ? finishOrder[0].showPayoff : null,
        exacta: findPayoff(rc.payoffs, "Exacta"),
        trifecta: findPayoff(rc.payoffs, "Trifecta"),
        superfecta: findPayoff(rc.payoffs, "Superfecta"),
        dailyDouble: findPayoff(rc.payoffs, "Daily Double"),
        pick3: findPayoff(rc.payoffs, "Pick 3"),
        pick4: findPayoff(rc.payoffs, "Pick 4"),
        pick5: findPayoff(rc.payoffs, "Pick 5"),
      },
      allPayoffs: (rc.payoffs || []).map((p) => ({
        wager: p.wager_name,
        amount: parsePayoutAmount(p.payoff_amount),
        pool: p.total_pool || null,
        winningNumbers: p.winning_numbers || null,
      })),
      winningTime,
    };
  });
  return {
    track,
    date,
    venue: (naData && naData.track_name) || venue,
    meetId: (naData && naData.meet_id) || null,
    lastUpdated: new Date().toISOString(),
    source: "theracingapi-na",
    races: racesOut,
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
    !!env.API_USER && !!env.API_KEY
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
      const meet = await findMeetId(track, date, env.API_USER, env.API_KEY);
      if (!meet) {
        throw new NotFoundError(`No NA meet for ${track} on ${date}`);
      }
      const data = await fetchUpstream(
        `/north-america/meets/${encodeURIComponent(meet.meet_id)}/entries`,
        env.API_USER, env.API_KEY
      );
      body = normaliseNaEntries(data, track, venue, date);
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
      const meet = await findMeetId(track, date, env.API_USER, env.API_KEY);
      if (!meet) {
        body = {
          track, date, venue,
          lastUpdated: new Date().toISOString(),
          source: "theracingapi-na",
          message: `No NA meet for ${track} on ${date}`,
          scratches: [],
        };
      } else {
        const data = await fetchUpstream(
          `/north-america/meets/${encodeURIComponent(meet.meet_id)}/entries`,
          env.API_USER, env.API_KEY
        );
        body = normaliseNaScratches(data, track, venue, date);
      }
    } else {
      // ── Free mode: no unauthorized scraping. Return empty list. ───────────
      // The Equibase XML feed fetch (fetchFreeScratches) is preserved below
      // for licensed/permitted future use but is intentionally NOT called here.
      body = {
        track, date, venue,
        lastUpdated: new Date().toISOString(),
        source: "unavailable",
        message: "Free mode: scratches require a licensed data source.",
        scratches: [],
      };
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

  // Free mode: no unauthorized scraping. Return graceful empty response so the
  // app falls back to morning-line odds baked into entries JSON.
  // The NYRA / Equibase fetchers (fetchFreeOdds) remain in this file for
  // licensed/permitted future use but are intentionally NOT invoked here.
  if (!usePaidSource(env)) {
    return jsonOk({
      track, date, venue, raceNumber,
      lastUpdated: new Date().toISOString(),
      source: 'unavailable',
      message: 'Free mode: live odds require a licensed data source. Using morning line.',
      odds: [],
    }, origin, 0);
  }

  // Paid mode: fetch from The Racing API
  const cacheKey = new Request(`https://ne-racing-cache/odds/${track}/${date}/${raceNumber}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    const meet = await findMeetId(track, date, env.API_USER, env.API_KEY);
    if (!meet) {
      return jsonOk({
        track, date, venue, raceNumber,
        lastUpdated: new Date().toISOString(),
        source: "theracingapi-na",
        message: `No NA meet for ${track} on ${date}`,
        odds: [],
      }, origin, 0);
    }
    const data = await fetchUpstream(
      `/north-america/meets/${encodeURIComponent(meet.meet_id)}/entries`,
      env.API_USER, env.API_KEY
    );
    const body = normaliseNaOdds(data, track, venue, date, raceNumber);
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

  const cacheKey = new Request(`https://ne-racing-cache/results/${track}/${date}`);

  // Free mode: no unauthorized scraping. Return empty results list.
  // fetchFreeResults is preserved for licensed/permitted future use.
  if (!usePaidSource(env)) {
    return jsonOk({
      track, date, venue,
      lastUpdated: new Date().toISOString(),
      source: 'unavailable',
      message: 'Free mode: official results require a licensed data source.',
      results: [],
    }, origin, 0);
  }

  // Paid mode: fetch from The Racing API
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    const meet = await findMeetId(track, date, env.API_USER, env.API_KEY);
    if (!meet) {
      return jsonOk({
        track, date, venue,
        lastUpdated: new Date().toISOString(),
        source: "theracingapi-na",
        message: `No NA meet for ${track} on ${date}`,
        races: [],
      }, origin, 0);
    }
    let data;
    try {
      data = await fetchUpstream(
        `/north-america/meets/${encodeURIComponent(meet.meet_id)}/results`,
        env.API_USER, env.API_KEY
      );
    } catch (err) {
      // Results return 404 until races finish — surface graceful empty
      // response so the UI doesn't error during a live card.
      if (err && err.upstreamStatus === 404) {
        return jsonOk({
          track, date, venue,
          meetId: meet.meet_id,
          lastUpdated: new Date().toISOString(),
          source: "theracingapi-na",
          message: "Results not available yet — races have not finished.",
          races: [],
        }, origin, CACHE_TTL.results);
      }
      throw err;
    }
    const body = normaliseNaResults(data, track, venue, date);
    const response = jsonOk(body, origin, CACHE_TTL.results);
    await writeCache(cacheKey, response);

    // ── PR #2: Persist finished race cards to RACE_HISTORY KV (durable archive).
    // Only writes when at least one race is `official: true` so we don't archive
    // partial/in-progress cards. Best-effort — never blocks the response.
    try {
      await archiveRaceHistory(env, track, date, body);
    } catch (kvErr) {
      // Swallow — history archive is a side effect, not a contract.
      console.warn(`RACE_HISTORY archive skipped: ${kvErr && kvErr.message}`);
    }

    return response;

  } catch (err) {
    return jsonError(`Results fetch failed: ${err.message}`, 503, origin);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// RACE HISTORY (PR #2) — durable archive of finished race cards in KV
// ═════════════════════════════════════════════════════════════════════════════
//
// Layout:
//   race:{TRACK}:{YYYY-MM-DD}  → full normalised results payload
//   index:dates                → sorted JSON array of dates with any data
//   index:track:{TRACK}        → sorted JSON array of dates per track
//
// Writes are best-effort; reads degrade gracefully when KV is unbound (dev mode).
//

/**
 * Write a normalised results payload to RACE_HISTORY KV.
 * Only persists when at least one race is marked official to avoid archiving
 * partial cards (results come back as 404 until races finish).
 */
async function archiveRaceHistory(env, track, date, body) {
  if (!env.RACE_HISTORY) return; // KV not bound in this environment
  if (!body || !Array.isArray(body.races) || body.races.length === 0) return;

  const anyOfficial = body.races.some((r) => r && r.official === true);
  if (!anyOfficial) return;

  const key = `race:${track}:${date}`;
  await env.RACE_HISTORY.put(key, JSON.stringify(body), {
    metadata: { track, date, races: body.races.length, archivedAt: new Date().toISOString() },
  });

  // Update date indexes (best-effort, race-safe via JSON merge).
  await updateDateIndex(env, "index:dates", date);
  await updateDateIndex(env, `index:track:${track}`, date);
}

/**
 * Add a date to a sorted-unique JSON array index in KV.
 * If the index doesn't exist yet, creates it. Idempotent.
 */
async function updateDateIndex(env, indexKey, date) {
  let arr = [];
  try {
    const existing = await env.RACE_HISTORY.get(indexKey, "json");
    if (Array.isArray(existing)) arr = existing;
  } catch (_) {
    arr = [];
  }
  if (arr.indexOf(date) === -1) {
    arr.push(date);
    arr.sort(); // ISO dates sort lexically
    await env.RACE_HISTORY.put(indexKey, JSON.stringify(arr));
  }
}

/**
 * GET /api/history/dates → { dates: ["2026-05-29", ...], track?: "AQU" }
 * Returns the list of dates that have archived results.
 * Optional ?track=XXX filter.
 */
async function handleHistoryDates(request, env, origin) {
  if (!env.RACE_HISTORY) {
    return jsonOk({ dates: [], source: "unavailable", message: "RACE_HISTORY KV not bound" }, origin, 0);
  }
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || "").toUpperCase();
  const indexKey = track ? `index:track:${track}` : "index:dates";
  let dates = [];
  try {
    const existing = await env.RACE_HISTORY.get(indexKey, "json");
    if (Array.isArray(existing)) dates = existing;
  } catch (_) {
    dates = [];
  }
  return jsonOk({ dates, track: track || null, count: dates.length }, origin, 300);
}

/**
 * GET /api/history/{TRACK}/{DATE} → archived results payload
 * Path-based route (not query-based) for clean cacheability.
 */
async function handleHistoryGet(request, env, origin, track, date) {
  if (!env.RACE_HISTORY) {
    return jsonError("RACE_HISTORY KV not bound", 503, origin);
  }
  const key = `race:${track.toUpperCase()}:${date}`;
  const body = await env.RACE_HISTORY.get(key, "json");
  if (!body) {
    return jsonError(`No archived results for ${track} ${date}`, 404, origin);
  }
  return jsonOk(body, origin, 3600);
}

/**
 * GET /api/history/list?track=AQU&from=2026-04-01&to=2026-05-31
 * Bulk fetch for backtest corpus loading. Caps at 100 cards per call to stay
 * within KV read budget.
 */
async function handleHistoryList(request, env, origin) {
  if (!env.RACE_HISTORY) {
    return jsonOk({ races: [], source: "unavailable" }, origin, 0);
  }
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || "").toUpperCase();
  const from  = searchParams.get("from") || "1970-01-01";
  const to    = searchParams.get("to")   || "9999-12-31";
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10) || 100, 100);

  const indexKey = track ? `index:track:${track}` : "index:dates";
  let dates = [];
  try {
    const existing = await env.RACE_HISTORY.get(indexKey, "json");
    if (Array.isArray(existing)) dates = existing;
  } catch (_) {
    dates = [];
  }
  const filtered = dates.filter((d) => d >= from && d <= to).slice(0, limit);

  // If no track filter, we don't know which track each date belongs to; bail.
  if (!track) {
    return jsonOk({ dates: filtered, message: "specify ?track= to fetch race payloads" }, origin, 60);
  }

  const records = [];
  for (const d of filtered) {
    const body = await env.RACE_HISTORY.get(`race:${track}:${d}`, "json");
    if (body) records.push(body);
  }
  return jsonOk({ track, from, to, count: records.length, races: records }, origin, 60);
}

// ═════════════════════════════════════════════════════════════════════════════
// ENGINE ACCURACY (PR #2) — KV log of picks and outcomes by engine version
// ═════════════════════════════════════════════════════════════════════════════
//
// Layout:
//   pick:{TRACK}:{DATE}:{race}:{engine}:{pp}     → pick record
//   outcome:{TRACK}:{DATE}:{race}:{engine}:{pp}  → settlement record
//   stats:{engine}                                → rolling aggregate counters
//
// Logged by the PWA via POST /api/picks/log when a pick is locked.
// Settled server-side via POST /api/picks/settle (called by a cron or admin).
// Read via GET /api/picks/stats for the in-app accuracy display.
//

const PICK_ENGINES = new Set(["v1", "v2", "baseline_ml"]);

// ── v2.37.0: D1 Equibase archive (RAILBIRD_DB) ──────────────────────────
//
// The RAILBIRD_DB D1 database is populated off-band by the Dropbox → R2 →
// parser → D1 pipeline (railbird_pp_parser.ts + railbird_d1_loader.ts).
// It holds the canonical Equibase past-performance corpus: horses,
// historical race results, point-of-call splits, workouts, and per-year
// career summaries.
//
// Endpoints:
//   GET /api/d1/horse/:name        → { horse, totalPastRaces, sample }
//   GET /api/d1/horse-stats/:name  → { horse, summaries[], pastRaces[] }
//
// Name matching is case-insensitive, LIKE-based. We trim and collapse
// internal whitespace before matching to tolerate user-entered variants.
// All reads are cached at the CDN edge for 5 minutes — the underlying
// archive is immutable for any given date, so staleness is not a concern.

function d1NormalizeHorseName(raw) {
  if (!raw) return "";
  // Decode any URL-encoded characters, strip outer whitespace, collapse internal.
  let s;
  try { s = decodeURIComponent(raw); } catch (_) { s = raw; }
  return String(s).trim().replace(/\s+/g, " ");
}

async function handleD1HorseLookup(request, env, origin, rawName) {
  if (!env.RAILBIRD_DB) {
    return jsonOk(
      { horse: null, source: "unavailable", message: "RAILBIRD_DB not bound" },
      origin, 0
    );
  }
  const name = d1NormalizeHorseName(rawName);
  if (!name) return jsonError("horse name required", 400, origin);

  try {
    // Exact case-insensitive match first.
    const HORSE_COLS = "registration_no, name, sire_name, dam_name, broodmare_sire_name, foaling_date, year_of_birth, foaling_area, breeder_name, color_code, sex_code";
    let row = await env.RAILBIRD_DB
      .prepare(`SELECT ${HORSE_COLS} FROM horse WHERE LOWER(name) = LOWER(?) LIMIT 1`)
      .bind(name)
      .first();

    // Fallback: LIKE prefix match if no exact hit.
    if (!row) {
      row = await env.RAILBIRD_DB
        .prepare(`SELECT ${HORSE_COLS} FROM horse WHERE LOWER(name) LIKE LOWER(?) LIMIT 1`)
        .bind(name + "%")
        .first();
    }

    if (!row) {
      return jsonOk(
        { horse: null, source: "d1", query: name, message: "no match in archive" },
        origin, 60
      );
    }

    // Count past races for this horse (joined via pp_entry).
    const cnt = await env.RAILBIRD_DB
      .prepare("SELECT COUNT(*) AS n FROM pp_past_race p JOIN pp_entry e ON e.pp_entry_id = p.pp_entry_id WHERE e.horse_reg_no = ?")
      .bind(row.registration_no)
      .first();
    const total = cnt && typeof cnt.n === "number" ? cnt.n : 0;

    // Sample of 3 most recent past races for the lookup card.
    const sample = await env.RAILBIRD_DB
      .prepare("SELECT p.past_date, p.past_track_code, p.past_distance_id, p.past_distance_unit, p.past_surface, p.past_official_finish, p.past_speed_figure, p.past_purse_usa FROM pp_past_race p JOIN pp_entry e ON e.pp_entry_id = p.pp_entry_id WHERE e.horse_reg_no = ? ORDER BY p.past_date DESC LIMIT 3")
      .bind(row.registration_no)
      .all();

    return jsonOk({
      source: "d1",
      query: name,
      horse: row,
      totalPastRaces: total,
      sample: (sample && sample.results) || []
    }, origin, 300);
  } catch (err) {
    return jsonError(`D1 lookup failed: ${err && err.message || err}`, 500, origin);
  }
}

async function handleD1HorseStats(request, env, origin, rawName) {
  if (!env.RAILBIRD_DB) {
    return jsonOk(
      { horse: null, source: "unavailable", message: "RAILBIRD_DB not bound" },
      origin, 0
    );
  }
  const name = d1NormalizeHorseName(rawName);
  if (!name) return jsonError("horse name required", 400, origin);

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10) || 50, 200);

  try {
    const HORSE_COLS = "registration_no, name, sire_name, dam_name, broodmare_sire_name, foaling_date, year_of_birth, foaling_area, breeder_name, color_code, sex_code";
    const horseRow = await env.RAILBIRD_DB
      .prepare(`SELECT ${HORSE_COLS} FROM horse WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE LOWER(?) LIMIT 1`)
      .bind(name, name + "%")
      .first();

    if (!horseRow) {
      return jsonOk(
        { horse: null, source: "d1", query: name, message: "no match" },
        origin, 60
      );
    }

    // pp_race_summary is per-pp_entry (per-race-card), so we join through pp_entry by horse_reg_no.
    const [summaries, pastRaces] = await Promise.all([
      env.RAILBIRD_DB
        .prepare("SELECT s.year, s.country, s.breed_type, s.surface, s.starts, s.wins, s.seconds, s.thirds, s.earnings_usa FROM pp_race_summary s JOIN pp_entry e ON e.pp_entry_id = s.pp_entry_id WHERE e.horse_reg_no = ? ORDER BY s.year DESC")
        .bind(horseRow.registration_no)
        .all(),
      env.RAILBIRD_DB
        .prepare("SELECT p.past_date, p.past_track_code, p.past_race_number, p.past_distance_id, p.past_distance_unit, p.past_surface, p.past_official_finish, p.past_speed_figure, p.past_purse_usa, p.past_post_position, p.past_field_size FROM pp_past_race p JOIN pp_entry e ON e.pp_entry_id = p.pp_entry_id WHERE e.horse_reg_no = ? ORDER BY p.past_date DESC LIMIT ?")
        .bind(horseRow.registration_no, limit)
        .all()
    ]);

    return jsonOk({
      source: "d1",
      query: name,
      horse: horseRow,
      summaries: (summaries && summaries.results) || [],
      pastRaces: (pastRaces && pastRaces.results) || []
    }, origin, 300);
  } catch (err) {
    return jsonError(`D1 stats failed: ${err && err.message || err}`, 500, origin);
  }
}

/**
 * POST /api/picks/log
 * Body: { engine, track, date, race, pp, horseName, betType, betTag, amount,
 *         score, prob, ml, deviceId }
 */
async function handlePickLog(request, env, origin) {
  if (!env.ENGINE_ACCURACY) {
    return jsonError("ENGINE_ACCURACY KV not bound", 503, origin);
  }
  if (request.method !== "POST") {
    return jsonError("POST required", 405, origin);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonError("Invalid JSON body", 400, origin);
  }
  const required = ["engine", "track", "date", "race", "pp"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return jsonError(`Missing field: ${k}`, 400, origin);
    }
  }
  const engine = String(body.engine).toLowerCase();
  if (!PICK_ENGINES.has(engine)) {
    return jsonError(`Unknown engine: ${engine}`, 400, origin);
  }
  const track = String(body.track).toUpperCase();
  const date  = String(body.date);
  const race  = parseInt(body.race, 10);
  const pp    = parseInt(body.pp, 10);
  if (!Number.isFinite(race) || race < 1 || race > 20) {
    return jsonError("race must be 1-20", 400, origin);
  }
  if (!Number.isFinite(pp) || pp < 1 || pp > 25) {
    return jsonError("pp must be 1-25", 400, origin);
  }

  const key = `pick:${track}:${date}:${race}:${engine}:${pp}`;
  const record = {
    engine, track, date, race, pp,
    horseName: body.horseName || null,
    betType:   body.betType   || "Win",
    betTag:    body.betTag    || "manual",
    amount:    Number.isFinite(parseFloat(body.amount)) ? parseFloat(body.amount) : 2,
    score:     Number.isFinite(parseFloat(body.score)) ? parseFloat(body.score) : null,
    prob:      Number.isFinite(parseFloat(body.prob))  ? parseFloat(body.prob)  : null,
    ml:        body.ml || null,
    deviceId:  body.deviceId || null,
    ts:        new Date().toISOString(),
  };
  await env.ENGINE_ACCURACY.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365 * 2, // 2 years
    metadata: { engine, track, date, race, pp },
  });
  return jsonOk({ ok: true, key }, origin, 0);
}

/**
 * POST /api/picks/settle
 * Body: { engine, track, date, race, pp, position, payout }
 * Records the outcome for a previously-logged pick. Idempotent.
 */
async function handlePickSettle(request, env, origin) {
  if (!env.ENGINE_ACCURACY) {
    return jsonError("ENGINE_ACCURACY KV not bound", 503, origin);
  }
  if (request.method !== "POST") {
    return jsonError("POST required", 405, origin);
  }
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonError("Invalid JSON body", 400, origin);
  }
  const required = ["engine", "track", "date", "race", "pp", "position"];
  for (const k of required) {
    if (body[k] === undefined || body[k] === null || body[k] === "") {
      return jsonError(`Missing field: ${k}`, 400, origin);
    }
  }
  const engine = String(body.engine).toLowerCase();
  if (!PICK_ENGINES.has(engine)) {
    return jsonError(`Unknown engine: ${engine}`, 400, origin);
  }
  const track = String(body.track).toUpperCase();
  const date  = String(body.date);
  const race  = parseInt(body.race, 10);
  const pp    = parseInt(body.pp, 10);
  const key = `outcome:${track}:${date}:${race}:${engine}:${pp}`;
  const record = {
    engine, track, date, race, pp,
    position: parseInt(body.position, 10) || null,
    payout:   Number.isFinite(parseFloat(body.payout)) ? parseFloat(body.payout) : 0,
    settledAt: new Date().toISOString(),
  };
  await env.ENGINE_ACCURACY.put(key, JSON.stringify(record), {
    expirationTtl: 60 * 60 * 24 * 365 * 2,
  });
  return jsonOk({ ok: true, key }, origin, 0);
}

/**
 * GET /api/picks/stats?engine=v1
 * Returns rolling accuracy stats for one engine (or all engines if omitted).
 * Computes on the fly by listing keys; cached 5 minutes.
 */
async function handlePickStats(request, env, origin) {
  if (!env.ENGINE_ACCURACY) {
    return jsonOk({ engines: {}, source: "unavailable" }, origin, 0);
  }
  const { searchParams } = new URL(request.url);
  const engineFilter = (searchParams.get("engine") || "").toLowerCase();
  const stats = {};

  // List picks (cap 1000 for now — sufficient through Saratoga meet).
  const pickList = await env.ENGINE_ACCURACY.list({ prefix: "pick:", limit: 1000 });
  for (const { name, metadata } of pickList.keys) {
    const eng = (metadata && metadata.engine) || name.split(":")[4] || "unknown";
    if (engineFilter && eng !== engineFilter) continue;
    if (!stats[eng]) stats[eng] = { picks: 0, settled: 0, wins: 0, places: 0, totalReturn: 0, totalStake: 0 };
    stats[eng].picks++;
  }
  const outcomeList = await env.ENGINE_ACCURACY.list({ prefix: "outcome:", limit: 1000 });
  for (const { name } of outcomeList.keys) {
    const parts = name.split(":");
    const eng = parts[4] || "unknown";
    if (engineFilter && eng !== engineFilter) continue;
    if (!stats[eng]) stats[eng] = { picks: 0, settled: 0, wins: 0, places: 0, totalReturn: 0, totalStake: 0 };
    const outcome = await env.ENGINE_ACCURACY.get(name, "json");
    if (!outcome) continue;
    stats[eng].settled++;
    if (outcome.position === 1) stats[eng].wins++;
    if (outcome.position <= 2 && outcome.position >= 1) stats[eng].places++;
    stats[eng].totalReturn += parseFloat(outcome.payout) || 0;
    // Stake reconstruction from the pick record
    const pickKey = name.replace(/^outcome:/, "pick:");
    const pick = await env.ENGINE_ACCURACY.get(pickKey, "json");
    if (pick) stats[eng].totalStake += parseFloat(pick.amount) || 0;
  }
  // Derived ROI
  for (const e of Object.keys(stats)) {
    const s = stats[e];
    s.winRate = s.settled > 0 ? s.wins / s.settled : null;
    s.placeRate = s.settled > 0 ? s.places / s.settled : null;
    s.roi = s.totalStake > 0 ? (s.totalReturn - s.totalStake) / s.totalStake : null;
  }
  return jsonOk({ engines: stats, generatedAt: new Date().toISOString() }, origin, 300);
}

// ═════════════════════════════════════════════════════════════════════════════
// EXPERT PICKS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Handles /api/expert-picks — returns expert handicapper picks for a given
 * track and date. For the "free" data source, attempts to fetch from NYRA's
 * expert picks page and falls back to the static JSON file's expertPicks
 * field.
 *
 * @param {Request} request
 * @param {object}  env
 * @param {string}  origin
 */
async function handleExpertPicks(request, env, origin) {
  const url   = new URL(request.url);
  const track = (url.searchParams.get("track") || env.DEFAULT_TRACK || "AQU").toUpperCase();
  const date  = url.searchParams.get("date") || new Date().toISOString().split("T")[0];
  const venue = TRACK_TO_VENUE[track] || track;

  try {
    // Try to load expert picks from the static entries file first
    // (expertPicks are embedded per-race in the static JSON)
    const fileUrl = `${STATIC_ENTRIES_BASE}/entries-${track}-${date}.json`;
    const res = await fetch(fileUrl, {
      headers: { Accept: "application/json" },
      cf: { cacheTtl: CACHE_TTL.entries },
    });

    if (res.ok) {
      const data = await res.json();
      const expertPicks = (data.races || []).map((race) => ({
        race: race.race_number,
        picks: (race.expertPicks || []).map((ep) => ({
          source:    ep.source,
          pick:      ep.pick,
          horseName: ep.horseName,
        })),
      })).filter((r) => r.picks.length > 0);

      return jsonOk(
        {
          track,
          date,
          venue,
          lastUpdated: new Date().toISOString(),
          source: "github-pages-static",
          expertPicks,
        },
        origin,
        CACHE_TTL.entries
      );
    }

    // No static file available — return empty
    return jsonOk(
      {
        track,
        date,
        venue,
        lastUpdated: new Date().toISOString(),
        source: "unavailable",
        expertPicks: [],
        message: `No expert picks available for ${track} on ${date}.`,
      },
      origin,
      0
    );
  } catch (err) {
    return jsonError(`Expert picks fetch failed: ${err.message}`, 503, origin);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /api/status — diagnostic endpoint for the Settings panel
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Returns rich diagnostic info about the worker's current data source,
 * upstream probe results (with latency), and configuration. Used by the
 * UI's Settings > Data Source panel to give the user a clear picture of
 * what's actually serving the data.
 *
 * Probes (each safe-wrapped):
 *   • staticBase     — HEAD against GitHub Pages data dir base
 *   • theracingapi  — GET /v1/racecards/standard?date=today (paid only)
 *   • equibase      — HEAD against the scratches XML feed
 */
async function handleStatus(request, env, origin) {
  const startedAt = Date.now();
  const dataSource = (env.DATA_SOURCE || "free").toLowerCase();
  const hasApiKey  = !!env.API_KEY;
  const hasApiUser = !!env.API_USER;
  const today      = new Date().toISOString().slice(0, 10);

  async function probe(label, url, init) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, init || { method: "HEAD" });
      return {
        label,
        url,
        ok: res.ok,
        status: res.status,
        latencyMs: Date.now() - t0,
      };
    } catch (err) {
      return {
        label,
        url,
        ok: false,
        status: 0,
        error: err && err.message ? err.message : String(err),
        latencyMs: Date.now() - t0,
      };
    }
  }

  // Probe the static entries base by HEADing one known-good file pattern
  // (we don't know which file exists today, so just probe the directory
  // listing which returns 200 even if empty).
  const probes = [];
  // Probe a real fixture file (AQU 2026-04-16 is the canonical reference card
  // that has shipped since v2.18 and exists on every deploy). Bare directory
  // URLs return 404 on GitHub Pages, so probing /index.html was misleading.
  probes.push(await probe("github-pages-static", `${STATIC_ENTRIES_BASE}/entries-AQU-2026-04-16.json`));
  probes.push(await probe("equibase-scratches", EQUIBASE_SCRATCHES_URL));

  if (dataSource === "theracingapi" && hasApiKey && hasApiUser) {
    const t0 = Date.now();
    const probeUrl = `${THERACINGAPI_BASE}/north-america/meets?start_date=${today}&end_date=${today}&limit=50`;
    try {
      const res = await fetch(probeUrl, {
        headers: { Authorization: basicAuthHeader(env.API_USER, env.API_KEY), Accept: "application/json" },
      });
      let meetsCount = null;
      if (res.ok) {
        try { meetsCount = ((await res.clone().json()).meets || []).length; } catch (_) {}
      }
      probes.push({
        label: "theracingapi-na",
        url:   probeUrl,
        ok:    res.ok,
        status: res.status,
        meetsToday: meetsCount,
        latencyMs: Date.now() - t0,
      });
    } catch (err) {
      probes.push({
        label: "theracingapi-na",
        url:   probeUrl,
        ok:    false,
        status: 0,
        error: err && err.message ? err.message : String(err),
        latencyMs: Date.now() - t0,
      });
    }
  }

  const body = {
    service:      "ne-racing-proxy",
    timestamp:    new Date().toISOString(),
    dataSource,
    mode:         usePaidSource(env) ? "paid" : "free",
    hasApiKey,
    hasApiUser,
    defaultTrack: env.DEFAULT_TRACK || "AQU",
    allowedOrigin: env.ALLOWED_ORIGIN || "*",
    activeSources: {
      entries:  dataSource === "theracingapi" ? "theracingapi-na"  : "github-pages-static",
      scratches: dataSource === "theracingapi" ? "theracingapi-na" : "equibase-live",
      odds:     dataSource === "theracingapi" ? "theracingapi-na"  : "nyra-equibase-free",
      results:  dataSource === "theracingapi" ? "theracingapi-na"  : "equibase-mobile",
    },
    upstream: {
      staticEntriesBase: STATIC_ENTRIES_BASE,
      theracingapiBase:  THERACINGAPI_BASE,
      equibaseFeed:      EQUIBASE_SCRATCHES_URL,
    },
    cacheTtl:      CACHE_TTL,
    supportedTracks: Object.keys(TRACK_TO_VENUE),
    probes,
    workerLatencyMs: Date.now() - startedAt,
  };
  return jsonOk(body, origin, 0);
}

// ═════════════════════════════════════════════════════════════════════════════
// Main fetch handler (Worker entry point)
// ═════════════════════════════════════════════════════════════════════════════
// ─── Feedback (beta) ────────────────────────────────────────────────────────
//
// POST /api/feedback
//   Body: { message: string, name?: string, email?: string,
//           page?: string, version?: string, userAgent?: string }
//   Stores entry in FEEDBACK_LOG KV (binding) and, if FEEDBACK_SENDGRID_KEY
//   + FEEDBACK_EMAIL_TO + FEEDBACK_EMAIL_FROM are set, sends an email copy.
//   Always returns 200 + { ok:true, id } when KV write succeeds; email
//   failures are logged but do NOT fail the request.
//
// GET  /api/feedback/list?limit=50
//   Requires header  Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>
//   Returns up to `limit` (max 200) most recent feedback entries, newest first.
//
async function handleFeedbackSubmit(request, env, origin) {
  if (!env.FEEDBACK_LOG) {
    return jsonError("Feedback storage not configured.", 500, origin);
  }

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonError("Invalid JSON body.", 400, origin);
  }
  if (!body || typeof body !== "object") {
    return jsonError("Body must be a JSON object.", 400, origin);
  }

  const message = (body.message || "").toString().trim();
  if (!message) {
    return jsonError("Field 'message' is required.", 400, origin);
  }
  if (message.length > 5000) {
    return jsonError("Message too long (5000 char max).", 400, origin);
  }

  const name      = (body.name      || "").toString().trim().slice(0, 120);
  const email     = (body.email     || "").toString().trim().slice(0, 200);
  const page      = (body.page      || "").toString().trim().slice(0, 80);
  const version   = (body.version   || "").toString().trim().slice(0, 60);
  const userAgent = (body.userAgent || request.headers.get("User-Agent") || "").toString().slice(0, 400);

  const now = new Date();
  const ts  = now.toISOString();
  // Key: feedback:<reverse-time>:<random> for newest-first listing
  const reverseTs = (10000000000000 - now.getTime()).toString().padStart(13, "0");
  const rand = Math.random().toString(36).slice(2, 8);
  const id   = `${reverseTs}-${rand}`;
  const key  = `feedback:${id}`;

  const record = {
    id,
    ts,
    message,
    name,
    email,
    page,
    version,
    userAgent,
    ip: request.headers.get("CF-Connecting-IP") || "",
    country: (request.cf && request.cf.country) || "",
  };

  try {
    await env.FEEDBACK_LOG.put(key, JSON.stringify(record), {
      // 1 year TTL — beta entries don't need to live forever
      expirationTtl: 60 * 60 * 24 * 365,
      metadata: { ts, version, page },
    });
  } catch (err) {
    return jsonError(`Failed to store feedback: ${err.message}`, 500, origin);
  }

  // Email copy (best effort — never blocks the response success)
  let emailStatus = "skipped";
  if (env.FEEDBACK_SENDGRID_KEY && env.FEEDBACK_EMAIL_TO) {
    try {
      const fromAddr = env.FEEDBACK_EMAIL_FROM || "noreply@railbirdai.com";
      const subject = `Railbird Beta Feedback — ${name || email || "anonymous"}`;
      const lines = [
        `New beta feedback received.`,
        ``,
        `From:     ${name || "(no name)"} ${email ? "<" + email + ">" : ""}`,
        `When:     ${ts}`,
        `Version:  ${version || "(unknown)"}`,
        `Page:     ${page || "(unknown)"}`,
        `Country:  ${record.country || "(unknown)"}`,
        `User Agent: ${userAgent}`,
        ``,
        `Message:`,
        `--------`,
        message,
        ``,
        `--`,
        `Entry ID: ${id}`,
        `Catalog : GET /api/feedback/list (admin token required)`,
      ];
      const emailRes = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.FEEDBACK_SENDGRID_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: env.FEEDBACK_EMAIL_TO }] }],
          from: { email: fromAddr, name: "Railbird AI Beta" },
          reply_to: email ? { email } : undefined,
          subject,
          content: [{ type: "text/plain", value: lines.join("\n") }],
        }),
      });
      emailStatus = emailRes.ok ? "sent" : `failed:${emailRes.status}`;
    } catch (err) {
      emailStatus = `error:${(err && err.message) || "unknown"}`;
    }
  }

  return jsonOk({ ok: true, id, emailStatus }, origin, 0);
}

async function handleFeedbackList(request, env, origin) {
  if (!env.FEEDBACK_LOG) {
    return jsonError("Feedback storage not configured.", 500, origin);
  }
  const auth = request.headers.get("Authorization") || "";
  const expected = `Bearer ${env.FEEDBACK_ADMIN_TOKEN || ""}`;
  if (!env.FEEDBACK_ADMIN_TOKEN || auth !== expected) {
    return jsonError("Unauthorized.", 401, origin);
  }
  const { searchParams } = new URL(request.url);
  let limit = parseInt(searchParams.get("limit") || "50", 10);
  if (isNaN(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  // Keys are stored as feedback:<reverseTs>-<rand> so a forward list() over
  // the "feedback:" prefix returns newest first.
  const listed = await env.FEEDBACK_LOG.list({ prefix: "feedback:", limit });
  const entries = [];
  for (const k of listed.keys) {
    try {
      const raw = await env.FEEDBACK_LOG.get(k.name);
      if (raw) entries.push(JSON.parse(raw));
    } catch (_) { /* skip malformed */ }
  }
  return jsonOk({
    ok: true,
    count: entries.length,
    truncated: listed.list_complete === false,
    entries,
  }, origin, 0);
}

export default {
  /**
   * Cloudflare Worker entry point.
   *
   * Environment variables (set via wrangler.toml [vars] or `wrangler secret put`):
   *   DATA_SOURCE    — "free" (default) | "theracingapi"
   *   API_USER       — The Racing API username (secret; only for theracingapi)
   *   API_KEY        — The Racing API password (secret; only for theracingapi)
   *   DEFAULT_TRACK  — Fallback track code when ?track= is omitted (default: "AQU")
   *   ALLOWED_ORIGIN — Value for Access-Control-Allow-Origin (default: "*")
   *
   * Switching sources:
   *   Free (GitHub Pages + Equibase):  DATA_SOURCE=free  (or unset)
   *   The Racing API (paid):           DATA_SOURCE=theracingapi  +  API_USER=<u>  +  API_KEY=<p>
   */
  async fetch(request, env, ctx) {
    // CORS: prefer an explicit allowlist (comma-separated) when set.
    // Falls back to "*" only if no allowlist is configured.
    const allowed = (env.ALLOWED_ORIGIN || "*")
      .split(",")
      .map(function (s) { return s.trim(); })
      .filter(Boolean);
    const reqOrigin = request.headers.get("Origin") || "";
    let origin = "*";
    if (allowed.length === 1 && allowed[0] === "*") {
      origin = "*";
    } else if (reqOrigin && allowed.indexOf(reqOrigin) !== -1) {
      origin = reqOrigin;
    } else {
      origin = allowed[0] || "*";
    }
    const url    = new URL(request.url);

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, 0),
      });
    }

    // ── Only GET supported for data endpoints; POST only for /api/feedback ─
    if (request.method !== "GET" && request.method !== "POST") {
      return jsonError("Method not allowed.", 405, origin);
    }
    // v2.35.3: POST is now also accepted on /api/picks/log + /api/picks/settle
    // (engine-accuracy logging). All other paths reject POST at the guard.
    if (request.method === "POST") {
      const postPaths = new Set(["/api/feedback", "/api/picks/log", "/api/picks/settle"]);
      if (!postPaths.has(url.pathname)) {
        return jsonError("POST not allowed on this endpoint.", 405, origin);
      }
    }

    // ── Guard: require API_KEY only when DATA_SOURCE=theracingapi ─────────
    const dataSource = (env.DATA_SOURCE || "free").toLowerCase();
    if (dataSource === "theracingapi" && (!env.API_KEY || !env.API_USER)) {
      return jsonError(
        "Worker misconfiguration: DATA_SOURCE is set to 'theracingapi' " +
        "but API_USER and/or API_KEY environment variables are not set. " +
        "Set both secrets (wrangler secret put API_USER / API_KEY) or set DATA_SOURCE=free.",
        500,
        origin
      );
    }

    // ── Route dispatch ────────────────────────────────────────────────────
    const { pathname } = url;

    // ── PR #2: Path-based history endpoint (/api/history/{TRACK}/{DATE}) ──
    const historyMatch = pathname.match(/^\/api\/history\/([A-Za-z]{2,5})\/(\d{4}-\d{2}-\d{2})$/);
    if (historyMatch) {
      return handleHistoryGet(request, env, origin, historyMatch[1], historyMatch[2]);
    }

    // ── v2.37.0: D1 horse lookups ────────────────────────────────────
    const d1HorseStatsMatch = pathname.match(/^\/api\/d1\/horse-stats\/(.+)$/);
    if (d1HorseStatsMatch) {
      return handleD1HorseStats(request, env, origin, d1HorseStatsMatch[1]);
    }
    const d1HorseMatch = pathname.match(/^\/api\/d1\/horse\/(.+)$/);
    if (d1HorseMatch) {
      return handleD1HorseLookup(request, env, origin, d1HorseMatch[1]);
    }

    switch (pathname) {
      case "/api/entries":
        return handleEntries(request, env, origin);

      case "/api/scratches":
        return handleScratches(request, env, origin);

      case "/api/odds":
        return handleOdds(request, env, origin);

      case "/api/results":
        return handleResults(request, env, origin);

      case "/api/expert-picks":
        return handleExpertPicks(request, env, origin);

      // ── Diagnostic status (richer than /health) ───────────────────────
      case "/api/status":
        return handleStatus(request, env, origin);

      // ── Beta feedback ──────────────────────────────────────────────────
      case "/api/feedback":
        if (request.method !== "POST") {
          return jsonError("POST required for /api/feedback.", 405, origin);
        }
        return handleFeedbackSubmit(request, env, origin);

      case "/api/feedback/list":
        return handleFeedbackList(request, env, origin);

      // ── PR #2: History archive (RACE_HISTORY KV) ──────────────────────
      case "/api/history/dates":
        return handleHistoryDates(request, env, origin);
      case "/api/history/list":
        return handleHistoryList(request, env, origin);

      // ── PR #2: Engine accuracy log (ENGINE_ACCURACY KV) ───────────────
      case "/api/picks/log":
        return handlePickLog(request, env, origin);
      case "/api/picks/settle":
        return handlePickSettle(request, env, origin);
      case "/api/picks/stats":
        return handlePickStats(request, env, origin);

      // ── Health check / root ───────────────────────────────────────────
      case "/":
      case "/health":
        return jsonOk(
          {
            service:      "ne-racing-proxy",
            status:       "ok",
            dataSource,
            activeSources: {
              entries:  dataSource === "theracingapi" ? "theracingapi-na"   : "github-pages-static",
              scratches: dataSource === "theracingapi" ? "theracingapi-na"  : "equibase-live",
              odds:     dataSource === "theracingapi" ? "theracingapi-na"   : "nyra-equibase-free",
              results:  dataSource === "theracingapi" ? "theracingapi-na"   : "equibase-mobile",
            },
            defaultTrack: env.DEFAULT_TRACK || "AQU",
            staticEntriesPattern: `${STATIC_ENTRIES_BASE}/entries-{TRACK}-{DATE}.json`,
            scratchesFeed:        EQUIBASE_SCRATCHES_URL,
            endpoints: [
              "/api/entries?track=AQU&date=YYYY-MM-DD",
              "/api/scratches?track=AQU&date=YYYY-MM-DD",
              "/api/odds?track=AQU&date=YYYY-MM-DD&race=5",
              "/api/results?track=AQU&date=YYYY-MM-DD",
              "/api/expert-picks?track=AQU&date=YYYY-MM-DD",
              "/api/status",
              "POST /api/feedback",
              "/api/feedback/list  (admin token)",
              "/api/history/dates?track=AQU",
              "/api/history/{TRACK}/{YYYY-MM-DD}",
              "/api/history/list?track=AQU&from=YYYY-MM-DD&to=YYYY-MM-DD",
              "/api/d1/horse/{NAME}",
              "/api/d1/horse-stats/{NAME}?limit=50",
              "POST /api/picks/log",
              "POST /api/picks/settle",
              "/api/picks/stats?engine=v1|v2|baseline_ml",
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
