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
| Talking Horses (`talking-horses/`) | **Works, verified against real captured text.** Multi-panelist show (Andy Serling + guest handicappers like Megan Burgess), each giving ranked program numbers per race, no horse names. Each named panelist attributed independently. |
| Hablan Los Caballos (`hablan-los-caballos/`) | **Works, verified against real captured text (v2.49.29).** Also uses the panel format (host Darwin Vizcaya, `"Darwin Vizcaya | @DarwinVizcaya_ Race 1 3 ..."`). Fixed a real mislabeling bug where this got attributed as `"Talking Horses - Darwin Vizcaya"` since the panel-format label was hardcoded to Talking Horses's name — the parser now returns bare contributor names and the caller attaches the correct per-page show label. |
| NYRA Bets picks (DeSantis, `racing.nyrabets.com/handicapping/bet-saratoga`) | **Works, verified against real captured text (v2.49.29).** Real page shape: `"Race 1 1:10 PM ET 6-3 Race 2 1:44 PM ET 5-6-4-2 ..."` (per-race post time + dash-ranked picks), plus a separate "Best Bet"-style named callout for select races. Fixed two real bugs found against the real text: the post time's own digits ("1:10") were being misread as the pick instead of the real "6-3"; and the named callout's horse name was bleeding backward onto every earlier race within 200 characters of it. See CHANGELOG.md's v2.49.29 entry for both root causes. |
| TimeformUS (`timeformus/`) | **Confirmed dead**, not a scraping bug — the page's own text says "David Aragona is no longer posting TimeformUS analysis on NYRA.com." Disabled in `SOURCES`. No text-scrapable replacement exists (NYRA's TrackMaster Selections page is informational only; real selections are behind the NYRA Bets app). |
| Central hub | `nyra.com/saratoga/racing/expert-picks/` links to all of NYRA's own handicappers — not scraped yet; would help auto-discover URLs if these move again. |

All three live sources have now been verified against real captured page
text via `workflow_dispatch` debug runs (not just Perplexity's description)
— same discipline applied to each one before trusting it on the schedule.

`nyra.com/robots.txt` doesn't functionally exist (redirects to a 404 SPA
page, no disallow/crawl-delay rules). `racing.nyrabets.com/robots.txt`
hasn't been checked yet.

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
