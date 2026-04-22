# Railbird Data Schemas

Every normalized record written by any adapter in `scripts/ingest/` must validate against these schemas.

## Files

| Schema | Purpose |
|---|---|
| `source_provenance.schema.json` | Mandatory envelope. Where did the record come from, and what are we allowed to do with it? |
| `meet.schema.json` | One meet at one track (e.g. Saratoga 2025 Summer Meet). |
| `race.schema.json` | One race on one day. Shape is a superset of the existing in-app race object so render functions read it without changes. |
| `entry.schema.json` | One horse entered in one race. Superset of the existing in-app horse object. |

## License tiers (defined in `source_provenance.schema.json`)

- **green** — open / explicitly permitted (e.g. NY State Open Data). OK to display and train.
- **yellow** — licensed via a paid agreement (e.g. The Racing API with written ML approval). Display and train per the specific contract terms.
- **red** — prohibited (e.g. Brisnet, TimeformUS, scraped NYRA). **Must not enter training output.** Display requires a license we don't have.
- **sample_manual_review** — hand-entered for UI dev only. Display-eligible so the app is usable; **never** training-eligible. This is the current default while no paid source is active.
- **unknown** — provenance lost. Excluded from training. Display allowed only with a "verify source" warning.

## Enforcement

- Ingestion: every adapter must set `source_provenance.license_tier`. Records missing it are rejected.
- Training: `scripts/training/features.js` reads an `ALLOW_LICENSE_TIER` env var (default `green,yellow`) and skips any record whose tier is not in the allow-list. A skip log is written to `training/skipped.jsonl`.
- UI: the in-app "Data source" indicator reads `source_provenance.license_tier` and badges sample vs licensed data differently.
