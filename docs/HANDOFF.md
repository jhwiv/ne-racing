# RailbirdAI — Handoff Notes

**Live site:** https://www.railbirdai.com
**Repo:** `jhwiv/ne-racing`
**Last verified:** 2026-07-22, against production, not assumed.

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
per-source history. See §7 for the control-group sample-size fix and
backfill (2026-07-21/22), plus a CRITICAL settle-endpoint bug found while
running it that had likely been silently dropping real losses for every
tracked source since v2.49.41.

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
- **Worse variant hit 2026-07-23** (`3f846904`, the v2.49.47 Analytics hero
  fix): the watchdog's "wait up to 5 minutes for the deployment run to even
  appear" step failed twice in a row (once automatically, once after an
  explicit manual re-run) — no `pages build and deployment` run showed up
  for this commit **at all**, not a failed run to retry. Confirmed via the
  Actions API, not assumed. This is the harder failure mode the watchdog's
  design doc already anticipated but can't fully solve on its own (it can
  only retry a run it can find). Resolved the same way HANDOFF already
  documents: this doc update is itself a new push, which triggers a fresh
  deploy attempt for the current tree (Pages deploys the full tree, not a
  diff) — confirm the *next* push's `pages build and deployment` +
  `Pages Deploy Watchdog` runs both show `success` before trusting the
  live site reflects v2.49.47. If this pattern (run never appears, not just
  fails) recurs often, the watchdog's `find_run_id` polling window may need
  to grow past 5 minutes.
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
- **Confirmed current again as of 2026-07-22** (`740ad8c`, the
  `/api/picks/settle` fix — see §7): worth flagging exactly how this deploy
  went, since it's a real example of the drift this section warns about.
  The owner's first `wrangler deploy` attempt uploaded **119.32 KiB /
  gzip 28.10 KiB — byte-identical to the 2026-07-20 deploy** — because the
  local `worker.js` in the deploy folder had never been refreshed from
  `master`. Caught by comparing upload sizes and re-checking the file hash
  (still `bd0bb3a8…`, the pre-fix version) before assuming the fix was
  live. Re-fetched `worker.js` from `master` (hash now
  `514ff296…5d33469`), redeployed — upload size changed (119.31 KiB) and
  version ID `364c40e3-bb0c-46ba-970e-8ecf6fec147f` confirmed a real, new
  deploy. **Lesson for next time:** a deploy folder outside the repo
  checkout (e.g. `C:\railbird-deploy`) is exactly the drift trap §2 already
  warns about — always diff the upload size or hash against what's
  actually on `master` before trusting a deploy went out, even when
  `wrangler deploy` itself reports success with no errors.

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
4. **2023 Equibase historical corpus (offline, backtest/fit-only — never
   touches the live Worker or live app)** — owner supplied real Equibase
   `EntryRaceCard` XML ("PPs", 40 files) and matching Trackmaster/Equibase
   chart XML ("Result Charts", 40 files) for SAR 2023. Ingested by
   `scripts/ingest/parse_equibase_pp.js` + `scripts/ingest/parse_equibase_chart.js`
   (parsed via a hand-rolled dependency-free XML parser,
   `scripts/ingest/lib/tiny_xml_parser.js` — this repo has zero npm deps by
   design) and merged by `scripts/ingest/build_2023_corpus.js` into
   `data/normalized/2023/SAR/*.json` (417 races, 410 with graded results).
   Two non-obvious correctness rules baked into the merge, both covered by
   `tests/parse-equibase.test.js`:
   - The **chart's `actualStarterPps` is authoritative over the PP file** —
     a horse listed in the PP file but absent from the chart was scratched
     after the PPs were generated and must be excluded (confirmed real case
     in the sample data: "Toned Up").
   - The **PP file's real morning line wins over the chart's closing odds**
     on conflict; closing odds only fill gaps where the PP has none.
   - `attachRollingConnectionsStats()` computes walk-forward jockey/trainer
     win% — a connection's stats for a given race are built ONLY from
     strictly-earlier dates (no same-day leakage between races).
   This corpus is what first let `scripts/backtest/` and
   `scripts/training/fit_logit.py` clear the project's own 200-race minimum
   for a real fitted-weights run (see §11). It is a one-time historical
   import, not a recurring feed — there is no scheduled job that grows it
   further; adding more years/tracks would mean repeating this same manual
   ingestion with new source files.
