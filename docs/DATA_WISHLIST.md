# Data Wishlist — Paid Sources Reserved for Future

**Purpose:** Running log of data we would pay for when budget opens. Keep this file updated — any time we hit a wall because a data point is gated behind a paid feed, add it here with what it unlocks.

**Current state (2026-04-22):** No paid data sources in use. All active code paths run against the hand-curated `data/fixtures/saratoga_2025_sample.json` set, labeled `license_tier: "sample_manual_review"` and excluded from training.

---

## Tier 1 — minimum unblock for a real 2025 SAR training set

| Source | Cost (est.) | What it unlocks | Status |
|---|---|---|---|
| [The Racing API](https://www.theracingapi.com) base + **North America add-on** | ~$20–$100+/mo + NA add-on | 523 confirmed SAR 2025 results, racecards, pre-race odds — REST API, 3-min refresh. Legitimate primary for training and live display (per ToS "data analysis" + "apps/websites"). Email [support@theracingapi.com](mailto:support@theracingapi.com) first to get written ML-training confirmation. | **RESERVED** — adapter code is in `scripts/ingest/theracingapi_adapter.js`, default-off. Set `THERACINGAPI_KEY` + `DATA_SOURCE=theracingapi` in `wrangler.toml` to enable. |

## Tier 2 — completeness, figures, and chain-of-title cleanup

| Source | Cost (est.) | What it unlocks | Status |
|---|---|---|---|
| [Equibase commercial data license](https://www.equibase.com) | $5k–$20k+/yr | Official chain-of-title for every NYRA race. Removes the "collated from public sources" caveat The Racing API carries. Required if you ever commercialize beyond hobbyist scope. Contact Jason Wilson (Pres/COO) per TDN reporting. | **NOT ACQUIRED** |
| [DRF Data Services](https://promos.drf.com/services) | B2B, not published (likely $$$) | Beyer Speed Figures (real ones), PPs back to 1993, real-time API. Contact: Robert Forbeck. | **NOT ACQUIRED** |
| [HorseRacingNation data files](https://picks.horseracingnation.com/horse-racing-data-files/) | Contact required | HRN speed/pace numbers, projected odds lines, power picks. Need an explicit contract with ML-training and display rights. | **NOT ACQUIRED** |
| [Brisnet](https://www.brisnet.com) Performance Plan | ~$75/mo | BRIS speed/pace ratings. **BLOCKED for training regardless of subscription** — their ToS states "Reuse of this data is expressly prohibited." Subscription does not grant training rights. Do not reopen unless Churchill Downs Inc. issues a separate enterprise agreement. | **BLOCKED BY TOS** |

## Tier 3 — official / partnership paths (non-monetary but gated)

| Source | What it unlocks | Status |
|---|---|---|
| Direct NYRA data-feed partnership | Official live feed for Saratoga/Belmont/Aqueduct. Cleanest path for a consumer-facing app. Approach as hobbyist fan-app via press/partnerships contact on nyra.com. | **NOT CONTACTED** |
| [The Jockey Club / InCompass](https://www.jockeyclub.com) | Upstream source feeding Equibase. Enterprise-only — not viable for indie. | **NOT VIABLE** |

---

## Data we would populate if Tier 1 were active

All of the following currently show as placeholders or are absent in the sample set:

1. **Full 2025 Saratoga card calendar** — all 40 racing days, every race, every entry (sample covers ~8 days and ~40 races).
2. **Accurate pre-race morning-line odds** for every horse.
3. **Closing live odds** (for CLV / handicapper calibration).
4. **Post-race official order of finish + margins + payout grid** for every 2025 SAR race.
5. **Scratch history** (who scratched, when, reason).
6. **Workouts** — the full 2025 tab for every runner on the 2025 SAR grounds.
7. **Speed figures** — The Racing API does not publish Beyer/TFUS; those require DRF/TimeformUS commercial deals, and TimeformUS is RED-blocked for training per their ToS.
8. **Jockey/trainer season stats** for the 2025 SAR meet specifically.
9. **Equipment changes, medication flags, claims** — these come from the official charts and require an Equibase license for clean provenance.

## Rules (hard limits)

- **Never** enter Equibase, Brisnet, or TimeformUS data into `training/` output unless a signed agreement explicitly permits it. The `features.js` `ALLOW_LICENSE_TIER` guard is the enforcement mechanism.
- **Never** re-enable the `unofficial_nyra_adapter` in the production ingest pipeline. It exists only as reference code.
- **Every** record written to `data/normalized/` must carry a `source_provenance` envelope. Records without provenance are considered untrusted and excluded from training.

## Ownership-specific needs (Stables feature, v2.20.0)

The Stables feature lets users follow a syndicate or ownership group and see all their upcoming Saratoga runners. Requires **owner** data on every entry.

| Field | Sample mode | Live mode requirement |
|---|---|---|
| `horse.owner` | Present in `data/fixtures/saratoga_2025_sample.json`. As of v2.20.1, the name pool in `STABLES` (see `scripts/ingest/build_sample_fixture.js`) is populated with **real, publicly-known NYRA/Saratoga stables** (Repole, Klaravich, Sackatoga, James Bond Racing, West Point, Centennial Farms, Juddmonte, Godolphin, etc.), but the assignment of a stable to any specific horse in the fixture is pseudo-random. Still labeled `sample_manual_review`, still `training_eligible: false`. | Required on every live entry, with the real stable actually attached to each real horse. The Racing API delivers this; NYRA scrape does not. Equibase/DRF also deliver it under license. |

Until a paid source is connected, the Stables card shows a "Switch to Sample mode" notice in Live mode rather than showing empty data.

## Decision log

| Date | Decision |
|---|---|
| 2026-04-22 | No paid sources this cycle. Build the entire pipeline against a hand-curated sample set, clearly labeled. Reserve paid pathway with adapter stubs. Keep `master` pinned at v2.18.1. Flip to The Racing API once user authorizes spend. |
| 2026-04-22 | v2.19.0 shipped to production. `master` now at v2.19.x. |
| 2026-04-22 | v2.20.0 added Stables (ownership groups) + Upcoming-at-SAR list. Ownership is Saratoga-only by scope. Live-mode activation depends on a licensed `owner` field on entries. |
| 2026-04-22 | v2.20.1: replaced synthetic stable name pool with 30 real, publicly-known NYRA/Saratoga stable names so typeahead and Stables feature feel real. Assignment to horses remains pseudo-random; fixture still flagged as sample and excluded from training. No paid source engaged. |
