/**
 * Cloudflare Worker — NE Racing Proxy
 * Proxies horse racing data from The Racing API (https://api.theracingapi.com/v1)
 * and normalises responses into a consistent JSON shape for the frontend.
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
 * DATA_SOURCE    = "theracingapi"
 * DEFAULT_TRACK  = "SAR"
 * ALLOWED_ORIGIN = "*"
 *
 * # Secrets — set via CLI, never committed to source control:
 * #   wrangler secret put API_KEY
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
// The Racing API identifies courses by their `course` field (a human-readable
// venue name).  We map Equibase abbreviations to those names so we can filter
// the upstream response to only the requested track.
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
const CACHE_TTL = {
  entries:  120,
  scratches:  60,
  odds:       60,
  results:  120,
};

// ─── Upstream API base URL ───────────────────────────────────────────────────
const UPSTREAM_BASE = "https://api.theracingapi.com/v1";

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
 * Returns null on a miss.
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
  // cache.put() expects the response to still be unconsumed, so we clone first.
  await cache.put(cacheKey, response.clone());
}

// ─── Upstream fetch helper ───────────────────────────────────────────────────
/**
 * Fetches `path` from The Racing API with the provided API key.
 * Returns the parsed JSON body on success, or throws on error.
 *
 * @param {string} path    — e.g. "/racecards/standard?date=2026-04-14"
 * @param {string} apiKey  — Bearer token
 */
