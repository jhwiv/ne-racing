# RailbirdAI — Handoff Notes

**Live site:** https://www.railbirdai.com
**Repo:** `jhwiv/ne-racing`
**Last verified:** 2026-07-04, against production, not assumed.

This supersedes any prior handoff doc that circulated outside this repo. A
few things in earlier notes were wrong (branch name, hosting provider, a
GitHub Pages "dead" claim) — this version corrects those and documents only
what was actually confirmed working end-to-end on 2026-07-04.

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
│  recently — see §4.                                        │
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
  anything in this repo's content — just re-run the failed job. Hit this
  twice on 2026-07-04, resolved both times within 1–2 retries.
- Version discipline: `NE_APP_VERSION` (in both HTML files), `CACHE_VERSION`
  (sw.js), and `version.json`'s `version` field must all match exactly, or
  the client's boot-time version check force-reloads in a loop. Bump all
  three together. `version.json` must keep its UTF-8 BOM (write it with
  Python's `utf-8-sig` codec, or equivalent) — this is a repo convention,
  not something the browser's `fetch().json()` actually requires (it
  strips BOMs fine either way — only Node's `fs.readFileSync` +
  `JSON.parse` does not, which is why `tests/version-sync.test.js` has 4
  pre-existing failures unrelated to any of this).

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

**Known, not fixed:** the About sheet's "What's new" entry still displays
v2.46.0 (2026-06-05) as the latest change. Updating it properly means
writing new changelog copy for everything shipped since — a content
decision, intentionally left alone.

---

## 5. Test suite

`node --test tests/*.test.js` (**not** `node --test tests/` — that form
doesn't glob correctly on this Node version). Baseline as of 2026-07-04:
199 passing, 4 failing, all four in `tests/version-sync.test.js` — a
pre-existing Node-only artifact (`fs.readFileSync` + `JSON.parse` doesn't
strip `version.json`'s BOM; the real browser runtime's `fetch().json()`
does, so this does not affect production). None of the Bets-tab logic
(`lockAllBets`, `updateBankrollBanner`, `removeLockedBet`, etc.) had any
test coverage before 2026-07-03 — `tests/bets-tab-fix.test.js` and this
handoff's Playwright QA scripts are the first coverage of that code path.

---

## 6. Saratoga meet dates (confirmed live via Racing API, 2026-07-04)

- Meet running now through 2026-09-07 per in-app copy.
- Opening day 2026-07-09 confirmed provisioned with real entries (9 races)
  as of 2026-07-04.
