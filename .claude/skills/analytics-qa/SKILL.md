---
name: analytics-qa
description: Mandatory process for ANY change to the Analytics tab (Pick Accuracy by Source card, Recent Picks list, or the numbers behind them) in app.html/index.html/worker.js. Use before writing code, and again before claiming anything is fixed. This exists because the owner reported failed fixes to this exact card across 2+ dozen prior requests -- do not repeat that.
---

# Analytics QA

The owner's own words, verbatim, from the request that created this skill:

> "You have had very difficult time getting the analytics correct... I have
> probably asked for these results more than two dozen times and you failed
> consistently get the layout right get the numbers right. Stick to your
> programming guidelines QA and peer review. Do not guess be 100 times more
> thorough do not hallucinate do not drift."

Treat that as a standing instruction for every future touch of this card,
not just the session that wrote it.

## Full context

Read `docs/ANALYTICS_QA.md` before doing anything else. It has the incident
history (what was wrong, how it was found, how it was fixed) and the last
known-good verified baseline. Do not re-derive from scratch what's already
written down there.

## The two things that must both happen, every time

### 1. Verify the NUMBERS are correct -- never trust the UI or the aggregation

Run `node scripts/qa/verify_analytics_numbers.js` against the live worker
(requires real network access -- trigger `.github/workflows/
qa-verify-analytics.yml` via `workflow_dispatch` if working from a sandboxed
session that can't reach `cloudflare-worker.jhwiv-online.workers.dev`
directly). This independently recomputes wins/losses/stake/return/win-rate/
ROI from raw `/api/picks/history` records and diffs against
`/api/picks/stats`. It exits non-zero on ANY discrepancy.

Do not hand-wave "the math looks right" from reading code. Do not assume a
prior session's verified numbers still hold -- new picks settle constantly.
Re-run it.

If a number looks surprising (e.g. one source deep in the negative while
another is strongly positive despite similar win rates), that is NOT
evidence of a bug by itself -- recompute the underlying wins/losses/average
payout per source and check whether the arithmetic actually explains it
(see docs/ANALYTICS_QA.md's worked example) before touching any code.

### 2. Verify the LAYOUT is correct -- a real screenshot, not a read-through

Render the actual Analytics tab in a real browser (Playwright, Chromium at
`/opt/pw-browsers/chromium`) with mocked `/api/picks/stats` data shaped
exactly like a real response (reuse the real numbers from step 1, don't
invent placeholder numbers), take a screenshot, and look at it. Specifically
check:
- Do the rank badges (1/2/3) appear in the same top-to-bottom visual order
  as the rows, or is a "3" sitting above a "2"? (This exact bug shipped
  once already -- rows rendered in a fixed engine order while badges were
  assigned from a separately ROI-sorted array.)
- Is there visible, comfortable spacing between each source's block, or are
  lines crammed together? (This exact bug shipped once already -- `mb-3`
  was used 4 times in this card's render function but never defined
  anywhere in CSS, so every "margin-bottom: 1.5rem" silently did nothing.
  If a NEW spacing class is introduced, grep to confirm it's actually
  defined before assuming it works.)
- Is anything present that shouldn't be, or missing that should be, per the
  actual request? Read the request again after the screenshot, not before.

Never report a layout fix as done from code reading alone. This project's
own CLAUDE.md already states this as a hard rule for the whole app; it
applies doubly here given the track record.

## Scope discipline

If the owner has asked for Analytics-only work, touch ONLY
`renderAnalyticsAccuracy()`/`renderAnalyticsPickHistory()`/related CSS in
app.html + index.html (mirrored), and the worker.js endpoints that feed
them (`/api/picks/stats`, `/api/picks/history`) if a numeric bug is actually
traced there. Do not drift into other tabs, other bugs, or unrelated
refactoring, even if tempting.

## Before reporting done

- Update `docs/ANALYTICS_QA.md`'s "Last verified" line and baseline numbers.
- State plainly, with the actual recomputed numbers and a screenshot
  description, what was checked and what it showed -- not just "fixed it."
