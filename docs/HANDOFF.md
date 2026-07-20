# RailbirdAI — Handoff Notes

**Live site:** https://www.railbirdai.com
**Repo:** `jhwiv/ne-racing`
**Last verified:** 2026-07-20, against production, not assumed.

This supersedes any prior handoff doc that circulated outside this repo. A
few things in earlier notes were wrong (branch name, hosting provider, a
GitHub Pages "dead" claim) — this version corrects those and documents only
what was actually confirmed working end-to-end on 2026-07-04/05. See §5 for
everything shipped in the v2.49.x wave (2026-07-05): the Pages deploy
watchdog, post-position colors, the new Today's Results tab, the live-data
staleness fix, and real-time bet recalculation on scratch. See §6 for
everything shipped between v2.49.7 and v2.49.45 (2026-07-06 → 2026-07-20):
a batch of critical bet-grading/accuracy bugs (wrong-graded exotics,
dead accuracy tiles), an audited handicapping engine, the live NYRA
expert-picks scraper, and the new Analytics tab with real per-pick,
per-source history.

---

## 1. Architecture (verified)

```
┌──────────────────────────────────────────────────────────┐
│  Browser                                                  │
│  https://www.railbirdai.com                                │
│  → GitHub Pages, custom domain via CNAME file             │
│     (jhwiv.github.io/ne-racing 301-redirects here —       │
│      this is alive, not dead)                             │
│     ├─ app.html / index.html  (byte-near-identical SPA)   │
│     ├─ sw.js                  (service worker cache)      │
│     ├─ version.json           (UTF-8 BOM required)        │
│     └─ data/brisnet-SAR-*.json (Brisnet PP overlay files) │
└──────────────────────────────────────────────────────────┘
             │ fetch()
             ▼
┌──────────────────────────────────────────────────────────┐
│  Cloudflare Worker: cloudflare-worker                     │
│  https://cloudflare-worker.jhwiv-online.workers.dev       │
│  Deployed via `wrangler deploy` from wrangler.toml —      │
│  NOT auto-deployed from git. This is the #1 thing to      │
│  remember: pushing to master updates the SITE             │
│  automatically, but does NOT touch the WORKER. If the     │
│  Worker's behavior doesn't match what's in worker.js,      │
│  check whether anyone has actually run `wrangler deploy`   │
│  recently — see §2.                                        │
│  ├─ /api/entries, /api/scratches, /api/odds, /api/results  │
│  ├─ mergeBrisnetIntoEntries() — overlays Brisnet PP data   │
│  │  fetched from railbirdai.com/data/brisnet-*.json onto  │
│  │  Racing API entries, matched by program number         │
│  └─ Bindings (confirmed live 2026-07-04):                 │
│     KV: RACE_HISTORY, ENGINE_ACCURACY, FEEDBACK_LOG,       │
│         BETA_VISITS, BETA_REQUESTS, BETA_ACCESS            │
│     D1: RAILBIRD_DB → "railbird"                           │
│     R2: ENTRIES_R2 → "railbird-entries"                    │
│     Vars: DATA_SOURCE=theracingapi, DEFAULT_TRACK=SAR,     │
│           ALLOWED_ORIGIN=https://railbirdai.com            │
└──────────────────────────────────────────────────────────┘
             │
             ▼
   The Racing API (paid, North America add-on)
   Auth: HTTP Basic, env.API_USER + env.API_KEY (Worker secrets)
```

**Separately:** `railbird-ingest` is a different Worker (Equibase → R2 →
D1 bulk-load pipeline), bound to a different D1 database (`railbird`, same
name coincidentally) and R2 bucket (`railbird-equibase`). Confirmed deployed
(3 manual versions, ~35 days old as of this writing) but not part of the
live-card critical path — don't confuse it with `cloudflare-worker`.

---

## 2. Deploy mechanics

### Site (app.html, index.html, sw.js, version.json, data/*.json)
- Push to `master` → GitHub Actions runs Jekyll build → deploys to Pages
  automatically. No manual step needed.
