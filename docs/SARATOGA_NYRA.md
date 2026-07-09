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
| TimeformUS (`timeformus/`) | **Confirmed dead**, not a scraping bug — the page's own text says "David Aragona is no longer posting TimeformUS analysis on NYRA.com." Disabled in `SOURCES`. |
| NYRA Bets picks (`nyra-bets-picks/`) | **404.** URL is stale/wrong. Disabled in `SOURCES` pending the real URL. |
| NYRA Picks / Spanish (`nyra-picks/`) | **404.** Same as above. |

Finding the correct current URLs for the two 404s is the one remaining
open item, and isn't something this script (or this dev environment) can
do on its own — no way to search/browse NYRA's site from here.

## Design

Four NYRA-official handicappers feed into the existing `expertPicks` array on each Saratoga race, joining the standard DRF/Equibase/Brisnet/TimeformUS/TDN voters. Each counts as **one equal-weight vote** in the consensus engine — so no change to `runAdviceEngine` scoring logic. More voters simply produce a stronger consensus signal when they converge.

This matches the pattern documented in `renderHandicapperProfiles()` / "How Consensus Works":
- 2+ experts agree → +8 to composite (Expert Consensus modifier)
- 4+ experts agree → LOCK designation

## Sources

| Handicapper | Role | Public URL |
|---|---|---|
| Andy Serling | NYRA Lead Analyst, Talking Horses host | https://www.nyra.com/saratoga/racing/talking-horses/ |
| David Aragona | Morning Line Oddsmaker, TimeformUS on NYRA | https://www.nyra.com/saratoga/racing/timeformus/ |
| Matthew DeSantis | NYRA Bets handicapper | https://www.nyra.com/saratoga/racing/nyra-bets-picks/ |
| Darwin Vizcaya | NYRA Picks (Spanish-language) | https://www.nyra.com/saratoga/racing/nyra-picks/ |

All four are refreshed every race day during the meet. All four are free.

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
