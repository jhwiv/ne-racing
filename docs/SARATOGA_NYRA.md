# Saratoga NYRA Expert Picks Integration

Added in v2.14 as scaffolding. Activated each year when the Saratoga meet opens (mid-July).

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

Each pick entry is `{source: string, pick: number, horseName: string}`. `source` is shown verbatim (with `NYRA - ` stripped) as a `.detail-expert-chip`. Match is checked by `pick === horse.pp || horseName === horse.name`.