async function fetchUpstream(path, apiKey) {
  const url = `${UPSTREAM_BASE}${path}`;
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
  // Already formatted (e.g. "£4,606") — return as-is
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
  // Filter to the requested venue (case-insensitive partial match for safety)
  const venueLC = venue.toLowerCase();
  const matching = racecards.filter(
    (rc) => rc.course && rc.course.toLowerCase().includes(venueLC)
  );

  // Sort by post time / race number
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
      // Mark scratched runners: The Racing API uses `scratched` flag or non_runners text
      status: r.scratched ? "SCRATCHED" : "RUNNER",
    }));

    return {
      raceNumber: idx + 1,
      raceId: rc.race_id || null,
      postTime: formatPostTime(rc.off_dt, rc.off_time),
      raceType: rc.race_name || rc.type || "N/A",
      raceClass: rc.race_class || null,
      distance: formatDistance(rc.distance_f, rc.distance),
      surface: rc.surface || "N/A",
      going: rc.going || null,
      purse: formatPurse(rc.prize),
      entries: runners,
    };
  });

  return {
    track,
    date,
    venue,
    lastUpdated: new Date().toISOString(),
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
          pp: parseInt(r.number || r.draw || 0, 10),
          horseName: r.horse || "Unknown",
          reason: r.scratched_reason || "Scratched",
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
        // Extract reason from parentheses, e.g. "Bold Ruler (Veterinarian)"
        const match = entry.match(/^(.+?)\s*(?:\((.+?)\))?$/);
        const horseName = match ? match[1].trim() : entry;
        const reason = match && match[2] ? match[2].trim() : "Non-Runner";
        scratches.push({
          raceNumber,
          pp: null,           // pp not always available from non_runners string
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
    scratches,
  };
}

// ─── Normalisation: racecard race → odds response ────────────────────────────
/**
 * Builds the /api/odds response for a specific race number.
 * We pull odds directly from the racecard runners' `odds` arrays since
 * the dedicated odds endpoint requires per-horse IDs which we'd need a
 * second round-trip to resolve.
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
      odds: [],
      error: `Race ${raceNumber} not found at ${venue} on ${date}`,
    };
  }

  const odds = (rc.runners || []).map((r) => {
    // `odds` is an array of { bookmaker, fractional, decimal, updated }
    // We pick the first available odds entry for a single "live" figure,
    // and expose the full set for clients that want multi-book data.
    const liveOdds = bestFractional(r.odds) || (r.sp ? String(r.sp).replace("/", "-") : "N/A");

    // `pool` is not directly available from the standard racecard; we surface
    // the decimal odds as a proxy for relative market confidence.
    const firstOdds = r.odds && r.odds[0];
    const pool = firstOdds && firstOdds.decimal
      ? Math.round(10000 / parseFloat(firstOdds.decimal))
      : null;

    return {
      pp: parseInt(r.number || r.draw || 0, 10),
      horseName: r.horse || "Unknown",
      liveOdds,
      pool,
      allOdds: (r.odds || []).map((o) => ({
        bookmaker: o.bookmaker,
        fractional: o.fractional ? String(o.fractional).replace("/", "-") : null,
        decimal: o.decimal ? parseFloat(o.decimal) : null,
        updated: o.updated || null,
      })),
    };
  });

  return {
    track,
    date,
    venue,
    raceNumber,
    lastUpdated: new Date().toISOString(),
    odds,
  };
}

// ─── Normalisation: results → results response ───────────────────────────────
/**
 * Converts upstream results into the /api/results shape.
 *
 * Payout fields from The Racing API:
 *   tote_win, tote_pl (space-separated place payouts), tote_ex (exacta),
 *   tote_trifecta, tote_tricast, tote_csf
 *
 * We parse these into floats where possible.
 */
function parsePayoutAmount(raw) {
  if (!raw) return null;
  // Strip currency symbols and parse the first number found
  const stripped = String(raw).replace(/[£€$,]/g, "").trim();
  const num = parseFloat(stripped);
  return isNaN(num) ? null : num;
}

/**
 * `tote_pl` is a space-separated string like "€2.30 €5.80 €4.20"
 * (win place show for each finishing position).
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
    show: parts[1] ?? null,
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
    // Sort runners by finishing position
    const runners = (rc.runners || []).slice().sort((a, b) => {
      const posA = parseInt(a.position, 10) || 9999;
      const posB = parseInt(b.position, 10) || 9999;
      return posA - posB;
    });

    const finishOrder = runners.map((r) => ({
      position: parseInt(r.position, 10) || null,
      pp: parseInt(r.number || r.draw || 0, 10),
      horseName: r.horse || "Unknown",
      jockey: r.jockey || "N/A",
      trainer: r.trainer || "N/A",
      // `sp` is the starting price (fractional), `bsp` is Betfair SP (decimal)
      liveOdds: r.sp ? String(r.sp).replace("/", "-") : decimalToFractional(r.bsp),
      btn: r.btn || null,       // beaten lengths
      comment: r.comment || null,
    }));

    const { place, show } = parsePlacePayouts(rc.tote_pl);

    return {
      raceNumber: idx + 1,
      raceId: rc.race_id || null,
      raceName: rc.race_name || null,
      official: !!rc.winning_time_detail, // a proxy: if time is recorded, race is official
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
    races,
  };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

/**
 * GET /api/entries?track=AQU&date=2026-04-14
 *
 * Fetches the full card (all races, all horses) from the racecards endpoint,
 * filters to the requested track, and returns the normalised entries shape.
 */
async function handleEntries(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || env.DEFAULT_TRACK || "SAR").toUpperCase();
  const date  = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const venue = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}. Supported: ${Object.keys(TRACK_TO_VENUE).join(", ")}`, 400, origin);
  }

  // Build a deterministic cache key
  const cacheKey = new Request(`https://ne-racing-cache/entries/${track}/${date}`);

  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    // /racecards/standard includes odds; /racecards/basic does not.
    // We use /standard for richest data (requires Standard plan or higher).
    const data = await fetchUpstream(
      `/racecards/standard?date=${date}&region=USA`,
      env.API_KEY
    );

    const body = normaliseEntries(data.racecards || [], track, venue, date);
    const response = jsonOk(body, origin, CACHE_TTL.entries);
    await writeCache(cacheKey, response);
    return response;
  } catch (err) {
    return jsonError(`Entries fetch failed: ${err.message}`, 503, origin);
  }
}

