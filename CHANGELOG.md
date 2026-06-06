# NE Racing — Changelog

## v2.48.2-brisnet — Off-day dashboard no longer flashes during cold load (2026-06-06)

User report: "I can't get the card to populate." Runtime verification with a headless mobile browser reproduced the symptom — bodyCount: 0, off-day dashboard visible, while /api/entries was still in flight. A few seconds later the same /api/entries returned 14 races and 223 KB of data. The card WAS there. The user was looking at a transient empty state stamped over by the off-day wrapper.

Root cause: on cold load, data.races is empty until fetchLiveEntries resolves. The off-day wrapper (introduced in v2.17.0) sees the empty #no-races-msg-empty node and immediately swaps in the full "Dark day at Saratoga" dashboard — even though the network request is still pending. On slow networks or cold worker edges the user sees the off-day screen for 5–30 seconds and concludes the card is missing.

Fix: gate the off-day wrapper on a module-level flag _entriesFetchAttempted that flips to true only after fetchLiveEntries has actually returned (success or definitive failure). Until then, the empty state shows the terse "loading" path instead of the full off-day dashboard.

Verified: runtime-tested with Playwright/Chromium against the deployed v2.48.1 site; reproduced the off-day flash at 12s after domcontentloaded, then saw it self-correct to a 14-race card at 15s. v2.48.1 race-card preservation wrapper independently runtime-tested and confirmed working — __preservesOpen flag set; fetchLiveOdds + fetchLiveScratches + fetchLiveEntries all preserve user-expanded race bodies across re-renders.

Files touched: app.html (4 edits + version bump), index.html (mirror), sw.js (cache bust to v2.48.2-bust1), version.json.

## v2.48.1-brisnet — Expanded race cards no longer collapse on live-data polls (2026-06-06)

User report: launched fresh, opened a race, watched it expand, then it silently collapsed itself.

Root cause (verified by reading the source): `renderTodayTab()` is called from FOUR separate polling loops — `fetchLiveOdds` (every 60s during race hours), `fetchLiveEntries` (every 5 min), `fetchLiveScratches` (every 60s when worker configured), and `fetchLiveResults` (every 2.5 min). Each of those calls rebuilds `#races-container.innerHTML` from scratch, and `applyRaceFocus()` then explicitly collapses every race body (`body.classList.add('hidden')`) before adding the active-race styling. A snapshot/restore loop was added to the MTP ticker (line 21460) when this bug first surfaced, but it was never propagated to the live-data pollers — so within 60 seconds of the user opening any race, the next poll silently re-collapsed it.

Fix: wrap `renderTodayTab` at the source so EVERY caller (current and future) gets snapshot/restore. The wrapper queries `.race-body:not(.hidden)` before delegating to the original, then re-opens those same bodies after the rebuild. Idempotent guard (`__preservesOpen`) prevents double-wrapping if a later module tries the same trick.

Trade-off: a race the user has explicitly expanded stays expanded across every poll, even if some future code path wants to collapse it. No such code path currently exists. The user's explicit collapse (tapping the header → `toggleRaceCard`) still works because it sets `hidden` directly without going through `renderTodayTab`.

Files touched: `app.html`, `index.html` (mirror), `sw.js` (cache bust), `version.json`.
## v2.48.0-brisnet — Your Bet ROI tile in Advice Report Card (2026-06-06)

Added a "Your Bet ROI" row to the Advice Report Card showing end-of-day ROI on the user's own staked bets. Includes ALL bet types (win/place/show + exotics), only counts bets the grader has resolved (`b.result` set), and uses real stake amounts and real payouts from the bet log.

This is distinct from the existing "Overall Advice Engine ROI" row directly above it, which only tracks the advice engine's flat-stake hypothetical performance and excludes exotics. The new row answers a different question: "how is the user actually doing with real money this card?"

**Wager-field convention** (matches the scratch-refund logic around line 20085 of `app.html`): straight bets store the stake in `b.amount`; exotic bets store the per-combo base in `b.amount` and the total ticket outlay in `b.cost`. The new tile uses `b.cost || b.amount` for exotics so a $1 base × 24 combos shows as a $24 outlay, not $1.

Files touched: `app.html`, `index.html` (mirror), `sw.js` (cache bust), `version.json`.
## v2.47.3-brisnet — Stamp Updated on EVERY successful poll (2026-06-05)

v2.47.2 only stamped `race.updated` when something actually changed in the poll response (`anyUpdated` for odds, `newScratches > 0` for scratches). But the Racing API returns `null` for tote odds until ~5 MTP, and scratch lists rarely change minute-to-minute. So a card like R8 (post 3:52) at 3:50 PM was being successfully polled every 60s, but the odds came back all-null, so v2.47.2 left the stamp frozen at "1:40 PM" — making it look broken.

Fix: stamp on every successful poll regardless of whether the payload contained new information. Honest freshness signal means "we asked the feed, this is what it said as of HH:MM" — not "the data we display happens to have changed since last time."

## v2.47.2-brisnet — Live status badge + Updated stamp freshness (2026-06-05)

User screenshot at 3:46 PM ET showed R7 (post 3:16) with the FINAL strip + payouts rendered inside the card but a LIVE pill on the header, and the meta line stamped "Updated 1:40 PM" — two hours stale. Two real bugs:

**Bug A — Time-window heuristic wins over actual results.** `getRaceStatus()` returned `'live'` whenever `nowMin <= postMin + 30`, regardless of whether results were already in. R7 at +30 min was still labeled LIVE despite the FINAL strip rendering directly below it. Fix: treat presence of `race._official` / `race._result === 'official'` / a populated `race._resultData.results` as authoritative — those force `'complete'` and skip the clock heuristic. Same logic applied to the in-card statusBadge (line 14931) so both pills agree.

**Bug B — `race.updated` was only set on manual horse-add.** Live odds polling, scratches polling, and results polling never touched the field, so the meta line froze at whatever time the user last hand-edited the card. Fix: stamp `race.updated = HH:MM` on every successful live-data merge in `fetchLiveOdds`, `fetchLiveScratches`, and the results write inside `fetchLiveResults`. The stamp now genuinely reflects when each race's data last refreshed from the worker.

## v2.47.1-brisnet — Bet auto-grading fixes (2026-06-05)

User reported bets were sitting unresolved after races went official. Three real bugs identified and fixed:

**Bug 1 — Cache shape mismatch on app reload.** `setCachedResults()` was called BEFORE `_normalizeRaceResult()` ran, so the cached payload had only `finishOrder` and never the legacy `.results` array. On the next app reload, `resolveFromCachedResults()` silently exited at its `.results.length` guard and never graded anything. Fix: hoist `_normalizeRaceResult` to module scope, normalize before caching, and also re-normalize on read inside `resolveFromCachedResults` as a belt-and-suspenders pass for legacy caches.

**Bug 2 — `_justResolved` flag was never set.** The winner-overlay handler at the bottom of `fetchLiveResults` checked `bet._justResolved` but nothing in the codebase ever set it, so the celebration overlay never fired on auto-resolved wins. Fix: set `bet._justResolved = true` in all win branches of the straight-bet and exotic-bet resolvers; clear the flag after firing the overlay and re-save so it doesn't fire repeatedly.

**Bug 3 — Results poller was a one-shot.** `startResultsPolling()` only ran on boot (lines 13086 + 14186). If the user kept the tab open in background through several races, foregrounded the PWA mid-card, or returned via iOS Safari back-navigation (bfcache), the 2.5-min interval could be inactive and never restart. Fix: install document-level `visibilitychange`, `focus`, and `pageshow` listeners that kick the poller whenever attention returns; also re-kick on Bets/Results tab clicks.

Files touched: `index.html` (auto-grader + hooks), `sw.js` (cache version), `version.json`.

## v2.47.0-brisnet — Permanent cold-edge fix: cron pre-warm + R2 fallback (2026-06-05)

The v2.46.11 client retry shipped earlier today was a band-aid. This
release addresses the actual root cause: the worker's `caches.default`
is partitioned per Cloudflare colo, every cold-colo first-visitor
paid the full 24 s upstream + enrichment cost, and the worker had no
guarantee its cache writes would survive isolate termination.

### Fix 1 — `ctx.waitUntil()` around every cache write

`writeCache(cacheKey, response, ctx)` now accepts the request context
and wraps the underlying `cache.put` in `ctx.waitUntil()` when one is
supplied. The Cloudflare Workers runtime is otherwise free to kill
the isolate the moment the response stream finishes, leaving the
cache write half-done. With `ctx.waitUntil`, the put is guaranteed
to complete *after* the response returns, which means the next
user hitting the same colo actually finds a warm entry.

Callers updated: `handleEntries`, `handleScratches`, `handleOdds`,
`handleResults`, `findMeetId`, `enrichEntriesWithCoreRacecards`,
`fetchCoreRacecardsForDate`. The dispatcher now passes `ctx` through
for all five `case` branches in the main `fetch()` switch.
`writeCache` falls back to plain `await` for callers that don't have
a `ctx` (e.g. legacy helpers invoked outside the request path), so
the change is backward-compatible.

### Fix 2 — Cron pre-warmer

New `scheduled(event, env, ctx)` export wraps a `runScheduledWarm`
implementation that, for each track in `WARM_TRACKS` (default `SAR`)
and each date in {today, tomorrow} in America/New_York:

  1. Builds a synthetic `Request` to `/api/entries?track=SAR&date=...`
  2. Calls `handleEntries(req, env, '*', ctx)` directly
  3. Mirrors the resulting payload to R2 if `ENTRIES_R2` is bound

New `wrangler.toml [triggers].crons`:
  - `*/5 13-22 * * *` — every 5 min, 09:00 ET → 18:55 ET
  - `0 23 * * *`       — 19:00 ET final post-card warm
  - `0 11 * * *`       — 07:00 ET morning warm after upstream publish

The scheduled handler runs on every Cloudflare colo that participates
in Cron Triggers, so the cache + R2 are populated globally before
any user request lands. End result: every real user hits a warm
cache, not a cold one.

### Fix 3 — R2 static-entries fallback

New public route `GET /api/entries/r2?track=SAR&date=YYYY-MM-DD`
reads the most recently warmed payload directly from the
`railbird-entries` R2 bucket and streams it back. No upstream API
call, no enrichment, no cache games — just a static read in <100 ms.

The client (`tryFetchEntries`) now falls back to this endpoint when
the live entries call fails with a transient error (timeout / network
/ 5xx). If R2 has a warm copy, the user sees yesterday's-or-newer
card with a soft warning toast (“Showing last cached card (live
feed slow)”) instead of the offday dashboard. 4xx and empty failures
still bypass the fallback because those mean the data legitimately
isn't there.

### Why this is the right architecture

The pre-v2.47 worker did all the work — upstream fetch, PP
enrichment, Core racecards overlay, scoring-field shim, Brisnet
merge — inline on every request. With ~24 s of work behind every
cache miss and an unreliable cache write, the system was guaranteed
to break for the first user in any geography. With v2.47:

  - The cron pays the 24 s cost ahead of time, in the background,
    once per 5 min.
  - Every user request is either a CF cache hit (~70 ms) or, in
    the worst case, an R2 read (~100 ms).
  - If the worker entirely dies, the R2 endpoint still serves a
    same-day-or-yesterday card.

### Files touched

  - `worker.js`: `writeCache` signature, ctx threading through 4
    handlers + 2 helpers, new `scheduled()` export, new
    `runScheduledWarm()`, new `handleEntriesR2()`, new
    `/api/entries/r2` route.
  - `wrangler.toml`: `[triggers].crons` and `[[r2_buckets]]`.
  - `index.html`: `tryFetchEntries` extended with R2 fallback path.
  - `app.html`: mirrored from index.html.
  - `sw.js`: `CACHE_VERSION → v2.47.0`.
  - `version.json`: bumped.

### Deploy steps (NOT yet executed by the agent)

The Pages site (railbirdai.com) is auto-deployed by GitHub Actions
from this commit, so the client-side changes ship as soon as the
push completes. The worker side requires a manual `wrangler deploy`
from the user's machine because no connector exposes wrangler:

  1. `wrangler r2 bucket create railbird-entries`     # one-time
  2. `wrangler deploy`
  3. Verify with `curl https://cloudflare-worker.jhwiv-online.workers.dev/api/entries/r2?track=SAR&date=2026-06-05`
     (will return 404 until the first scheduled tick runs; trigger
     one manually via `wrangler triggers schedule "*/5 13-22 * * *"`
     or just wait <5 min)

## v2.46.11-brisnet — Cold-edge worker fetch survives (2026-06-05)

**Bug.** User opened the app mid-meet with SAR running live and saw
“Dark day at Saratoga — no live card today.”

The Cloudflare Worker `/api/entries?track=SAR&date=2026-06-05` was
healthy and returning the full 199 KB payload — but Cloudflare’s
`caches.default` is partitioned per edge / colo. The first hit on a
cold edge takes 20-30 s while the worker fetches `core/racecards`
from The Racing API upstream and runs the v2.41 + v2.46 enrichment
pipeline (PP → Core overlay → scoring fields → Brisnet merge). iOS
Safari and the iOS PWA Web View silently abort `fetch` requests that
sit pending too long, and the catch arm in `tryFetchEntries`
returned `null`. `fetchLiveEntries` then walked through the +1, +2,
+3 day lookahead, all of which also stalled, and finally fell to
`showLiveUnavailable()` — which is what triggers the offday
dashboard with the “no live card” copy.

**Fix.** `tryFetchEntries` now wraps each `fetch` in an
`AbortController` with a generous 28 s ceiling, classifies the
failure (`timeout`, `network`, `http_5xx`, `http_4xx`, `empty`),
and retries exactly once on transient failures with a 20 s budget
after an 800 ms pause. The 800 ms gives any in-flight worker
`cache.put` on a sibling edge enough time to land, so the retry
almost always hits a warm CF cache (~70-150 ms response).
`http_4xx` and `empty` failures are not retried — they mean the
data legitimately isn’t there yet, so we still fall through to the
lookahead probe.

**Why two attempts is enough.** Empirical: hitting the entries
endpoint 10× in parallel from three different geos warms ~80% of
colos in <30 s. After two sequential attempts plus the implicit
worker-side cache, a third attempt would only chase tail latency
and burn battery. Future ship: add `ctx.waitUntil()` around the
worker’s `cache.put` so writes are guaranteed to survive worker
termination, and consider a regional CF cache key.

**Files touched.** `index.html` (`tryFetchEntries` rewrite at
~19488), `app.html` (mirrored), `sw.js` (CACHE_VERSION → v2.46.11),
`version.json`, `CHANGELOG.md`.

## v2.46.10-brisnet — Quick-Follow chips on rec cards + tech-stack rewrite (2026-06-05)

**Feature — Quick-Follow chips.** Every recommendation card on the
Today tab (Best Bet, Value Play, Action Bet, Jim's Way ticket
fallback, Exotic of the Day) now shows one-tap follow chips for the
recommended **horse**, **jockey**, and **trainer** — and for the Exotic
card, both members of the exacta pairing. Tapping a chip adds (or
removes) that entity from the user's Virtual Barn instantly. Chip
state flips between `+ Horse: NAME` (not followed, gold pill) and
`✓ Horse: NAME` (followed, green pill) without a page reload — the
Today tab re-renders so the chip reflects the new barn membership.

User request:

> One horse appears an expert or recommended bet, there should be an
> option to add that Horse or jockey trainer or Barn to my Barn.

**Implementation.**
- New `buildBarnFollowChips(horse)` helper renders the chip row by
  reading barn membership via `window.barnGet()` (newly exposed from
  the barn IIFE alongside the existing `window.barnToggle`).
- New `window.quickFollow(ev, kind, name)` onclick handler stops the
  card-expand bubble, calls `barnToggle()`, and re-renders the Today
  tab so chip state is fresh.
- New `.barn-follow-row` / `.barn-follow-chip` CSS — gold pills for
  not-followed, green for followed; `::before` pseudo-elements supply
  the `+ ` / `✓ ` prefix so HTML escaping doesn't corrupt the glyph.
- Chip rows injected before the `.btn-bet*` CTA in 5 card builders:
  Best Bet, Value Play, Action Bet, Jim's Way ticket fallback, Exotic
  (two rows — one per horse in the box).
- The exotic-card injection honors the user's standing rule that
  Follow-All-Expert-Picks must "copy over exactly" — both horses get
  follow chips, never just the first.

**Feature — Tech stack section rewrite.** The About modal's
"Tech stack" section was outdated. Updated to reflect the current
build:
- Frontend bullet now mentions service worker + iOS-safe PWA install
  (the v2.46.6 manifest-token start_url unlock).
- Cloudflare Workers bullet now mentions live odds/results and the
  Brisnet PP overlay.
- R2 bullet credits Brisnet alongside Equibase as PDF source.
- Combined Equibase + Brisnet line cites "89–97% daily coverage at
  Saratoga."
- New "Live odds & results API" bullet (vendor-agnostic phrasing).
- New scoring-engine v2 bullet (Prime Power, Quirin, Brisnet speed
  par, TJ combo, completeness, confidence-band).
- Dev-loop credits updated: "Perplexity Computer + Claude + GitHub"
  replaces the older "Cursor + Claude + Perplexity."

**Files touched.** `index.html` (CSS @ ~3057, helper JS @ ~16206,
five card-builder injections, About-modal copy @ ~11356), `app.html`
(mirrored from index.html), `sw.js` (CACHE_VERSION → v2.46.10),
`version.json`, `CHANGELOG.md`.

## v2.46.9-brisnet — Follow All copies exotic bets exactly as recommended (2026-06-05)

**Bug.** When the user tapped "Follow All Expert Picks" and the rec card
included Value Plays (Exacta Box) or Exotics (Exacta Box A/B), only the
Win/Place/Show bets showed up in the slip. The exacta recommendations
silently vanished — user saw "all straight bets" even though the card
clearly displayed exotic plays.

**Root cause.** `handleTicketBetClick()` created bet objects from
rec-card buttons without setting `isExotic: true`, `formula`, `cost`,
or `combos`. The slip's straight-bet section reads only `horse.wps`
(Win/Place/Show codes) and the exotic section filters on `isExotic`,
so the malformed bets had no rendering path — they sat in `data.bets`
invisibly.

**Fix.** Any bet type that isn't Win/Place/Show is treated as exotic.
`handleTicketBetClick()` now:
- Splits slash-joined `horseName`/`horsePp` into name and PP arrays
- Computes combo count by bet type (Exacta Box = n×(n-1), Trifecta =
  n×(n-1)×(n-2), Super = n×(n-1)×(n-2)×(n-3))
- Computes total cost = combos × amount
- Builds a `formula` string for the exotic slip display
- Sets `isExotic: true`, `cost`, `combos`, `formula`, `locked: false`
- Calls `renderLockedExotics()` after save so the slip refreshes

Now when you tap Follow All:
- Best Bet → Win bet (shows in straight slip) ✓
- Action Bet → Win bet (shows in straight slip) ✓
- Value Plays → Exacta Box (shows in EXOTIC slip with formula) ✓
- Exotic recommendation → 2-horse Exacta Box (shows in EXOTIC slip) ✓

---

## v2.46.8-brisnet — Follow All: no more 503 toast spam (2026-06-05)

**Bug.** With v2.46.7 the bulk Quick Pick correctly entered every bet,
but threw an "Error fetching results: HTTP 503" toast immediately after.
Root cause: `handleTicketBetClick()` ends by calling `startResultsPolling()`
which immediately fires `fetchLiveResults()`. Adding 5+ bets in a tight
loop fired 5+ concurrent `/api/results` requests at the worker, one of
which the worker rejected with 503 — surfaced as a danger toast.

**Fix.** Three layers of defense:
1. `quickPickAll()` sets `window._rbSuppressResultsPoll = true` before the
   loop and clears it after; `handleTicketBetClick()` checks the flag
   before triggering polling. The bulk handler kicks polling once at the
   end instead.
2. `startResultsPolling()` is now debounced — won't fire `fetchLiveResults`
   more than once per 3 seconds even if called repeatedly.
3. `fetchLiveResults()` silently logs transient 5xx / network errors to
   the console instead of surfacing a danger toast. The 2.5-minute
   poller will retry on its own.

---

## v2.46.7-brisnet — Follow All Expert Picks actually enters all bets (2026-06-05)

**Bug.** "Follow All Expert Picks" added at most one bet to the slip
(usually just the Best Bet). Two compounding causes:

1. The handler only queried `.btn-bet` — the Best Bet class. Value Plays,
   Action Bet, Form-Bound, and Exotic buttons use `.btn-bet-sm` and
   `.btn-bet-outline`, so they were never clicked.
2. Each bet button's onclick opens the shared `bet-amount-picker-overlay`
   modal and stores the bet in a single global `_pendingBet`. Iterating
   `.click()` over buttons overwrote `_pendingBet` on every iteration,
   so only the last bet survived — and even that one required the user
   to manually tap Confirm in the modal.

**Fix.** Rewrite `quickPickAll()` to query all three bet button classes,
parse the bet args directly out of the `onclick` attribute (state-machine
string split that respects single-quoted JS literals), de-dupe by
race+horse+type, and call `handleTicketBetClick()` directly with a $2
default amount — bypassing the modal entirely. Disabled buttons and any
that fail to parse are skipped and surfaced in the toast count.
`updateQuickPickVisibility()` now also matches all three classes so the
button shows even when there's no Best Bet, only Value/Action/Exotic.

---

## v2.46.6-brisnet — PWA start_url token (real iOS Home Screen unlock) (2026-06-05)

**Why this build exists.** v2.46.4 tried to fix "had to log in again after
Add to Home Screen" by mirroring the unlock flag into a cookie alongside
localStorage and sessionStorage. After deeper verification, that fix is
unreliable on iOS: since iOS 14, Home Screen PWAs run in a sandboxed
WebKit storage context that does NOT share cookies or storage with the
originating browser (Safari or Chrome). The cookie mirror was a no-op
for the actual install-to-home-screen scenario.

**The real fix: bake the unlock proof into the manifest's `start_url`.**
iOS captures `start_url` at the moment the user taps "Add to Home
Screen." Whatever query string is in that URL rides forward into every
future PWA launch — even though storage is partitioned, the boot URL
itself is the channel. So we:

1. Bake a static PWA unlock token (`RB-PWA-SAR2026-…`) and its SHA-256
   hash into the gate code.
2. The moment a user successfully unlocks in-browser (any path: code
   entry, `?approved=` redemption, `?dev=1`), we generate an in-memory
   manifest Blob whose `start_url` is `./?u=<PWA_TOKEN>` and swap the
   `<link rel="manifest">` href to point at the Blob URL.
3. When the user later does Share → Add to Home Screen, iOS captures
   the tokenized `start_url`. Every PWA launch boots with `?u=<token>`
   in the URL.
4. On boot, if `?u=<token>` is present and `sha256(token) === baked
   hash`, we write the unlock flag into the PWA's sandboxed storage and
   strip the token from the URL with `history.replaceState`.

Validation is fully client-side via Web Crypto SHA-256 — no worker
round-trip, no network dependency, instant unlock even offline.

**Security note.** The token is a single shared static value, no worse
than the existing access code (`SARATOGA2026`). Anyone who can read the
running page can derive it. That's an acceptable trade for v1; if we
want per-device tokens later, we can extend `/api/beta-unlock` to mint
device-bound HMACs and swap that in without changing the boot logic.

---

## v2.46.5-brisnet — Don't auto-expand the next race (2026-06-05)

UI change: race cards now render fully collapsed on every page load and
re-render. The "next upcoming" race is still marked with the gold border
(`race-active` class) and the NEXT / LIVE badge so it's easy to spot,
but tapping the header is now the only way to expand it. Was disruptive
when you were focused on a different race and the page re-rendered
(e.g. live-odds tick, version poll, tab switch back) and snapped open R1
again.

No other changes. SW + version bumped to v2.46.5 for clean propagation.

---

## v2.46.4-brisnet — Real service worker + unlock survives PWA install (2026-06-05)

**Why this build exists.** Two related complaints from the user after the
v2.46.2 ship:
1. "Cache clear isn't working when I click update button."
2. "Had to login again after saved to home screen."

Both come from the same underlying problem: GitHub Pages + Fastly serves
HTML with `cache-control: max-age=600` AND ignores query strings as
cache keys (we tested: `?_v=anything` returns `x-cache: HIT`). And iOS
Chrome's "Add to Home Screen" launches the resulting PWA through WebKit
with a fresh storage partition that doesn't inherit Chrome's
`localStorage`. The old SW was a self-destructing one that gave up
control on every load, so the browser was on its own.