- **Known flake:** the "pages build and deployment" workflow's deploy step
  can fail with a generic `Deployment failed, try again later.` even though
  the Jekyll build itself succeeded. This is GitHub's own deploy API, not
  anything in this repo's content. Hit twice on 2026-07-04 and twice more on
  2026-07-05 (resolved within 1–3 retries each time). On 2026-07-05 this
  actually shipped a real problem: the v2.49.0 pp-badge deploy failed
  silently, nobody retried it, and the color-coding sat live-in-git-but-
  not-actually-deployed for ~10 minutes until the *next* commit's deploy
  happened to succeed and carried it out (Pages deploys the full tree, not
  a diff, so a later successful deploy papers over an earlier failed one —
  but only if there is a later push at all).
- **`.github/workflows/pages-deploy-watchdog.yml`** (added 2026-07-05) fixes
  the "nobody noticed" half of that failure mode. It can't hook the Pages
  deploy directly (that check isn't a workflow file in this repo, so
  `workflow_run` can't target it), so instead it triggers on every push to
  `master`, polls the GitHub API for the matching "pages build and
  deployment" run, and calls `rerun-failed-jobs` up to 3 times if it fails.
  If it's still failing after 3 attempts, the watchdog job itself fails —
  which surfaces as a normal GitHub Actions failure notification, so a
  stuck deploy is never silent even when auto-retry can't fix it.
- Version discipline: `NE_APP_VERSION` (in both HTML files), `CACHE_VERSION`
  (sw.js), and `version.json`'s `version` field must all match exactly, or
  the client's boot-time version check force-reloads in a loop. Bump all
  three together. `version.json` must keep its UTF-8 BOM (write it with
  Python's `utf-8-sig` codec, or equivalent) — this is a repo convention,
  not something the browser's `fetch().json()` actually requires (it
  strips BOMs fine either way; only Node's `fs.readFileSync` + `JSON.parse`
  does not — see §5 for the test-suite fallout that caused before this was
  fixed, 2026-07-04).

### Worker (worker.js, wrangler.toml)
- **Manual only.** `wrangler deploy` from a checkout with the current
  `worker.js` + `wrangler.toml`. Nothing in git triggers this.
- To do it from a machine with Node + no existing checkout:
  download raw `worker.js` and `wrangler.toml` from GitHub into an empty
  folder, `cd` there, run `npx wrangler deploy`. First run opens a browser
  Cloudflare auth prompt.
- **This drifted badly before 2026-07-04**: the deployed Worker had been
  running code that didn't match this repo at all (confirmed — a distinctive
  function name from `worker.js` wasn't found anywhere in the live deployed
  source, and every route including the bare root returned an identical
  generic `{"error":"Not found"}`, which nothing in this repo's routing
  logic produces). If `/api/entries` misbehaves, checking "does the deployed
  code even match git" is a legitimate first move, not paranoia.
- **Confirmed current as of 2026-07-20**: owner ran `npx wrangler deploy`
  from a checkout at `HEAD` (`58973e8`, v2.49.45), matching this repo's
  `worker.js` byte-for-byte (SHA256 `bd0bb3a8…8a2bb95`, verified both sides
  before deploying). Deploy output showed all 8 bindings resolved (6 KV +
  1 D1 + 1 R2) and all 3 cron triggers registered, version ID
  `c3687dd5-460b-429c-9d8d-668f872ed39f`. Live-verified post-deploy: `GET
  /api/picks/history?limit=1` returned real `200` pick data. This closes
  out the `/api/picks/history` endpoint added in v2.49.43 (see §6), which
  had been sitting deployed-in-git-but-not-on-Worker until this deploy.

---

## 3. Data pipeline

1. **The Racing API** (live, paid, NA add-on) — real-time entries, odds,
   results. Requires `DATA_SOURCE=theracingapi` **and** `API_USER`/`API_KEY`
   secrets on the Worker; if `DATA_SOURCE` is unset it silently falls back to
   a static "free" mode with no live data for the current day, no error
   surfaced. Check `env.DATA_SOURCE` is actually set as a plaintext var
   (Cloudflare dashboard → Worker → Settings → Variables and secrets) if
   entries ever look missing/stale despite the API itself having data.