/**
 * GET /api/scratches?track=AQU&date=2026-04-14
 *
 * Derives scratches from the same racecards endpoint.
 * The Racing API embeds non-runner information in the racecard payload;
 * there is no separate scratches-only endpoint.
 */
async function handleScratches(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || env.DEFAULT_TRACK || "SAR").toUpperCase();
  const date  = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const venue = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}`, 400, origin);
  }

  const cacheKey = new Request(`https://ne-racing-cache/scratches/${track}/${date}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchUpstream(
      `/racecards/standard?date=${date}&region=USA`,
      env.API_KEY
    );

    const body = normaliseScratches(data.racecards || [], track, venue, date);
    const response = jsonOk(body, origin, CACHE_TTL.scratches);
    await writeCache(cacheKey, response);
    return response;
  } catch (err) {
    return jsonError(`Scratches fetch failed: ${err.message}`, 503, origin);
  }
}

/**
 * GET /api/odds?track=AQU&date=2026-04-14&race=5
 *
 * Returns live tote/bookmaker odds for a specific race.
 * Odds are embedded in the standard racecard runners; we extract them here.
 *
 * The `race` query parameter is 1-based (race 1, race 2, …).
 */
async function handleOdds(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track      = (searchParams.get("track") || env.DEFAULT_TRACK || "SAR").toUpperCase();
  const date       = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const raceNumber = parseInt(searchParams.get("race") || "1", 10);
  const venue      = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}`, 400, origin);
  }
  if (isNaN(raceNumber) || raceNumber < 1) {
    return jsonError("Invalid race number. Must be a positive integer.", 400, origin);
  }

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

/**
 * GET /api/results?track=AQU&date=2026-04-14
 *
 * Returns results and payouts for all completed races at the track.
 * Uses the /results endpoint (requires Standard plan or higher).
 */
async function handleResults(request, env, origin) {
  const { searchParams } = new URL(request.url);
  const track = (searchParams.get("track") || env.DEFAULT_TRACK || "SAR").toUpperCase();
  const date  = searchParams.get("date") || new Date().toISOString().slice(0, 10);
  const venue = TRACK_TO_VENUE[track];

  if (!venue) {
    return jsonError(`Unknown track code: ${track}`, 400, origin);
  }

  const cacheKey = new Request(`https://ne-racing-cache/results/${track}/${date}`);
  const cached = await readCache(cacheKey);
  if (cached) return cached;

  try {
    // The results endpoint accepts start_date / end_date query params.
    // We query a single day by setting both to the same date.
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

// ─── Main fetch handler ───────────────────────────────────────────────────────
export default {
  /**
   * The Cloudflare Worker entry point.
   *
   * Environment variables (set via wrangler.toml [vars] or `wrangler secret put`):
   *   API_KEY        — The Racing API Bearer token (secret)
   *   DATA_SOURCE    — "theracingapi" (reserved for future source switching)
   *   DEFAULT_TRACK  — Fallback track code when ?track= is omitted (default: "SAR")
   *   ALLOWED_ORIGIN — Value for Access-Control-Allow-Origin (default: "*")
   */
  async fetch(request, env, ctx) {
    const origin = env.ALLOWED_ORIGIN || "*";
    const url    = new URL(request.url);

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, 0),
      });
    }

    // ── Only GET is supported for data endpoints ────────────────────────────
    if (request.method !== "GET") {
      return jsonError("Method not allowed. Use GET.", 405, origin);
    }

    // ── Guard: API key must be present ──────────────────────────────────────
    if (!env.API_KEY) {
      return jsonError(
        "Worker misconfiguration: API_KEY environment variable is not set.",
        500,
        origin
      );
    }

    // ── Route dispatch ──────────────────────────────────────────────────────
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

      // ── Health check / root ─────────────────────────────────────────────
      case "/":
      case "/health":
        return jsonOk(
          {
            service: "ne-racing-proxy",
            status: "ok",
            source: env.DATA_SOURCE || "theracingapi",
            defaultTrack: env.DEFAULT_TRACK || "SAR",
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
