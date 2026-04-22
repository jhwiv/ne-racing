# Saratoga 2025 Sample Fixtures — READ THIS BEFORE TOUCHING

`saratoga_2025_sample.json` is a **hand-authored placeholder dataset** created solely to exercise the UI (Barn features, typeahead autocomplete, calendar navigation, race-card rendering) during development while no paid data source is configured.

## What it is

- A deterministic random sample of **30 racing days** drawn from the real 2025 Saratoga Summer Meet calendar (July 10 – September 1, 2025, 40 total race days). The specific 30 dates are listed in `meta.sampled_dates` inside the JSON. Re-running the builder with the same `SAMPLE_SEED` (20250710) reproduces the same 30 days.
- Horse/jockey/trainer names drawn from a pool of real, well-known 2025 NYRA circuit names so typeahead feels realistic.
- **Stable / owner names are real, publicly-known NYRA and Saratoga outfits** (e.g. Repole Stable, Klaravich Stables, Sackatoga Stable, James Bond Racing Stables, West Point Thoroughbreds, Centennial Farms, Juddmonte Farms, Godolphin, Stonestreet Stables, etc.). Sources: TDN 2025 meet recaps, NYRA press releases, nybreds.com owner leaderboards, individual stable websites.
- These names are **publicly known**; their appearance in this file is **not** an assertion that any specific horse ran in any specific race on any specific date, nor that any listed stable actually owned any specific horse in this fixture. Ownership is assigned pseudo-randomly across the real-name pool purely to make the UI feel real.
- Every race carries `"data_status": "placeholder_sample_for_ui_dev"`.
- Every race's `source_provenance.license_tier` is `"sample_manual_review"`, `training_eligible: false`.

## What it is NOT

- NOT a reproduction of 2025 Equibase charts.
- NOT a reproduction of NYRA entries or results pages.
- NOT a training dataset. `scripts/training/features.js` will refuse to read it.
- NOT for display without the "Sample data" badge the UI shows when this source is active.

## When it goes away

The day any of the following happens, this file should be retired:

1. User authorizes The Racing API subscription and ingests real 2025 SAR records → `data/normalized/2025/SAR/*.json` takes over.
2. A licensed commercial CSV drop from Equibase / DRF / HRN is ingested via `scripts/ingest/csv_import_adapter.js` (not yet written — add when needed).
3. 2026 SAR meet opens and the Live toggle is flipped.