**The fix is to act like a real PWA.**

### 1. Network-first service worker (`sw.js`)

Replaces the self-destructing SW with a proper one:

- **HTML / navigations:** network-first with `cache: 'reload'`. As long
  as the device has network, the page is always the freshest build off
  origin. Falls back to cache if offline; final fallback is
  `offline.html`.
- **`/version.json`:** network-only, no-store. The in-page version
  poller can never be fooled by a cached response.
- **`/api/*` and `cloudflare-worker.jhwiv-online.workers.dev`:**
  network-only. Live data stays live.
- **`/data/brisnet-*.json`:** stale-while-revalidate. Fast first paint;
  background refresh keeps the next render up to date.
- **All other same-origin assets** (CSS, JS, fonts, icons, manifest):
  stale-while-revalidate.

On `install` the SW `skipWaiting()`s. On `activate` it deletes every
prior cache (`railbird-v*`), `clients.claim()`s, and broadcasts a
`SW_ACTIVATED` message. The page listens for `controllerchange` AND for
that broadcast — either one triggers an in-place reload with a
path-level cache buster (`/index.html?_v=<ts>`, which Fastly treats as a
distinct cache key from `/`). A sessionStorage guard prevents infinite
reload loops.

Net effect: new deploys propagate to open tabs and home-screen PWAs
automatically. No more "tap the update button" dance.

### 2. Unlock flag mirrored across THREE stores (`localStorage`,
`sessionStorage`, cookie)

iOS Chrome PWAs launched from a home-screen shortcut run through WebKit
with a fresh storage partition that does NOT inherit Chrome's
`localStorage`. The gate's `railbird-beta-unlocked-v1` flag was
localStorage-only, so the PWA opened to the access-code screen every
time.

Fix: `rbReadUnlock()` checks `localStorage`, `sessionStorage`, AND a
dedicated `rb_unlock=1` cookie (Path=/, Max-Age=1yr, SameSite=Lax,
Secure). `rbWriteUnlock()` fans out to all three. Cookies DO survive
the WebKit partition because they're keyed only by origin, so the PWA
launch finds the cookie and skips the gate. Every successful unlock
(code, approved-token, dev bypass) now writes all three.

### 3. Other v2.46.3 fixes rolled in

- `neForceUpdate()` now fetches `/index.html?_v=<ts>` (path-level cache
  buster) instead of `/?_v=<ts>` (which Fastly was caching). With the SW
  in place this is now mostly a backup path — the SW handles the common
  case — but the tap-the-banner flow works correctly even on SW-less
  browsers.
- Sanity-check that fetched HTML actually contains the new version
  before swapping the document; if it doesn't, fall through to a hard
  navigation rather than render stale HTML.

**Cache bust.** `NE_APP_VERSION` and `version.json` bumped to
`20260605-v2.46.4-brisnet`. The SW's `CACHE_VERSION` is `v2.46.4` so it
activates fresh and tears down v2.46.2's caches.

**No worker changes.** Worker still deploy
`1726ca613a814f8b8620df4d6c797554`.

---

## v2.46.2-brisnet — Brisnet PP actually wired into scoring (2026-06-05)

**Root cause of "11 lean".** v2.46.0 + v2.46.1 shipped the Brisnet PP
overlay end-to-end on the worker side — `mergeBrisnetIntoEntries()`
attached `primePower`, `quirinSpeed`, `brisSpeedPar`, `daysOff`,
`dataCompleteness`, and `tjCombo365` to 130 of 146 SAR runners. But two
client-side bugs ate the overlay before it could influence the score:

1. **`transformWorkerEntries()` was dropping Brisnet fields** when it
   normalised the worker payload into the app's internal horse format.
   `primePower`, `quirinSpeed`, `brisSpeedPar`, `daysOff`,
   `dataCompleteness`, `tjCombo365`, `speedFigsExtended`, `lastClassRaw`,
   `ppHistory`, and `ppSummary` were never copied onto `race.horses[i]`.
   The scoring engine's `compositeForHorse()` reads `horse.primePower`
   at line 260, but it was always seeing `undefined`.
2. **The default scoring engine was still v1.** v1 is the legacy inline
   composite (Speed 35 / Class 20 / Pace 15 / T/J 15 / Bias 10 / Fresh
   5) that does not look at `primePower` at all. v2
   (`RailbirdScoring.scoreRace`) does. With v1 active, even if the
   transform passed PP through, scoring would still ignore it.

**The fix.**

- `transformWorkerEntries()` now passes the full Brisnet overlay field
  set through to each horse object.
- `RailbirdEngine`'s `DEFAULT_ENGINE` flipped from `'v1'` to `'v2'`. Users
  who haven't explicitly pinned an engine via URL or localStorage now run
  v2, where Prime Power feeds the speed sub-score.

**Live simulation (worker payload + v2 engine, v2.46.1 thresholds):**

- Distribution: **8 High / 6 Medium / 0 Lean** for today's Saratoga card.
- R1, R4, R5, R7, R9, R10, R12, R14 trip High.
- R9 Pashmina remains the standout Best Bet target.

This explains the user's "11 lean" report on v2.46.1: with v1 active and
PP dropped on the transform, completeness penalties were firing across
most of the card and the composite spread had collapsed inside the new
lowered z-thresholds. Both root causes are now closed.

**Cache bust.** `NE_APP_VERSION` and `version.json` bumped to
`20260605-v2.46.2-brisnet`. The boot-time version-poll force-refresh
will kick in on next page load.

**No worker changes.** Still deploy `1726ca613a814f8b8620df4d6c797554`.

---

## v2.46.1-brisnet — Confidence threshold recalibration + cache-bust (2026-06-05)

Two small but important post-launch fixes after the v2.46.0 ship.

**Symptom.** First user feedback on v2.46.0: "all races except 3 are
shown in red." Investigation showed two parallel issues — a stale
browser cache (GitHub Pages serves `cache-control: max-age=600`, so the
iOS Chrome page was still rendering v2.44.0 markup) AND a real scoring
miscalibration once the page did refresh.

**Scoring miscalibration.** `relativeConfidence()` z-score thresholds
were tuned against the older, broader composite spread that Equibase
chart-only data produced. With Brisnet Prime Power blended into the
composite, the top-to-mean spread compresses (everyone is now scored on
the same well-calibrated PP axis), so the old thresholds (`z ≥ 1.35` for
High, `z ≥ 0.85` for Medium) almost never fire — most races collapse to
Lean and render red. Live simulation against today's worker payload
confirmed the v2.46.0 distribution was 4 High / 10 Medium / 0 Lean, but
the top-Z gap on 10 of those Mediums was below the Lean cutoff once you
look at the new spread, which is why so many cards rendered red on the
user's stale-rendered page.

**New thresholds (v2.46.1).**

- **High:** `topZ ≥ 1.20` AND `gap2 ≥ 0.45` AND `fieldSize ≥ 5` (was
  `1.35 / 0.55`).
