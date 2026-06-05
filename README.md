# Railbird AI

Mobile-first Saratoga handicapping app. Live at **[railbirdai.com](https://railbirdai.com)**.

Static client (`index.html`) on GitHub Pages, with a Cloudflare Worker
(`worker.js`) acting as the data plane against The Racing API.

---

## Data source — what you actually get from The Racing API

> **This section is authoritative. Re-read it before adding any feature that
> depends on speed figures, class ratings, or comparative pace data on a
> North American card.**

The Racing API exposes **two completely separate datasets**:

### 1. Core API (UK / Ireland focus)

- Full coverage of UK & Irish racing.
- For North America, **only group-level races and selected handicaps**, going
  back ~35 years (~16,000 US races total).
- Returns RPR (Racing Post Rating) and TSR (Topspeed Rating) — but
  **only for UK/Ireland runners**. North American runners in the Core dataset
  do not get ratings.
- Endpoints: `/v1/racecards`, `/v1/results`, etc.
- A "Pro" plan subscription on theracingapi.com covers **the Core API only**.

### 2. North America add-on (separate subscription, US/Canada)

- Standalone dataset, **separate IDs, separate schema** — no shared keys
  with the Core API.
- Full thoroughbred coverage of US & Canadian tracks from **July 2023
  onward** (100,000+ races and growing).
- Entries & results refresh every **5 minutes**.
- Priced as an **add-on**: £49.99 / month on top of any base plan.
- Restricted to three endpoints:
  - `GET /v1/north-america/meets`
  - `GET /v1/north-america/meets/{meet_id}/entries`
  - `GET /v1/north-america/meets/{meet_id}/results`
- **No speed figures, no class ratings, no Beyer / Brisnet / Equibase figs
  in the response.** This dataset is field, jockey, trainer, post, ML odds,
  scratches, results — full stop.

### What this means for Railbird

Saratoga is North American, so Railbird's worker reads exclusively from the
NA add-on (`DATA_SOURCE=theracingapi-na`, `?day=today` parameter). That's
the correct source — there's no "Core" feed that would give us better
Saratoga data; the Core feed has almost no NYRA cards in it, and even when
it does, the ratings are blank for US runners.

**Speed figures on NYRA cards will always be `null` from this vendor.**
This is a dataset limitation, not a worker bug, and not something we can
fix by changing endpoints, parameters, or plan tier. The only real fixes
are:

1. **Brisnet integration** — separate paid data subscription, separate
   adapter. Tracked in `docs/DATA_WISHLIST.md`.
2. **TimeformUS / Equibase** — similar tradeoff, different rate cards.

Until one of those is wired up, the Railbird client compensates with:

- A worker-side **NYRA jockey/trainer percentage shim** (frozen 2026-04-14
  top-50 leaderboard, name-tokenizer normalization) — see
  `worker.js`. This is what gives the entry table its jockey % and
  trainer % columns even though those fields are not in the NA feed.
- **NA-native scoring weights** in `index.html` (v2.42.0): form 25 /
  beaten-lengths 20 / speed 15 (when present, mostly absent) /
  class 10 / J+T 10 / days-off 8 / post 7 / odds 5, with a +10 RPR
  bonus only when a rating happens to be present.
- **Relative confidence** (z-score vs field mean) rather than absolute
  score gaps, so the engine reports High / Medium / Lean labels per race
  instead of collapsing the entire card to "Low" because nobody has a
  Beyer.
- A separate **true-PASS gate** (≤3 live runners after scratches,
  >50% scratched, or no live odds) so passing a race is a deliberate
  signal, not a side effect of missing figs.

### Verifying the subscription is active

If you ever see all NA endpoints returning empty arrays, the first thing to
check is whether the NA add-on is still on the account at
[theracingapi.com](https://www.theracingapi.com/) — it's billed separately
from the Pro plan and can lapse independently.

---

## Architecture

- **`index.html`** — single-file PWA, ~23,800 lines. Service worker
  (`sw.js`) and `version.json` drive cache-busting.
- **`worker.js`** — Cloudflare Worker at
  `cloudflare-worker.jhwiv-online.workers.dev`. Handles auth to The
  Racing API, normalizes payloads (NA shape ↔ Railbird shape), applies
  the jockey/trainer shim.
- **GitHub Pages** auto-deploys `master` to `railbirdai.com` in
  ~60–90 seconds via the `CNAME` file in the repo root.
- **No build step.** Edit `index.html` directly, bump
  `NE_APP_VERSION` (line 21) and `version.json`, commit, push.

## Repo layout

```
/index.html        Main app (single file)
/worker.js         Cloudflare Worker source
/wrangler.toml     Worker deploy config
/version.json      Build tag — must match NE_APP_VERSION in index.html
/sw.js             Service worker
/CHANGELOG.md      Per-version notes (most recent at top)
/docs/             Project docs (data wishlist, NYRA reference)
/scripts/          Build / publish helpers (currently disabled)
/.github/workflows/ GitHub Actions (currently disabled)
```

## Deploy

1. Edit files.
2. Bump `NE_APP_VERSION` constant (line 21 of `index.html`) and
   `version.json` to match.
3. Append a CHANGELOG entry at the top.
4. `git push origin master`.
5. Wait ~90 s, then `curl -s https://railbirdai.com/version.json` to
   confirm.

Worker deploys go through the Cloudflare API directly — see the
deploy snippet in the project notes.

## License

Proprietary, internal. Not for redistribution.
