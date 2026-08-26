# Data Wishlist — Paid Sources Reserved for Future

**Purpose:** Running log of data we would pay for when budget opens. Keep this file updated — any time we hit a wall because a data point is gated behind a paid feed, add it here with what it unlocks.

**Current state (2026-04-22):** No paid data sources in use. All active code paths run against the hand-curated `data/fixtures/saratoga_2025_sample.json` set, labeled `license_tier: "sample_manual_review"` and excluded from training.

---

## Tier 1 — minimum unblock for a real 2025 SAR training set

| Source | Cost (est.) | What it unlocks | Status |
|---|---|---|---|
| [The Racing API](https://www.theracingapi.com) base + **North America add-on** | ~$20–$100+/mo + NA add-on | 523 confirmed SAR 2025 results, racecards, pre-race odds — REST API, 3-min refresh. Legitimate primary for training and live display (per ToS "data analysis" + "apps/websites"). Email [support@theracingapi.com](mailto:support@theracingapi.com) first to get written ML-training confirmation. | **ACTIVE, confirmed live 2026-08-26** — `wrangler.toml` has had `DATA_SOURCE=theracingapi` set since the `f3f7576` commit (2026-08-03). `GET /api/status` confirms `hasApiKey`/`hasApiUser: true`, `mode: "paid"`, and a live `200` probe against `api.theracingapi.com`. Feeds the live app directly AND reaches the training corpus via `pull-race-history.yml` → `data/normalized/`. Does **not** provide speed figures, class ratings, or Beyer/Brisnet/Equibase figs for NA runners — that remains a real dataset gap regardless of this being active (see item 7 below). |

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
| 2026-08-21 | **Compliance bug found and fixed (v2.49.76).** `worker.js`'s `mergeBrisnetIntoEntries()` (v2.46.0) had been overlaying real Brisnet PP data onto live entries for 6 SAR dates (matching a committed `data/brisnet-{TRACK}-{DATE}.json`), which then flowed via `RACE_HISTORY` archival and `pull-race-history.yml` into `data/normalized/` — the training corpus — with no `source_provenance` tag distinguishing it. 56 of 559 training races (10%) were affected, violating this file's own "Rules" section. Fixed by excluding those 6 dates unconditionally in `load_corpus.js`'s `loadCorpus()` and re-fitting `data/weights/v2.json` clean; see `docs/HANDOFF.md` §14.7 for the full writeup. **Still open:** `mergeBrisnetIntoEntries()` itself remains live and enabled in `worker.js` — this fix only keeps its output out of *training*, not out of *live display*. Whether the live overlay should be disabled entirely (the Brisnet ToS quote above may cover display use too, not just training) is an open decision for the owner. |
| 2026-08-21 | **Live overlay disabled (v2.49.77, worker.js).** Owner confirmed: close the gap the entry above flagged. `mergeBrisnetIntoEntries()` gated behind `ENABLE_BRISNET_OVERLAY === "true"`, default disabled — matches this file's own "BLOCKED BY TOS ... do not reopen unless Churchill Downs Inc. issues a separate enterprise agreement." Not deleted; reserved default-off the same way `theracingapi_adapter.js` is reserved for its own not-yet-authorized source, so it can be re-enabled the moment a real agreement exists. **Requires a manual `wrangler deploy --config wrangler.toml`** to take effect in production — does not auto-deploy via Pages like the HTML/JS changes. |
| 2026-08-26 | **Richer-data audit.** Owner had already been paying for The Racing API; confirmed live (`/api/status`: paid mode, real API probe succeeded) and confirmed already reaching the training corpus (`pull-race-history.yml` → `data/normalized/`, running daily) — an earlier in-conversation claim that it "wasn't being used"/"never reaches training" was wrong on both counts and is corrected here. Confirmed via direct `wrangler d1 execute` against production that `RAILBIRD_DB` is real (1,907 horses, 8,448 workouts, 106,904 point-of-call rows) but frozen 2019-03-10 → 2023-08-31 — three years stale, predates the current meet, not usable as-is. Whatever off-band pipeline built that snapshot is not in this repo and can't be resumed from here; reviving it (not a new purchase) is the highest-leverage next step for workouts/trip-line data specifically. See `docs/HANDOFF.md` §14.9 for the full writeup. Also: `.github/workflows/deploy-worker.yml` added (owner's go-ahead given, per §11.5's own deferred condition) — `worker.js` now auto-deploys on push to `master` once `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` repo secrets are added. |