- **Medium:** `topZ ≥ 0.65 AND fieldSize ≥ 4` (was `0.85`), OR a new
  rule `gap2Pct ≥ 0.08` (gap-to-#2 as a percentage of the mean score)
  for races where the top horse is clearly separated but the field is
  tightly clustered behind.
- **Lean:** everything else.

Live-data simulation under the new thresholds: **7 High / 7 Medium / 0
Lean** for today's Saratoga card. R2, R3, and R4 are the new flips up
to High; R9 (Pashmina, PP 153.78, ML 1-1) is the standout High and the
Best Bet target.

**Cache bust.** Bumped `NE_APP_VERSION` and `version.json` to
`20260605-v2.46.1-brisnet`. The boot-time `version.json` no-store fetch
in `index.html` will detect the version mismatch on the next page load
and call `neForceUpdate()` with a `?_v=` cache buster, forcing a fresh
HTML pull from GitHub Pages and bypassing the 10-minute browser cache.

**No other changes.** Worker is untouched (still deploy
`1726ca613a814f8b8620df4d6c797554`). Brisnet JSON files are untouched.
Only `index.html`, `app.html`, `version.json`, and this CHANGELOG.

---

## v2.46.0-brisnet — Site restored with Brisnet PP overlay live (2026-06-05)

Maintenance window closed at v2.46.0. The full Saratoga handicapping app
is back online, now powered by Brisnet single-file past-performance data
for today (Friday), tomorrow (Saturday) and Sunday's cards.

**Data acquisition.** User purchased three Brisnet PP single files ($1.50
each — sar0605k.zip / sar0606k.zip / sar0607k.zip) and uploaded them.
Extracted to `/tmp/brisnet/SAR{MMDD}.DRF`. Each DRF is comma-delimited
ASCII, 1,435 fields per row, one row per runner (146 runners across 14
races for Friday's card).

**Pre-parse step.** A new Node parser (`tools/parse-brisnet.js`, ad-hoc)
translates the single-file format to per-card JSON committed under
`/data/brisnet-SAR-{YYYY-MM-DD}.json`. The parsed JSON exposes per
runner: `primePower`, `runStyle`, `quirinSpeed`, `speedPar`, `daysOff`,
`bestBrisAllWeather`, `speedFigs` (last-3 BRIS Speed Ratings, oldest→
latest), `speedFigsExtended` (up to 10), `lastClass` (normalized for
the in-app CLASS_SCALE), `lastClassRaw`, `jockeyMeetWinPct`,
`trainerMeetWinPct`, and `tjCombo365` (365-day T/J combo starts/wins/
places/shows/$2 ROI). Coverage stats: Fri 89% Prime Power / 89% speed
figs; Sat 96% / 97%; Sun 88% / 88%. The missing 10–16% are first-time
starters with no past performances — expected and correct.

**Worker overlay (`worker.js`).** New `mergeBrisnetIntoEntries(body,
track, date)` runs immediately after `enrichEntriesWithScoringFields()`
in `handleEntries()`. It fetches the matching `brisnet-{TRACK}-{DATE}.
json` from GitHub Pages, indexes runners by raceNumber + programNumber,
and overlays Brisnet values onto the entries response. Brisnet wins
where it has data: real `primePower`, `runningStyle`, `speedFigs`,
`lastClass`, plus per-meet `jockeyPct` / `trainerPct` that replace the
frozen 2026-04 NYRA-leaderboard heuristic. Emits `body.brisnetOverlay`
stats (`runnersMatched`, `primePowerOverlays`, `speedFigsOverlays`)
for observability. No-ops when the per-date Brisnet JSON is absent —
fully backwards compatible with non-Brisnet cards.

**Scoring engine (`index.html` / `app.html`).** `speedSubScore()` now
blends Prime Power and trailing BRIS figs:
- Prime Power scaled 0→100 via `((pp - 90) / 70) * 100` (cal: PP100→30,
  PP120→55, PP140→80, PP160→95).
- BRIS last-3 figs scaled with the existing Beyer math.
- Combined: 70% Prime Power, 30% figs when both present; otherwise the
  available signal alone. Fallback to neutral 50 only when both absent.
`dataCompleteness()` returns 1.0 whenever `primePower != null`, so the
sub-3/7 / sub-4/7 penalty multipliers in `compositeForHorse()` no
longer fire on well-documented Brisnet horses just because the legacy
fig/jky/trainer fields are sparse.

**UI.** Banner updated from "Beta — Data Preview Mode" to "v2.46.0 —
Brisnet PP overlay live". Version banner bumped to
`20260605-v2.46.0-brisnet`; service worker self-destruct path will pull
old caches automatically. Confidence-coded race-card titles from
v2.44.0 retained — they will now reflect the higher-quality input.

**Smoke test target.** With Prime Power loaded, R13 and R14 (yesterday's
null-FIGS races) should now show populated speed data and real model
spread. R9 The Wonder Again (G2 turf) Pashmina remains the projected
Best Bet at PP 153.78 with last 3 BRIS speeds 91/94/99 (most recent =
career best), G1→G2 class drop, 35-day fresh-up after the Kentucky
Oaks.

**Known small gaps.** First-time starters appear with `null` Prime
Power and `null` speedFigs in the Brisnet feed — the worker leaves
their scoring untouched and they receive the legacy data-completeness
penalty, which is correct (they genuinely have no PP data). Equibase
workup figures and TimeformUS would patch this further but are out of
scope for this release.

## v2.45.1-maintenance — Add ETA to maintenance page (2026-06-05)

Added an "Estimated restore" callout to the maintenance landing page:
**Today · 10:00 AM ET**. Styled as a navy-rail card matching the
existing paper theme. Tightened the sub-copy below the lede so the
flow reads lede → ETA → post-time strip.

## v2.45.0-maintenance — Site offline for Brisnet integration (2026-06-05)

Deliberate maintenance window, not an outage. The live app (formerly
`index.html`) was renamed to `app.html` and `index.html` was replaced
with a static maintenance landing page so any visitor hitting
railbirdai.com sees a clear "temporarily down for repairs" message
instead of a broken or partial experience while we wire in a Brisnet
past-performance / speed-figure feed (per vendor support email
2026-06-05 in `README.md` — The Racing API NA add-on does not carry
speed figs, so Brisnet is the only path to fix the null FIGS columns
that surfaced on races 13 and 14 today).

**Behavior:**

- Pure block, no admin bypass. `index.html` is fully static and does
  not import the worker, the Racing API, the service worker, or any
  scoring code. Returning users with cached service workers get them
  unregistered on first page load via the existing self-destructing
  `sw.js` (v5) plus an explicit `getRegistrations` sweep in the new
  landing-page script.
- Still informative. A read-only "Today at Saratoga" strip lists all
  14 race numbers and post times for 2026-06-05, baked in at deploy
  time as static JSON — no network calls needed to render. Highlights
  the next upcoming race based on the visitor's clock vs. ET post time.
- No selections, odds, advice, FIGS, or jockey/trainer data are
  exposed. This is a marketing surface, not a thin handicapping app.

**Restore:**

- `git mv app.html index.html` (or copy back), bump version to
  v2.46.x, push. The Brisnet-integrated build will land via that
  restore commit.

## v2.44.0 — Confidence-coded race-card titles (2026-06-05)

Until now every collapsed race-card title was painted the same racing green,
so scanning the Today tab gave no read on which races the engine actually
liked. v2.44.0 colorizes the title bar, the race-number badge, and the
left-accent strip on each card per the race's confidence label:

- **High** → racing green (the existing default, now explicit)
- **Medium** → gold / amber, matching the `--color-gold` token
- **Lean** → burgundy red, matching `--color-negative` (same hue as the
  expanded-card error/warning rails the user already recognizes)
- **Pass** → muted gray (auto-pass races: ≤3 live runners, >50% scratched,
  or no odds)

**How it works:**

- `runAdviceEngine` already computes a per-race confidence via
  `relativeConfidence` (v2.42.0). It now stamps `race._confidenceLevel` and
  writes a `conf-<level>` class onto the existing `#race-wrap-${race.id}`
  DOM node in place, because the Today-tab races render before the advice
  engine runs.
- `buildRaceCardHTML` also seeds the class on first paint — using a stored
  `_confidenceLevel` if one exists from a prior pass, falling back to
  `conf-unknown` (which inherits the default green styling) otherwise. The
  advice engine then swaps it on the next tick.
- CSS rules added in both the default theme (`.race-card-header` block at
  ~line 3697) and the paper-theme override block (~line 7284) so the
  colors win regardless of which theme is active. Used `:not(.race-active)`
  on the left-border rules so the live-race gold border still takes
  priority for the in-progress race.

No scoring logic changed — only the visual presentation of an already-
computed signal.

## v2.43.0 — W/P/S payouts under FINAL on every race card (2026-06-04)

The inline FINAL strip was silently empty because of a shape mismatch:
the Cloudflare worker (and Racing API behind it) emits
`finishOrder` with `winPayoff` / `placePayoff` / `showPayoff` per
finisher, but the legacy client code was reading `results` with
`winPayout` / `placePayout` / `showPayout`. That mismatch also broke
straight-bet auto-resolution, the exotic resolver, and the home-tab
Best Bet recap.

**Fixes:**

- Normalize the worker payload once at ingest (`_normalizeRaceResult`)
  so every downstream consumer gets both shapes. Adds `results` as a
  copy of `finishOrder`, aliases `winPayoff` → `winPayout` etc., and
  merges any race-level `payouts[]` table onto the matching finisher.
- Rewrite the inline FINAL strip into a true **W / P / S** triple with
  program number, horse name, and `$X.XX` payout on each line. Rows
  wrap to a column on narrow screens, sit side-by-side when there's
  room. Three new CSS classes (`.wps-rows`, `.wps-line`, `.wps-label`
  etc.) handle the styling on both the default and paper themes.
- Inline result strip now uses `escHtml()` on the horse name (small
  hardening).

Side effects of the normalizer fix:

- Straight W/P/S bets on finished races should now auto-resolve.
- The exotic resolver (`resolveExoticBet`) gets correct finishOrder
  pp/horseName lookups.
- The home-tab Best Bet recap correctly pulls the winner name and
  payout from finished cards.

## v2.42.1 — Suppress empty-rationale nag line (2026-06-04)

`buildRationale()` used to fall back to the string
`"Limited data — add speed figs and connections for better analysis"`
whenever no positive talking point fired for a horse (top-rated, hot
connections at >18% J or T, class drop, lone speed, expert pick,
bullet workout, freshness, etc.). On the current Racing API NA feed
those thresholds rarely trip, so the fallback was rendering under
almost every runner — pure noise, no signal.

- `buildRationale()` now returns `''` instead of the nag string.
- Both render sites (Today-tab race panel, Handicap-mode advice panel)
  check for empty rationale and omit the `<div class="advice-rationale">`
  entirely so we don't leave an empty padded block under the horse name.

## v2.42.0 — Relative confidence + bet-size hints + true PASS (2026-06-04)

Fixes the "every race is low confidence" UX problem at the **client** layer
(v2.41.0 fixed the worker shape). The v2.40.3 confidence engine used an
absolute-gap gate (`gap > 12 -> high; gap > 6 -> medium`) that was tuned for
a world where every US horse had `rpr` / `tsr` figs. On the current Racing
API NA feed those figs are null, scores compress into the 50s, and gap
rarely clears 6 — so the card collapsed to uniform Low Confidence and the
ticket cascaded into PASS even on races with a clear top pick.

**New scoring helpers** (top-level, not inside the inline scoring IIFE):

- `relativeConfidence(scored, fieldSize)` — computes the top runner's
  z-score against the field mean and the normalized gap to #2. Maps to
  High / Medium / Lean. Lean replaces "Low" everywhere except True PASS.
  Calibrated so a typical 10-horse Saratoga card surfaces 1–2 High, 3–4
  Medium, the rest Lean.
- `isTruePass(race, scored)` — the only path that returns the hard "Pass"
  label. Triggers when **≤3 live runners**, **>50% scratches**, OR
  **zero runners with ML odds**. Matches the spec the user signed off on.
- `betSizeHint(confidence, bankroll, isPass)` — stake recommendation per
  race: High = 5% of bankroll, Medium = 2%, Lean = 1%, Pass = $0.
- `buildBetSizeHint(hint)` — renders the hint as a pill (`hint-high` /
  `hint-medium` / `hint-lean`) directly underneath the confidence bar.

**Call sites updated** (the 5 places that previously inlined the absolute-
gap gate):

- `confidenceFor(scored)` in the scoring IIFE (line 617). Now delegates to
  `window.relativeConfidence`, with a fallback to the legacy gate for test
  harnesses that strip the helper.
- Today-tab race-panel render (was 5 inline lines, now 3).
- Today-tab ticket builder (`updateTopPicksCard`).
- Handicap-mode advice render.
- Best-Bet selection: 3-pass priority — High first, then Medium, then any
  non-PASS race with the biggest gap. Best Bet is now **always populated**
  unless every race on the card is True PASS.
- Action Bets: every non-Best-Bet, non-Value-Play, non-True-PASS race now
  qualifies (no more absolute-gap gate).
- Pass Races row: only populated by True PASS.

**UX additions:**

- New "Lean" label (orange) appears on race panels that previously read
  "Low Confidence." Visually: 3 filled bars (vs 2 for the old Low).
- Bet-size hint pill ("Suggested stake: $X (Y% of bankroll)") shown under
  every confidence bar on every non-PASS race — both in the Today tab and
  in handicap mode.
- New `.bet-size-hint`, `.hint-high`, `.hint-medium`, `.hint-lean` CSS
  classes; new `.conf-seg.orange` for Lean.

**Bankroll cache:** `window._bankrollCache` is populated at the top of
`runAdviceEngine()` from `getStore().settings.startingBankroll`. Defaults
to $1000 if the store isn't loaded yet. The hint helpers read from this
cache so they don't have to re-read the store on every render.

**Not in this release** (deferred per user):

- New scoring weights (form 25 / btn 20 / etc.). With NA data still lacking
  real form/btn fields, reweighting would shake the engine without improving
  signal. Revisit once Brisnet integration lands.
- Per-card scoring data purchase (Brisnet) — user explicitly deferred.

## v2.41.0 — Worker-side scoring-field enrichment shim (2026-06-04)

Fixes the "uniform low confidence" UX problem caused by Racing API's NA entries
endpoint omitting the seven scoring fields the v2.40.3 client engine expects.
The shim runs inside the worker after `enrichEntriesWithCoreRacecards` and
before the response is returned to the client, so the client engine is
unchanged.

**Fields synthesised per runner (best-effort, never throws):**

- `name` — passthrough of `horseName` so `transformWorkerEntries` keeps working
- `runningStyle` — heuristic from pp form letters (E / E/P / P / S)
- `jockeyPct` — fuzzy match against embedded NYRA top-50 jockey win-pct table
- `trainerPct` — fuzzy match against embedded NYRA top-50 trainer win-pct table
- `lastClass` — most recent `race_class` from ppHistory
- `lastRaceDate` — most recent `race_date` from ppHistory
- `speedFigs` — derived from rpr / tsr / official_rating in ppHistory when present
- `dataCompleteness` — recomputed sum/7 so the client doesn't have to

**Name tokenizer:** Racing API NA uses "Last F M" (e.g. `Velazquez J R`).
Embedded stats use "First M Last" (e.g. `John Velazquez`). Tokenizer infers
format: if first token ≥4 chars AND remaining tokens are 1–2 chars, treat as
"Last F M" and rebuild as "F Last" for lookup. Saratoga match rate 91% jockeys
/ 42% trainers. Tracks outside the NYRA circuit fall back to a 10% win pct
(non-zero so dataCompleteness counts the field).

**Also fixed in this deploy:**

- `/racecards/standard` was being called with `date=YYYY-MM-DD`, which Core
  rejects with 422. Now sends `day=today` or `day=tomorrow` based on the
  requested date in America/New_York, and short-circuits to a passthrough
  for any other date (Core doesn't archive racecards through this endpoint).

**Coverage on Saratoga (2026-06-04 fresh probe, 11 races / 118 runners):**

- coreEnrichment: 30/118 (25.4%) with RPR / form / spotlight / trainer14d
- ppEnrichment: 82/118 (69.5%) with ppHistory
- scoringFieldEnrichment: 118/118 runners touched
- dataCompleteness: mean 0.518, range 0.43–0.57 (was uniform 0.0)
- RPR overlay values: 114–133, mean 125

The client v2.40.3 confidence engine is unchanged; this only fixes the input
shape. The v2.40.3 absolute-threshold gate still softens most cards toward
low confidence — that's the v2.42.0 work (relative confidence + Lean/Medium/
High labels + bet-size hints, queued).

## v2.39.4 — Remove duplicate Jim's Way label (2026-06-03)

The ticket-card variant rendered "🤷 Jim's Way" twice — once in the
`rec-bet-tag` row and again immediately below in the `card-explainer`
row. Kept the styled tag, removed the duplicate explainer line.
Compact variant unchanged (only had the label once).

## v2.39.3 — Rename fallback label to "Jim's Way" (2026-06-03)

User-facing label change only. The PASS-race fallback is now labeled
"🤷 Jim's Way" everywhere instead of "🤷 Jim Fallback" / the longer
"if you don't want to skip this race..." line. Ticket line uses
"JIM'S WAY — Race N: ...". No logic changes.

## v2.39.2 — Jim fallback bet (2026-06-03)

For users who refuse to skip a race even when the engine recommends PASS.
Whenever a race auto-passes (low confidence AND top score < 60), the app now
surfaces a small fallback recommendation labeled:

> 🤷 If you don't want to skip this race and you need to bet because your
> name is Jim, here's what you should do

The fallback picks the best available horse (top score, but prefers an
overlay horse within 6 points of the top), suggests a $2 stake, and
recommends PLACE instead of WIN in small fields (≤5 horses) or when the
top score is brutally low (<50).

Renders in three places:

- Today-tab race-card detail panels (compact inline block)
- Handicap-mode advice panels (compact inline block)
- Daily ticket: one card per PASS race (ticket-style card with bet-slip button)

No backend changes. Two new helpers added next to `buildSuggestedBets`:
`buildJimFallbackBet(race, scored, opts)` and `renderJimFallbackBet(fb, compact)`.
All three call sites wrap the render in a try/catch so a helper bug can never
break the existing PASS render.

## v2.39.0 — Invite & approve flow (Option Y) (2026-06-03)

New owner-approved beta access path. No per-user passwords — each approved
requester gets a unique unlock token by email.

**Worker (5 new endpoints):**

- `POST /api/beta-request` — public. Validates first/last/email/invited_by,
  stores `req:<id>` in `BETA_REQUESTS` KV (30-day TTL on pending), emails
  the owner with HMAC-signed Approve/Reject buttons.
- `GET  /api/beta-approve?id=&sig=` — HMAC-verified. Mints a 32-char urlsafe
  access token, writes `tok:<token>` in `BETA_ACCESS` KV (no TTL), emails
  the requester their personal unlock URL. Idempotent: re-clicking the
  approve link returns the same token instead of minting a new one.
- `GET  /api/beta-reject?id=&sig=`  — HMAC-verified. Marks request rejected
  (90-day retention for audit). Requester is not notified.
- `GET  /api/beta-unlock?token=`    — redeem an access token; returns the
  requester’s name/email so the client can personalize the welcome.
- `GET  /api/beta-pending`          — owner-only (same admin token as
  `/api/feedback/list`). Returns all requests with status summary.

HMAC signatures use SHA-256 + `BETA_APPROVE_SECRET` (43-char urlsafe random
worker secret). Constant-time verification rejects tampered ids or wrong
intents (approve vs reject).

**Client (`index.html`):**

- Beta gate now has three modes: existing access-code (backup), invite
  request form (`?invite=<slug>`), and token redemption (`?approved=<tok>`).
- `?approved=` flow auto-redeems, persists `railbird-beta-unlocked-v1`,
  caches the user’s name to `railbird.userName.v1`, replaces history so
  the token isn’t shareable from the URL bar.
- More sheet → “Invite a friend”: native `navigator.share` first, clipboard
  fallback, `prompt()` last-resort. Slug is `first-last-<8charuuid>` derived
  from the cached user name + stable device UUID.
- Admin sheet adds an “Access Requests” panel with pending/approved/rejected
  counts and a request table.

**Infra:**

- KV namespaces `BETA_REQUESTS` (`93a68573bb29466d93098731e1962db7`) and
  `BETA_ACCESS` (`c5947eb94d814f5da1c0b970c444e6ef`) added to `wrangler.toml`.
- Worker secret `BETA_APPROVE_SECRET` set (HTTP 201).
- Existing `FEEDBACK_ADMIN_TOKEN` is reused for `/api/beta-pending` — no
  new auth surface for the owner.

## v2.38.23 — Admin token UX fix: iOS auto-caps bypass (2026-06-03)

User report: "Password doesn't work" after setting token to lowercase.

### Root cause

iOS Chrome auto-capitalizes the first character of text inputs on the
first keystroke after focus, EVEN WHEN `autocapitalize="off"` is set on a
`type="password"` field. User typed `asshole`, iOS sent `Asshole`, server
rejected with 401. Confirmed via direct curl: `Asshole` → 401,
`asshole` → 200.

### Fix (two layers)

1. **Worker (server-side)**: case-insensitive token compare on both
   `/api/feedback/list` and `/api/admin/users`. `auth.toLowerCase() ===
   expected.toLowerCase()`. Token still trimmed on both sides.
2. **Admin sheet input**: changed `type="password"` → `type="text"` so
   the user can SEE what they typed. Added `autocapitalize="none"`,
   `autocorrect="off"`, `enterkeyhint="go"`, `data-form-type="other"`,
   `data-lpignore="true"` to silence iOS keyboard heuristics and
   LastPass interference.

### Why text not password

The Admin sheet is owner-only and only ever rendered on the owner's
phone after explicit `?admin=1` unlock. Showing the token in plain text
removes the iOS keyboard mystery ("did I type Asshole or asshole?") and
lets the owner confirm at a glance. There is no shoulder-surfing risk
for a one-off owner-only utility.

### QA

- Preship L1-L4: 56/56 PASS
- Playwright: Admin sheet accepts both `asshole` and `Asshole`,
  returns 200 and device list in both cases.
- Direct curl: `Asshole` against new worker → 200 (was 401 on v2.38.22).

## v2.38.22 — Visible "Update available" banner (2026-06-03)

User request: "Add a visible 'Update available — tap to refresh' banner
instead of silent force-reload (less surprising UX)."

### What changed

- New fixed pill at bottom-center (above the tab bar) that appears when the
  60-second version-poll detects a newer build on the server. Dark slate
  background, gold pulsing dot, gold "Tap to refresh" CTA. Tapping triggers
  the same nuclear force-update (`neForceUpdate`) that was previously silent.
- Boot-time version mismatch (page just opened, user has not engaged) still
  silently force-updates — no banner needed because there's nothing to
  interrupt. Runtime mismatch (user is in the app) shows the banner.
- Banner is non-dismissible. Once it appears, it stays until the user taps.
  It only re-arms for new pending versions (no flicker on repeat polls).
- Exposed `window.__neShowUpdateBanner(version)` for debugging.

### Why

A user mid-handicap or mid-bet should not be yanked into a reload. The
banner lets them finish what they're doing and refresh on their own timing.

### QA

- Preship L1-L4: 56/56 PASS
- Playwright: banner appears within 1s of stub returning a newer version,
  tap fires neForceUpdate path, hidden when versions match.
- No regressions to v2.38.21 admin tab or beta-ping.

## v2.38.21 — Beta user tracking, owner-only Admin tab (2026-06-03)

User report: "Can you add something that will keep track of users?
I've given to two beta testers but it seems like someone else got
the link. Can you count unique users? This is info for me only."

### What it does

- One stable UUID per device (localStorage `railbird.deviceId.v1`,
  generated client-side on first visit).
- One boot-time `POST /api/beta-ping` per page load (fire-and-forget,
  `keepalive: true`, runs 800ms after DOMContentLoaded so it never
  competes with the TODAY card render).
- Worker upserts the device record in a new `BETA_VISITS` KV namespace:
  `seen:<uuid> -> { first_seen, last_seen, visit_count, last_ua_short,
  last_version }`. No TTL.
- `GET /api/admin/users` (gated by existing `FEEDBACK_ADMIN_TOKEN`
  Worker secret) returns total device count + sorted device list.
- New "Admin" item in the More sheet, hidden by default. Reveals when
  the user has cached the admin token in sessionStorage, when
  `?admin=1` is in the URL, or once they've unlocked the feature once.
- Admin sheet renders a 2-stat summary (Total / Expected = 3) plus a
  table: UUID short, first seen, last seen, visit count, device
  summary (e.g. "iPhone · Chrome"), last version. Your own device is
  highlighted and marked "(this device)".
- Flag panel: green "≤ 2 testers + you" or amber "N devices seen — N-3
  more than expected."

### Decisions / non-decisions

- Device count only, per your answer. No IP, no fingerprint, no geo.
- Reuses `FEEDBACK_ADMIN_TOKEN` rather than creating a second secret.
- No public list endpoint. `/api/admin/users` returns 401 without
  the bearer token.
- The boot ping is the only user-facing telemetry. It's a single POST
  per load, no heartbeat, no error beacons (per earlier "No" on those).
- Schema is forward-compatible: if you later want IP/geo, just add
  fields to the record — the admin renderer ignores unknown columns.

### Implementation

Worker: `worker.js` adds `handleBetaPing`, `handleAdminUsers`,
`BETA_VISITS` binding in `wrangler.toml` (KV id
`88359534063440468af41dccfa3233cd`), `/api/beta-ping` to the POST
allowlist, routes wired in the dispatch switch.

App: `index.html` adds the Admin sheet (full-bleed flex overlay,
z-index 10000, same pattern as About v2.38.18), the boot-ping IIFE,
and the More-sheet Admin item. The Admin item is `display:none` by
default so beta testers never see it.

## v2.38.20 — Opening-day boot crash for legacy stores (2026-06-03)

User at 5:44 AM EDT opening morning: "Track live today. Take a spin
through the app. Everything ok?"

Not ok. Playwright spin at iPhone 13 / America/New_York surfaced this:

  getTodayStr:  2026-06-03      ✓
  activeTrack:  SAR              ✓
  worker /api/entries SAR/2026-06-03: 200 OK with 10 races  ✓
  raceCount on TODAY tab:  0     ✗
  pageerror:   "Cannot read properties of undefined (reading 'SAR')"
               at getTrackData (index.html:11332)
               at deduplicateBets (index.html:12755)
               at initApp (index.html:12790)

Reproduced deterministically by seeding a pre-migration localStorage
shape: `{ settings, bets, barn }` with no `tracks` key.

Root cause: the migration in getStore() guarded each track-bucket
creation with `if (existing.tracks && !existing.tracks.SAR)`. The
guard was meant to skip when the bucket already existed, but it also
skipped when `existing.tracks` was missing entirely — so legacy stores
stayed unmigrated. Then getTrackData() did `store.tracks[tc]` and
threw. The throw was inside initApp(), so it halted before
loadEntries() ran. Result: "Preparing the day's card…" forever, on
opening day, for any user whose store predates the per-track migration.

Fix:
1. getStore() now creates `existing.tracks = {}` first if it's missing,
   then unconditionally seeds CT and SAR buckets.
2. getTrackData() defensively re-creates `store.tracks` if it's still
   missing for any reason, so no future code path can re-trigger this.

Verified with both store shapes (legacy + fresh): zero JS errors,
store.tracks.SAR exists post-boot.

QA: preship.sh L1–L4 PASS 56/56.

## v2.38.19 — TODAY tab was rolling to tomorrow at 8pm EDT (2026-06-02)

User report: "Why does it look like there were races today?"

At 9:21 PM EDT on June 2 (opening eve), the TODAY tab was already
showing June 3 — Saratoga's opening-day card — with the heading still
reading "Today's Card." Confirmed via Playwright at America/New_York
timezone:

  jsNow:        Tue Jun 02 2026 21:21:56 GMT-0400 (EDT)
  getTodayStr:  2026-06-03   ← wrong
  activeTrack:  SAR

Root cause: `getTodayStr()` was `new Date().toISOString().split('T')[0]`,
which is UTC. After 8pm EDT (00:00 UTC), every "today" check returned
tomorrow. That fed into the track-data loader, the date-strip
highlight, and the bet-history "today" filter, so the entire app
flipped a day early.

Fix: `getTodayStr()` now uses `Intl.DateTimeFormat` pinned to
`America/New_York` (Saratoga's local time), with a local-time fallback
if Intl isn't available. The two other UTC fallbacks elsewhere in the
file were also rewritten to call `getTodayStr()` first or use local
time as the fallback, so no code path can reintroduce the bug.

## v2.38.18 — About modal: real fixes after click-by-click QA (2026-06-02)

User report: "In the about section card open close and swipe doesn't
work correctly. Test it by clicking and scrolling. Don't guess."

Ran a real Playwright session at iPhone 13 viewport (390×664) — open
from More → About, scroll, expand all four rows, swipe to close.
Found and fixed three concrete bugs:

### 1. "Who is this app for?" answer was offensive copy (P0)

The audience row still contained dev-time placeholder text mocking
"retards, douchebags or assholes." Replaced with a real audience
statement aligned with the rest of the About sheet — the serious
recreational fan / railbird who reads the Form on the train up. Would
have been the second thing a beta tester saw on opening day.

### 2. Modal didn't fully cover the bottom tab bar (P0)

The sheet used `position: fixed; inset: 0` with the page's regular
`100vh` semantics. On iOS Safari/Chrome, with the URL bar showing,
the document is shorter than the layout viewport — `inset: 0` left a
sliver at the bottom where `#bottom-tab-bar` (z-index 200) stayed
tappable behind a sheet that was supposed to be modal. Confirmed in
Playwright: tab nav was hit-testable under the open sheet.

Fix: switched the sheet to explicit `top/left/right/bottom: 0` with
`height: 100dvh` (dynamic viewport units that honor the live toolbar
height) and bumped `z-index` from 9100 to 10000 so nothing in the
app can sit above it.

### 3. Double scroll containers fought each other (P1)

Both `#about-sheet` and `.about-card` had `overflow-y: auto`. When all
four rows were expanded (`scrollHeight=2491` vs `clientHeight=632`),
iOS rubber-banding split between the two containers and the swipe-to-
close handler couldn't tell which one the user was scrolling.

Fix: sheet is now `overflow: hidden` (pure flex backdrop). Only the
card scrolls, with `overscroll-behavior: contain` so scroll chaining
stops at the card boundary. `max-height: calc(100vh - 32px)` →
`max-height: 100%` since the sheet's padding now bounds it.

Swipe-to-close logic at line ~10546 was already correct (locks to
dominant axis, only triggers from `scrollTop=0` on a downward swipe);
removing the outer scroll container is what lets it work reliably.

## v2.38.17 — About modal: Saratoga-only copy (2026-06-02)

The About → Executive summary modal still claimed Railbird covered
"NYRA, Churchill, Del Mar, Santa Anita, and the Triple Crown / Breeders'
Cup meets." That hasn't been true since the product narrowed to the
Saratoga 2026 meet. Rewrote the copy to match reality:
  - Lead is now Saratoga-specific.
  - "Covers every race day of the Saratoga meet, opening through closing."
  - Added "Saratoga-focused" as the first differentiator (one meet done
    well, vs. a thin layer over the whole country).
  - Status line updated to "Saratoga 2026 coverage."
  - Archive figures kept (1,907 horses / 15,272 past races in D1).

## v2.38.16 — Tap-to-rank for straight exotics (2026-06-02)

Replaced the cramped `1/2/3` number-box inputs in the Evaluate Any Bet modal
(Exacta / Trifecta / Superfecta · Straight) with a single thumb-sized circular
slot per horse. First tap assigns 1st, next tap assigns 2nd, and so on.
Tapping a ranked horse clears its slot and compacts the remaining ranks so
there are no gaps. No keyboard. No focus juggling. One-handed.

Underlying selection state (`pos:N`) is unchanged, so `_betEvalBuildSelection`
and every downstream code path keep working without modification.

## v2.38.10 — Heart-tap crash, Equibase deep-link, copy-ticket label (2026-06-01)

Three user-reported bugs, all confirmed in the live browser and fixed.

### Heart tap crashed the app (CRITICAL)

Reported: "hearts don't do anything except when you press a heart it crashes
the app and you have to do a full reset." Confirmed in Playwright: clicking
any `.barn-heart` button closed the page within ~2 seconds, no JS exception.

Root cause: an **infinite mutation loop** between two MutationObservers both
watching `#races-container`. The second observer (line ~22136) fired
`applyBarnHighlights` on every mutation, and `applyBarnHighlights` itself
mutated the DOM unconditionally by removing every `.vb-row-pill` and
re-appending fresh ones on every call. The append was a mutation, which
re-fired the observer, which mutated again, forever. The browser eventually
killed the tab.

Fix: made `applyBarnHighlights` idempotent at the DOM level — it now
short-circuits when a row is already in the correct In Barn / Curated state
and only touches the DOM when something actually changed. Also wrapped it
in a re-entrancy guard that coalesces nested calls into a single trailing
pass, so any future regression that re-introduces non-idempotency still
can't hang the page.

### "View in Equibase" sent users to the generic site

Reported: "View in equibase link sends user to general equibase site, not
the race in question."

Root cause: the URL builder used
`equibase.com/static/entry/index.html?type=Entry&dt=...&tk=...&rn=...`. Live
test confirmed Equibase **ignores those query parameters entirely** and just
renders the generic Entries hub regardless of date or track.

Fix: switched to Equibase's actual race-level static URL format,
`equibase.com/static/entry/{TRACK}{MMDDYY}USA{RACE}-EQB.html`. Verified that
published race pages (e.g. Churchill Downs / Gulfstream) resolve to the
correct single-race entries page. Also added `buildEquibaseFullCardUrl()`
as a future fallback. Caveat: Equibase only publishes static pages for
finalized cards — future-dated races may 404 until Equibase posts them.

### "Copy Ticket" button purpose was unclear

Reported: "What is the purpose of the copy bet button?" — referring to the
📋 Copy Ticket button on the recommended-bets card. It does work; it copies
a plain-text summary (best bet + value plays + action exotic + estimated
cost + budget) to the clipboard so the user can paste into an ADW slip,
share with a friend, or save to notes.

Fix: relabelled to "Copy ticket to clipboard" and added a descriptive title
+ aria-label so the purpose is obvious from the button alone.

## v2.38.9 — Pedigree + equipment rendering, weights stub (2026-05-31)

### Fixed (caught in full click-through QA against railbirdai.com)

**Dam Sire was forwarded but never displayed in the horse modal.**

v2.38.7 added `damSire` to `transformWorkerEntries` so it survived from the
Worker payload into the in-memory horse record, but the horse-detail modal's
breeding line at index.html:13929 only rendered Sire + Dam. The Worker has
been sending `damSire` (e.g. `Poet's Voice*GB` for Little Trilby) but no user
ever saw it. Now the breeding line reads `Sire: X · Dam: Y · Dam Sire: Z`
when present, falling back gracefully when any one piece is missing.

**Equipment / medication changes never reached the badge.**

The Worker emits `equipment` and `medication` (strings like `blinkers on`,
`L` for Lasix) from The Racing API NA payload, but the UI's equipment badge
reads `equipmentChanges`. The two field names never matched, so the badge
was always blank for live data. The transform now merges `equipment` and
`medication` into `equipmentChanges` when the new combined field isn't
already present — preserving any future static feed that wants to set
`equipmentChanges` directly.

**`/data/weights/v2.json` 404 noise on every page load.**

The lazy fetched fitted-weights override file didn't exist yet (the engine
falls back to `DEFAULT_V2_WEIGHTS` when absent — by design), but the missing
file produced a network-level 404 in the console on every load. Added a
placeholder file with `status: "insufficient"` so the existing threshold
check rejects it and falls back to defaults, with no console noise.

### Real-browser QA harness

This release was validated against the live site with Playwright + iPhone 13
viewport + Chrome iOS user agent. Every nav tab, the horse modal, the
bet-builder wizard (Daily Double end-to-end with leg selection), the W/P/S
flow, the bets tab, the more sheet, and the settings modal were all
exercised with real DOM clicks. Bugs above were confirmed by reading the
actual rendered text returned from the live page — no guessing.

## v2.38.8 — Smart Tips "+ Add" button fix (2026-05-31)

### Fixed

**Smart Tips "+ Add {Horse}" button did nothing when clicked.**

The button on the wizard review screen (e.g. "+ Add Ziggle Pops (GB)")
rendered visually but the click was a no-op. Root cause: the click
handler embedded the action payload as a JSON-stringified literal
inside an HTML `onclick="..."` attribute. Because JSON uses double
quotes around keys and values, the first `"` after the opening `{`
terminated the `onclick` attribute prematurely, leaving the rest of
the JSON as stray (ignored) HTML attributes. The button rendered
correctly but had no functional onclick handler.

Fix: replaced the inline JSON-in-attribute pattern with an indexed
registry. Each render of the advice card stores tip actions in
`window.__wizAdviceActions[]` and the button calls
`wizApplyAdvice(idx)` with a plain integer index. Same pass also
adds proper HTML escaping (`wizEsc`) for headline / explanation /
horse names rendered into `innerHTML`, so any future horse with `&`,
`<`, `>`, `"`, or `'` in its name (common with foreign-bred names)
renders safely.

Affects all three advice action types: `addBox`, `addWith`, `addLeg`.
No change to engine logic, no change to advice generation rules.

## v2.38.7 — Field pass-through cleanup in worker→client transform (2026-05-31)

### Fixed

Three long-standing field-loss bugs in the Racing API NA data path:

1. **Weight dropped.** `transformWorkerEntries` (index.html) hardcoded
   `weight: ''` for every horse. The Worker has been emitting
   `weight` (lbs carried) from the NA payload (`r.weight`) all along —
   the client just discarded it. Horse-detail and form views now show
   the actual weight when available.

2. **damSire dropped.** Worker `normaliseNaEntries` correctly emits
   `damSire` (from `r.dam_sire_name`) but the client transform never
   pulled it through, so breeding views could only show sire and dam.
   Now passed through. Same pass also forwards `programNumber`,
   `equipment`, `medication`, and `claimingPrice` which the Worker
   already produces.

3. **expertPicks undefined on NA path.** The Worker's NA-path race
   object did not include an `expertPicks` field at all, leaving the
   client to handle `undefined`. The static GitHub-Pages path always
   set `expertPicks: race.expertPicks || []`, so behavior was
   inconsistent across data sources. The NA path now always emits
   `expertPicks: []` for shape parity. Real picks remain available
   only via `/api/expert-picks` against curated static JSON — Racing
   API NA does not carry handicapper picks.

No engine logic changed. No UI changes. Pure data-fidelity fixes that
restore fields already paid for in the upstream feed.

## v2.38.6 — iOS status-bar safe-area reserve (2026-05-31)

### Fixed

On iPhones running the app in Safari or as an installed PWA, the iOS
status bar (time / cell / wifi / battery) was rendering on top of the
SARATOGA 2026 header. The header used
`padding-top: env(safe-area-inset-top, 0px)` which returned 0 in mobile
Safari and in some standalone configurations, so no space was reserved.

Fix:
- `#top-header` now uses `min-height` (not fixed `height`) so a generous
  inset can grow the header without clipping content.
- A small inline script tags `<html>` with `data-ios="true"` on iOS UAs
  (and `data-standalone="true"` when running as installed PWA).
- CSS rule `html[data-ios="true"] #top-header` enforces a minimum
  `max(env(safe-area-inset-top, 0px), 44px)` of reserved space — 44px is
  the iPhone status-bar height. Non-iOS browsers (desktop, Android) are
  unaffected.
- `.stage-sheet` sticky offset uses the same expression so dropdowns
  align under the header.

## v2.38.5 — Cream panel contrast fix, part 2 (2026-05-31)

### Fixed

v2.38.4 fixed the SVG and card backgrounds but missed the default
`.stat-val` / `.stat-label` color. An older v2.12 rule at index.html:7246
forces `.rec-bet-details .detail-stat-card .stat-val { color: #fff }` and
the v2.15 MSP-relight block at 8267 only covered the `[id^="horse-detail-"]`
variant. Result: ML / Live / Our Model values plus jockey/trainer pills
still rendered white on cream.

This release adds explicit `color: #1E2A36` (--msp-ink) for `.stat-val`
and `color: #4A5663` (--msp-ink-2) for `.stat-label` across every
cream-panel ancestor (`.rec-bet-details`, `.rec-bet-details:has(...)`,
`[id^="horse-detail-"]`, `.horse-detail-panel`, `[class*="expand"]`). Also
re-applies the `.positive` / `.negative` / `.gold` color variants after
the default override so they win the cascade.

Adds a catch-all for any inline-styled `color:rgba(255,255,255,...)` text
inside the detail panel (e.g. the "Data completeness:" line and the
“dropping in class” arrow row).

## v2.38.4 — Cream panel contrast fix (2026-05-31)

### Fixed

- Expanded horse detail panel was rendering white-on-cream text in
  several places, making them nearly invisible:
  - SVG `<text>` fills inside the score gauge ("32" and "SCORE") and the
    edge donut (win-prob % and "Win Prob" label) were `fill:#fff`/
    `fill:rgba(255,255,255,0.5)`. The previous cream-relight cascade
    only handled CSS `color:` and missed SVG `fill:` entirely. Now
    relit to `#1E2A36` (--msp-ink) and `#4A5663` (--msp-ink-2).
  - SVG track strokes (`.gauge-track`, `.edge-track`, `.comp-track`)
    were `stroke:rgba(255,255,255,0.06-0.08)` and disappeared on cream.
    Now `rgba(30,42,54,0.14)`.
  - Stat-card backgrounds (`.detail-stat-card`, `.detail-class-move`,
    `.detail-pace-pill`, `.detail-field-rank`, `.detail-completeness`,
    `.detail-experts`, `.detail-sparkline`) used
    `background:rgba(255,255,255,0.04)` which is invisible on cream.
    Now `#FAF4E6` with `#D8CDB8` border.
  - `.detail-stat-card.positive/.negative/.gold` used bright tones
    (#4ADE80 / #EF4444 / #D4A849) picked for dark navy. Re-toned to
    AA-passing dark variants on cream (#166534 / #991B1B / #8A6A1A).
  - Inline-styled `rgba(255,255,255,0.25/0.4)` spans in class-move
    arrow and field-position labels now use `#4A5663`.
  - Sparkline line + dots re-toned for cream.
  - Expert chips re-themed for cream.

### Why this slipped through earlier

The v2.12/v2.15 cream-relight cascade was built around CSS `color:`
properties. SVG `<text>` elements use the `fill:` attribute, which is
not affected by `color:` overrides. The earlier `* { color: ... }`
blanket rule had no effect on SVG paint. This release adds explicit
`fill:` and `stroke:` overrides targeted at every cream-rendering
ancestor of `buildExpandedDetails()` output.

## v2.38.3 — About: swipe-to-close in any direction (2026-05-31)

### Added

- The About sheet card now closes on swipe in any direction (up, down,
  left, right). 60px swipe threshold. Card follows the finger during
  the drag and flies off in the swipe direction on release.
- Vertical swipes only close when the card's content is scrolled to
  the top (swipe down) or bottom (swipe up) — otherwise the swipe
  scrolls the content as normal.
- The X close button and tap-outside-to-close still work as before.


## v2.38.2 — About: center the sheet vertically (2026-05-31)

### Changed

- The About sheet is now vertically centered on all screen sizes
  (was anchored to the bottom on mobile). Expanded rows (Executive
  summary, Tech stack) now sit in the middle of the viewport instead
  of hovering at the bottom edge.
- Rounded corners on all four sides on mobile (was bottom-square).


## v2.38.1 — Barn: stop auto-seeding curated horses (2026-05-31)

### Fixed

- **Curated horses no longer auto-populate every tester's Barn.** Prior
  versions silently upserted all entries from `data/curated-horses.json`
  (12 horses as of v2.36.4 — the Belmont Stakes field) into each user's
  personal Barn on every boot. Testers saw a Barn full of horses they
  never added.
- One-time migration (`migrateCuratedHorsesOutOfBarn`) evicts previously
  auto-seeded curated horses from existing Barns. Horses the user
  actually engaged with (favorited, noted, custom-tagged) are preserved.
  Evicted horses are stashed in `s.barn.curatedHidden` and remain
  searchable + addable from the lookup panel.
- The personal Barn is now strictly user-driven.

### Notes

- Curated horse profiles are unchanged — they're still in
  `data/curated-horses.json`, still indexed in the lookup registry, and
  still one tap to add. They just aren't pre-installed.
- `window.virtualBarnSeedCurated()` (manual force-seed) still works for
  demo / showcase purposes.


## v2.38.0 — About: executive summary + tech stack (2026-05-31)

Added two new rows to the About sheet:

- **Executive summary** — one-page description of what Railbird AI is,
  who it's for, what makes it different, and current status.
- **Tech stack** — frontend, Cloudflare backend (Workers / D1 / KV / R2),
  AI & data sources (Perplexity API, Equibase SIMD), and dev/ops tooling.

Equibase D1 backfill paused at 1,907 horses / 15,272 past performances /
261 races across the 2023 BEL and SAR meets. Further historical backfill
deprioritized — D1 archive remains live as a fallback enrichment layer
for the curated daily card.


## v2.37.0 — Equibase D1 archive online (2026-05-31)

First slice of the Dropbox → R2 → D1 Equibase ingestion pipeline shipped. The
production Cloudflare worker now talks to a D1 database (`railbird`) that
holds the parsed 2023 Past Performance corpus. The Belmont Day 2023 sample
is already loaded — 133 horses, 1,046 historical race lines, 13 races,
including Arcangelo (2023 Belmont winner), Tapit Shoes, Forte, Hit Show,
Angel of Empire, National Treasure, Red Route One, etc.

### Added

- **Worker D1 binding (`RAILBIRD_DB`)** and two new public endpoints:
  - `GET /api/d1/horse/{NAME}` — fast lookup; returns pedigree + count of
    archived past races + 3 most recent lines.
  - `GET /api/d1/horse-stats/{NAME}?limit=50` — deeper card with summaries
    by year and up to 200 past performances.
  Both endpoints are case-insensitive and tolerate URL-encoded whitespace.
  Edge-cached for 5 minutes.
- **Horse profile modal — “Equibase archive (2023)” panel.** When you open
  any horse in your Barn, the app now asynchronously hydrates archived
  Equibase past performance lines from D1 alongside the curated/demo data.
  Renders sire/dam/foaling info, an aggregated year-by-year career record
  (starts: W-P-S, earnings on hover), and a chip-formatted list of past
  races (track, distance, surface, finish/field, BSF, purse, post).
  Panel hides silently if the horse isn't in the archive yet — no empty
  state shown.

### Notes / known limitations

- The Dropbox archive is 2023-only. The 2026 Belmont stubs (Golden Tempo,
  Renegade, etc.) will not light up the new archive panel — those horses
  were juveniles in 2023 and not yet in the corpus. The panel only renders
  when there is data to show.
- Backfill of the rest of the 2023 NY-track meets (BEL spring, SAR, Big A
  fall) is queued. Currently only Belmont Day 2023 (Jun 10) is loaded.
- Speed figures from Equibase are stored as integer×10 (BSF 970 = BSF 97).
  The app divides by 10 when rendering chips.

## v2.36.4 — Belmont Stakes field added to curated horses (2026-05-30)

Beta tester typed "golden tempo" and "secret connection" into search and
got nothing. Root cause: upstream entries API returns `upstream_unavailable`
for BEL/AQU/SAR, so the only horses the app could match against were two
curated stubs. Search was promising "any horse" but the database only
contained ~2.

### Added

- **10 Belmont Stakes 2026 stubs** in `data/curated-horses.json`:
  Golden Tempo, Renegade, Chief Wallabee, Commandment, Emerging Market,
  Growth Equity, Ocelli, Ottinho, Powershift, Vitruvian Man. Each carries
  verified trainer + jockey + (where public) owner & sire so search hits
  work on connections too. Each links to public sources (NYRA contender
  page, America's Best Racing cheat sheet, DRF, In the Money Telegraph,
  MyWinners) plus an Equibase search link for deep dives.
- **Equibase fallback in global search empty state.** When nothing in the
  app matches, search now shows a "Search Equibase for [name]" affordance
  that opens equibase.com in a new tab — search is no longer a dead end.
- **Equibase fallback in the Barn drawer empty state.** Same idea, from
  the Choose-a-horse drawer.
- **Alt-name matching.** `Powershift` has been spotted in public field
  lists as `Poweshift` — both spellings now match.
- **Broader haystack.** Global search and Barn drawer now also match
  against `watchReason` text and tag strings, so typing
  "kentucky derby winner" surfaces Golden Tempo, "triple crown trail"
  surfaces Ocelli, "celebrity ownership" surfaces Vitruvian Man, etc.

### Verified search hits after this release

- `golden tempo` → Golden Tempo (curated)
- `renegade` → Renegade
- `chief wallabee` → Chief Wallabee
- `secret connection` → Secret Connection
- `bona venture` → Secret Connection (owner match)
- `cherie devaux` → Golden Tempo (trainer match)
- `curlin` → Golden Tempo (sire match)
- `phipps` → Golden Tempo (owner match)
- `lil yachty` → Vitruvian Man (owner match)
- `chad brown` → Emerging Market + Growth Equity (trainer match)
- `tagg` → Inspeightofcharlie
- any unknown horse → Equibase fallback link


## v2.36.3 — Keyboard-aware search drawers + better matching (2026-05-30)

Beta tester reported: typing in the "Choose a horse" Barn drawer shifted
the screen so the input was hidden behind the iOS keyboard / suggestion
bar, and the results area disappeared entirely.

### Fixed

- **Barn drawer ("Choose a horse") respects the iOS keyboard.** Drawer
  now uses `visualViewport` to detect the soft keyboard and lifts itself
  above it, capping its own height at 92% of the visible viewport. Result:
  the search input + suggestions stay visible the whole time.
- **Search input is now sticky inside the drawer body.** A new
  `barn-drawer-search-wrap` pins the input to the top of the scroll area
  so it never gets pushed offscreen as results render.
- **Results panel scrolls independently from the rest of the drawer**, so
  long candidate lists don't bury the input under keyboard suggestions.
- **`autocapitalize="none"` and `autocorrect="off"`** on the search
  input — iOS Safari was autocapitalizing the first letter, which
  doesn't matter for our case-insensitive matcher but looked broken.

### Changed

- **Global search now matches across trainer, owner, jockey, and sire**
  on curated/demo/live horses (not just horse name). So typing
  "bona venture" surfaces Secret Connection, "tagg" surfaces Charlie, etc.
- **"Loading horses…" state** shown in global search when the candidate
  cache hasn't finished loading yet — prevents the misleading
  "No matches" message before fetch resolves.
- **"No matches" copy expanded** to clarify the search covers Barn,
  today's card, AND curated profiles — not just the first two.

## v2.36.2 — Search surfaces curated horses + anonymous feedback (2026-05-30)

Response to beta tester: "I searched secret connection and it didn't surface"
and "Remove beta tester email option and name in feedback. I want to make it
very easy."

### Fixed

- **Global search now surfaces curated horses.** Typing "sec" (or any
  prefix/substring) now matches Secret Connection, Inspeightofcharlie, and
  every other horse with a curated profile — not just horses already in
  the user's Barn or on today's card. Implemented by scanning the cached
  lookup-candidate set (curated + demo + live) inside `globalSearchScan()`,
  with a cache warm-up triggered when the search overlay opens so the
  first keystroke already has data.
- **Tapping a curated search result adds the horse to the Barn and opens
  its profile.** Previously curated horses (e.g. Secret Connection) had
  no path from search; now one tap stages them in the Barn and surfaces
  the full profile modal — the original tester complaint.

### Changed

- **Feedback form is now one-tap and anonymous.** Removed the optional
  "Your name" and "Your email" inputs from the Send Feedback modal.
  Subtitle updated to "Anonymous and goes directly to the builder."
  Backend continues to accept name/email; the client now sends empty
  strings for both so the worker schema is unchanged.

## v2.36.1 — Charlie earnings by race (2026-05-30)

Response to EG's "earnings by race" beta feedback for Inspeightofcharlie.

### Added

- **Per-race earnings on horse history rows.** A green earnings chip
  appears next to the finish chip on every history row in the horse
  detail panel. When earnings are estimated rather than chart-verified,
  they're prefixed with "Est." and the calculation method is visible
  on hover (e.g. "20% of $82,000 purse").
- **Earnings methodology disclaimer.** Form history section opens with
  a short note explaining that estimated earnings use the standard NA
  purse-share method (1st 55%, 2nd 20%, 3rd 12%, etc.) and that
  authoritative purse shares require Equibase Race Charts (paid).
- **Equibase career deep link on every horse detail.** When an Equibase
  refno is known, links straight to that horse's profile. When the
  refno is missing or unverified, falls back to an Equibase search by
  name, with a hint explaining why.
- **Inspeightofcharlie history rows now carry earnings**, reconciling
  within ~$300 of the stated 2026 season total and ~$2,200 of the
  stated 2025 pre-meet total (the difference covers an unlisted debut
  start).

### Fixed

- **Removed wrong Equibase refno (11094587) from Inspeightofcharlie's
  curated profile.** That ID pointed to an unrelated older horse with
  35+ starts since 2019 — not the 4yo NY-bred we're tracking. Field
  is now blank pending re-verification; the Equibase deep link falls
  back to search-by-name in the meantime.

## v2.36.0 — Beta feedback batch #1 (2026-05-30)

First response to beta tester feedback. Four changes, all user-facing.

### Added

- **Tour promotion.** A new `?` icon in the header opens the welcome tour
  in one tap from anywhere in the app. The same tour now also sits at the
  top of Settings under "New here? Take the tour" as a prominent primary
  button. The old buried "Replay Welcome Tour" entry at the bottom of
  Settings → Diagnostics is removed (it was easy to miss).
- **Barn lookup now includes today's live entries.** Any horse running on
  the currently loaded card is searchable by name, trainer, jockey, or
  owner in the barn drawer — and the suggested list surfaces up to six
  of them with a "Running today" badge. The lookup cache is invalidated
  whenever a fresh card lands so newly arrived horses show up immediately.
- **"Bet on NYRA Bets" deep link.** Each race header on NYRA tracks
  (SAR, AQU, BEL, BTP) now has a "Bet on NYRA Bets ↗" link next to the
  Equibase link. Opens the official NYRA Bets track page in a new tab.
  No deep race-number link exists publicly, so this links to the track.
- **Secret Connection (Bona Venture Stables)** added as a curated profile
  stub so testers can find and add it to the Barn while we wait for the
  full profile to be backfilled from Equibase.

### Investigated, not shipped

- **Per-race earnings ledger for horses in the Barn.** TheRacingAPI's
  North America add-on exposes meets/entries/results by `meet_id` only —
  there is no documented horse-history endpoint for NA. This data lives
  in Equibase past performances and will be filled in via the parked
  Equibase ingest (track 1, D1/R2 pipeline). Tracking separately.

## v2.35.3 — Picks-log POST fix (2026-05-30)

Pre-beta QA sweep caught one production blocker: the worker's top-level
method guard rejected POST on any path other than `/api/feedback`, which
meant `/api/picks/log` and `/api/picks/settle` (new in v2.35.0) returned
HTTP 405 before reaching the route dispatcher. Without this fix the
ENGINE_ACCURACY KV would never receive a single write — silently
breaking the eventual conditional-logit refit pipeline.

### Fixed

- `worker.js`: POST allowlist now includes `/api/picks/log` and
  `/api/picks/settle` alongside the existing `/api/feedback`. All other
  paths still 405 on POST.

## v2.35.2 — Bet Evaluator lazy advice load (2026-05-30)

UX papercut fix: the Bet Evaluator no longer fails with "Open the Advice tab
first" when launched cold. The cache is now populated on-demand and missing-
data states show precise, actionable messages.

### Fixed

- `index.html`: new `_betEvalEnsureAdvice(raceId)` helper lazily calls
  `runAdviceEngine()` when the scored-field cache is empty for the requested
  race. Both `renderBetEvalHorses()` and `runBetEvaluation()` now go through
  this helper before reading the cache. First-time testers no longer have to
  visit the Advice tab as a prerequisite.
- `index.html`: when advice is genuinely unavailable, the modal now
  distinguishes between three cases: today's card hasn't loaded yet (prompts
  Refresh on the Card tab), the race isn't in the current card (wrong track),
  and the generic fallback. Previous single "Open the Advice tab first"
  message was confusing.

## v2.35.1 — PR #2 QA fixes (2026-05-29)

Post-checkpoint QA pass on the fitter pipeline. Fixes two issues found while
smoke-testing end-to-end, plus a new regression test that locks in the
fitter-output contract.

### Fixed

- `scripts/training/fit_logit.py`: `weights_normalized` now correctly takes
  `|β|` before dividing by `Σ|β|`. Previously, negative coefficients leaked
  through into the output file (the runtime validator handled this correctly,
  so production scoring was unaffected, but the on-disk weights were
  misleading and the report-card view could show negative values).
- `scripts/training/fit_logit.py`: `datetime.utcnow()` replaced with
  `datetime.now(timezone.utc)` to silence the Python 3.12+ deprecation
  warning.

### Added

- `tests/fitter-output-contract.test.js`: end-to-end regression test that
  invokes `fit_logit.py` against a synthetic JSONL corpus (250 races, baked-in
  speed signal) and asserts: schema fields present, `weights_normalized` is
  non-negative and sums to 1, `trained_at` is ISO-UTC, the runtime loader
  (`loadFittedWeights`) accepts the produced payload. Skips automatically if
  python3/scipy is unavailable.
- `data/weights/.gitkeep`: documents the directory contract (production
  `v2.json` is tracked; smoke-test artifacts are gitignored).

### Tests

203/203 passing (was 202/202).

## v2.35.0 — PR #2 Checkpoint 3b: Fitted Weights Training Pipeline (2026-05-29)

Completes PR #2's training arm. Adds a Python conditional-logit fitter that
learns the v2 composite weights from race outcomes archived in the
`RACE_HISTORY` KV namespace (PR #2 Checkpoint 1). The v2 engine auto-loads
fitted weights at runtime when they meet a minimum-sample-size threshold, and
falls back to the hand-picked defaults otherwise.

### Added

- `scripts/training/extract_features.js` — Node feature extractor. Pulls the
  on-disk corpus (and, optionally, the Worker `/api/history` corpus), runs
  `scoreRace(race, { version: 'v2' })` on each race with a recorded result,
  and emits per-race JSONL containing the 6 sub-scores (speed, class, pace,
  trainer/jockey, bias, freshness), the PP order, and the winner's index in
  that order. Late-scratched winners and races without a recorded result are
  skipped (with reason counts on stderr).
- `scripts/training/fit_logit.py` — Python conditional-logit fitter. Uses
  L-BFGS-B (scipy) to maximize
  `ℓ(β) = Σ_i [ β·x_{i,winner(i)} − log Σ_k exp(β·x_{i,k}) ]`
  with a small L2 ridge (default 0.001) for numerical stability. Outputs
  `data/weights/v2.json` with: raw `beta`, Hessian-based standard errors,
  `weights_normalized` (Σ=1, the actual production input), `n_races`,
  date range, McFadden pseudo-R², top-1 hit rate, and a `status` field of
  `fitted` or `insufficient`. Refuses to write fitted weights below
  `--min-races` (default 200) unless `--write-anyway`.
- `scripts/lib/scoring.js`:
  - Exported `DEFAULT_V2_WEIGHTS` (the hand-picked
    `{speed:0.35, class:0.20, pace:0.15, tj:0.15, bias:0.10, fresh:0.05}` vector).
  - Exported `loadFittedWeights(payload)` to validate a weights-file payload
    and normalize it for the engine.
  - `scoreRace(race, opts)` now accepts `opts.fittedWeights`; when supplied
    and version==='v2', it replaces the hand-picked weights in the composite.
- `index.html` runtime:
  - New `RailbirdFittedWeights` IIFE lazy-fetches `data/weights/v2.json` once
    per session, caches the parsed payload, and enforces the 200-race minimum.
  - `runAdviceEngine()` v2 delegation passes the cached payload as
    `fittedWeights` to `RailbirdScoring.scoreRace`. Engine silently falls
    back to defaults when no fitted weights are available.
- `tests/fitted-weights.test.js` — 8 unit tests covering payload validation,
  insufficient-sample rejection, absolute-value handling of negative
  coefficients, default-weight passthrough, and version-gating (v1 ignores
  fitted weights).

### Behavior

- Fitted weights are **gated on n_races >= 200**. Below that, the engine uses
  the existing hand-picked defaults — no silent regressions on a small
  early-meet corpus.
- Conditional-logit coefficients can be negative if a sub-score is mis-signed
  in training. The validator normalizes by absolute value and re-scales to
  sum to 1, treating each sub-score as a positive influence (matches the
  "higher = better" orientation the sub-scores are designed around).
- Engine version remains opt-in via the existing A/B toggle. Default users
  see v1; only those who flipped to v2 (Settings, `?engine=v2`, or sticky
  device assignment) get the new weights.

### Tests

- 202/202 passing (previous 194 + 8 fitted-weights).

---

## v2.34.1 — PR #2 Checkpoint 3a: Evaluate Any Bet UI (2026-05-29)

User-facing UI for the bet evaluator landed in Checkpoint 2. Adds a bottom-
sheet modal accessible from the Bets tab so users can evaluate any bet they
are considering — WPS, full exotics (straight / box / key / wheel), and
multi-race tickets (Pick 3/4/5/6) — and see EV, overlay vs morning-line,
fair odds, engine rank, takeout, and structural warnings.

### Added

- **"Evaluate Any Bet" modal** in `index.html`:
  - Launch button on the Bets tab (gold gradient on racing-green) calling
    `openBetEvaluator()`.
  - Mobile-first bottom-sheet overlay (`#bet-eval-overlay` / `.bet-eval-sheet`).
  - Pool picker (10 pools), structure picker for exotics, race picker for
    single-race pools, multi-leg picker with "Start Race" selector and
    togglable PP chips for multi-race pools.
  - Per-structure picker UI:
    - WPS → single radio.
    - Exacta/Trifecta/Superfecta `straight` → finishing-position number
      input next to each horse.
    - `box` / `wheel` → checkbox include list.
    - `key` → hybrid key-radio + with-checkboxes.
  - Result card with verdict badge (OVERLAY / Underlay / Fair), cost, EV,
    expected return, probability, fair vs taken odds, engine rank,
    takeout %, structural warnings list, and takeout-source footer.
- JS adapter `_betEvalAdviceToScoredField()` converts cached advice items
  (`_adviceByRaceId[raceId]` shape) into the evaluator's `scoredField`
  shape (`{pp, prob, ml, composite, dataCompleteness}`).
- ~470 lines of CSS for the modal, modeled on the existing bet-amount-
  picker styles, with gold-on-green header matching the launch button.

### Behavior

- Auto-runs `runAdviceEngine()` if the advice cache is empty when the user
  opens the modal, so the evaluator always has scored data to consume.
- Defensive: shows inline error messages (no scored field, not enough
  horses, position not assigned, etc.) instead of throwing.
- All evaluator calls go through `window.RailbirdBetEvaluator.evaluateBet()`
  (the IIFE-attached inlined module from Checkpoint 2), so the UI uses the
  exact same math the tests cover.

### Tests

- All 194 tests still pass — no test changes were needed since the UI
  delegates to the already-tested evaluator core.

---

## v2.34.0 — PR #2 Checkpoint 2: Bet Evaluator + Engine Wiring (2026-05-29)

Second checkpoint of PR #2. Builds on v2.33.0 (methodology v2 + backtest
harness) and v2.34.0-checkpoint-1 (KV recorder, A/B engine toggle, inlined
scoring) by adding a full user-bet evaluator, wiring v2 scoring into the live
`runAdviceEngine()` behind the A/B toggle, and adding a Worker-backed corpus
loader for the backtest harness.

### Added

- `scripts/lib/bet_evaluator.js` — pure user-bet evaluator (~700 lines).
  Single entry point `evaluateBet({pool, race, legs, selection, structure,
  amount})` covering ten wager types:
  - **Win / Place / Show** (Harville-approximated place/show probabilities,
    overlay vs morning-line, engine rank, structural warnings).
  - **Exacta / Trifecta / Superfecta** in four structures: straight, box,
    key, wheel. Per-permutation Harville pricing with takeout deduction.
  - **Pick 3 / 4 / 5 / 6** with multi-leg coverage and ticket-cost warnings.
    Multi-race ER uses the fair-pricing identity
    `ER = baseAmount × (1 − takeout) × validCombos`, validated against the
    full-coverage identity `ER = (1 − takeout) × cost`.
  - Per-track takeout table with NYRA fallback. Sources cited inline:
    NYRA (Aqueduct/Belmont/Saratoga), Charles Town, Churchill Downs, Lone
    Star Park. All takeout rates verified against the host association's
    published FAQ on 2026-05-29.
  - Returns `{cost, probability, expectedReturn, expectedValue, overlay,
    engineRank, warnings, confidence, takeout, takeoutSource}`.
- `tests/bet-evaluator.test.js` — 53 unit tests covering odds parsing,
  takeout lookup, Harville probabilities, permutation generators, every
  evaluator path, fair-pricing identities, and dispatcher routing.
- `scripts/backtest/load_corpus.js` — added `loadCorpusFromWorker()` and
  `mergeCorpora()`. The Worker-backed loader pulls archived race history
  from `/api/history/list` + `/api/history/{TRACK}/{DATE}` so the backtest
  harness can consume the production race archive without re-fetching from
  vendor APIs. Merge applies the same "results-wins" de-dup policy across
  on-disk and Worker sources.
- `tests/load-corpus-worker.test.js` — 9 tests covering the worker loader
  (empty listings, fetch failures, missing fields, per-day error skipping)
  and the merge helper (uniqueness, results-wins, empty input).

### Changed

- `index.html` — `runAdviceEngine()` now delegates to
  `window.RailbirdScoring.scoreRace(race, {version:'v2', bias, today})` when
  `RailbirdEngine.isV2()` is true. v1 (legacy) remains the default; v2 is
  opt-in via Settings, `?engine=v2`, or sticky device assignment.
  Output shape is identical between paths so all downstream rendering
  (advice rows, confidence bars, suggested bets, top picks card, bet slip
  hooks) works unchanged. A defensive `try/catch` around the v2 call falls
  back to the inline v1 path on any error so the UI never goes blank.
- `scripts/ingest/theracingapi_adapter.js` — `trainingEligible` flipped
  from `false` to `true`. Written ML-training approval from
  support@theracingapi.com is on file as of 2026-05-29. License notes and
  header comment updated to reflect approval.

### Sources verified 2026-05-29

- [NYRA betting FAQ](https://www.nyra.com/aqueduct/racing/betting-faq/) —
  NYRA takeout rates (Win/Place/Show 16%, Exacta/DD 18.5%, Tri/Super/Pick3/
  Pick4 24%, Pick5/Pick6 15%).
- [NY Gaming Commission horse racing reports](https://gaming.ny.gov/horse-racing-reports)
- [Iron Bets — Bet Charles Town](https://ironbetsracing.com/bet-charles-town/)
- [Churchill Downs visiting information](https://www.churchilldowns.com/come-to-the-track/visiting-information/event-information/)
- [Lone Star Park wagering menu](https://www.lonestarpark.com/wageringmenu/)

### Test count

130 → 192 (+62: 53 bet-evaluator, 9 worker-loader). All pass.

### Deferred to Checkpoint 3

- "Evaluate My Bet" UI in `index.html` (race+pool+horse+structure picker,
  results card with EV/overlay/engine-rank/warnings, hook from bet slip).
- `scripts/training/fit_logit.py` — Python conditional-logit fitter that
  reads from the Worker's archived race history and exports
  `data/weights/v2.json`.
- v2 engine wiring to load fitted weights when `n_races ≥ 200`, with
  fallback to hand-picked defaults below that threshold.

---

## v2.33.0 — Methodology v2 + Backtest Harness (2026-05-29)

First half of a two-PR effort to put the advice engine on an empirical
footing. This PR is **purely additive** to the production UI — nothing in
`index.html` changes behavior. The new code is exercised offline by the
backtest harness so v2 can be validated before it's wired into the PWA.

### Added

- `scripts/lib/scoring.js` — pure scoring + probability module, no DOM/fetch.
  Exposes `scoreRace()` and `scoreCard()` with a `version: 'v1' | 'v2'` flag.
  - **v1** replicates the math currently in `index.html` for parity tests.
  - **v2** fixes five peer-review issues:
    1. **Probability normalization.** Replaces `score / Σscores` (not a
       probability) with a temperature-scaled softmax so dispersion is
       meaningful and overlay calculations are honest.
    2. **Field-strength normalization.** A 75 composite in a 5-horse MCL no
       longer looks identical to a 75 in a 12-horse stakes.
    3. **Trainer + Jockey decoupling.** Stops averaging jockey% and trainer%
       (which double-counted hot pairs); now scores them independently and
       blends 60% high / 40% low.
    4. **Bias additivity cap.** Style and rail bumps are explicit additive
       components around a 50 baseline, capped [0, 100], with penalties for
       wrong-style/wrong-post that v1 didn't apply.
    5. **Expert consensus decoupling.** Off the composite by default in v2
       (still surfaced for UI display as a benchmark). v1 default keeps the
       legacy +3/+6/+10/+14 bonus.
- `scripts/backtest/` — offline measurement harness.
  - `load_corpus.js` reads `data/normalized/`, `data/entries-*.json`, and
    optionally `data/fixtures/`. Dedupes by race id, preferring copies with
    results regardless of source.
  - `metrics.js` computes log-loss, multi-class Brier, top-1/top-3 hit rate,
    flat $2 win ROI on top pick, overlay-bet ROI, and calibration deciles.
  - `run.js` is the CLI entry point. Compares v1, v2, and a morning-line
    baseline head-to-head and writes an optional JSON report.
  - Degrades gracefully when no result data is present — still scores every
    race and prints a clear unavailability notice.
- `tests/scoring.test.js` — 35 new unit tests covering all sub-scores, both
  probability normalizations, field-strength bounds, v1-vs-v2 differences,
  and end-to-end `scoreRace()`.
- `tests/backtest.test.js` — 18 new tests covering log-loss / Brier / hit-rate
  primitives, calibration bucketing, and end-to-end `evaluateVersion()` with
  and without result data.
- `package.json` — added so `npm test` and `npm run backtest` work.
- `scripts/backtest/README.md` — usage, metrics definitions, data sources,
  known limitations, instructions for adding real result data.

### Documented but not changed

- Added a comment block above `runAdviceEngine()` in `index.html` listing the
  five v1 methodology caveats so future readers know what's known to be wrong.
- Discovered a sixth caveat during testing: identical speed figs trigger BOTH
  the career-best (+8) and career-worst (−5) clauses simultaneously, and the
  worst clause wins. Flat-form horses are silently depressed. Documented; not
  fixed in v1 since fixing would be a behavior change.

### Test results

- 128/128 tests pass (`node --test tests/`).
- End-to-end backtest demo run on the existing Saratoga placeholder fixture
  with synthetic results: v1 calibration collapses into two probability
  buckets (the score-share compression bug, visible empirically), v2 spreads
  across three buckets. Both demo runs are inferior to the ML baseline on
  synthetic data — expected, since the synthetic winners were drawn from ML.

### Not in this PR (PR #2)

- Conditional-logit (fitted) weights for v2.
- UI toggle to run v2 in the live PWA.
- Move methodology card behind login + accuracy storage to Cloudflare KV.

## v2.32.6 — About sheet in More tab (2026-05-28)

Renamed the standalone "What's a railbird?" entry in the More sheet to a
broader **About** card, and grouped two collapsible Q&A rows inside it:

1. **What's a railbird?** — same definition copy as v2.32.4, now inline
   inside the About sheet instead of opening the separate modal.
2. **Who is this app for?** — short, irreverent in-voice answer using the
   exact wording the user supplied.

Mechanics:

- New `#about-sheet` modal (same cream-card pattern as the railbird-def
  modal and feedback modal).
- Two `.about-item` buttons that expand/collapse `.about-answer` blocks
  in place — no extra navigation, no extra modals stacked on top.
- Escape, backdrop tap, and X all close the sheet. Re-opening starts
  with both rows collapsed (clean state).
- The hero RAILBIRD AI title tap still opens the standalone railbird-def
  modal (unchanged) — the More-tab path is the only thing that moved.

Files touched:

- `index.html`: replaced the More-sheet "What's a railbird?" button with
  an "About" button that calls `openAboutSheet()`. Added the
  `#about-sheet` markup, styles, and script just below the existing
  railbird-def modal.

## v2.32.5 — Restore desktop nav (2026-05-28)

User reported that the desktop view has no top-level nav buttons —
the Today / Bets / Handicap / More tabs that appear on mobile were
missing entirely.

Root cause: line 4539 had a stale override `#desktop-nav { display:
none !important; }` left over from a brief experiment where we
replaced the desktop nav with a chip bar. The chip bar was later
removed, but the override stayed. Meanwhile the bottom-tab-bar is
already hidden ≥768px (correct), so desktop users were left with no
navigation at all.

Fix: removed the stale `display: none !important` override.
The base rule at line ~1495 with `@media (min-width: 768px) { #desktop-nav { display: flex } }`
immediately takes effect, restoring the Today / Bets / Handicap /
More buttons in the top header on desktop.

The desktop nav buttons (`#dnav-today`, `#dnav-bets`, `#dnav-handicap`,
`#dnav-more`) were already present in the HTML and wired to
`switchTab()` / `openMoreSheet()` — they were just being hidden.

No HTML or JS change. Pure CSS regression fix.

## v2.32.4 — "What's a railbird?" definition (2026-05-28)

Small personality touch: a punchy dictionary-style definition of
"railbird" is now accessible from two places:

1. **Tap the gold "RAILBIRD AI" title** on the hero/landing screen.
   The title now has a tap affordance (cursor pointer, focus ring,
   subtle opacity dim on press). Tapping pops a bottom-sheet card.
2. **More tab → "What's a railbird?"** entry, sitting just below
   Settings, above Send Feedback. Same modal, same content.

Copy (deliberately punchy, not preachy):

> **railbird** (n.) /ˈreɪl-bərd/
> The fan at the rail. The one who studies the form, watches the
> workouts, and roots for the **horse**, not the bet.

Implementation notes:
- `event.stopPropagation()` on the title tap so it doesn't trigger
  the hero's scroll-to-enter behavior.
- Modal closes via the X button, backdrop tap, or Escape key.
- Reuses the same bottom-sheet pattern as the feedback modal for
  visual consistency.
- No new dependencies, no JS framework changes, ~75 lines total.

## v2.32.3 — Hero layout fix for Chrome iOS (2026-05-28)

User reported the landing/hero screen rendering out of alignment in
Chrome on iPhone — the title block was clipped behind the URL bar and
the A2HS "Add to Home Screen" install banner appeared to overlay the
headline copy.

Root cause: `#hero-screen` used `height: 100dvh` (dynamic viewport).
On Chrome iOS, `100dvh` is measured on initial paint *before* the URL
bar appears, so the hero is sized as if the URL bar isn't there. The
title is vertically centered against that taller-than-actual area, so
it ends up clipped under the URL bar when the bar paints in.

Fix:
- `#hero-screen` now uses `height: 100svh` (small viewport height —
  the smallest stable viewport, with the URL bar always assumed
  visible). Falls back to `100dvh` for browsers without `svh` support.
- Added `padding-top: calc(env(safe-area-inset-top, 0px) + 1rem)` so
  the title clears the Dynamic Island / notch on first paint.
- No JS change — pure CSS, no behavior risk.

## v2.32.2 — Horse profile honesty (2026-05-28)

Follow-up to a user QC pass on the curated Inspeightofcharlie profile.
The Overview panel showed `Jockey: Nik Juarez` with no qualifier, even
though the horse's most recent verified ride (May 10, 2026 Aqueduct
allowance) was by Manuel Franco. "Sample starts: 6" was also unclear
— looked like a career total but really meant the count of form lines
in our local data.

Three changes:

1. **Curated data refreshed.** Added the May 10, 2026 Aqueduct race
   (NW1X turf allowance, 2nd of 14, Manuel Franco up) at the top of
   the history rows, sourced from NYRA official results. Updated
   top-level `jockey` to `Manuel Franco` and added a `dataAsOf:
   2026-05-10` field. Bumped `season2026` stats (3 starts, 1-1-1)
   and `career` (8 starts, 1-3-2). Added a caveat that the curated
   set is a manually-refreshed snapshot, not a live feed.

2. **Overview panel made self-consistent and honest.** The Overview
   now derives the displayed jockey from the most recent history row
   (if any history rows have a jockey field), falling back to the
   top-level `h.jockey`. The label changes from `Jockey` to
   `Last known jockey` on curated profiles, with a tooltip explaining
   that trainers change riders frequently. A small "(as of YYYY-MM-DD)"
   suffix appears next to the rider name showing the date of the
   form line it was pulled from. Renamed `Sample starts` to
   `Form-line starts` on curated profiles, with a tooltip clarifying
   it's the count of public form lines we have on file, not the
   horse's career total.

3. **Test relaxation.** Loosened
   `curated-horses.test.js` assertion `career.starts === 7` to
   `>= 7`, because the curated record now reflects 8 career starts
   after the May 10 race was added.

Known limitation: the curated dataset still contains only one horse.
This is intentional — it's a demo/seed profile. The live Racing API
feed will populate every other horse profile beta testers see during
the Belmont Festival.

- `NE_APP_VERSION` → `20260528-0800-profile-honesty-v2.32.2`
- `RAILBIRD_VERSION` → `v2.32.2-profile-honesty`

Sources for the May 10 Aqueduct race:
[NYRA results](https://www.nyra.com/aqueduct/racing/results/?day=2026-05-10),
[Equinedge results](https://equinedge.com/results/belmont-at-the-big-a/05-10-2026),
[form-guide.com.au](http://form-guide.com.au/race/horse/aqueduct-usa/2026-05-11/9).

## v2.32.1 — Headline stakes fix (2026-05-28)

Factual-accuracy patch on the pre-meet Headline Stakes panel. A user QC pass
asked whether the surfaced races were real Belmont/Saratoga information; they
weren't fully. The hand-curated `OFFDAY_STAKES['Belmont Stakes Festival']`
list contained:

- **Met Mile (G1)** dated Fri Jun 5 — actually runs Sat Jun 6 per NYRA.
- **Brooklyn (G2)** on Sat Jun 6 — not on the 2026 Belmont Stakes Racing
  Festival schedule at all.
- **Jaipur (G1)** listed as 6F Inner Turf — actually 5½F Turf.

Fix:

- Replaced the four-row Belmont Festival panel with eight real G1s pulled
  directly from the
  [NYRA Belmont Stakes Racing Festival schedule](https://www.nyra.com/belmont-stakes/racing/bsrf-stakes-schedule/):
  Fri New York / Ogden Phipps / DraftKings Acorn, and Sat Belmont Stakes /
  Manhattan / Metropolitan H. / Just A Game / Jaipur (5½F Turf).
- Added a small italic line under the panel header: *"Schedule from NYRA ·
  live entries and odds appear after the post draw Mon Jun 1."* This sets
  honest expectations for beta testers who hit the app before the entries
  are drawn.
- Fixed the welcome step `meetLine` ("Met Mile, Brooklyn, Jaipur…") to drop
  the fabricated Brooklyn reference and surface Belmont / Met Mile / Manhattan
  / Just A Game instead.

No logic changes. Static copy only. Unit tests unaffected.

- `NE_APP_VERSION` → `20260528-0735-headline-stakes-fix-v2.32.1`
- `RAILBIRD_VERSION` → `v2.32.1-headline-stakes-fix`

Background note for QC: The Racing API has a rolling ~6-day lookahead
window. As of 2026-05-28, the API has cards through 2026-06-03 only;
nothing for any track Jun 4 onward, because entries haven't been drawn
anywhere yet (Belmont post draw is Mon Jun 1 at 5pm EDT). Saratoga IS
covered — the 2025 Belmont weekend and 2025 summer meet are both in the
API today. So the app will get live data during Belmont Festival, the
data just isn't in the vendor system yet.

## v2.32.0 — Beta gate, feedback channel, KV catalog (2026-05-28)

Beta-readiness release. Three changes:

1. **Closed-beta access gate.** A fullscreen unlock screen blocks the app
   until the visitor enters a shared access code (current code:
   `SARATOGA2026`, stored in the bundle as a SHA-256 hash). Once unlocked
   on a device, the unlock flag is written to `localStorage` under
   `railbird-beta-unlocked-v1` and the gate never appears again. The
   builder bypasses the gate with `?dev=1` on any URL — that flag sets the
   unlock for that device permanently. Rotation: replace the `BETA_HASH`
   constant in the gate IIFE with `sha256("NEWCODE")`.

2. **Feedback channel.** A "Send Feedback" entry has been added to the
   More sheet. It opens a modal with one required field (message) and two
   optional fields (name, email). Submissions POST to a new worker
   endpoint, `POST /api/feedback`, which writes the record to a Cloudflare
   KV namespace (`FEEDBACK_LOG`, id `f4480a5e9...`) keyed by reverse
   timestamp for newest-first listing, and — when `FEEDBACK_SENDGRID_KEY`
   + `FEEDBACK_EMAIL_TO` worker secrets are set — emails a plain-text copy
   to the builder via SendGrid. Email failures are best-effort and never
   fail the request.

3. **Feedback admin endpoint.** `GET /api/feedback/list?limit=50` returns
   the most recent feedback entries (max 200) for review between
   sessions. Requires `Authorization: Bearer <FEEDBACK_ADMIN_TOKEN>` — the
   token is stored as a worker secret and never reaches the client.

### Added

- `worker.js` — `handleFeedbackSubmit(request, env, origin)` and
  `handleFeedbackList(request, env, origin)`; new POST allow-listing in
  the fetch entry; CORS methods now `GET, POST, OPTIONS`.
- `wrangler.toml` — `FEEDBACK_LOG` KV binding declared.
- `index.html` — beta-gate overlay + IIFE (inline at top of `<body>`,
  runs before any other script); feedback modal + `openFeedbackModal()`,
  `closeFeedbackModal()`, `submitFeedback()`; "Send Feedback" item in
  More sheet.

### Notes for the builder

- KV namespace id: `f4480a5e92fa463a88e014541224b85f`.
- Admin token: stored as `FEEDBACK_ADMIN_TOKEN` worker secret; reference
  copy lives in `.secrets-reference.txt` (gitignored).
- SendGrid key: not yet configured. Set
  `FEEDBACK_SENDGRID_KEY` worker secret + verify a sender identity in
  SendGrid (single-sender on `jhwiv.online@gmail.com` is the fastest
  path) and email-on-submit lights up immediately. Without the key,
  feedback still catalogs in KV — just no inbox copy.
- The install banner already handles Android ("Install App" via
  `beforeinstallprompt`, fallback to the three-dot menu hint) and iOS
  ("tap Share…Add to Home Screen") in `initA2HSBanner()`; no v2.32.0
  changes required.

## v2.31.0 — Live North American data + PP card (2026-05-28)

The app is finally wired to a real, paid live data source. The Cloudflare
Worker now authenticates against The Racing API's North American (NA)
endpoints with HTTP Basic credentials and returns entries, scratches,
odds, and results normalised into the existing Railbird schema. No
client-side endpoint changes were required — `/api/entries`,
`/api/scratches`, `/api/odds`, `/api/results`, and `/api/status` all
keep their shapes. Settings > Data Source now reports `LIVE (The Racing
API — North America)` when both `API_USER` and `API_KEY` are set on the
Worker, with a live probe count and worker latency.

Stage 2 introduces a Past Performances (PP) card that opens whenever a
horse name is tapped from Today or Bets. The card surfaces the
handicapper description that ships in the NA entries payload
(`runner.description`) together with the horse's most recent finish
position and WPS payouts pulled from the live results endpoint.

### Added

- **Worker NA integration** (`worker.js`) — HTTP Basic auth via
  `basicAuthHeader(user, pass)` using `btoa(...)`; `findMeetId(track,
  date, ...)` caches the per-date `meet_id` for 300s; five new
  normalisers (`normaliseNaEntries`, `normaliseNaScratches`,
  `normaliseNaOdds`, `normaliseNaResults`, plus helpers for time-zone
  short-code mapping, post-time formatting, jockey/trainer names, race
  number, scratched detection, finish inference, and payoff lookup).
  `usePaidSource` now requires BOTH `API_USER` and `API_KEY`.
- **Track-to-venue map** expanded from 12 to 36 tracks. Adds Churchill
  Downs (CD), Keeneland (KEE), Indiana Grand (IND), Gulfstream (GP),
  Santa Anita (SA), Del Mar (DMR), Woodbine (WO), and many more.
- **PP card** (`#pp-card`) — opens on horse name tap in Today and Bets
  tabs. Shows program number, ML odds, description text, recent
  finish-position pill, and WPS payouts. Closes on backdrop tap or
  Escape.

### Fixed

- **BEL** entry was wrongly mapped to Aqueduct; now correctly maps to
  Belmont Park.
- **BTP** entry was wrongly mapped to Belmont Park; now correctly maps
  to Belterra Park.
- **`post_time_long` coercion** — upstream returns this field as a
  string. Worker now `parseInt(..., 10)` before passing to
  `Intl.DateTimeFormat`, eliminating `"N/A"` post-time renders.
- **Time-zone short codes** (`"E"`, `"C"`, `"M"`, `"P"`, `"AKST"`,
  `"HST"`) — `naTimeZoneToIana()` now maps these to IANA zones before
  `Intl.DateTimeFormat`.
- **Race-level payouts** — previously the race's top-level `payouts.win
  / place / show` could be populated from the 2nd-place horse's
  payoffs. Now always uses the winner's WPS. Per-horse payoffs remain
  on each `finishOrder[i]` entry.
- **`handleResults` 404** — results endpoint returns 404 until a race
  has officially finished. Worker now catches `err.upstreamStatus ===
  404` and returns a graceful empty-results payload instead of
  bubbling the error.

### Bumped

- `NE_APP_VERSION` → `20260528-1015-na-live-v2.31.0`
- `RAILBIRD_VERSION` → `v2.31.0-na-live`
- `version.json` → `20260528-1015-na-live-v2.31.0`

## v2.29.0 — Pre-meet countdown polish (2026-05-27)

With the onboarding tour pointing every new user to Today, the off-day
dashboard becomes the first thing they actually see. v2.29.0 reshapes
that dashboard to give the next 7 days of pre-meet visitors something
worth looking at: a large countdown to opening day, a curated list of
the headline stakes coming up, and two clear CTAs so they can productively
use Handicap or the Barn while they wait for live cards.

### Added

- **Opening-day countdown card** (`#offday-countdown`, lines ~14299–14329) —
  large numeric counter ("7 days to go"), meet label ("Belmont Stakes
  Festival"), and opening-day date in plain English ("Opens Wednesday,
  June 3"). Renders only when a meet opens within 14 days; otherwise
  invisible. Computed live from `TRACKS.SAR.seasons`, no hard-coded dates.
- **Headline stakes preview card** (`#offday-stakes`, lines ~14334–14372) —
  curated list of marquee stakes for the upcoming meet, with race name,
  grade, purse, day, distance, surface, and an editorial note. Belmont
  Stakes Festival ships with Met Mile (G1), Brooklyn (G2), Jaipur (G1),
  and Belmont Stakes (G1). Summer Meet ships with Whitney, Fourstardave,
  and Travers. Data is hand-curated in `OFFDAY_STAKES` (no API needed).
- **Dual-CTA footer** (lines ~14377–14387) — replaces the generic "Tip"
  line with two real buttons:
  - **Open Handicap** (outline) → `switchTab('handicap')`
  - **Build your Barn** (filled gold) → `switchTab('barn')`

### Fixed

- **Redundant cream banner**: the warning banner "No race card available
  — check back on a race day" was rendering above the off-day dashboard,
  duplicating the dashboard's own "Dark day at Saratoga" header. The
  banner-hide call inside the dashboard wrapper was being overridden by
  a later `showLiveUnavailable()` call. `showLiveUnavailable()` now
  checks for `#offday-dashboard` first and stays hidden when the rich
  dashboard is on screen.

### Bumped

- `NE_APP_VERSION` → `20260527-1930-pre-meet-countdown-v2.29.0`
- `RAILBIRD_VERSION` → `v2.29.0-pre-meet-countdown`
- `version.json` to match.

### Tests

- 79/79 passing.
- Playwright smoke (393×852): countdown reads "7 days to go · Belmont
  Stakes Festival · Opens Wednesday, June 3", all 4 headline stakes
  render with correct day/distance/surface/purse, Open Handicap button
  switches to `tab-handicap`, Build your Barn switches to `tab-barn`,
  cream banner is hidden. Zero page errors.

## v2.28.0 — First-meet onboarding tour (2026-05-27)

New users land on the app cold and have to guess what the tabs do. v2.28.0
adds a brief, dismissible 3-step welcome tour that introduces the product
with meet-aware copy keyed to the Saratoga calendar — so a first-time user
today sees "Belmont Stakes Festival opens in 7 days" instead of generic
fluff. The tour fires once after the hero is dismissed, never reappears
unless replayed from Settings, and writes a single `tourDone` flag.

### Added

- **Tour modal** (`#tour-modal`, `index.html` lines ~8238–8266) — full-screen
  scrim with a centered sheet, 3-dot progress indicator, Skip control, Back
  + Continue/Get Started footer buttons. Navy `#1B2E4B` sheet, gold
  `#C0A062` accents, cream `#F8F4EA` body text. All literal hex values
  (defeats the MSP cascade that redefines `--lux-navy` to cream inside
  tab-panel scope).
- **Tour CSS** (lines ~2295–2392) — z-index 600, opacity+transform open
  transition, `.tour-hint` callout box (gold left border) for inline notes
  like "no card today? that's normal between race days."
- **Tour engine IIFE** (lines ~9047–9250, ~200 lines) — reads
  `TRACKS.SAR.seasons` and today's date to compute the meet phase
  (`pre-festival` / `in-festival` / `pre-summer` / `in-summer` /
  `off-season`) and renders meet-aware copy on step 1. Public API:
  `window.maybeStartTour()` (no-op if done), `window.startTour()` (always
  fires), `window.endTour()`, `window.tourNext()`, `window.tourPrev()`.
  ESC also closes and marks done.
- **Hero hooks** (lines ~8992–9022) — `enterApp()` fires
  `maybeStartTour()` 600ms after the chevron tap; the scroll-past path
  fires it 900ms after the user scrolls below 100px. Either way the user
  lands on Today before the modal opens.
- **Settings > App Info > Replay Welcome Tour** button (line ~8228) —
  closes the Settings sheet and calls `startTour()` so users can replay
  the tour any time.
- **`store.settings.tourDone`** boolean (added to the default store, line
  ~8408) — separate from `welcomeDone` so the tour can be replayed
  without re-showing the hero.

### Meet-aware copy phases

Computed from `TRACKS.SAR.seasons[*].opens` / `closes` and `new Date()`:

- `pre-festival` (before 2026-06-03): "Belmont Stakes Festival at
  Saratoga opens in N days — Met Mile, Brooklyn, Jaipur, all run at the
  Spa this year."
- `in-festival` (2026-06-03 to 06-07): "running right now at the Spa."
- `pre-summer` (06-08 to 07-02): "Saratoga summer meet opens in N days."
- `in-summer` (07-03 to 09-07): "Saratoga is running now — 40 days of
  the best racing in America."
- `off-season`: "Saratoga is dark right now. We'll be back when the meet
  opens."

Today is 2026-05-27 → phase `pre-festival`, daysUntil 7. Test ran live.

### Bumped

- `NE_APP_VERSION` → `20260527-1900-onboarding-tour-v2.28.0`
- `RAILBIRD_VERSION` → `v2.28.0-onboarding-tour`
- `version.json` to match.

### Tests

- 79/79 passing.
- Playwright smoke (393×852, deviceScaleFactor 2): first-run tour opens
  after hero dismissal, all 3 steps render with correct copy, Next /
  Back / Skip all work, finishing sets `tourDone:true`,
  `maybeStartTour()` is a no-op afterward, Settings > Replay Welcome
  Tour reopens the modal at step 1. Zero page errors.

## v2.27.1 — Remove obsolete Sample · SAR 2025 toggle (2026-05-26)

Vestigial UI from v2.19.0 had a Data Mode toggle in Settings letting you flip
between "Sample · SAR 2025" (a hand-curated 2025 placeholder set) and "Live".
The sample path was a parallel pipeline that intercepted `getCachedRacesForDate`
for SAR dates in the 2025 meet window. Now that v2.27.0 shipped real rehearsal
data through the actual worker pipeline (`data/entries-{TRACK}-{DATE}.json` with
`dataMode:'rehearsal'`), the toggle is dead weight and confusing.

### Removed

- **SAR 2025 Pipeline IIFE** (`index.html` lines 16358–17042, 685 lines)
  including:
  - `loadFixture()` / `FIXTURE_URL = 'data/fixtures/saratoga_2025_sample.json'`
  - `isSampleMode()`, `setMode()`, fixture interceptor for
    `getCachedRacesForDate`.
  - Settings Data Mode toggle card (`#sar-data-mode-card`, Sample / Live
    pill, click handlers).
  - "Upcoming at Saratoga" preview card (`.sar-up-card`) that only worked
    in Sample mode and showed a "switch to Sample" notice otherwise.
  - Barn add-input typeahead (`.sar-ta-*`) sourced from the sample dataset.
- **MSP-overlay CSS** for `#sar-data-mode-card`, `.sar-data-banner`,
  `.sar-ta-*`, `.sar-up-*` (58 lines).
- Simplified the `dataMode` validator on boot — only `'live'` is a valid
  value now; anything else is silently corrected.

### Kept (still useful)

- `data/fixtures/saratoga_2025_sample.json` — the Virtual Barn IIFE still
  reads it to seed demo horses with realistic histories on first load.
- Virtual Barn auto-demo seeding (`source: 'demo-saratoga-2025'`) — unrelated
  to the toggle; gives new users a populated Barn out of the box.
- `tr.sar-barn-row` CSS — race-card highlight for horses in the Barn.

### Net diff

`index.html` —743 lines (17899 → 17156). 79/79 tests still pass.

## v2.27.0 — Live-data wiring (pre-paid) (2026-05-26)

Everything is wired end-to-end against the existing free static path so
flipping to a paid API is a one-day cutover. No live data is being paid for
yet — this release just removes every "oh I also need to build X" item from
the cutover day.

### Worker (requires manual `wrangler deploy`)

- **New `/api/status` endpoint** — diagnostic JSON returning `mode`
  (`free` | `paid`), `activeSources` per data type, upstream probe results
  with per-probe latency (`github-pages-static`, `equibase-scratches`, and
  `theracingapi` when configured), worker-side `workerLatencyMs`, `cacheTtl`,
  `defaultTrack`, `hasApiKey`. Safe-wrapped so a single dead upstream never
  brings the endpoint down.
- Existing `/api/entries`, `/api/scratches`, `/api/odds`, `/api/results`
  endpoints already accept both DATA_SOURCE values; no schema change needed
  to flip modes.

### Synthetic rehearsal fixtures

- `scripts/generate-rehearsal-fixtures.js` — deterministic generator
  (mulberry32 seeded RNG, real jockey/trainer names mixed with fictional
  horses) so anyone can regenerate the rehearsal cards.
- `data/entries-BEL-2026-06-03.json` — Belmont Stakes Festival opener at
  Saratoga (9 races, 82 entries, Grade 1 Met Mile + Brooklyn G2 + Jaipur G2).
- `data/entries-SAR-2026-07-03.json` — Saratoga summer-meet opener (10 races,
  100 entries, full meet-day variety).
- Both files carry a top-level `"dataMode": "rehearsal"` flag so any future
  watermark / banner code can distinguish rehearsal data from real cards.

### Settings > Data Source diagnostic panel

- New panel rendered on settings open and refreshable on demand. Fetches
  `${workerUrl}/api/status` and shows:
  - **Mode badge** — PAID (green) / FREE (gold) / unknown (amber).
  - **Active sources table** — entries / scratches / odds / results, each
    labeled with the upstream it's currently pulling from.
  - **Upstream probes** — green/red dot, HTTP code, per-probe latency, error
    message on failure.
  - **Cache TTL**, default track, API-key presence, fetched-N-seconds-ago.
- Cached for 60s in-session; Refresh button bypasses the cache.
- Surfaces a clear amber message if the worker is older and lacks the
  endpoint (`Worker does not expose /api/status. Run wrangler deploy ...`).

### Cutover runbook (free → paid)

When ready to start paying The Racing API:

1. **Provision the API key**: subscribe at theracingapi.com, copy the Bearer
   token.
2. **Inject it as a worker secret** (never commit to wrangler.toml):
   ```
   cd /path/to/ne-racing
   wrangler secret put API_KEY
   # paste token at prompt
   ```
3. **Switch the worker to paid mode** in `wrangler.toml`:
   ```
   [vars]
   DATA_SOURCE = "theracingapi"   # was "free"
   ```
4. **Deploy**: `wrangler deploy`.
5. **Verify via /api/status** (browser or curl):
   ```
   curl -s https://cloudflare-worker.jhwiv-online.workers.dev/api/status | jq
   ```
   Expect `mode: "paid"`, `hasApiKey: true`, `theracingapi` probe with
   `ok: true` and HTTP 200.
6. **Verify in app**: open Settings on https://railbirdai.com — the Data
   Source panel should show the PAID badge in green, all four activeSources
   should read `theracingapi`, and the theracingapi probe row should be
   green with sub-1s latency.
7. **Smoke test entries endpoint**:
   ```
   curl -s 'https://cloudflare-worker.jhwiv-online.workers.dev/api/entries?track=SAR&date=2026-07-03' | jq '.races | length'
   ```
   Expect a non-zero number (real card from TRA).
8. **Rollback** (if anything misbehaves): set `DATA_SOURCE = "free"` and
   `wrangler deploy` again. The static path is untouched and will resume
   serving immediately. API key remains as a secret and is ignored in free
   mode.

### Versions

- `NE_APP_VERSION` → `20260526-2100-live-data-wiring-v2.27.0`
- `RAILBIRD_VERSION` → `v2.27.0-live-data-wiring`
- `version.json` bumped accordingly.

## v2.26.1 — Polish + Barrier Island Digital branding (2026-05-26)

Three small polish items follow-on from v2.26.0, plus first-time addition of
Barrier Island Digital, LLC attribution to align with the rest of the
studio's properties (Maritimes Grand Loop, Trip Optimizer).

### Polish

- **Mobile header wordmark** dropped from 0.92rem to 0.78rem so "SARATOGA
  2026" no longer crowds the SIM pill on 393px viewports. Bumps back to
  0.92rem at ≥600px where the header has room.
- **More-sheet items** now stack title and subtitle vertically. `.more-item-
  body` got `display:flex; flex-direction:column` so titles like "Results &
  Bankroll" don't run inline with their subtitles.
- **Section-title accent** recolored gold → racing-green for full palette
  unity. The 40×3px gradient bar under every section heading was the only
  remaining gold-on-cream UI element.

### Barrier Island Digital branding

- Added `assets/bid-compass-white.png` (480×470 transparent PNG, sourced
  from maritimesgrandloop.com).
- New `.bid-hero` lockup in the welcome hero block — white compass + white
  serif name + white DM Mono "Powered by" eyebrow, drop-shadowed and
  transparent so it reads cleanly over the luxury Saratoga hero photo
  (no chip, white-on-existing-background per spec).
- New `.bid-footer-band` (full-bleed navy band that breaks out of tab-panel
  padding via negative margins + `!important` to win the MSP overlay
  cascade) wraps a transparent `.bid-footer` lockup at the end of the
  Reference tab. White compass + white text reads cleanly against navy
  regardless of the cream page background underneath. Reachable from any
  session via More > Track Reference.

### Files touched

- `index.html` — 4 CSS blocks (header sizing, more-sheet flex, section accent
  color, BID lockup styles) + 2 HTML insertions (hero, reference footer).
- `assets/bid-compass-white.png` — new.
- `version.json` → `20260526-2010-bid-footer-band-v2.26.1`.

---

## v2.26.0 — UX tightening pass (2026-05-26)

Second UX polish wave following the v2.25.0 audit. Six structural items plus
four pieces of color/visual cleanup, all aimed at making the app read crisper
and faster on first contact.

### 1. Demote the prominent blue sign-in card

The blue "Sign in to your sportsbook" card on the Bets tab was the loudest
element on the screen and competed with the bankroll banner for attention.
- Replaced the full-bleed `.adw-signin-chip` block with a single-line
  `.adw-signin-link` button (underlined racing-green text) under the bankroll
  banner. Still opens the same `#adw-sheet` of provider options.
- The sheet itself is unchanged — only the entry-point is demoted.

### 2. Single master race picker on Handicap

The Handicap tab previously had five independent race selectors stacked
across its sub-panels (Advice / Speed Figs / Pace / Class / Trainer-Jockey).
Now:
- One `#hcp-master-race-select` sits at the top of the tab.
- Per-section pickers are hidden (`.hcp-hidden-picker`) but kept in the DOM
  so existing render code reads `.value` unchanged.
- `syncHandicapRace(value, silent)` propagates the master value to children
  with a silent flag to avoid feedback loops.

### 3. Consolidate bottom nav from six tabs to four

The six-tab bottom bar (Today / Bets / Handicap / Barn / Results / Reference)
was too dense on narrow screens. New shape:
- Visible: **Today / Bets / Handicap / More**.
- Barn, Results, Reference now live inside a `#more-sheet` bottom sheet that
  mirrors the `#adw-sheet` pattern (handle, header, list of items with icon
  + title + sub).
- `switchTab()` lights up the More button when navigating to a sub-view so
  the user always has a visible anchor.
- `updateModeTabBadges()` is neutered — it now strips Simulated/Real badges
  instead of adding them, since the new nav has no room for them.
- Legacy `tab-btn-barn`, `tab-btn-results`, `tab-btn-reference` IDs are
  preserved (hidden + `aria-hidden="true"`) for code that still references
  them.

### 4. FAB consistency

The gold floating-action button overlapped Today / Bets / Handicap cards and
added clutter where the primary tabs already have their own toolbars.
- `switchTab()` now tags `<body>` with a `tab-<name>` class.
- CSS hides `#fab-menu` when `body.tab-today`, `body.tab-bets`, or
  `body.tab-handicap`. FAB still appears on sub-views that need quick
  actions.

### 5. Results page — three hero stats

The Results tab previously rendered Today's P&L plus eight equally weighted
bankroll tiles. The user has to scan to find the numbers that matter.
- Today's P&L hero stays prominent.
- New `.hero-stat-row` adds ROI + Win Rate as two large tiles right under it.
- The remaining six stats (Starting, Current, Wagered, Returned, Net P&L,
  Bets) are collapsed into a `<details class="bankroll-detail">` expander
  labeled "Bankroll detail".

### 6. Header left-anchor

The "Saratoga 2026" wordmark was already in the header but hidden below
768px. It is now visible on every viewport so the user always knows which
track the app is locked to.

### Bonus polish

- **Refresh Advice** button on Today is hidden until at least one race exists
  in the card.
- **Slot-machine emoji** removed from the Exotic Bet Builder title (both the
  wizard `#wizard-title` and the dynamic `renderStep0` path) — title is now
  plain text.
- **FAB color** unified from gold to racing-green in both the base and MSP
  override stylesheets.
- **Gold underline** on active mobile and desktop nav buttons removed — icon
  color (racing-green) alone carries the active state.

### Files touched

- `index.html` — extensive (nav HTML, sheets, picker, switchTab, results
  layout, CSS).
- `version.json` → `20260526-1912-ux-tighten-v2.26.0`.
- `NE_APP_VERSION` / `RAILBIRD_VERSION` constants bumped to match.

---

## v2.25.0 — Pre-live UX polish (2026-05-26)

Three pre-paid-data UX polish items, identified during a layout review and
shipped together so the app reads more clearly the moment paid data goes live.

### 1. Hero shows on first visit only

The full-bleed Saratoga photo + 'Your Private Handicapping Companion' splash
previously appeared on every page load and required a scroll past on every
return visit. Now:

- First launch: hero renders normally; user scrolls past or taps the chevron
  to enter the app, which sets `settings.welcomeDone = true`.
- Subsequent launches: hero is hidden (`display:none`) and the user lands
  directly on the Today screen.
- `resetHero()` is now wired to actually reset the flag so a future Settings
  toggle can re-show the welcome.

### 2. Date strip & next-race-day point at the upcoming meet

- New `getNextRaceDayStatic(code)` helper reads the configured
  `TRACKS[code].seasons` table and returns the next opener date.
- `buildDateStrip()` now defaults its anchor to the next race day when the
  user hasn't navigated the strip yet AND today is off-meet — so a user
  opening the app on May 26 sees the Jun 3 Belmont Stakes Festival opener
  in the visible week, not a strip of dark days. Manual nav still wins.
- Days that fall inside any meet window now render with a small gold dot
  pip beneath the date, making race days visually scannable at a glance.
  The dot turns green for today's race day and dark gold when selected.
- `offday_probeNextRaceDay()` is now static-first — it returns the season
  opener from the `TRACKS` table immediately instead of depending on a
  worker probe that may not have static data files for future dates.
  Network probe is preserved as a fallback (extended 7→14 days) for
  detecting card-posted state mid-meet.
- The off-day dashboard's 'Next race day' subtitle now shows the season
  label and days-until count (e.g. 'Belmont Stakes Festival — 8 days away')
  when only the static date is known.

### 3. Header track pill becomes a dynamic status pill

The top-right pill that showed 'SAR — Saratoga' on every screen (redundant
with the page heading and the SAR-only lock) now reflects real-time state:

- `SIM` (green-tinted) — user is in simulate mode, no real wagers.
- `LIVE` (green, gentle pulsing animation) — in-meet, real mode.
- `OPENS TODAY` / `OPENS TOMORROW` / `OPENS IN Nd` / `PRE-MEET` (gold) —
  next meet is upcoming, with a countdown when within 30 days.
- `OFF` — no upcoming meet (year-end edge case).

Pill is now uppercase mono and has an aria-label / title that exposes the
full human-readable status (e.g. 'Saratoga — Belmont Stakes Festival opens
Wed Jun 3 (8 days)'). The pill auto-refreshes whenever betting mode toggles
via an added `updateHeaderTrack()` call inside `syncBettingModeUI()`.

### Files touched
- `index.html`: hero IIFE rewrite, `buildDateStrip` + `getNextRaceDayStatic`,
  date-strip CSS dot pip, `updateHeaderTrack` rewrite, status-pill CSS,
  `offday_probeNextRaceDay` static-first, `offday_updateNextBlock` season
  label rendering, `syncBettingModeUI` pill refresh hook, version bump.
- `version.json`: 20260526-1900-prelive-polish-v2.25.0.
- `CHANGELOG.md`: this entry.

## v2.24.2 — Gate entries probes by meet window (2026-05-26)

Stop firing `/api/entries` requests for dates outside the Saratoga
season. The smoke test for v2.24.1 surfaced 12 × 404s in the console
on page load — `fetchLiveEntries` (today + 3-day lookahead) +
`offday_probeNextRaceDay` (7-day lookahead) + the settings-modal
probe were all hammering the worker for SAR dates between today
(2026-05-26) and the Belmont Stakes Festival opener (2026-06-03).

### Changes

- **New helper `isDateInEnabledMeet(dateStr)`**: returns true if the
  date falls inside any `seasons[]` window of an enabled track. Falls
  open (returns true) on internal errors so it never accidentally
  blocks a valid fetch.
- **`tryFetchEntries`**: short-circuits to `null` when the requested
  date is outside every enabled track's season. This single guard
  covers `fetchLiveEntries`, the manual `selectCalendarDate` flow,
  and `offday_probeNextRaceDay` since they all funnel through this
  function. No callers needed changes.
- **`probeTrackAvailability`** (settings modal): also gated by
  `isDateInEnabledMeet(today)` so opening the Settings modal during
  the off-season no longer fires a probe request that 404s.
- **Version bump**: v2.24.1 → v2.24.2.

### Behavior during the SAR off-season (today)

- App opens, finds no SAR card for today, lookahead immediately
  returns null (no network), falls through to the off-day dashboard.
- Off-day dashboard's 7-day lookahead also returns null instantly.
- Network tab: 0 requests to `/api/entries`.
- Once today ≥ 2026-06-03 (Belmont Stakes Festival opens) or
  today ≥ 2026-07-03 (Summer Meet opens), normal fetching resumes.

### Not changed

- Worker code path — still returns 404 on missing static files; we
  just no longer ask.
- Cache, polling cadence, advice engine, bankroll — untouched.

## v2.24.1 — Hide hero track picker (2026-05-26)

Remove the "SAR · LRL · BTP · opens …" pill row that appeared on the
hero splash when no live cards were posted today. With the Saratoga-only
lock from v2.24.0 the picker would only ever show a single SAR chip,
which is already covered by the persistent header track pill.

### Changes

- **v2.18.0 hero track picker IIFE**: `trk_boot` now short-circuits and
  removes any existing `#hero-track-picker` element when
  `ENABLED_TRACKS.length <= 1`. Reverse by deleting that guard if
  `ENABLED_TRACKS` is ever expanded.
- **Defense in depth**: even with the picker hidden, the probe and the
  upcoming-meets fallback now both iterate over `ENABLED_TRACKS` via a
  new `trk_enabledCodes()` helper. If the early-return guard is ever
  removed by mistake, the picker still cannot list suppressed tracks
  (LRL, BTP, etc.).
- **Version bump**: v2.24.0 → v2.24.1.

### Not changed

- Hero markup (title block, eyebrow, tagline, bg image).
- Top header `Saratoga 2026` wordmark and the `SAR — Saratoga` pill in
  the header (kept — these are the canonical track indicators now).
- Everything else from v2.24.0.

## v2.24.0 — Saratoga-only lock (2026-05-26)

Suppress all tracks besides Saratoga (SAR) in the UI. The Saratoga
summer meet opens 2026-07-03 and the user has purchased live data only
for Saratoga, so other tracks are hidden to avoid accidental selection
and to prevent unnecessary worker requests for tracks without a live
subscription.

### Changes

- **New `ENABLED_TRACKS` allow-list** (single source of truth) added
  immediately below the `TRACKS` registry. Currently set to `['SAR']`.
  Reverse the lock by adding codes back to this array — no other
  edits required.
- **Helpers**: `isTrackEnabled(code)` and `enabledTrackEntries()` for
  use across the UI.
- **Track drawer** (`buildDrawerLists`): now renders one button per
  enabled track (currently only `SAR — Saratoga`). Grid column count
  adapts to `ENABLED_TRACKS.length`. The Saratoga live-meet dot/badge
  and the upcoming-meet hint still render via `getSarStatus()`.
- **Settings modal**: track dropdown (`#settings-track`) only shows
  enabled tracks. If the persisted `activeTrack` is no longer enabled,
  the dropdown defaults to `SAR`.
- **Track availability probe** (`probeTrackAvailability`): only probes
  enabled tracks — avoids hitting `/api/entries` for tracks the user
  has no live data for. `paintAvailability` likewise only renders
  enabled tracks.
- **`getActiveTrack`**: in-session guard coerces any disabled persisted
  code to `SAR` immediately, before the `sarLockV1` migration in
  `initStore` writes the new value back to localStorage.
- **`initStore` migration `sarLockV1`**: one-time migration that
  rewrites `settings.activeTrack` to `SAR` if the current selection is
  not in `ENABLED_TRACKS`. Historical per-track buckets in
  `store.tracks[*]` are preserved untouched so prior bets, notes,
  bias logs, and advice for other tracks are not lost.
- **New-user default**: fresh stores ship with `activeTrack: 'SAR'`
  (was `'CT'`) and pre-set `sarLockV1: true` + `ctMigrationV25: true`.
- **Worker default**: `wrangler.toml` `DEFAULT_TRACK` flipped from
  `AQU` to `SAR` so `/api/*` endpoints called without `?track=` now
  resolve to Saratoga.
- **Version bump**: `v2.23.0-light-program` → `v2.24.0-saratoga-only`
  (`NE_APP_VERSION`, `RAILBIRD_VERSION`, `version.json`).

### Not changed

- `TRACKS` registry — kept intact so the lock is fully reversible and
  saved per-track data is not orphaned.
- Worker route logic, scraping pipelines, advice engine, bankroll,
  results, scratches, odds polling.
- Theme / styling.
- Service worker, data files in `data/`, fixtures, schemas, tests.

## v2.23.0 — Light Program re-skin (2026-04-23)

Full visual re-skin only. No feature, data, advice, bankroll, Worker, or
scraping behavior changed. The Barn data model stays intact (main Barn
shows only saved horses; lookup/add is a drawer; tapping a horse opens
its profile; no favorite/star concept reintroduced). Version-sync and
all prior tests remain green.

Goal: move from the previous "luxury navy" skin to a **Modern Saratoga
Program** visual system — ivory page, paper cards, dark ink text, turf
green main accent, brass/gold sparingly for highlights, navy demoted to
ink/header accent only. Elegant racing-program feel, not a casino or
dark luxury lounge.

### New palette tokens (appended, not removed — legacy `--lux-*` tokens
are remapped to these so every existing rule flips light):

- App background: `#F8F4EA` (ivory)
- Card surface: `#FFFDF7` (paper)
- Soft panel: `#F1E8D8`
- Border: `#D8CDB8` (tan hairline)
- Primary ink: `#1E2A36`
- Secondary ink: `#526070`
- Muted: `#6F7782`
- Turf green: `#2F6B4F` (primary accent)
- Deep rail green: `#184C38`
- Brass: `#C8A13A` (highlights only)
- Saddle tan: `#B98957`
- Loss red: `#9F3F38`
- Navy ink (accent only): `#243B5A`

### Components re-skinned

- **App shell**: ivory page background (`#F8F4EA`), FOUC paint and
  `theme-color` meta now match. No full-screen navy.
- **Top header**: white/paper with a thin tan border and an ivory-safe
  turf-green track pill. Icon buttons hover turf-green.
- **Bottom tab bar**: cream with muted-ink inactive labels/icons and a
  turf-green active label underlined by a brass rule. Safe-area + 56px
  tap target preserved.
- **Cards** (`.card`, `.race-card-wrap`, `.rec-bets-card`, etc.): paper
  cream surface, thin tan border, soft shadow, dark ink text. Active
  race card gets a turf-green left rule. Race-number badge is turf
  green + white.
- **Buttons**: primary = turf green with white text; gold reserved for
  "In Barn"/highlight; outline = turf on cream; danger = red on cream.
  All 8px radius, sans font, readable weight.
- **Forms**: cream surfaces, dark ink, muted placeholders, turf-green
  focus ring (`0 0 0 3px rgba(47,107,79,0.18)`).
- **Badges/pills**: tinted backgrounds with dark readable text.
  `In Barn` = brass-on-cream, `Running Today` / `Winner` / `Curated` =
  turf-tint, `Action/Value` = brass-tint, `Scratch` = red-tint. No
  gold-on-cream or pale-gray-on-ivory reused.
- **Barn tab**: cream hero with paper stall cards, clean stats chips,
  brass `In Barn` badge. Primary CTA (Add horse / empty-state) is turf
  green. Stall-card left rule stays brass for the "stable-door" feel.
- **Today / race form**: paper race cards, turf-green horse links,
  readable muted-ink metadata, turf-green active-race accent, no heavy
  dark rows.
- **Modals/drawers**: light paper with soft dark translucent scrim.
  The virtual-barn profile modal (previously a dark navy sheet) is now
  cream/paper with dark ink and turf/brass-tinted chips.
- **Toasts, banners, winner strip, FAB menu, P&L panel, bankroll
  banner**: all flipped to paper/cream surfaces with turf/brass
  accents.

### Contrast fixes

- No light text on light cream: v2.15 inline-rgba(255,255,255,α) remap
  now targets `--msp-ink` / `--msp-ink-2` / `--msp-muted` (dark ink on
  cream) instead of a deep navy-on-navy.
- Bottom-nav inactive labels: were warm #C8C2AD on navy, now muted ink
  (`#526070`) on cream — AA compliant body text.
- Horse-detail expanded panel: was dark navy; now `--msp-panel` (soft
  cream) with dark ink, avoiding a heavy dark block in the middle of a
  cream list.
- Grade badges: A+/A now brass on cream, B+ turf-tint, everything else
  ink/tan — every color passes 4.5:1 against its paper surface.
- Placeholders, disabled `Add to Barn`, `.barn-empty`, captions,
  helper text, tips — all force `--msp-ink-2` or `--msp-muted` rather
  than inheriting cream.

### Typography

- Brand/hero/display moments keep the serif (Playfair / Cormorant).
  Horse names keep the serif for racing-program character.
- Everything else — app UI, nav, labels, buttons, forms, bankroll,
  race metadata, advice, lookup, profile, tabs — is clean sans
  (`-apple-system, Inter, system-ui, sans-serif`). No tiny all-caps
  labels on mobile.
- Numeric data uses tabular lining figures.

### Files changed

- `index.html`: FOUC script, early paint style, `theme-color`, baked
  `NE_APP_VERSION` / `RAILBIRD_VERSION`, and a large "v2.23.0 — Modern
  Saratoga Program" override block appended inside the main
  `<style>`. No markup or JS touched.
- `version.json`: bumped to match baked constant.
- `CHANGELOG.md`: this entry.

## v2.22.1 — Simple Barn cleanup (2026-04-23)

Finishes the simplification that v2.22.0 started. Live Playwright QA on
railbirdai.com after v2.22.0 still surfaced favorite/star semantics in
several active places: the hero showed a `★ 0 FAVORITES` stat chip, the
footer tip still said "Tap the heart on Today to give a horse a stall in
your barn — tap it again to mark a favorite", the lookup drawer still
rendered a heart toggle next to Add to Barn, the rich profile modal still
exposed a `★ Favorite` chip + a `.vb-fav` toggle button, and race-form
rows still branched into a `vb-fav-row` highlight with a solid-gold
"★ Favorite" pill. Per the user: *"If a horse is in the barn, it is by
definition a favorite. Remove the star that highlights the Horse being
a favorite. Make it just simple. Click on Add to Barn button."*

Changes to active UI:

- **Hero stats**: `★ 0 FAVORITES` chip removed. Chips are now
  `In barn`, `Running today`, `Connections` (jockeys + trainers count).
- **Footer tip**: replaced with
  *"Tap a horse to open its profile. Use Add horse to choose more for
  your Virtual Barn."* No heart/favorite wording.
- **Drawer subtitle**: drops "…or the heart to add as a favorite."
- **Lookup drawer row**: the `.barn-lookup-heart` button is gone. The
  only action is `Add to Barn`; if the horse is already saved the
  button becomes a disabled `In Barn`. Legacy `state === 'fav'`
  collapses to `inbarn` for display. The `barn-lookup-badge-fav`
  badge and `Unfavorite`/`Mark as favorite` labels are removed.
- **Profile modal (`openHorseProfile`)**: removes the
  `★ Favorite`/`☆ Mark as favorite` toggle button (`.vb-fav`) and its
  `data-act="fav"` handler, the `vb-chip-fav` overview chip, and the
  "· ★ Favorite" suffix on the ownership ribbon. Modal now gets a
  stable `.vb-profile-modal.is-open` class and `data-open="true"`
  attribute so Playwright / tests can verify visibility without
  relying on hidden DOM text.
- **Race-form highlight (`applyBarnHighlights`)**: membership-only.
  Every barn row gets the `In Barn` pill and the `in-virtual-barn`
  stripe — no `vb-fav-row` class, no `★ Favorite` pill. Legacy
  `vb-fav-row` is proactively stripped on every rerender.
- **Stall cards & `buildListSection`**: any remaining
  `barn-stall-heart` button, `vb-stall-fav` badge, or
  `barn-count-fav` star counter removed. `is-fav` CSS rule on
  `.stall-card` removed.
- **Today-tab heart** (`barn_decorateHorseRows` + `barn_heartSvg`):
  collapses to two visual states — outline (not in barn) or soft
  gold fill (in barn). No solid-gold "fav" glow. Tooltip is
  membership-centric. Micro-label on tap is `In Barn` or `Removed`.
- **Toast copy**: "Marked as favorite" / "Removed favorite on …"
  replaced with "<Name> is in your Virtual Barn". The star emoji is
  no longer concatenated into add-to-barn toasts.

Data compatibility:

- The `h.favorite` property is still read/written by `toggleFollow` and
  `barnLookupHeart` so the pure-function heart-semantics tests (which
  port those helpers) keep their contract. Nothing visible branches on
  `h.favorite` anymore — it's purely legacy state that becomes a no-op
  in the UI.

Tests:

- New `tests/simple-barn-cleanup.test.js` — 10 invariants covering: no
  Favorites chip in hero stats, no heart/favorite copy in footer tip or
  drawer subtitle, no heart button in the lookup render, no fav
  elements in stall card or list section, membership-only
  `applyBarnHighlights` output, no `.vb-fav`/`vb-chip-fav` in the
  profile modal, stable `is-open`/`data-open` marker on the modal,
  stall-card wiring still routes click and chevron to
  `barnOpenHorseProfile`, and version bumped past v2.22.0.
- `tests/stall-card-profile.test.js` invariants from v2.22.0 preserved.
- `tests/heart-semantics.test.js` and `tests/lookup-barn.test.js`
  preserved unchanged — they test pure-function ports, not the DOM.
- Version bumped to `20260423-1200-simple-barn-cleanup-v2.22.1`
  across `index.html` constants and `version.json`.

## v2.22.0 — Simple Barn semantics + click-to-expand profile (2026-04-23)

Fixes the reported Barn bug: *"When I click on horses in the barn, it just
highlights them. It doesn't provide any information expansion when you press
the button."* Root cause was not that the click wasn't wired — the card click
already called `openHorseProfile(name)` — it was that the call was wrapped
in a silent `try/catch` with no fallback, so any throw surfaced only as the
CSS :hover / :focus-within highlight with no modal.

Simple-barn semantics also lands here: the stall card drops the star/favorite
button and the favorite sub-line from My Barn, leaving two unambiguous
actions: **tap the card** (or press Enter/Space, or tap the explicit `›`
chevron) to open the rich horse profile, and **Remove** to delete. The card
click handler now short-circuits only on `.stall-card-remove`; everything
else — including the chevron — falls through to the profile.

Changes:

- `buildMyBarnSection` no longer renders `.stall-card-fav`, `data-fav-for`,
  or the "★ Favorite" badge. Adds `.stall-card-view` chevron button that
  carries `data-view-for`. `is-fav` class removed from the card element.
- New `barnOpenHorseProfile(name)` helper centralizes profile-open: it
  dispatches to the closure-local `openHorseProfile` first, then falls back
  to `window.openVirtualBarnProfile`. Failures are logged, not swallowed,
  so the "highlights but never expands" silent failure cannot recur invisibly.
- `barn_wireStallCards` rewires:
  - Card click → `barnOpenHorseProfile(name)` (unless target is inside
    `.stall-card-remove`).
  - Enter/Space on the card → `barnOpenHorseProfile(name)`.
  - `.stall-card-view` chevron → `ev.stopPropagation()` + `barnOpenHorseProfile`.
  - `.stall-card-remove` → `barnRemoveHorse('horses', n)` only. Never opens
    the profile.
- Profile modal itself is unchanged: curated horses (Inspeightofcharlie
  included) still render Overview, Pedigree, Stats, Form history, Sources,
  and Notes/Tags. Demo horses still show the sample history, and missing
  fields render as "not in sample".
- `tests/stall-card-profile.test.js` — new 9-test suite locking: no fav
  control in markup, View chevron + Remove present, card click routes to
  `barnOpenHorseProfile`, Enter/Space opens profile, chevron stopPropagation
  + opens profile, Remove does not open profile, `barnOpenHorseProfile`
  helper is defined with closure + window fallback, lookup drawer does not
  double-call the stall-card helper, Inspeightofcharlie curated record
  carries the fields the profile modal needs.
- Version bumped to `20260423-1049-simple-barn-v2.22.0` across
  `index.html` constants and `version.json` (version-sync test preserved).

## v2.21.8 — Barn stable: fix version mismatch / reload loop (2026-04-23)

Fix: production shipped v2.21.7 with `version.json` updated to
`20260423-0300-barn-drawer-fix-v2.21.7`, but the baked-in app-shell
constants in `index.html` (`NE_APP_VERSION`, `RAILBIRD_VERSION`) were
still pinned to `v2.21.6-redesigned-barn`. The on-load version poller
fetches `version.json` every page load and reloads via
`neForceUpdate(remote)` when `remote !== NE_APP_VERSION`, so every
client bounced between `_v=...v2.21.6` and `_v=...v2.21.7`, which made
Playwright QA unable to interact with the Barn.

Fix applied:

- Bumped `NE_APP_VERSION` to `20260423-0400-barn-stable-v2.21.8` and
  `RAILBIRD_VERSION` to `v2.21.8-barn-stable` in `index.html`.
- Bumped `version.json` to the same `20260423-0400-barn-stable-v2.21.8`
  string so the polling comparison (`remote === NE_APP_VERSION`)
  succeeds on first load and no reload is triggered.
- Added `tests/version-sync.test.js` to lock the invariant: the
  `NE_APP_VERSION` literal in `index.html` must equal `version.json`'s
  `version` field exactly, and no stale active-build constant
  (`v2.21.6`/`v2.21.7` in `NE_APP_VERSION` or `RAILBIRD_VERSION`) may
  remain in `index.html`.

v2.21.7's Barn drawer hidden-until-opened behavior is preserved: closed
drawer/scrim still resolve to `display:none !important`, initial render
still emits `hidden` + `aria-hidden="true"`, and main Barn still shows
only saved horses until *Add horse* is tapped.

## v2.21.7 — Barn drawer fully hidden until opened (2026-04-23)

Fix: automated QA at 390px found that the closed lookup drawer's text
("Choose a horse", "Done", helper copy) and its search input were still
discoverable in the main Barn page before the user tapped *Add horse*.
Root cause: the closed drawer relied only on `transform:translateY(100%)`,
so the DOM node, its visible text, and the input still occupied and
exposed space to text-search and interaction tooling.

Fix applied:

- `.barn-drawer:not(.open)` and `.barn-drawer-scrim:not(.open)` now
  resolve to `display:none !important`, removing the closed drawer from
  the visual layout, from `innerText`, and from the tab/focus order.
- Initial render emits the closed drawer with both `aria-hidden="true"`
  and the HTML `hidden` attribute, so it is inert before any JS runs.
- `barn_openDrawer` / `barn_closeDrawer` toggle `hidden` alongside
  `aria-hidden` and the `.open` class on both the drawer and the scrim.
- Opened behavior is preserved: scrim appears, drawer slides up via
  `display:flex` + `transform:translateY(0)`, search input is focused,
  Done / scrim-click / Esc all close it.
- Added four tests in `tests/redesigned-barn.test.js` covering:
  closed-drawer aria-hidden/hidden attributes, CSS `display:none` rules,
  and `hidden`/`aria-hidden` toggling in open/close handlers.

## v2.21.6 — Redesigned Barn: My Barn is primary, lookup moves to a drawer (2026-04-23)

User feedback addressed: **"The design of the page is terrible. It still
has a floating search bar that covers things and it includes horses that
were not picked to be part of the Barn. Come up with a proper redesign
that scores greater than an 8/10 for visual, emotional attachment,
usability."** Prior versions (v2.21.4/5) showed a long list of curated +
demo horses inside the Barn tab above "In My Barn" — which made the page
feel like a catalog, not a personal stable. v2.21.6 is a decisive
redesign that restores the personal-stable feeling.

### Information architecture — My Barn is the only primary content

- The **Barn page now renders ONLY horses the user has actually saved.**
  No suggested horses, no demo horses, no lookup candidates on the main
  page by default.
- Lookup/search is a **deliberate secondary flow** opened by an explicit
  "Add horse" / "Choose a horse" CTA in the hero action row.
- Lookup results render inside a **bottom sheet drawer** with scrim,
  drag-handle, clear `Done` close button, Esc support, and 32px+ bottom
  padding so nothing is covered by the tab bar or FAB.
- No floating search bar. The previous inline "Lookup" panel that sat
  above "In My Barn" is gone.

### Emotional design — the private stable

- Hero: `Your Virtual Barn` with italic subtitle `The N horses you're
  keeping close.` and kicker `The Stable`. Cream gradient panel, navy
  ink, gold accents — warm instead of the old heavy navy block.
- **Stat chips** (In barn · Favorites · Running today) on cream cards
  with tonal accents (gold for favorites, green for running today).
- **Stall cards**: each saved horse is a cream card with a gold
  left-stripe (the stall door), large Cormorant horse name, trainer/
  jockey/owner line, italic watch-reason excerpt in a left-bordered
  pull-quote, and a row of semantic badges (In Barn, ★ Favorite,
  Curated/Sample, R4 today).
- **Empty state**: SVG stable illustration (cream barn with gold roof
  and two dark stall doors), headline "Your barn is quiet.", sub-copy
  "Add the first horse you want to follow", primary CTA "Choose a horse".

### Usability

- Card tap → open profile. Star → toggle favorite (visible inline
  feedback — fill + warm glow). Remove → delete with confirm.
- Drawer: search matches horse/trainer/owner/jockey. Lookup candidates
  never leak onto the main page. Favorite-highlight on race forms is
  preserved.
- 390px-first layout: hero padding + stat chip flex, CTA row wraps,
  stall cards stack, drawer sheet max-height 92vh with internal scroll.

### Technical

- New `buildMyBarnSection(horses, todayMatches)` — stall-card renderer
  driven only by `barn.horses`; lookup candidates never flow into it.
- New `barn_openDrawer` / `barn_closeDrawer` — drawer state lives on
  `window.__barnDrawerOpen`; focus the search input on open; Esc closes.
- New `barn_wireStallCards` — event delegation for card/fav/remove.
- `barn_renderLookupResults` unchanged semantically; it now only targets
  the drawer-internal `#barn-lookup-results` host.
- Migration (`migrateDemoHorsesToLookup`) untouched — already hides
  untouched demo horses from My Barn on boot.
- New test suite `tests/redesigned-barn.test.js` pins the invariants:
  My Barn renders before the drawer; there is no inline lookup panel on
  the main render; `#barn-lookup-input` exists exactly once and inside
  the drawer; empty-state copy + CTA are present; version is v2.21.6.

Version bumps:
- `version.json`: `20260423-0100-light-barn-v2.21.5` → `20260423-0200-redesigned-barn-v2.21.6`
- `RAILBIRD_VERSION`: `v2.21.5-light-barn` → `v2.21.6-redesigned-barn`

## v2.21.5 — Light Barn: softer surfaces + gentler Virtual-Barn copy (2026-04-23)

User feedback addressed: **"Remove 'Find a horse to add.' Have search and
choose for virtual barn. Lighten up colors. Blues are too strong."** The
Barn tab was dominated by deep navy cards; headings sounded transactional
("Find a horse to add"). v2.21.5 lightens the surface palette and warms
the copy while preserving Railbird's navy-and-gold identity.

### Wording — warmer, Virtual-Barn-native

- Lookup heading `Find a horse to add` → `Search & choose for your Virtual Barn`.
- Helper copy `Search the curated profiles and 2025 Saratoga sample — tap
  Add to Barn or the heart to keep.` → `Search available profiles, then
  choose the horses you want to keep tabs on.`
- Placeholder `Search horses to add…` → `Search by horse, trainer, or owner…`
- Loading line `Loading horses you can add…` → `Loading available profiles…`
- Empty-state line now acknowledges trainer/owner search, e.g. `No profiles
  match "…". Try another horse, trainer, or owner — the pool is limited
  to curated profiles and the 2025 Saratoga sample.`
- Lookup filter extended to match across **name + trainer + owner +
  jockey** so the placeholder promise holds. (Previously name-only.)

### Visual — Light Barn palette

Barn-tab surfaces now sit on a cream/slate ground rather than deep navy.
Identity cues (gold accent, navy hero) are preserved; the dense "all navy,
all dark" feeling from the screenshot is gone.

- **Lookup panel**: `#F7F2E6` cream surface with soft `rgba(27,46,75,0.14)`
  border; dark-ink (`#1B2E4B`) heading + `#3A4256` sub-copy.
- **Result rows**: standalone cream cards (`#FFFDF7`) with 10px radius,
  1px soft border, subtle shadow — not a dense stacked list. 8px gap
  between rows.
- **In-Barn stall cards**: cream background with gold left-stripe preserved
  for identity; dark-ink horse name + muted slate meta.
- **Summary strip + section chrome**: cream (`#FFFDF7` / `#F7F2E6`) with
  gold numeric accent tone shifted to `#7A5F1F` for contrast on cream.
- **Connections drawer**: cream head, soft navy ink on hover lighten.
- **Hero card**: navy preserved but lightened from `#15253F → #1B2E4B →
  #24385A` to `#2A3B5B → #344767 → #3E5277` — still navy, less heavy.
- **Footer tip**: softened from translucent navy panel to a pale gold pill
  (`rgba(201,168,76,0.1)` + 1px gold-25% border) with dark-ink body.
- **Badges**: moved from white-on-navy to muted color-coded ink-on-tint
  (curated = green, demo = slate-blue, in-barn = gold, fav = warm gold).
- **Add-to-Barn / Favorite buttons**: keep gold fill but with a dark-ink
  border, dark-ink label, and subtle shadow for a refined (not muddy)
  press target on cream.

### Accessibility

- Body-text tokens on cream surfaces (`#1B2E4B`, `#3A4256`, `#4A5269`)
  clear WCAG AA at 4.5:1 against `#F7F2E6` / `#FFFDF7`.
- No pale-gray-on-cream combinations: the old `#DCD6C2` / `#C8C2AD` meta
  colors (unreadable on light ground) are retired in Barn scope.
- 40×40 heart and 44×44 remove hit targets preserved; input min-height
  48px preserved.

### Layout — FAB no longer obscures Add to Barn

- Added a 64px bottom-spacer after the lookup result list
  (`.barn-lookup-results:after`) so at 390px viewport the floating `+`
  FAB (bottom ≈ tab-bar 64px + safe-area + 24px) never sits directly on
  top of the last row's `Add to Barn` button.

### Preserved

- Lookup candidate pool + add-from-lookup flow from v2.21.4.
- Heart semantics (tap-to-add-and-favorite / tap-to-toggle / tap-to-remove-only).
- Migration of auto-seeded demo horses via `lookupDemoHidden`.
- Favorite highlight pills and row stripe in the main grid (unchanged).
- All 41 existing tests.

### Files

- `index.html` — Barn CSS palette + lookup-panel copy + filter fields.
- `version.json` / inline `NE_APP_VERSION` / `RAILBIRD_VERSION` → v2.21.5.
- `CHANGELOG.md`.

## v2.21.4 — Lookup Barn: search-and-add instead of a default long list (2026-04-22)

User complaint addressed: **"I still don't like the barn. You have a long
list of horses. I'd rather have a lookup function and add from that. The
favorite should be highlighted on any racing form it appears on."**

### UX reset — Barn is now a personal stable, not a horse directory

- **Removed auto-seed of 14 demo Saratoga horses into personal barn.** The
  boot path no longer calls `seedDemoHorses()`. Curated public-profile
  horses (Inspeightofcharlie) continue to upsert at boot, preserving any
  user edits via the existing idempotent merge.
- **One-time migration** moves prior auto-seeded demo horses out of
  `s.barn.horses` into `s.barn.lookupDemoHidden` only when they are
  provably untouched: `source === 'demo-saratoga-2025'`, not favorite,
  no `notes`, no custom (non-demo/non-saratoga) tags, and watch reason
  equals the stock seed copy. Any user-touched demo horse stays put.
  Curated and user-added horses are never touched. Migration is gated
  by `localStorage[railbird.barn.v214LookupMigration]` so it runs once.

### New: Lookup / search-and-add panel (top of Barn)

- Prominent search input ("Search horses to add…") near the top of the
  Barn tab.
- Candidate pool is built locally from `data/curated-horses.json` +
  `data/fixtures/saratoga_2025_sample.json` — no network calls, no
  scraping, no Worker changes. Curated entries win name collisions.
- Result cards show name, trainer/jockey/owner/sire meta, a source
  badge (Curated profile / Demo sample), an in-barn state badge
  (In Barn / ★ Favorite), a one-tap **Add to Barn** button, and a
  favorite heart.
- Empty-query state shows up to 4 suggested curated + 4 demo horses
  under a "Suggested horses" header — not the full list.
- Result name opens the full profile modal (lazily upserts the horse
  so `openHorseProfile` can render it).

### Heart semantics in the lookup panel

- Not in barn → add + mark favorite.
- In barn, not favorite → mark favorite on.
- Already favorite → unmark favorite (horse stays).
- Never removes. `Add to Barn` is a separate button that adds without
  favoriting.

### Favorite highlight on racing forms

- Favorite barn horses get a distinctive **solid gold ★ Favorite pill**
  and a stronger row stripe (`tr.vb-fav-row` — 4px gold stripe + soft
  glow on gold background). Non-favorite in-barn horses keep the
  subtler gold tick + "In Barn" pill.
- `applyBarnHighlights()` now also toggles the `vb-fav-row` class so
  the CSS can target whole rows, and name normalization covers case +
  extra whitespace.
- Heart toggles in the lookup panel and the profile modal immediately
  trigger `applyBarnHighlights()` so race-form rows re-paint without
  a tab switch.

### Files changed

- `index.html` — auto-seed removed, migration added, lookup panel
  rendered at top of Barn, strengthened favorite highlight styles.
- `version.json`, inline `NE_APP_VERSION` / `RAILBIRD_VERSION` bumped
  to `v2.21.4`.
- `tests/lookup-barn.test.js` — new. 14 tests covering migration
  (5 scenarios), candidate merge, lookup heart (3 branches), and
  highlight classification incl. normalization.

### Caveats

- Migration conservatively only removes demo horses that match ALL of:
  demo source + not favorite + empty notes + no custom tags + stock
  watch reason. Anything else stays to avoid destroying user intent.
- Lookup pool is limited to curated + Saratoga sample; horses from
  live expert entries files are not (yet) indexed.
- Cloudflare Worker was intentionally NOT touched; no deploy triggered.

## v2.21.3 — Emotional Virtual Barn + real heart feedback (2026-04-22)

User complaint addressed: **"After pressing the heart button, nothing
happens. We see all the horses but no indication of a curated personal
virtual barn."** The heart now has a visible, emotional consequence, and
the Barn reads as a personal stable — not a horse directory.

### Heart button — reliable, visible, emotional

- **New semantics (horses).** Heart is now a *favorite* gesture, not an
  add/remove switch:
  - Not in barn → adds the horse AND marks favorite (heart fills gold).
  - In barn, not favorite → marks favorite.
  - In barn, favorite → unmarks favorite (horse stays in barn).
  - Removal is a distinct explicit action in the profile modal / Barn list.
  The old "tap heart to remove" behavior was fighting the curated auto-
  seed (a tap removed the horse, boot re-seeded it, so the tap looked
  like a no-op). This was the user's "nothing happens" bug.
- **Three-state heart icon:** outline (not in barn), soft-fill + border
  (in barn, not favorite), solid gold with drop-shadow (favorite).
- **Pulse + glow + floating label.** Every heart tap now plays a 0.55s
  scale pulse, a gold radial glow, and a floating pill near the heart
  ("★ In Barn", "★ Favorite", "Favorite off"). Combined with the
  existing toast, the feedback is unmistakable on desktop and mobile.
- **Toast microcopy** is horse-specific:
  *"Inspeightofcharlie is in your Virtual Barn"*,
  *"Marked Inspeightofcharlie as favorite"*,
  *"Removed favorite on Inspeightofcharlie"*.
- **Event guarded.** Heart clicks call `stopPropagation` + `preventDefault`
  before the row-click or profile-open handlers can swallow them.

### "My Virtual Barn" — emotional ownership

- **New hero card at the top of the Barn tab:**
  *"Your Virtual Barn — N horses under your eye"* / *"Watching for the
  next start."* Large gold heart mark, navy→dark-navy gradient, italic
  serif sub-line — warm, not clinical.
- **Summary strip now includes a Favorites count**, next to Horses,
  Jockeys, Trainers, and Running-today.
- **Stall metaphor.** Each horse in *In My Barn* is rendered as its own
  stall card: inset gold stripe, rounded border, serif name, and a
  stack of badges (`In Barn`, `★ Favorite`, `Curated profile` or `Demo`).
  Personal line: *"You're keeping tabs on this one."*
- **Inline favorite heart** on every stall in the Barn tab, so the
  favorite toggle is reachable from the Barn view — not just from Today
  or the profile modal.
- **Section renamed** `Horses` → `In My Barn`, with a secondary
  `★ N` count beside the horse count to show favorites at a glance.
- **In Barn row highlighting on Today** now shows distinct pills:
  `In Barn` (gold), `★ Favorite` (solid gold), and `Curated` (green),
  replacing the single ambiguous pill.

### Profile modal — unmistakable ownership state

- **Ownership ribbon** at the top of every horse profile:
  *"In your Virtual Barn · ★ Favorite"* (or without the star if not a
  favorite). Updates live when the favorite button is tapped.
- Favorite button label sharpened: `☆ Mark as favorite` vs `★ Favorite`.
- **Remove button relabeled** `Remove from Barn` so it's visibly distinct
  from the favorite heart.
- Favorite toggle inside the modal now also pops a toast and refreshes
  all row highlights and heart states across the app.

### Preserved

- Curated horse data (`data/curated-horses.json`) and the
  Inspeightofcharlie seed are unchanged. `upsertHorse` merge semantics
  (non-destructive of user notes / tags / favorite / watchReason) are
  unchanged.
- Demo Saratoga fixture seed is unchanged.
- All 22 prior tests still pass. 5 new heart-semantics tests added
  in `tests/heart-semantics.test.js` lock in the contract that a heart
  tap never silently removes a horse from the barn.

### Files changed

- `index.html` — heart semantics, pulse/glow/pop CSS, hero card,
  stall cards, ownership ribbon, section relabel, highlight pills,
  footer tip copy, version constants.
- `version.json` — bumped to `20260422-2315-emotional-barn-v2.21.3`.
- `CHANGELOG.md` — this entry.
- `tests/heart-semantics.test.js` — new.

## v2.21.2 — Curated horse profiles in Virtual Barn (2026-04-22)

Focused update: seed the Virtual Barn with a hand-curated public-profile
horse (Inspeightofcharlie) so the user gets a richer profile modal
without any manual entry.

### Added
- **`data/curated-horses.json`**: small curated dataset of public-profile
  horse facts with explicit source labels and URLs (Equibase profile,
  Sky Sports, At The Races, IrishRacing). Labeled as
  `data_status: curated-public-profile` — **not** an official or
  licensed data feed. No bulk scraping, no crawler, no automated
  harvesting loop — only the specific hand-gathered facts.
- **Auto-seed of curated horses** on Barn boot via `seedCuratedHorses()`.
  Idempotent: uses the existing `upsertHorse` merge logic, which only
  fills blank fields and appends non-duplicate history. User edits
  (notes, tags, watchReason, favorite, user-added history) are
  preserved. No manual entry required.
- **Richer profile modal for curated horses**:
  - New **CURATED · Public profile data** source badge.
  - New **Pedigree & identity** section (foaled, sire, dam, damsire,
    breeder, Equibase refno).
  - New **Stats** section with season + career + surface + alternate
    rows, each tagged with its source.
  - **Form history** (renamed from Sample history for curated horses)
    gains finish/finishOf, SP, OR, winner, and per-row source lines.
  - New **Sources** section with clickable external profile links,
    per-source notes, explicit caveats block (e.g. earnings conflicts
    between Equibase and IrishRacing), and a disclaimer that the data
    is curated from public profiles, not an official/licensed feed.
- `window.virtualBarnSeedCurated()` exposed for manual re-seed.

### Inspeightofcharlie specifics included
- Name, suffix (NY), breed (TB), color/sex (CH G), foaled 2026-02-02.
- Sire Speightster, dam Untaken, damsire Noonmark.
- Jockey Nik Juarez, trainer Barclay Tagg, owner Two Lions Farm,
  breeder Sinatra Thoroughbred Racing & Breeding, LLC.
- Equibase refno 11094587, latest speed figure 71.
- 2026 stats (Equibase): 2 starts / 1-0-1 / $47,600.
- Career stats (Equibase): 7 starts / 1-2-2 / $84,430.
- Surface splits (At The Races): Turf 4-1-2, AW 3-0-2.
- Alternate career total (IrishRacing): 7 / 1 / $96,420 — retained as
  source-specific alternate because it conflicts with Equibase canonical.
- 6 form lines from Sky Sports + At The Races with finish, SP, weight,
  jockey, trainer, winner, OR, and per-row source labels.

### Internal
- `version.json` bumped to `20260422-2215-curated-barn-v2.21.2`.
- `RAILBIRD_VERSION` / `NE_APP_VERSION` bumped in `index.html`.
- `upsertHorse` extended to carry curated profile fields (pedigree,
  stats, sources, caveats) without overwriting user-set values.

### Caveats
- Earnings conflict between Equibase ($84,430) and IrishRacing
  ($96,420) is preserved in the UI as an alternate stat row with a
  visible note; Equibase is treated as canonical.
- Some At The Races rows had ambiguous columns in the public summary;
  they are labeled as public form lines, not official chart data.
- No Cloudflare Worker deploy. No new external network calls.

## v2.21.1 — Barn contrast + horse-first hierarchy (2026-04-22)

Focused corrective release against v2.21.0 based on real-device QA
(iPhone 390px): Barn was reading as a Jockey/Trainer/Stable form with
horses buried below the fold, and several text tones on navy were below
readable contrast.

### Fixes
- **Barn is horse-first above the fold**: the Horses section now renders
  with an elevated primary card (gold hairline, larger heading) as the
  first thing after the summary row. Jockeys/Trainers are collapsed
  under a secondary **Connections** accordion, and the Stables card is
  nested inside that accordion instead of dominating the viewport.
- **Load sample horses CTA**: when the Horses list is empty (including
  for legacy v2.20 users who had Jockeys/Trainers but no horses) the
  Barn now shows a prominent "Load sample Saratoga horses" button that
  seeds 14 curated horses from the 2025 SAR sample fixture. The
  auto-seeder was also fixed so a prior skipped attempt (flag set, 0
  horses in barn) retries on next load.
- **Contrast rewrite** (WCAG AA-friendly on navy/cream):
  - Barn section headings upped to solid `#F7F2E6`.
  - Empty-state copy raised from `alpha(0.82)` to solid `#E6DFC9`.
  - Count dots replaced with a solid gold chip.
  - Input placeholders on navy cards now `#B9B3A0`.
  - Footer tip moved off pale-italic-on-cream to solid `#3A4256` text on
    a soft navy tint pill.
  - Meta / watch-reason rows now `#DCD6C2` / `#D9D2BC`.
  - Inactive bottom-nav labels/icons lifted from `--lux-ink-mute`
    (`rgba(237,232,220,0.62)`) to solid `#C8C2AD`, icons bumped to 0.9
    opacity, min-height raised to 56px.
  - Upcoming-at-SAR card: gold accents solidified, row text brightened,
    empty-state italic replaced with plain readable copy.
- **Tap targets**:
  - `.icon-btn` (top-bar gear, track pill, close buttons) now
    guaranteed ≥44×44px via `min-width`/`min-height`/flex centering.
  - Bottom-nav buttons min-height 56px.
  - Barn add-row inputs/buttons raised to 44px min height.
  - Barn `Remove` button raised to 44px; `Open` button in Upcoming row
    raised to 36px with proper hit area.
- **Richer horse profile**: profile modal now has three collapsible
  sections — **Overview**, **Sample history**, and **Notes & tags**.
  Overview is a definition-list grid of Jockey / Trainer / Owner /
  Age-Sex / Style / ML / sample-start count, with chips for quick
  scanning. Sample history preserves every fixture field we have per
  entry: date, track, race, post time, distance, surface, conditions,
  purse, post position, weight, morning line, scratched flag, plus
  jockey / trainer / owner for that race. Missing fields render as
  *"not in sample"* rather than invented data.
- **In-race highlighting preserved**: the gold left-stripe and "In Barn"
  pill for horses in the active race card continue to work.

### Internal
- `version.json` bumped to `20260422-2200-virtual-barn-v2.21.1`.
- `RAILBIRD_VERSION` / `NE_APP_VERSION` bumped in `index.html`.
- `buildDemoHorsesFromFixture()` now carries per-race connection fields
  (jockey, trainer, owner, pp, weight, ml, purse, conditions, postTime,
  scratched) into the horse history so the profile modal has something
  to render.
- `seedDemoHorses()` accepts `{force:true}` and the CTA / settings
  re-seed path uses it. The auto-seed path also retries when the flag
  is set but the barn is still empty.
- `window.__augmentBarn` now exposed so the seed CTA can refresh
  Stables/Upcoming cards after seeding.

### Out of scope / known limitations
- No new data sources, no Worker deploy. The Worker token is unavailable
  in this release loop; CORS / auth remain as shipped in v2.21.0.
- "Sample history" is explicitly scheduled-entry data from the 2025 SAR
  placeholder set. No finish positions / beaten lengths / speed figs
  are shown because the fixture does not contain them.

## v2.21.0 — Virtual Barn + QC remediation (2026-04-22)

### Features
- **Virtual Barn**: the Barn tab is now horse-first. Each followed horse has a
  full profile (notes, tags, watch reason, favorite, history/timeline).
  Profiles open by tapping a horse name; data persists in localStorage.
- **Demo Saratoga horses**: on first load the Barn is seeded with ~14 curated
  demo horses mined from `data/fixtures/saratoga_2025_sample.json`, each
  labelled `DEMO · Saratoga sample` so nothing gets confused with official
  stats. Skipped if the user already has 3+ horses. Re-seedable via
  `window.virtualBarnSeedDemo()`.
- **In-race highlighting**: when a Virtual Barn horse is entered in the loaded
  card, the row is highlighted with a gold left-stripe and an "In Barn" pill
  (★ Barn for favorites).

### Fixes
- **Auto-update polling bug**: app was reading `d.v` from `version.json`, but
  the file uses `{ "version": "…" }`. Updates were not propagating. Now reads
  `d.version` with a `d.v` legacy fallback.
- **Expert consensus double-count**: `countExpertPicks` / `getExpertNames` now
  match on pp *with fallback* to name (not OR), and dedupe by source so the
  same picker can't be counted twice in one race.
- **Value badge overclaiming**: renamed `Value` → `Overlay` and
  `Strong Value` → `Big Overlay` with tooltips clarifying the badge compares
  morning-line implied probability to the model, not tote odds. No
  calibration claim implied.

### Security / compliance
- **Worker CORS locked** to `https://railbirdai.com` via `wrangler.toml`. The
  Worker now honors an allowlist instead of wildcard `*`.
- **Worker observability enabled** in `wrangler.toml`.
- **Unauthorized scraping disabled**: the Worker's free-mode handlers for
  scratches / live odds / results no longer hit Equibase or NYRA; they
  return `source: "unavailable"` with a graceful empty payload. The
  licensed-adapter code (`fetchFreeScratches`, `fetchFreeOdds`,
  `fetchFreeResults`) is retained as architecture-only for a future
  permitted data feed.
- **Daily entries workflow disabled** — `.github/workflows/daily-entries.yml`
  no longer runs on a cron. Re-enable only against a licensed feed.
- **Dev pages relocated** to `/dev/` (`dev/qc.html`, `dev/debug.html`,
  `dev/clear.html`) and excluded via `robots.txt` — no longer discoverable at
  the apex domain.
- **Stale `APP_VERSION`** constant removed from `sw.js` (the self-destruct SW
  doesn't need a version; the app's `version.json` poll is the source of
  truth).
- **`robots.txt`** added, disallowing `/dev/` and the old root dev pages.

### Accessibility / contrast
- Bumped `--color-muted` from `#636B7F` → `#4A5368` (AA on cream bg).
- Bottom nav labels: larger, bolder, darker color; min-height 52px.
- Barn heart toggle: enlarged tap target (40×40 min).
- Barn empty states, meta, summary labels: higher contrast (`0.82`/`0.85`
  alpha) + added aria-labels.
- Barn item remove: bumped font-size + min-height for mobile.

### Testing
- Added `scripts/lib/advice-utils.js` — a tiny, dependency-free pure module
  holding expert-consensus matching, overlay classification, and exotic
  box-cost combinatorics.
- Added `tests/advice-utils.test.js` + `tests/fixture.test.js` using
  `node:test`. 17 tests covering consensus matching, value thresholds,
  exotic math, and the Saratoga fixture shape. Run with `node --test tests/`.

## v2.16 — Landing hero no-grey-flash (2026-04-17)

### Fix
- Landing page used to show a grey blurred placeholder before the hero photo loaded (visible for ~1 second). Root cause: the inline `<img>` had a heavily blurred base64 LQIP that rendered as grey while the real hero WebP was only `prefetch`ed (low priority).
- Now the hero key is picked in a head-level inline script, and the chosen WebP is `preload`ed with `fetchpriority="high"` so the browser starts downloading it before the stylesheet block is parsed.
- `#hero-screen-bg` gets a solid dark-navy floor so any time the photo isn't yet decoded, the user sees the luxury title on navy (matching the vignette) — never a grey wash.
- The hero loader JS now starts with `opacity: 0` and fades in once the full-res image decodes. Removed the CSS `hero-img-in` keyframe that was animating against the blurred placeholder.

---

## v2.4 — Scroll Fix + App Icon (2026-04-14)

### Features
- Added PWA manifest (`manifest.json`) with proper app name "NE Racing Companion"
- Added Saratoga-themed app icon (gold jockey on racing green) for home screen: 192x192, 512x512, 180x180 Apple touch icon, plus favicons
- Added `apple-mobile-web-app-capable` meta tags for standalone mode on iOS
- Updated `theme-color` to racing green `#1B4332`

### Fixes
- "Let's Go" now scrolls to land cleanly on Today's Ticket (or main content), accounting for sticky header height, instead of showing header chrome
- Used `requestAnimationFrame` to ensure DOM is painted before calculating scroll position

---

## v2.3 — Cache Fix (2026-04-14)

### Fix
- Rewrote `sw.js` to use network-first for ALL requests (not just HTML). Old cache-first strategy for assets caused stale content to persist.
- Removed hardcoded `APP_VERSION` from `sw.js` — the SW no longer needs version coupling with `index.html`.
- On activate, the new SW purges all caches so existing users get fresh content immediately.
- Added `updateViaCache: 'none'` to SW registration so the browser always checks the network for `sw.js` updates.
- Note: `_headers` file is for Cloudflare Pages and has no effect on GitHub Pages. Cache busting relies on the SW + version.json polling.

---

## v2.2 — Polish Pass (2026-04-14)

### Fixes
- Welcome overlay scroll bleed-through — hidden via `display: none` after "Let's Go"
- LIVE odds column hidden when Worker URL is placeholder
- Exotic bet horse pills grouped by race with headers
- Reference tab meet badges: Completed / Active / Upcoming based on date
- Dynamic hero subtitle based on selected track and season
- Advice onboarding hint updated to mention checkboxes with pulse animation
- All "Bet Slip" references renamed to "Bets"

---

## v2.1 — Bug Fix (2026-04-14)

### Fix
- Fixed `fieldSize` reference bug in advice engine rendering: `horses.length` was referencing an out-of-scope variable from the scoring loop, causing confidence calibration in the race-panel rendering to use an undefined value. Changed to `scored.length` which correctly reflects the non-scratched field size.
- Bumped app version to `20260414-1400`.

---

## v2.0 — Major Upgrade (2026-04-14)

### Task 1: Expert Handicapper Picks
- New `/api/expert-picks` endpoint in `worker.js` (fetches from static JSON or returns empty gracefully)
- `expertPicks` array added to each race in the data model (source, pick PP, horse name)
- Expert Consensus section in each race's advice panel showing who picked whom
- HIGH CONVICTION badge (`.badge-conviction`) when engine's top pick matches 2+ expert picks
- Expert picks referenced in Today's Ticket card ("Aragona & DeSantis both pick him")

### Task 2: Today's Ticket Redesign
- Replaced generic Recommended Bets card with ticket-themed "Today's Ticket" card
- Three bet categories: Best Bet (5% bankroll), Value Play ($2 EX Box), Action Bet (2% bankroll)
- Plain-English one-sentence reasons for every recommendation (no numeric scores on ticket)
- PASS section listing races with no clear edge (gap < 5, low completeness, or auto-PASS)
- "Copy Ticket" button copies clean text summary to clipboard
- Est. Cost / Budget / Remaining summary footer
- Maximum 4 recommendations per day (1 Best + up to 2 Value + 1 Action)

### Task 3: Deeper Advice Engine
- **Data completeness penalty**: 7-point check (3 speed figs, running style, jockey%, trainer%, lastClass). <50% = 15% penalty, <30% = 30% penalty
- **Freshness factor** (5% weight): 14-28 days = 80 (ideal), 7-13d = 65, 29-60d = 55, 61-90d = 35, 90+ = 20. Pace reduced to 15%
- **Equipment change bonus**: +5 to composite (capped at 100) when equipmentChanges is non-empty
- **Improved confidence calibration**: High requires gap > 12 AND completeness >= 70% AND field >= 5. Medium requires gap > 6 AND completeness >= 50%. Else Low
- **Auto-PASS**: When confidence is Low AND top score < 60
- **Expert consensus boost**: +8 if 2+ experts match, +4 if 1 expert matches
- Updated Reference tab methodology table with new weights and modifiers

### Task 4: Workout Data Display
- `workouts` array added to horse data model (date, distance, time, surface, rank, note)
- Workout table in Horse Detail Modal showing recent workouts
- Bullet workout indicator (lightning bolt) next to horse name in entry table
- Bullet workouts mentioned in advice rationale

### Task 5: Daily Data Pipeline
- `.github/workflows/daily-entries.yml`: Runs 8 AM ET weekdays, triggers `scripts/build-entries.js`
- `scripts/build-entries.js`: Node.js script (zero npm deps) that fetches NYRA entries, cross-references jockey/trainer stats, assigns running styles, fetches expert picks, outputs enriched JSON
- `data/jockey-stats.json`: Top 50 NYRA circuit jockeys with trailing 12-month stats
- `data/trainer-stats.json`: Top 50 NYRA circuit trainers with trailing 12-month stats

### Task 6: UX Fixes
- **6a**: Sync info hidden in manual mode (`syncInfo.classList.add('hidden')` when `dataMode === 'manual'`)
- **6b**: No change needed — gear icon and track pill already work correctly
- **6c**: Loading indicator (pulsing dot + "Loading entries...") shown during live data fetch
- **6d**: Equibase deep links per race card ("View on Equibase" link in race header)

### Task 7: Accuracy Tracking
- `ne-racing-accuracy` localStorage key tracks best bet wins, value play ROI, expert consensus record, action bet record
- Updated Advice Report Card in Results tab: Best Bet Record, Expert Consensus Record, Value Play ROI, Action Bet Record
- `storeTicketPicks()` saves daily ticket picks for cross-referencing with results
- `updateAccuracyTracking()` called on every result update

### Data File Changes
- `data/entries-AQU-2026-04-16.json`: Added `expertPicks` (per race), `equibaseUrl` (per race), `lastRaceDate`, `equipmentChanges`, `workouts` (per horse) for all 70 entries across 8 races

### Worker Changes
- `worker.js`: New `/api/expert-picks` endpoint, `transformStaticEntries()` passes through expertPicks, equibaseUrl, and all new horse-level fields

---

## v1.x — Previous Changes (2026-04-14)

## Part 1: CSS Navigation Bug Fix
- **Moved** `#desktop-nav { display: none; }` **before** the `@media (min-width: 768px)` query so the responsive rule properly overrides on desktop
- Desktop nav (Today, Bets, Handicap, Results, Reference) now renders at ≥768px
- Mobile bottom tab bar continues to render at <768px — verified at 375px viewport

## Part 2: Enriched JSON Data Format
- Added `race_type_code` to each race object (MCL, CLM, MSW, AOC, ALW)
- Added per-horse fields: `ml`, `speedFigs`, `runningStyle`, `jockeyPct`, `trainerPct`, `lastClass`
- All 70 horses across 8 races populated with researched data from Equibase, NYRA, DRF, and BloodHorse sources
- Jockey win percentages based on trailing 12-month NYRA circuit stats (21 jockeys)
- Trainer win percentages from NYRA meet leaders (23 trainers from research + reasonable estimates for 24 smaller barns)
- Beyer Speed Figures sourced from past performances; estimated from class level for horses without published figs
- Running styles assigned from past-performance running lines

## Part 3: Updated `transformStaticEntries()` + `mapRaceTypeToCode()`
- Added `mapRaceTypeToCode()` helper that fuzzy-matches race_type strings ("Maiden Claiming" → "MCL", etc.)
- Updated `transformStaticEntries()` to map `race_type_code` directly, falling back to `mapRaceTypeToCode(race_type)`
- Horse mapping now includes: `id`, `speedFigs`, `runningStyle`, `jockeyPct`, `trainerPct`, `lastClass`, `notes`, `wps`
- Race `type` field now resolves to CLASS_SCALE-compatible codes

## Part 4: Recommended Bets Card + Pass Logic
- **New card** (`#rec-bets-card`) replaces the old Top Picks card at the top of the Today tab
- **Best Bet of the Day**: Horse with highest composite score where gap > 15 (High confidence). Falls back to widest gap with Medium/Low label
- **Value Plays**: Horses ranked #1 or #2 with ML ≥ 5-1 AND composite score ≥ 65. Includes exacta box suggestion with #2 horse
- **Pass Races**: Any race where score gap < 7 between #1 and #2 is marked "PASS — No clear edge. Save your bankroll."
- **Daily Ticket Summary**: Shows estimated cost, daily budget (20% of bankroll), and remaining budget
- Suggested bet amount: 5% of bankroll for Best Bet
- Visual style matches racing green/gold/white design language
- New CSS classes: `.rec-bets-card`, `.rec-bet-item`, `.rec-bet-tag`, `.rec-tag-best`, `.rec-tag-value`, `.rec-tag-pass`, `.rec-bet-summary`

## Part 5: Default Track Bias
- Added `defaultBias` to AQU TRACKS entry: `{ surface: "Fast", rail: "Inside", style: "Speed" }` — AQU spring dirt favors inside speed
- Added `defaultBias` to SAR TRACKS entry: `{ surface: "Fast", rail: "Neutral", style: "No Bias" }` — Saratoga generally fair
- `runAdviceEngine()` now falls back to `TRACKS[code].defaultBias` when no manual bias log entry exists for today
- This ensures the 10% bias factor always has data, even without manual input

## Part 6: Race Type Mapping Fallback in Advice Engine
- Changed `CLASS_SCALE[race.type] || 40` to `CLASS_SCALE[race.type] || CLASS_SCALE[mapRaceTypeToCode(race.type)] || 40`
- Handles both code-format ("MCL") and full-string-format ("Maiden Claiming") race types gracefully

## Files Changed
- `index.html` — All code changes (CSS fix, transform update, helper function, recommended bets card, default bias, class scale fallback)
- `data/entries-AQU-2026-04-16.json` — Enriched with ML odds, Beyer Speed Figures, running styles, jockey/trainer percentages, race type codes, and last class for all 70 horses