5. **Track Status web search (Perplexity, optional)** — neither The Racing
   API nor Equibase exposes a cancellation-reason field (confirmed: no
   "status"/"cancelled"/"weather" field in either response shape below), so
   this is a deliberately separate, independent signal, not part of the
   entries/odds/results data flow above. When `PERPLEXITY_API_KEY` is set,
   the `scheduled()` cron's 07:00 ET morning tick asks Perplexity directly
   whether today's card is confirmed running or confirmed cancelled, and
   caches the answer in `RACE_HISTORY` KV (`trackstatus:{TRACK}:{DATE}`) —
   read by `GET /api/track-status`. See §12 for the full writeup and the
   explicit "not yet tested against a real key" caveat.

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
  since real losses vastly outnumber that edge case. **Follow-up (2026-07-22,
  §7.2):** this fix was itself silently defeated at the API boundary --
  `/api/picks/settle` rejected every `position: null` confirmed-loss record
  this produces. Fixed in §7.2; if `gradePick()`/`settleEnginePicksForRace()`
  are touched again, re-check that fix is still intact.

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

## 7. Control-group backfill + a CRITICAL settle-endpoint bug (2026-07-21/22)

Owner pushed back hard on the Analytics tab's control groups: Market
Favorite (`baseline_ml`) and Handicapper Consensus (`crowd`) had only 1 and
2 graded picks respectively, against 35 for the engine's own picks (`v2`) —
nowhere near enough sample to answer "does our engine actually add value
over the market/crowd," the entire point of tracking them. Asked directly
to evaluate the app and its picks' real value; this section is that
evaluation.

### 7.1 Every-race control logging (no longer just Best Bet's race)