2. **Brisnet single-file PP overlay** — owner downloads the "Ultimate Past
   Performances" DRF-format export from brisnet.com, `tools/parse-brisnet.js`
   parses it into `data/brisnet-SAR-{date}.json` (edit the `DATES` array at
   the top of that script first), commit + push to `master`. The Worker
   fetches this from `railbirdai.com/data/...` at request time and merges it
   onto Racing API entries by program number — no Worker redeploy needed for
   new data, just the git push.
3. Cross-validated 2026-07-04: Brisnet file matched Racing API entries
   program-number-for-program-number on a real card (same horses, jockeys,
   post positions) — the two sources agree.

---

## 4. Bets-tab defect history (v2.48.11 → v2.48.15)

Three known defects (A/B/C) plus one unresolved (D) were tracked through
several point releases. Fixed in **v2.48.14**:

- **A** — bankroll banner counted unlocked bets as if committed, lost track
  of locked straights (which clear `horse.wps`), and let stale exotic bets
  from prior days inflate today's committed total.
- **B** — unchecking a bet that had already been locked left an orphaned
  row in `data.bets` with no way to clear it.
- **C** — legacy bets missing a `track` field rendered "AQU" next to
  Saratoga races; backfilled via a one-time migration.
- **D** — "Follow Expert Picks" appeared to pre-lock 3 bets before the user
  tapped "Lock All Bets". **Still unresolved.** The only three `locked = true`
  write sites in the codebase are all inside `lockAllBets`, so nothing in
  `app.html` explains the reported symptom. Needs a `data.bets` console-log
  dump from the affected device before a real fix can be proposed — don't
  guess at this one.

Fixed in **v2.48.15** (found via a full Playwright-driven QA pass, not code
reading alone):

- Locked straight bets had no removal path at all — `lockAllBets` clears
  `horse.wps`, and the only remove UI read exclusively from `horse.wps`. Once
  locked, a bet was stuck until "Clear All" wiped the entire day. Fixed by
  adding a remove button to `renderTodaysLockedBets()`, shown only while a
  bet is still `pending` (a graded win/loss/scratch is permanent history).
- Two stale hardcoded version strings (a promo banner claiming "v2.46.0 ...
  on all 14 races", and an About-sheet "Current version" hardcoded to
  "v2.46.10-brisnet") — first is now evergreen text, second now reads
  `NE_APP_VERSION` live.
- Profanity in production UI copy ("Shit's fucked up") replaced with
  "Something's broken" — cosmetic only, same function.

**About sheet "What's new" copy:** rewritten at v2.48.16 (2026-07-04), then
again at v2.49.6 (2026-07-05) to cover the whole v2.49.x wave below. This is
manual content, not auto-generated from CHANGELOG.md — it drifts stale on
its own schedule and needs a deliberate rewrite each time a batch of
user-visible changes ships. Check it's still current before assuming it is.

---

## 5. v2.49.x feature wave (2026-07-05)

Seven releases shipped same-day, each verified via Playwright before commit
(seed a mock store/route, exercise the actual code path, screenshot or
assert on the resulting DOM — never "read the diff and assume it works").

- **v2.49.0 — Post-position color badges.** Standard US saddle-cloth colors
  (1 Red, 2 White, 3 Blue, 4 Yellow, 5 Green, 6 Black, 7 Orange, 8 Pink,
  9 Turquoise, 10-14 striped), matching NYRA's own race-card convention.
  New `ppBadgeHtml()`/`ppBadgeStyle()`, applied everywhere a program number
  renders as markup (race card, Handicap picks, Bets, exotic tickets) but
  deliberately not in the 5 plain-text/clipboard contexts, where a `<span>`
  can't render anyway. **Note:** this deploy itself failed on GitHub's side
  (see §2) and only actually reached production ~10 minutes later, papered
  over by the next commit's successful deploy — the reason the watchdog
  below exists.
- **`.github/workflows/pages-deploy-watchdog.yml`** — see §2. Added the same
  day the v2.49.0 deploy silently failed and nobody noticed.
