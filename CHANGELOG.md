# NE Racing — Changelog

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