Root cause: `daily_pick_log.js` only computed a `baseline_ml`/`crowd` pick
for the Best Bet slot's single race per day, while the engine's own picks
log every slot (Best Bet + every Value Play + every Action Bet) — several
times a day. `buildLogPayloads()` now computes both controls for **every
race on the card, every day**, independent of which race the engine's own
Best Bet lands on. Deliberately did NOT loosen crowd's ≥2-handicapper
consensus gate (that's a real bar, not an artifact) — it just gets ~9x more
races/day to clear it, the same structural boost baseline_ml gets since a
market favorite exists in nearly every race. `daily_pick_settle.js`
re-derives from the same `buildLogPayloads()`, so it picked up this fix
with zero changes of its own.

### 7.2 CRITICAL: `/api/picks/settle` was rejecting confirmed losses

Found by actually running the backfill below, not by code review: **72 of
189** settle POSTs failed with HTTP 400. Root cause: `handlePickSettle()`
hard-required a `position` field, but `gradePick()` (the v2.49.41 fix, §6.1)
deliberately sends `position: null` for a horse absent from an official
race's recorded finishers — a CONFIRMED LOSS, not a missing/unknown value.
This validation silently defeated v2.49.41 at the network layer: those
picks got rejected instead of settled and stayed "pending" forever, which
looks identical to the exact bug v2.49.41 was built to fix, just moved one
layer down.

**This was never backfill-specific.** `daily_pick_settle.js` posts this
exact shape every single day for every engine, including `v2` — so this
had likely been silently dropping a real fraction of losses across every
tracked source since v2.49.41 shipped (2026-07-19ish per version cadence).
No way to quantify exactly how much without re-scanning historical
settle attempts (not logged anywhere the failures would be visible).

Fixed by removing `position` from the required-fields list (the record
already tolerantly parses it to `null` when absent — no other behavior
change). `won` (always a real boolean once `gradePick()` returns a grade)
is the field that actually matters and was never the problem. New
`tests/worker-pick-settle.test.js` exercises the real `handlePickSettle`
against a fake KV — the existing `daily-pick-settle.test.js` never could
have caught this because its mock worker unconditionally returns
`{ok:true}` regardless of payload, the same class of gap as the
`/api/picks/history` filter chips (§6.4) before their own worker-level
tests existed.

**Deploy gotcha hit live** — see §2's "Confirmed current again as of
2026-07-22" entry: the owner's first deploy attempt silently redeployed the
stale pre-fix `worker.js` because the local deploy folder hadn't been
refreshed from `master`. Caught by comparing wrangler's reported upload
size against the prior deploy (byte-identical — a real tell) before
trusting a clean `wrangler deploy` exit actually shipped anything.

### 7.3 Backfill (`scripts/backfill_control_history.js`, one-time, re-runnable)

Real historical odds data turned out to already exist: the scheduled
pre-warmer has mirrored one `/api/entries` snapshot per (track, date) to
the `ENTRIES_R2` bucket since v2.47.0 shipped (2026-06-05), and nothing in
the code ever deletes old ones. New script re-derives what `baseline_ml`/
`crowd` would have logged on every past day (live `/api/entries` first,
falling back to `/api/entries/r2` for historical dates), then settles each
immediately against the real archived result via `/api/history/{TRACK}/
{DATE}` — turning weeks of dead time into real sample size immediately
instead of waiting. `v2`'s own picks are deliberately excluded — this
fixes the control-group gap, not the engine's own coverage. New companion
workflow (`.github/workflows/backfill-control-history.yml`, manual
dispatch, defaults to `--dry-run`) since backfilling means writing real
historical records into production `ENGINE_ACCURACY` — a one-way data
change, sanity-checked in dry-run first.

**Confirmed backfilled as of 2026-07-22:** 189 picks logged and settled (0
failed, after §7.2's fix), covering `baseline_ml` from 2026-06-05 and
`crowd` from 2026-07-09 (the date the NYRA scraper pipeline actually went
live — no expert-picks data exists before that, so no crowd consensus is
computable for earlier dates, working as intended, not a gap). 34 dates
had no entries source available (dark days, or older than R2's coverage),
1 date had no archived results yet, 22 individual picks were skipped for
lack of a grade (race not official / horse genuinely ungradeable).
**Note:** `RACE_HISTORY` (the results archive) does NOT store morning-line
odds — confirmed by reading `normaliseNaResults()` — so a `baseline_ml`
backfill is only possible because of the separate `ENTRIES_R2` mirror; if
that R2 bucket is ever cleared, this exact backfill can't be re-derived
for dates before whenever it's re-populated.

Re-run this script (idempotent, deterministic KV keys) any time a gap is
suspected — safe to simply re-run the full range.

---

## 8. Test suite

`node --test tests/*.test.js` (**not** `node --test tests/` — that form
doesn't glob correctly on this Node version). Baseline as of 2026-07-04
(v2.48.17): 206 passing, 1 failing, 1 skipped. Reconfirmed unchanged through
every v2.49.x release on 2026-07-05 (see §5) — the 1 known failure below,
nothing else. Grew to 321 total (319 pass/1 fail/1 skip) by 2026-07-20 from
§6's work, principally the permanent regression suite for the v2.49.13–19
bet-grading fixes (commit `443b9c1`) and new worker.js handler tests
(`tests/worker-pick-stats.test.js`, `tests/worker-pick-history.test.js`)
that invoke the real `worker.js` `fetch` handler against a fake in-memory
KV. **Updated 2026-07-22:** 333 total — 331 passing, 1 failing (the same
known-intentional failure below), 1 skipped. The growth from 321 → 333 is
§7's work: `tests/backfill-control-history.test.js` (7 tests) and
`tests/worker-pick-settle.test.js` (4 tests, including the exact
`position: null` regression from §7.2).

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

## 9. Saratoga meet dates (confirmed live via Racing API, 2026-07-04)

- Meet running now through 2026-09-07 per in-app copy.
- Opening day 2026-07-09 confirmed provisioned with real entries (9 races)
  as of 2026-07-04.

---

## 10. Future options (deferred, not scheduled)

Ideas raised and explicitly deferred — not bugs, not committed work. Pick
these up only if asked.

### 10.1 Engine Accuracy card: split "engine picks" vs. "your placed bets" (2026-07-06)

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

---

## 11. Advice engine: real 2023 data, weight refit, Pace bug fix, live Calibration & Overlay tracking (2026-07-25 → 2026-07-27)

Owner asked to backtest the advice engine and see if a different weighted
average would predict better, then offered real 2023 Equibase data to make
that backtest meaningful, then said explicitly: **"fix it all. improve
betting results."** This section is the record of what that turned into.

### 11.1 Data: see §3.4

The 2023 Equibase PP + chart ingestion (417 races, 410 graded) is documented
as a permanent architecture fact in §3.4, not repeated here.

### 11.2 Pace running-style bug

`paceSubScore()`/`buildPaceContext()` only recognized running-style codes
`E`/`EP`/`S`/`SS`. Real Equibase data also uses `E/P` (slash form) and `P`
— together **53% of real starters in the 2023 corpus** — which fell through
to a silent neutral score instead of being scored as front-runners/closers.
Fixed via two small helpers, `isFrontRunning(style)` (`E`, `EP`, `E/P`) and
`isCloserStyle(style)` (`S`, `SS`), used by both `paceSubScore()` and
`buildPaceContext()` in `scripts/lib/scoring.js`. Covered by 3 new cases in
`tests/scoring.test.js`.

This fix was investigated carefully before being applied, because an earlier
finding this session was that Pace's fitted weight comes out **negative** —
that looked at first like it might just be this same recognition bug. It
is not: re-running the fit with the bug fixed still produces a negative Pace
coefficient (see 11.3). The negative sign is real, not an artifact.

**Ship discipline note:** this fix was applied to the live `index.html`/
`app.html` inline scoring block by hand-editing the exact ~28 lines needed,
**not** by running `scripts/build/inline_scoring.js` to regenerate the block.
That tool is unsafe to run un-audited — see the pre-existing warning in §8
about `relativeConfidence()` drift. It bit again this session, twice, and was
caught both times by diffing before commit; no regression shipped. If you
need to touch the inline scoring block, hand-edit it and diff against
`git diff --cached` for `relativeConfidence`/`Prime Power scale` strings
before committing — do not trust a mechanical regen.

### 11.3 First real fitted weights

With the 2023 corpus in hand, `scripts/training/fit_logit.py` (conditional
logistic regression / McFadden choice model, needs `numpy`+`scipy`) was run
for real for the first time — 559 scoreable races cleared the project's own
`MIN_RACES=200` gate in `data/weights/v2.json` (previously a permanent
`status:"insufficient"` placeholder since the runtime-fetch mechanism was
built; this is the first time it has ever activated).

Result, committed to `data/weights/v2.json`:

- `beta` (raw logit coefficients) for `[speed, class, pace, tj, bias, fresh]`:
  `[1.907, 1.022, -0.985, 1.389, 0.0006, -2.294]`
- `weights_normalized`: `[0.251, 0.134, 0.130, 0.183, 0.0001, 0.302]`
- `pseudo_r2_mcfadden = 0.0476`, `top1_hit_rate = 0.2147`, `n_races = 559`
- `status: "fitted"` (was `"insufficient"`)

Validated with chronological (never in-sample) train/holdout splits via
`scripts/backtest/weight_sweep.js` before committing — multiple splits agreed
directionally, not just one lucky split. Honest caveat given to the owner:
`pseudo_r2_mcfadden` of 0.05 is modest — horse racing is hard to predict —
this is a real, validated improvement over the hand-picked
`DEFAULT_V2_WEIGHTS`, not a claim of a solved model.

Deploy mechanism: the app already had a `RailbirdFittedWeights` runtime
fetch of `data/weights/v2.json` that only activates when
`status==="fitted" && n_races>=200`; this was previously dormant because the
file was always the placeholder. No code change was needed to activate it —
committing the real file to `master` was the entire deploy. Confirmed live
end-to-end via Playwright after push.

### 11.4 Model Calibration & Overlay Betting (v2.49.54)

Answering "what can be done to get better results" honestly: beating the
market's own pick accuracy is a very high bar. The owner picked the more
achievable, higher-value option — **is the model's stated confidence
trustworthy, and is betting model-vs-market overlays actually profitable**.

Shipped:

- `worker.js`: `handlePickStats()` now accumulates, per engine, a 10-bucket
  calibration table (predicted-probability decile vs. empirical hit rate,
  via `pick.prob`) and an overlay split (`qualifying` = model probability
  beats market-implied by more than `OVERLAY_MIN = 0.08`, matching
  `metrics.js`'s existing `flatOverlayROI` convention, vs. `nonQualifying`).
  `parseOddsToNum(ml)` mirrors the parser already in `scoring.js` exactly.
  **This required a manual `wrangler deploy`** — worker.js has no
  auto-deploy (see §2); owner confirmed they ran it after being given the
  PowerShell command.
- New "Model Calibration & Overlay Betting" card in the Analytics tab
  (`renderAnalyticsCalibration()`), reusing the existing `/api/picks/stats`
  fetch already made by `renderAnalyticsAccuracy()` — no second network call.
- New tests: `tests/worker-pick-calibration.test.js` (6 cases: bucketing
  math, prob-less-pick exclusion, overlay classification, unparseable-ML
  handling, ROI math).

### 11.5 Deploy cadence clarification (given to owner)

- `worker.js` changes: **manual only**, on code change only — `wrangler
  deploy` (or CI, if ever set up — not currently). Not a daily task; nothing
  to run "when the track is open" unless worker.js itself changed.
  Data jobs (`.github/workflows/*`, NYRA picks refresh, race-history pull)
  are already scheduled and automatic — no manual daily action needed there.
- Pages (`index.html`/`app.html`/`sw.js`/etc.) auto-deploys on push to
  `master`, per §2.
- Owner was offered, and asked to think about rather than immediately
  approve, automating the worker.js deploy via a GitHub Actions workflow +
  Cloudflare API token. Tradeoff given: removes the manual review checkpoint
  before a worker.js change goes live. **Not implemented** — awaiting an
  explicit go-ahead and a Cloudflare API token from the owner before doing
  this.

---

## 12. Track Status: prominent boot-time check + web-search confirmation (2026-07-30)

Reported live: Saratoga was weather-closed one day, and the app gave zero
indication anything unusual was happening — every race just sat at
RESULT PENDING forever, indistinguishable from ordinary results lag. Owner
asked directly: the first thing the app does on launch should be to make
sure the track is open, prominently, on the same screen as "Preparing the
day's card…" — then, as a same-day follow-up, asked to add a web search to
actually confirm status rather than relying on the upstream data source
(neither of which has ever exposed a cancellation-reason field — see §3.5).

### 12.1 v2.49.55 — local Track Status banner

New `#track-status-banner`, the first element on the Today tab.
`renderInitialTrackStatus()` paints synchronously on boot from the static
season calendar (`getSarStatus()`), before `fetchLiveEntries()`'s network
round trip even starts. `renderCardFoundStatus()` states plainly once
entries resolve whether today has a posted card, naming the lookahead date
if found. `checkForAbandonedCard()`/`renderAbandonedCardStatus()` — the
actual shape of the reported bug — flags a card that was posted but has
produced zero official results 2.5h+ past its first post time, checked on
every results-poll tick. Deliberately never asserts a specific cause
("weather") since no such signal existed at this point — only states what
was actually knowable.

### 12.2 v2.49.56 — Perplexity web-search confirmation

Direct same-day follow-up. Provider and cadence were both explicit owner
choices (asked via a two-question decision, not assumed): **Perplexity
API** over Google/Bing Custom Search (returns a synthesized, sourced
answer rather than raw links this app would have to parse/interpret
itself — same problem class as the NYRA-picks scraper in §6.3, avoided
here by picking a provider that already does that synthesis), and a
**once-daily scheduled cron check** over live per-page-load search (avoids
multiplying API cost/latency by traffic or cron frequency).

- `checkTrackStatusViaSearch(track, date, env)` (worker.js) calls
  Perplexity's `/chat/completions` with a direct question that explicitly
  discourages hedging/guessing, and applies a best-effort keyword
  classifier over the free-text answer (`confirmed_closed` /
  `confirmed_live` / `unclear`). **The classifier is not authoritative —
  the raw `summary` text is the real source of truth**, and both worker.js
  and the client are written to always carry that raw text alongside any
  use of the coarse status.
- `GET /api/track-status?track=&date=[&force=1]` — reads the cached result
  from `RACE_HISTORY` KV (`trackstatus:{TRACK}:{DATE}`, no new KV
  namespace provisioned). `&force=1` bypasses cache for a live check —
  this is also the manual verification path (see caveat below).
- `scheduled()`'s `runScheduledWarm()` now runs this check ONLY on the
  07:00 ET tick (`event.cron === '0 11 * * *'`), one Perplexity call per
  enabled track per day. Missing `PERPLEXITY_API_KEY` degrades every call
  to `{status:"unknown", reason:"not_configured"}` — never affects
  entries/odds/results.
- Client: banner rendering refactored from "one function overwrites the
  DOM" to "compose two independent message slots"
  (`_trackStatusLocalMsg` + `_trackStatusSearchMsg`,
  `repaintTrackStatusBanner()`) so the local heuristic and the web-search
  result never fight over the same element. The web-search line only
  renders when it adds real signal: a confirmed cancellation (surfaced
  even if local checks haven't caught it — this is the actual value of
  adding a second, independent source), or a "confirmed live"
  corroboration specifically alongside an already-showing local warning.
  An unclear/unconfigured result adds zero noise.

**CRITICAL — not yet verified against a real key.** No `PERPLEXITY_API_KEY`
existed in the environment that built this feature, so
`checkTrackStatusViaSearch()`'s actual HTTP request/response shape against
Perplexity's real API has never been exercised — only mocked in tests. Do
this before trusting it in production:
1. `wrangler secret put PERPLEXITY_API_KEY`
2. Hit `https://cloudflare-worker.jhwiv-online.workers.dev/api/track-status?track=SAR&date=<today>&force=1`
   directly in a browser.
3. Confirm the JSON actually looks like a real Perplexity answer (a
   `summary` field with real prose, not an error) and that `status` is a
   reasonable read of it — read the `summary` yourself, don't just trust
   `status`.
4. Only then rely on the cron's daily cache for the client banner.

8 new worker tests (`tests/worker-track-status.test.js`, mocked
`fetch`) + client verification via a real Playwright-driven browser across
3 scenarios (search catches an early closure locally-silent otherwise,
search corroborates an existing local warning, unclear search adds no
noise), screenshots taken. Full suite: 380 total, 379 pass, 1
known-intentional fail (unchanged baseline, see §8).

### 12.3 v2.49.56 → v2.49.57 — boot-time splash

Same-day follow-up: asked for a splash page when the app opens — a normal
open day gets a quick positive splash, a closed day gets a subdued one
naming the reason (**"closed on the particular day"** — a mundane
scheduled dark day — vs. **"closed for some other reason"** — an
exceptional, web-search-confirmed cause). This is purely a more prominent
FIRST presentation of facts §12.1/12.2 already compute; no new signal was
added.

- New `#track-splash` full-screen overlay, tied to `initApp()` so it shows
  once per real app open (not on every tab switch — tab switches don't
  re-run `initApp()`). `showTrackSplash()` paints synchronously on boot;
  `updateTrackSplashOpen()` / `updateTrackSplashClosed()` are called from
  the SAME functions that already drive the banner
  (`renderCardFoundStatus()`, `renderSearchTrackStatus()`) — no duplicated
  logic, no second source of truth.
- Never traps the user: every state (including "checking") has a visible
  Continue button, and "checking" auto-continues after 5s even if
  resolution hasn't landed (entries can legitimately take 30-50s cold) —
  the persistent banner still carries the final word whenever it arrives.
  Open auto-dismisses itself after 3.2s; closed (either flavor) waits for
  a tap, since there's something worth reading.
- **Real bug found and fixed during verification, not before**: entries
  resolving and the web-search check are two independent async calls with
  no guaranteed ordering. If the search's `confirmed_closed` result won the
  race and arrived first, the LATER "entries found today" call would
  silently flip the splash back to the celebratory open look — burying an
  actual confirmed cancellation exactly like the abandoned-card scenario
  (races posted, then rained out). Fixed with a one-way latch,
  `_trackSplashConfirmedClosedBySearch`: once the search confirms a
  closure, nothing later can flip the splash back to open for the rest of
  that page load. Caught by a Playwright test that deliberately forces the
  wrong order (search resolves, THEN a late "card found" call), asserting
  the splash stays closed — this is the actual regression test for the bug,
  not just a happy-path check.
- **Test-harness gotcha worth remembering for future Playwright work on
  this app**: the service worker's own self-update flow
  (`checkVersion()` → `neForceUpdate()` → `document.open()/write()` of a
  freshly re-fetched `index.html`, or a `window.location.replace()`
  fallback if `document.open()` throws) was firing non-deterministically
  in headless Chromium runs, silently swapping the whole document mid-test
  — this looked exactly like random state loss / a phantom bug (a
  top-level `var` reading back as `undefined` with no thrown error) until
  traced to an actual navigation event. Fix for any future test script
  against this app: disable SW registration up front —
  ```js
  await page.addInitScript(() => {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', { value: undefined, configurable: true });
    }
  });
  ```
  Not a shipped bug — real users always have a matching `version.json`, so
  `neForceUpdate` only ever fires on an actual new deploy, same as always.

Verified live via Playwright: all three visual states screenshotted, the
tap-to-dismiss Continue button exercised, and the ordering-race fix
specifically regression-tested. Full suite unchanged from §12.2 (380
total, 379 pass, 1 known-intentional fail).

### 12.4 v2.49.60 — CRITICAL: Dark Day dashboard never rendered when there was no cached data (2026-08-03)

Reported live on an actual weather-closed day: the app looked stuck on
the loading hero instead of showing the Dark Day dashboard. Reproduced
with a real Playwright run (not a shortcut) letting the genuine
`tryFetchEntries` 30s-per-date retry ceiling exhaust across today + 3
lookahead days (~2 real minutes) with no cached races in localStorage —
confirmed it does NOT loop forever on the static loading placeholder; it
resolves to a plain, unstyled "No race card available — check back on a
race day" line instead of the rich dashboard, which is what actually
reads as "broken."

**Root cause**: the Dark Day dashboard (`offday_buildHTML()`, §5-era
feature) is wired in by *monkey-patching* `renderTodayTab()` — it
intercepts every call to that function and checks `_entriesFetchAttempted`
before deciding whether to swap in the dashboard. `fetchLiveEntries()`'s
"nothing found anywhere, no cached data to fall back on" branch called
`showLiveUnavailable()` (just toggles a small banner) but never
`renderTodayTab()` itself. The ONLY `renderTodayTab()` call that had
happened by that point was during `initApp()`, *before* the fetch even
started — when `_entriesFetchAttempted` was still `false`, so the
dashboard interceptor correctly declined to fire *then*. Once the fetch
chain actually finished and flipped `_entriesFetchAttempted` to `true`,
nothing ever gave the interceptor a second chance by calling
`renderTodayTab()` again. The sibling branch (stale cached data exists)
was never affected — it already called `renderTodayTab()`.

**Fix**: one added `renderTodayTab();` call, right before
`showLiveUnavailable()`, in that no-cache branch of `fetchLiveEntries()`.

**Lesson for future changes near this dashboard**: any code path that
should be able to show the Dark Day dashboard MUST call `renderTodayTab()`
itself (not just update some other banner/element) — the dashboard has no
independent render call of its own; it is entirely parasitic on
`renderTodayTab()` being invoked *after* `_entriesFetchAttempted` is true.
Grep for `_entriesFetchAttempted = true` before adding a new early-return
branch in `fetchLiveEntries()` and make sure `renderTodayTab()` gets
called somewhere on that path.

Verified via Playwright end-to-end (full real retry chain, not a
shortcut): confirmed the bug first, applied the fix, re-ran the identical
scenario and confirmed `#offday-dashboard` renders correctly, screenshots
of both states. Confirmed no regression on the normal "card found today"
path. Full suite: 380 total, 378 pass, 1 known-intentional fail, 1
environment-conditional skip (fitter-output-contract needs python3/scipy
— this session's container didn't have them, unrelated to this fix).

### 12.5 v2.49.61 — check the web-search status FIRST, before the slow retry loop (2026-08-03)

Direct follow-up, reported live with a screenshot: §12.4's fix corrected
*what* renders once the fetch chain finishes, but not *how long* that
takes. On a genuine no-card day, `fetchLiveEntries()` still worked
through today's own live-entries attempt AND all 3 lookahead dates (up to
~30s each via `tryFetchEntries`'s existing cold-start retry ceiling — see
§2/§3 — up to ~2 minutes worst case) before concluding "nothing here,"
even though the web-search Track Status check (§12.2) already had the
answer. Asked directly: look at the calendar first.

Fix: kick off `fetchTrackStatus()` (new shared helper, bounded to 8s) in
parallel with today's live-entries attempt, unawaited, right when
`fetchLiveEntries()` starts. If today's own attempt comes back empty, the
(by then almost certainly already-resolved) status result is checked
*before* starting the 3-day lookahead loop — a confirmed closure skips the
lookahead entirely. Zero added latency to the normal path since the
precheck runs concurrently, not sequentially before it.

Verified via Playwright with the real retry chain unshortened: confirmed
this resolves in ~31s (today's own unavoidable attempt only) instead of
the ~120s worst case, lands on the Dark Day dashboard with the real
reason in both banner and splash, and confirmed zero added latency on the
normal card-found path (~560ms, matching pre-change timing exactly).

### 12.6 v2.49.62 — known recurring dark days: Saratoga does not race Mon/Tue (2026-08-03)

Direct follow-up, reported live again: even after §12.5's fix, the app
still spent ~30s trying today's card before showing the dark-day view.
Asked the owner directly rather than continuing to guess (two questions):
(1) was `PERPLEXITY_API_KEY` actually configured yet — **no** — so
§12.5's web-search precheck was a no-op the whole time, correctly falling
back to the only thing left: actually attempting the fetch; (2) is
Saratoga's dark day a known recurring pattern or ad hoc — **owner
confirmed a real recurring pattern: Saratoga does not race Mondays or
Tuesdays.** (Today, 2026-08-03, is in fact a real Monday — confirmed via
`date`.)

New `isKnownWeeklyDarkDay(track, dateStr)` (SAR-only,
`SAR_WEEKLY_DARK_DAYS = [1, 2]` i.e. Mon/Tue, owner-confirmed not a guess)
checked FIRST — before any network attempt — everywhere the app decides
whether to try loading a card for a date: `renderInitialTrackStatus()`
(instant confident message instead of "Checking…"), `fetchLiveEntries()`
(skips today's own attempt entirely when today is dark), the 3-day
lookahead loop, and `offday_probeNextRaceDay()`'s 14-day probe (both skip
known-dark candidate dates via `continue`).

**This is a genuinely different signal from §12.2's web search, not a
replacement for it** — a recurring weekly pattern is static and free to
check (zero network, zero Perplexity dependency), while the web search
exists specifically for one-off/ad-hoc closures (the original weather
report) that no static calendar could ever predict. Checking order is now:
known weekly pattern (instant) → web-search precheck (parallel with the
fetch, ~8s bound, §12.5) → the live-entries retry chain itself (§2/§3,
last resort).

**If Saratoga's actual weekly schedule ever changes** (different meet,
different year, or NYRA changes the pattern mid-meet), update
`SAR_WEEKLY_DARK_DAYS` — do not assume Mon/Tue holds beyond what the owner
confirmed for the 2026 meet specifically.

Verified via Playwright against the real current date (a real Monday):
confirmed ~570ms resolution with zero `/api/entries` calls from the main
flow (only the unrelated `trk_probe` widget and the off-day dashboard's
own next-race-day lookup — which correctly skipped the following dark
Tuesday and checked Wednesday instead — touched the network at all).
Also directly unit-tested `isKnownWeeklyDarkDay()` against all 7 weekdays
and confirmed the rule doesn't apply to non-Saratoga track codes, and
confirmed a real non-dark Wednesday still fetches normally end to end
(regression check).

### 12.7 v2.49.63 — abandoned-card banner didn't clear when results actually arrived (2026-08-12)

Reported live on a real race day, and this time the diagnosis leaned
heavily on the owner running direct `Invoke-RestMethod` checks against
the live worker (bypassing the app) rather than me guessing from a
screenshot alone — confirmed both `/api/entries` and `/api/results` had
correct, real, `official: true` data for today throughout. This was
never a data problem, which narrowed it to the client's own state
handling immediately.

**Root cause**: `renderAbandonedCardStatus()` runs at the very top of
`fetchLiveResults()` (added in §11-era work, deliberately placed there so
the banner still updates even when the fetch itself fails, using
whatever local data already exists). But that means it only ever
evaluates data from *before* the current call's own fetch/merge runs — a
fetch that succeeds and correctly stamps `race._official = true` never
gets to immediately clear its own warning; the banner only had a chance
on some *later* poll tick. In practice it kept missing that too, so the
warning persisted through a manual "Check Results (Live)" tap and a full
app reload, even though the merge was demonstrably succeeding (the
"Checked — no new results yet" toast only fires from code that runs after
a successful merge — that toast firing was itself proof the data was
fine, just not reflected in the banner).

**Fix**: one added call to `renderAbandonedCardStatus()` right after the
merge/save completes, alongside the existing pre-fetch call (kept
unchanged for the failed-fetch case).

**Notable this round**: the bug was confirmed by stashing the fix and
re-running the exact same Playwright scenario against the pre-fix code —
watching it reproduce the live symptom precisely (banner stuck even after
a successful merge with real official results) — before trusting the fix
was actually the cause, not just a plausible-sounding guess.

## 13. Analytics tab: `/api/picks/stats` and `/api/picks/history` crashed once real pick history grew large (v2.49.64, 2026-08-13)

Reported live via screenshot: "Pick Accuracy by Source: Loading...",
"Model Calibration & Overlay Betting: Could not load.", "Recent Picks:
Could not load." all failing at once on the Analytics tab. Diagnosed
step by step against the live worker, not guessed:

1. Confirmed the worker had not been redeployed since the most recent
   `worker.js` changes (owner: "No").
2. `Invoke-RestMethod` directly against `/api/picks/stats` returned
   `error code: 1101` — Cloudflare's generic "Worker threw exception"
   page, also reproduced in-browser (Ray ID captured from the actual
   screenshot).
3. `wrangler tail` (had to be restarted with `--config wrangler.toml` —
   see the wrangler config-auto-discovery gotcha noted throughout this
   doc; the first `tail` attempt silently connected to an unrelated
   worker, "family-transition-tracker", on the same Cloudflare account)
   produced the definitive stack trace:

   ```
   GET https://cloudflare-worker.jhwiv-online.workers.dev/api/picks/stats - Exception Thrown
   X [ERROR] Error: Too many API requests by single Worker invocation. To configure
   this limit, refer to https://developers.cloudflare.com/workers/wrangler/configuration/#limits
       at handlePickStats (worker.js:2164:47)
   ```

**Root cause**: `handlePickStats` (§11.4's Model Calibration & Overlay
Betting endpoint, also backing "Pick Accuracy by Source") does 2 extra KV
`.get()` calls for *every* settled outcome record — the outcome itself,
then a second read of the matching `pick:` record (swapping the
`outcome:`/`pick:` key prefix) to reconstruct stake/betType/betTag/prob/ml
— with no cap on top of its 2 `.list()` calls. `handlePickHistory`
(backing "Recent Picks") has the identical shape: 2 `.get()` calls per
matching pick key, and its `limit` query param was only ever applied to
the final `.slice()` of the *output*, not to how many keys got
detail-fetched along the way. The `ENGINE_ACCURACY` KV namespace has been
accumulating real pick/outcome records since June across 3 engines (v2,
baseline_ml, crowd) via the existing `daily_pick_log.js`/
`daily_pick_settle.js` scheduled workflows (see §3) — large enough by
mid-August that a single "All Time" Analytics load blew past Cloudflare's
per-invocation subrequest ceiling and the Worker threw instead of
responding, rather than degrading gracefully.

**Fix**: both handlers now filter matching keys by `date`/`engine` first
(free — both are embedded in the KV key name itself, e.g.
`outcome:SAR:2026-07-13:1:v2:3`, no read required), sort by the key's
embedded date segment specifically rather than the raw key string (TRACK
sorts ahead of DATE in the key, which would silently break "most recent"
ordering once more than one track's history exists), then only
detail-fetch the most recent 400 records
(`MAX_DETAILED_OUTCOMES`/`MAX_DETAILED_PICKS` in `worker.js`).
`/api/picks/stats` additionally returns `truncated` / `processedOutcomes`
/ `totalOutcomes` fields so a caller can tell aggregates are scoped to
recent history rather than silently presenting a partial number as a true
all-time total.

**Why 400, not some other number**: chosen as a conservative margin under
an assumed 1000-subrequest paid-plan ceiling (2 `.list()` + 400 × 2
`.get()` = 802, leaving headroom for the rest of the request). The crash
only started now, after weeks of accumulation, which is far more
consistent with a ~1000-limit paid plan being approached than an
extremely low 50-limit free-plan ceiling that would have broken almost
immediately after the feature shipped.

**Tests**: `tests/worker-pick-stats.test.js` and
`tests/worker-pick-history.test.js` each gained a test that seeds 410 KV
records (10 over the cap) and asserts the cap is enforced and reported
honestly, plus a companion test confirming small (under-cap) histories
report `truncated: false` with exact, unchanged counts. Full suite: 383
total, 382 pass, 1 pre-existing unrelated failure (the `index.html`
scoring-block sync check, confirmed to fail identically via `git stash`
against a clean master — not caused by this change), 1 skipped.

**Deploy note**: pure `worker.js` change, no client HTML touched. Does
NOT auto-deploy via Cloudflare Pages — requires
`wrangler deploy --config wrangler.toml` from the correctly up-to-date
local clone (see the Wrangler config-auto-discovery gotcha earlier in
this doc for why the explicit `--config` flag matters on this machine).