- **v2.49.1 — Clear Bet History button** on the Results & Bankroll screen;
  wipes every bet, every date, every track (distinct from the Bets tab's
  "Clear All", which only clears today). Confirmed bet data is 100% local
  `localStorage` (`racing2026` key) — no server-side account, so nothing
  shown is ever another user's. Also fixed a real bug surfaced while testing
  this: `renderResultsList()` permanently detached the `#no-results-msg`
  empty-state node from the DOM the first time any bet rendered, so once
  all bets were cleared the empty state could never come back — fixed by
  rebuilding that markup from a literal string instead of a stale DOM ref.
- **v2.49.2 — Bigger cold-load state.** "Preparing the day's card" was a
  tiny 0.85rem italic line, easy to mistake for a dead screen. Now a large
  card with an animated indeterminate progress bar. Found and fixed a real
  contrast bug in the same pass: `--lux-navy`/`--lux-ink-soft` are
  repointed by a later "msp" theme layer to cream/dark-ink tokens, so the
  card actually renders light, not dark, in the live theme — a hardcoded
  light-tint progress-bar track was nearly invisible against it. Fixed by
  deriving the track color from `currentColor` via `color-mix()` so it
  adapts to whichever theme is active.
- **v2.49.3/v2.49.4 — Today's Results tab.** New 5th bottom-nav tab, right
  of Bets: one row per today's race with a status badge (Upcoming/Live/
  Result Pending/Final — reusing `getRaceStatus()`, the same source of
  truth the Today tab uses) and, once final, the Win/Place/Show payout
  lines. `refreshStatusTabIfActive()` hooks the existing
  `fetchLiveEntries()`/`fetchLiveResults()` completion points and
  re-renders only if this tab is the one on screen. `fmtPayout()`/
  `wpsLine()`/`buildWpsRowsHtml()` were hoisted out of `buildRaceCardHTML()`
  so this tab and the Today tab's inline FINAL strip share one
  implementation instead of two. (v2.49.4 was a same-day label-only rename
  to "Today's Results".)
- **v2.49.5 — Fixed live data going stale for hours after backgrounding.**
  Reported live: every race stuck at the same morning "Updated" timestamp
  at 1pm. Root cause: `startLivePolling()` only resumed on
  `visibilitychange`, which iOS PWAs don't reliably fire when the OS (not
  the user) suspends/resumes a backgrounded home-screen app. The results
  poller had already hit this exact gap and been fixed with `focus`/
  `pageshow` backups (`installResultsPollerHooks`) — live polling never got
  the same treatment until now. Added a debounced (10s floor)
  `wakeLivePolling()` wired to both events.
- **v2.49.6 — Real-time bet recalculation on scratch.** Owner asked
  directly whether scratches recalculate bets in real time; audit found
  advice/strategy recalculation was already correct (`renderTodayTab()`
  always re-runs `runAdviceEngine()`, which excludes scratched horses) but
  bet recalculation wasn't — a scratch only flagged the horse and showed a
  manual "remove this bet" banner, leaving locked bets and unlocked
  selections sitting in the bankroll totals until the race went official.
  New `applyScratchToBetsAndData()`, called from both `toggleScratch()`
  (manual) and `fetchLiveScratches()` (60s live poll): refunds straight
  bets and single-race exotics (EX/TRI/SUPER) on the scratched horse
  immediately, clears any unlocked W/P/S checkbox on it. Deliberately does
  **not** touch multi-race exotics (DD/P3/P4/P5/P6) — pari-mutuel pools
  substitute the beaten favorite for a scratched leg horse, which can't be
  determined until that leg's race actually runs, so only the existing
  post-results `resolveMultiRaceBet()` can grade those correctly.

---

## 6. v2.49.7 → v2.49.45 wave (2026-07-06 → 2026-07-20)

Two weeks of daily releases. Grouped by theme rather than listed
version-by-version; every fix below was verified against a reproduced
failure first, not fixed on read-through alone (same discipline as §5).
The many `chore: refresh NYRA expert picks` commits interleaved in git log
across this whole range are the scheduled scraper job running on its own
cadence (§6.3) — not manual work, skip them when scanning history.

