# Railbird QA harness

Five layers of automated testing that drive the **real UI** and read the **real DOM**. Built after three bugs (heart-tap crash, picker→barn miss, jockey search gap) made it to production because prior QA seeded localStorage and tested at the storage layer instead of clicking buttons.

## The rule

> Every assertion must touch a button the user touches, and then read the screen the user reads. Never seed `racing2026` and call it a test.

## Layers

| | What it does | Bug class it catches |
|---|---|---|
| **L1 smoke-crawl** | Visit every tab + overlay, fail on console errors, "undefined", "NaN", empty regions | `Race undefined` (v2.38.11), broken page loads |
| **L2 interaction-matrix** | Click heart, click picker Add, type in search, click ×, click Clear all — read DOM after each | Heart-tap crash (v2.38.10), picker→barn miss (v2.38.14) |
| **L3 data-coverage** | For every jockey/trainer/horse in `__getLookupCandidatesCached()`, type a token and assert the right section returns the right row | Jockey search gap (v2.38.15) |
| **L4 state-transitions** | (action × surface) matrix — fail if any cell doesn't update | "Store updated but tab didn't render" bugs |
| **L5 visual-regression** | Pixelmatch every screen vs. baseline | Contrast regressions, layout overflow |

## Run it

```bash
cd scripts/qa
npm install                  # one-time
npm run l3                   # one layer
npm run all                  # all layers, live URL

# Or use the pre-ship gate (runs against your local working tree)
scripts/preship.sh           # blocks push if anything fails
scripts/preship.sh --live    # post-push: hit the live site
scripts/preship.sh --update-snaps   # refresh L5 baselines after intentional UI change
```

## Environment

| var | default | notes |
|---|---|---|
| `QA_BASE_URL` | `https://railbirdai.com/` | trailing slash |
| `QA_VERSION` | (none) | pin localStorage `ne-racing-version` to skip reload loop |
| `QA_SAMPLE` | (none) | L3 only — sample N names per category for fast feedback |
| `QA_UPDATE_BASELINE` | `0` | L5 — overwrite baselines instead of diffing |

## Adding a new test

1. Pick the layer that matches the bug class. If the bug is "I clicked X and Y didn't update," it's L4.
2. Write the action as an `eval` that **clicks the real DOM element**. Never call internal functions like `barnAddFromLookup` directly — that's the path that bit us.
3. Read the surface as an `eval` that **queries visible DOM**. Never read `localStorage` and call it a verification.
4. Add the (action, surface) cell to L4's matrix if there's a new surface.

## Anti-patterns banned in this directory

- ❌ `localStorage.setItem('racing2026', ...)` followed by a render call
- ❌ Calling `globalSearchScan(q)` and checking its return value as "the test"
- ❌ Asserting on a badge count without then opening the actual tab the badge represents
- ❌ Skipping the L5 baseline update step after intentional UI changes (causes false alarms next run)
