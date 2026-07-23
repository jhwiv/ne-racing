# Analytics Tab — QA History & Verified Baseline

**Purpose of this file:** the owner reported, in these words, that the
Analytics tab's "Pick Accuracy by Source" card had been wrong — layout and/or
numbers — across more than two dozen prior requests to fix it. This file is
the durable record of what was actually found and fixed, and the last
independently-verified-correct baseline, so the next session doesn't start
from zero or repeat a mistake already made. See `.claude/skills/analytics-qa/
SKILL.md` for the mandatory process to follow before touching this card
again.

---

## 2026-07-23 (v2.49.47) — Hero ROI figure could read as "way more effective" than the win rates support

Direct follow-up question after the fixes below: is it misleading that the
"Leading source" hero shows Our Picks at +30.1% ROI with no other context,
when its win rate (22.9%) is barely different from Market Favorite's
(21.9%) and Handicapper Consensus's (21.3%)? Yes — confirmed, not assumed:
ROI is driven mostly by payout size on wins, not pick accuracy, and Our
Picks' ROI is built from only 8 wins (vs. 28 and 13 for the others), making
it the *least* statistically stable of the three despite getting the
biggest visual treatment.

**Fix:** the hero now shows the leading source's own win rate and settled
count directly beneath its ROI figure, plus one fixed sentence: "ROI
reflects how big the payouts were on wins, not how often a source's picks
actually won — compare win rates directly, especially with fewer picks
settled." Verified via a real Playwright screenshot (not code-read-only) —
renders as three clean lines under the hero, no layout regression, no new
console errors.

---

## 2026-07-23 — Three real, confirmed bugs found and fixed

Reported via a screenshot: rows crammed together, rank badges (1st/2nd/3rd)
visually out of order relative to the rows they labeled, and a request to
remove the "Exacta Box bets only" sub-line. Also asked directly whether it
was plausible for Market Favorite and Handicapper Consensus to be deep in
the negative while Our Picks was strongly positive — verified rather than
assumed.

### Bug 1 — Missing `.mb-3` CSS class (the actual cause of "too close together")

`renderAnalyticsAccuracy()` (`app.html`/`index.html`) wraps the volume line,
hero figure, legend, and every per-source row in `<div class="mb-3">` —
intended to give each block 1.5rem of bottom margin, matching the sibling
utility classes `.mb-1` (0.5rem) and `.mb-2` (1rem) already defined nearby.
**`.mb-3` itself was never defined anywhere in the stylesheet** — confirmed
by grep, not assumption:

```
grep -n '\.mb-1 { margin-bottom' app.html
# .mb-1 { margin-bottom: 0.5rem; } .mb-2 { margin-bottom: 1rem; }
grep -n '\.mb-3\b' app.html
# (no output before the fix)
```

`.mt-3` (margin-*top*: 1.5rem) was defined right next to `.mt-1`/`.mt-2` on
the same line — only the bottom-margin counterpart was missing. Every
`class="mb-3"` in this function was silently a no-op, which is exactly why
rows, the hero figure, and the legend all rendered with zero gap between
them.

**Fix:** added `.mb-3 { margin-bottom: 1.5rem; }` next to `.mb-1`/`.mb-2` in
both `app.html` and `index.html`. Verified `mb-3` is used in exactly 4 places
in the codebase, all inside this one function — the fix is scoped
automatically, no risk of affecting anything outside the Analytics card.

### Bug 2 — Rank badges rendered out of visual order

`renderAnalyticsAccuracy()` computes two different orderings that were never
kept in sync:
- `ranked` — sources with `settled >= 3`, sorted by ROI descending. Badge
  numbers (1/2/3, with gold styling for 1st) come from this array's index.
- `present` — sources with any settled picks, in a **fixed** engine order
  (`v2`, `baseline_ml`, `crowd`, `v1`) regardless of ROI.

Rows were rendered by mapping over `present` (fixed order) while badges came
from `ranked` (ROI order). Whenever the fixed engine order didn't match the
ROI order — which is most of the time — a row in the 2nd visual position
could carry a "3" badge and the 3rd visual row a "2" badge. Confirmed exactly
this in the reported screenshot: visual order was Our Picks (badge 1),
Market Favorite (badge **3**), Handicapper Consensus (badge **2**).

**Fix:** rows now render in `rowOrder = ranked.concat(present minus ranked)`
— ranked sources appear in actual rank order, with any present-but-unranked
sources (settled 1–2, no badge yet) following after in their original order.
Badge number and visual position now always agree.

### Bug 3 — Exacta Box breakout removed per explicit request

The nested "↳ Exacta Box bets only" sub-line (with its own mini bar, ROI,
and win/loss count) under each source's row has been removed entirely, along
with the code that computed it. This was a deliberate, explicit request —
not a bug — do not re-add it without being asked.

### Non-bug: the ROI disparity is real, independently verified

Checked whether it's actually plausible for Market Favorite (`baseline_ml`,
the literal lowest-morning-line-odds horse in every race) and Handicapper
Consensus (`crowd`) to be deep in the negative while Our Picks (`v2`) is
strongly positive, given all three have similar ~21–23% win rates. Ran
`scripts/qa/verify_analytics_numbers.js` against the live worker — **zero
discrepancies**, every number independently recomputed from raw
`/api/picks/history` records matches what `/api/picks/stats` reports. The
explanation: win rates are similar, but average payout per win differs a
lot — Our Picks' 8 winners averaged $12.03/$2-stake, baseline_ml's 28
winners averaged only $5.37, crowd's 13 winners averaged $6.66. Similar hit
rate, very different payout profile — legitimate, not a bug. (This also
matches a known, accepted limitation: `baseline_ml` uses each race's
*morning-line* odds, not live/closing odds, to pick the "favorite" — true
betting favorites using closing odds typically run higher win rates than
this, so a ~22% win rate for the ML-favorite proxy is a known, understood
gap, not a new one.)

---

## Verified baseline (2026-07-23, all-time, via `verify_analytics_numbers.js`)

Use this to sanity-check future drift — these should only ever grow (more
picks settle over time), never shrink or contradict themselves.

| Source | Logged | Settled | W-L | Win rate | Stake | Return | ROI |
|---|---|---|---|---|---|---|---|
| Our Picks (`v2`) | 98 | 35 | 8-27 | 22.9% | $74.00 | $96.26 | +30.1% |
| Market Favorite (`baseline_ml`) | 129 | 128 | 28-100 | 21.9% | $256.00 | $150.48 | -41.2% |
| Handicapper Consensus (`crowd`) | 64 | 61 | 13-48 | 21.3% | $122.00 | $86.58 | -29.0% |

Volume line: **291 total picks logged across 3 sources — 224 graded so far,
67 pending.**

Correct rank order (by ROI, min 3 settled): **1. Our Picks, 2. Handicapper
Consensus, 3. Market Favorite.**

`v2`'s Win-only breakdown (excluding its 2 Exacta Box picks, which the UI no
longer shows but the worker still computes): 33 settled, 8 wins, 24.2% win
rate, +45.8% ROI.

**Last verified:** 2026-07-23, against production, via
`scripts/qa/verify_analytics_numbers.js`. Re-run it, don't assume this table
is still current.
