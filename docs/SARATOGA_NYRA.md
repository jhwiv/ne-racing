# Saratoga NYRA Expert Picks Integration

Added in v2.14 as scaffolding. Activated each year when the Saratoga meet opens (mid-July).

**Activated 2026-07-09 (v2.49.26)**, the day the 2026 meet opened. The
ingestion + worker + client wiring below is live: `scripts/fetch-nyra-
expert-picks.js` (scraper), `.github/workflows/nyra-expert-picks.yml`
(scheduled runner), and `fetchExpertPicksForCard()` in app.html/index.html
(client wiring to the already-existing `GET /api/expert-picks`). See
CHANGELOG.md's v2.49.26 entry for the full root-cause writeup of why this
had never actually worked before despite the scaffolding existing since
v2.14 — `race.expertPicks` was hardcoded to `[]` in the live paid-data
path and nothing called the worker endpoint that could have filled it in.

**Update 2026-07-09 (v2.49.27), same day — live-checked against real
pages via GitHub Actions.** Of the four sources below, only Talking Horses
actually works, and not in the shape originally assumed:

| Source | Status |
|---|---|
| Talking Horses (`talking-horses/`) | **Works.** Real page is a multi-panelist show (Serling + rotating guest handicappers like Megan Burgess), each giving ranked program numbers per race, no horse names. Each named panelist is now attributed independently — see CHANGELOG.md's v2.49.27 entry. |
| TimeformUS (`timeformus/`) | **Confirmed dead**, not a scraping bug — the page's own text says "David Aragona is no longer posting TimeformUS analysis on NYRA.com." Disabled in `SOURCES`. No text-scrapable replacement exists (NYRA's TrackMaster Selections page is informational only; real selections are behind the NYRA Bets app). |
| NYRA Bets picks (DeSantis) | **Found via Perplexity Computer (2026-07-09):** moved off nyra.com entirely, to `racing.nyrabets.com/handicapping/bet-saratoga`. Real HTML table, same "Race N num-num" shape as Talking Horses but single-handicapper (no panelist markers) — handled by the new `race-number-list` parser strategy (v2.49.28). Not yet verified against this pipeline's own captured raw HTML. |
| NYRA Picks / Spanish (Vizcaya) | **Found via Perplexity Computer:** renamed to "Hablan Los Caballos" (Spanish for "Talking Horses"), still on nyra.com at `/saratoga/racing/hablan-los-caballos/`. Same shape as DeSantis's page. Also not yet verified against raw HTML. |
| Central hub | `nyra.com/saratoga/racing/expert-picks/` links to all of NYRA's own handicappers — not scraped yet; would help auto-discover URLs if these move again. |

Both newly-corrected URLs need a `workflow_dispatch` debug run (`debug:
true`) to confirm the parser matches their real markup, same discipline
Talking Horses already went through — Perplexity described the page shape
but didn't hand over raw HTML to verify against directly.

`nyra.com/robots.txt` doesn't functionally exist (redirects to a 404 SPA
page, no disallow/crawl-delay rules). `racing.nyrabets.com/robots.txt`
hasn't been checked yet since DeSantis's picks only just moved to that
host.

## Design

Four NYRA-official handicappers feed into the existing `expertPicks` array on each Saratoga race, joining the standard DRF/Equibase/Brisnet/TimeformUS/TDN voters. Each counts as **one equal-weight vote** in the consensus engine — so no change to `runAdviceEngine` scoring logic. More voters simply produce a stronger consensus signal when they converge.

This matches the pattern documented in `renderHandicapperProfiles()` / "How Consensus Works":
- 2+ experts agree → +8 to composite (Expert Consensus modifier)
- 4+ experts agree → LOCK designation

## Sources

| Handicapper | Role | Public URL |
|---|---|---|
| Andy Serling (+ guest panelists) | NYRA Lead Analyst, Talking Horses host | https://www.nyra.com/saratoga/racing/talking-horses/ |
| ~~David Aragona~~ | ~~Morning Line Oddsmaker, TimeformUS on NYRA~~ | **Discontinued** — no longer publishes here (confirmed on the page itself) |
| Matthew DeSantis | NYRA Bets handicapper | https://racing.nyrabets.com/handicapping/bet-saratoga (moved off nyra.com — corrected 2026-07-09) |
| Darwin Vizcaya | Hablan Los Caballos (Spanish-language) | https://www.nyra.com/saratoga/racing/hablan-los-caballos/ (renamed — corrected 2026-07-09) |

Three of the four are live/scrapable (see the status table above); Aragona's is disabled. All are free.

## Worker wiring (already present)

Worker endpoint `GET /api/expert-picks?track=SAR&date=YYYY-MM-DD` already exists in `worker.js:1560` (`handleExpertPicks`). It reads from the static entries JSON at `entries-SAR-{DATE}.json` on GitHub Pages. The client already renders `ep.source` as chips in the detail panel.

**To activate during meet (July 2026):**

1. **Data ingestion.** Extend `scripts/enrich-entries.js` to scrape the four NYRA URLs above on race days and append entries to `race.expertPicks` for `track === 'SAR'`:
   ```js
   race.expertPicks.push({ source: 'NYRA - Serling',  pick: 4, horseName: 'MIDNIGHT COWBOY KID' });
   race.expertPicks.push({ source: 'NYRA - Aragona',  pick: 4, horseName: 'MIDNIGHT COWBOY KID' });
   race.expertPicks.push({ source: 'NYRA - DeSantis', pick: 7, horseName: 'FANCY FOOTWORK' });
   race.expertPicks.push({ source: 'NYRA - Vizcaya',  pick: 4, horseName: 'MIDNIGHT COWBOY KID' });
   ```
2. **Cloudflare Worker cron.** Add a scheduled trigger in `wrangler.toml` to run the scrape every 30 min during meet hours, writing refreshed `entries-SAR-*.json` to the static data path. The client's existing `probeTrackAvailability` + `fetchLiveEntries` flow will pick them up automatically.
3. **UI.** Already done — detail panel strips the `NYRA - ` prefix when rendering chips (`index.html:11465`), so they appear as "Serling", "Aragona", "DeSantis", "Vizcaya" alongside the standard sources. SAR pill in Reference > Handicappers marks meet-active voters.

## Out of scope (per your direction)

- Build process for other tracks: remains unchanged. SAR voters only activate when `track === 'SAR'`.
- Advice engine scoring: not touched. Voters plug into existing consensus, which already handles n-voter cases.
- Bankroll math, data fetch for other tracks: not touched.

## HTML structure reminder

Each pick entry is `{source: string, pick: number|null, horseName: string|null}`.
`horseName` can be `null` (the real Talking Horses format only gives ranked
program numbers, no names) — the chip template omits the name span when
absent rather than rendering the literal string "null" (fixed v2.49.27).
`source` is shown verbatim as a `.detail-expert-chip`; only literal `NYRA - `
prefixes are stripped, so panelist-attributed sources like `"Talking Horses
- Andy Serling"` render as-is. Match is checked by `pick === horse.pp ||
horseName === horse.name`.