### 6.1 Critical bet-grading and accuracy bugs (v2.49.13 → v2.49.19, v2.49.25, v2.49.30 → v2.49.33, v2.49.41)

A concentrated bug-hunt after the owner asked directly whether the app was
"working or infected with bugs." All fall into one of three shapes: a
value written with one key/type and read with another so the two never
connect; a tile that measures the wrong thing (e.g. "did the user
personally bet and win" instead of "did the real outcome happen"); or a
mutation that doesn't refresh every dependent view. Confirmed fixes:

- **Exacta Box bets could never resolve** (v2.49.13) — `bet.type` stored
  as `"Exacta Box"`, grading code checked short codes (`EX`/`TRI`/`SUPER`).
  Every exacta-box bet sat permanently pending.
- **Wizard-built Daily Double / Pick 3–6 bets always graded a loss**
  (v2.49.15, CRITICAL) — the multi-race wizard writes per-leg picks under
  `leg_N` keys; the resolver never read that key shape, so every leg's
  lookup fell through to empty and the bet graded `loss` even when every
  leg won. Worse than the Exacta Box bug: this one actively told users
  they lost when they may have won, with no visible sign anything was off.
- **"Expert Consensus" accuracy tile** (v2.49.14) was measuring "did the
  user also bet on and win this" instead of "did the pick actually happen"
  — fixed to track the real outcome.
- **Stale bankroll banner after removing an exotic bet** (v2.49.16) —
  `removeExoticBet` never called `updateBankrollBanner()`, unlike its two
  sibling remove functions.
- **"Action Bet Record" tile was a dead metric** (v2.49.17) — `isActionBet`
  was read in the accuracy tracker but never assigned at either
  bet-construction site; the tile permanently showed `— (—%)`.
- **"Overall Advice Engine ROI" pooled every non-exotic bet** (v2.49.18),
  tagged or not, graded or not — effectively a duplicate of "Your Bet ROI."
  Rescoped to graded, engine-flagged (`isBestBet`/`isValuePlay`/
  `isActionBet`) bets only.
- **"Still pending" count included stale bets from other days** (v2.49.19).
- **Bet Type Breakdown counted still-pending bets as $0-return losses**
  (v2.49.25) — same shape as v2.49.18, different tile.
- **Value Play Exacta Box button placed an un-gradeable 1-horse box**
  (v2.49.30, CRITICAL).
- **"Overall Advice Engine ROI" + "Your Bet ROI" silently excluded every
  exotic bet** (v2.49.31, CRITICAL) — the v2.49.18 rescope had been too
  aggressive.
- **Post-race grading now cross-checks this device's own known scratches**
  (v2.49.32).
- **Value Play ROI and Current Bankroll undercounted exotic bet cost**
  (v2.49.33).
- **Grading silently discarded real losses** (v2.49.41, CRITICAL) — The
  Racing API's NA results only return structured finish data for
  win/place/show. `gradePick()`/`settleEnginePicksForRace()` treated "horse
  not in that list" as "can't grade yet" (`null`) instead of a confirmed
  loss, even on an official race where absence is fully determined. Every
  tracked source's win rate/ROI had been counting almost only wins. Known
  accepted tradeoff: an unlogged late scratch now also grades as a loss
  rather than a void (indistinguishable in this data) — net improvement
  since real losses vastly outnumber that edge case.

`tests/bets-tab-fix.test.js` and a permanent regression suite added
straight after this batch (commit `443b9c1`) now cover v2.49.13–19
specifically, so these can't silently regress.

### 6.2 Handicapping engine audit (v2.49.20 → v2.49.23)

Full audit of the True-Pass confidence gate, ticket tracking, and the Bet
Evaluator. Found and fixed: Prime Power scoring never actually matched its
own documented calibration (v2.49.21); the server-side Engine Accuracy
system (worker.js endpoints from earlier work) was built but never wired
up to anything live until v2.49.22; a scroll glitch on future dates plus
misleading "Pass" copy (v2.49.23).

### 6.3 NYRA expert-picks pipeline (v2.49.26 → v2.49.33)

Activated with the owner's explicit OK to scrape NYRA's own public pages
(v2.49.26). Took several rounds of real fixes against the *actual* live
pages rather than assumptions: workflow file-add/gitignore bug, debug
diagnostics, parser fixes against real live HTML, two corrected dead
source URLs (found via Perplexity), a single-handicapper parser strategy,
three more real bugs found via debug runs (v2.49.27–29). `.github/workflows/
nyra-expert-picks.yml` now runs on its own schedule and commits
`chore: refresh NYRA expert picks` — expected, not noise.

### 6.4 Analytics tab (v2.49.34 → v2.49.45)

Built up over two weeks into the app's real answer to "is the engine
actually better than the market or the crowd":

- **v2.49.34** — Value Play picks logged/settled server-side as real
  Exacta Boxes (previously logged as if they were Win bets).
- **v2.49.35/36** — New Analytics tab: real settled results tracked
  per-engine (`v2` "Our Picks" vs `baseline_ml` "Market Favorite" vs
  `crowd` "Handicapper Consensus"), Exacta Box performance broken out from
  straight-pick performance so the exacta heuristic's real hit rate isn't
  blended into the engine's overall number.
- **v2.49.37** — Pick Accuracy by Source redesigned as a bar-chart
  infographic (plain-language source names, color-keyed legend, contrast
  validated against the live card surface with the dataviz skill).
- **v2.49.38** — Analytics promoted to its own bottom-bar tab; Handicap
  demoted into More (same pattern as Barn/Results/Reference earlier).
- **v2.49.39** — Today/All Time toggle (`/api/picks/stats?date=`). Notable
  pattern repeated across several of these: the client detects when the
  requested Worker version isn't actually deployed yet (`appliedDateFilter`
  echoed back doesn't match what was asked for) and shows an explicit
  "needs a server update" notice instead of silently mislabeling data —
  worth reusing this pattern for any future worker.js-dependent client change.
- **v2.49.42** — Best Bet now requires real market edge (`overlay =
  modelProb − impliedProb`, the Benter-style signal Value Play already
  used), not confidence alone, within each confidence tier.
- **v2.49.43** — New `GET /api/picks/history` endpoint exposes real
  per-pick detail (not just aggregates); sources with logged-but-unsettled
  picks now show "N logged, pending" instead of vanishing entirely; new
  "Recent Picks" card with real per-bet WON/LOST/PENDING history.
- **v2.49.44** — QA pass caught `fetch()` not rejecting on the 404 this
  app's own `jsonError()` returns for an undeployed endpoint — the picks-
  history fetch was silently reading that 404 body as "no picks logged."
  Fixed by checking `r.ok` before parsing.
- **v2.49.45** — Recent Picks gets per-source filter chips (All / Our
  Picks / Market Favorite / Handicapper Consensus), reusing the `engine`
  filter `/api/picks/history` already supported server-side.

**Known gap:** `CHANGELOG.md`'s newest entry is v2.49.36 — it was not kept
up to date through v2.49.37–45. This handoff section is the more current
record for that range; reconcile `CHANGELOG.md` if it's ever load-bearing
for something (e.g. release notes).

---

## 7. Test suite

`node --test tests/*.test.js` (**not** `node --test tests/` — that form
doesn't glob correctly on this Node version). Baseline as of 2026-07-04
(v2.48.17): 206 passing, 1 failing, 1 skipped. Reconfirmed unchanged through
every v2.49.x release on 2026-07-05 (see §5) — the 1 known failure below,
nothing else. **Updated 2026-07-20:** 321 total — 319 passing, 1 failing
(the same known-intentional failure below), 1 skipped. The growth from 206
→ 321 is real added coverage from §6's work, principally the permanent
regression suite for the v2.49.13–19 bet-grading fixes (commit `443b9c1`)
and new worker.js handler tests (`tests/worker-pick-stats.test.js`,
`tests/worker-pick-history.test.js`) that invoke the real `worker.js`
`fetch` handler against a fake in-memory KV.

The 1 remaining failure — `index.html scoring block is in sync with
scripts/lib/scoring.js` (`tests/inline-scoring-sync.test.js`) — is failing
**on purpose**. `scripts/build/inline_scoring.js` (no `--check` flag)
overwrites index.html's inlined scoring block from `scripts/lib/scoring.js`.
Ran it once on 2026-07-04 to see the diff before committing anything, and
it would have **reverted real, deliberate scoring logic**: the entire
v2.46.0 Brisnet Prime Power blend, the data-completeness anchor for
Brisnet-enriched horses, and the v2.42.0 relative-confidence engine — all
real changes that were made to the live `index.html`/`app.html` inline
block but never backported into `scripts/lib/scoring.js`, the file this
test treats as canonical. **Do not run `inline_scoring.js` to "fix" this
test** — it goes the wrong direction. If this ever needs fixing for real,
someone has to backport the live scoring changes into `scripts/lib/scoring.js`
first, then regenerate, then verify the offline backtest still produces the
same picks.

Three other failures (in `tests/version-sync.test.js`,
`tests/redesigned-barn.test.js`, `tests/simple-barn-cleanup.test.js`) were a
real bug, not a test artifact as first assumed: `fs.readFileSync` +
`JSON.parse` doesn't strip `version.json`'s UTF-8 BOM the way the browser's
`fetch().json()` does. Fixed by stripping the leading BOM (`\uFEFF`) before parsing in all
three files (2026-07-04, v2.48.17). Fixing the crash let
`version-sync.test.js`'s other assertions actually run for the first time,
which caught a real, separate staleness bug: `RAILBIRD_VERSION` (a
display-only constant, unrelated to `NE_APP_VERSION`) was frozen at
`v2.38.15` — many versions behind. Bumped to match.

None of the Bets-tab logic (`lockAllBets`, `updateBankrollBanner`,
`removeLockedBet`, etc.) had any test coverage before 2026-07-03 —
`tests/bets-tab-fix.test.js` and this handoff's Playwright QA scripts are
the first coverage of that code path.

---

## 8. Saratoga meet dates (confirmed live via Racing API, 2026-07-04)

- Meet running now through 2026-09-07 per in-app copy.
- Opening day 2026-07-09 confirmed provisioned with real entries (9 races)
  as of 2026-07-04.

---

## 9. Future options (deferred, not scheduled)

Ideas raised and explicitly deferred — not bugs, not committed work. Pick
these up only if asked.

### 9.1 Engine Accuracy card: split "engine picks" vs. "your placed bets" (2026-07-06)

Shipped in v2.49.22, the Engine Accuracy card (`refreshEngineAccuracy()`,
worker's `/api/picks/stats`) currently shows **only** the engine's own
recommended-pick accuracy: `logTicketPicksToEngine()` logs the Best Bet/Value
Plays/Action Bets at a flat $2 stake automatically on every ticket build,
independent of whether the user bets on them, and the KV keys
(`pick:{track}:{date}:{race}:{engine}:{pp}`) carry no user/device dimension —
so it's a global aggregate across all users, not a personal stat.

The user asked whether this could also show "bets actually placed by the
user" side by side. Answer given: yes, feasible. Approach if ever built:

- At log/settle time, check `data.bets` (this device's localStorage) for a
  matching real wager (same race/horse/bet type) and tag the settle record
  with `userPlaced: true/false`.
- Extend `/api/picks/stats` to return both aggregates.
- Render two lines in the card, e.g.:
  ```
  Engine picks (all users):     41-59 (41%) · ROI -8%  · n=100
  Picks you actually bet:        6-9  (40%) · ROI -12% · n=15
  ```

Touches: `storeTicketPicks`/`logPickToEngine`/`settleEnginePicksForRace`
(app.html + index.html), `worker.js` (`/api/picks/log`, `/api/picks/settle`,
`/api/picks/stats`), `refreshEngineAccuracy()`'s render.

User's explicit response when offered: **"no. add it to future options"** —
do not implement unless asked again.
