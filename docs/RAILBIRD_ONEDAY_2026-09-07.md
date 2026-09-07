# Railbird one-day stack — SAR 2026-09-07

Personal handicapping exception for Saratoga's 2026 Summer Meet closing day
(Monday). Chip confirmed the track is **OPEN**. Do **not** renew
TheRacingAPI. Do **not** enable Brisnet overlay. Do **not** permanently
re-enable `unofficial_nyra_adapter` for training.

## What is live in this commit

- `wrangler.toml` `[vars] DATA_SOURCE = "free"` (was `theracingapi`).
  TheRacingAPI is inactive (`401` / `"Subscription inactive"`). The worker
  also auto-falls back if `DATA_SOURCE` is still `theracingapi` at runtime.
- `data/entries-SAR-2026-09-07.json` — 12 races / 128 runners plus preserved
  `expertPicks`. All `scratched` values are `false`; Equibase late-change XML
  is the live scratch feed (`CACHE_TTL.scratches` = 60s).
- Client `isKnownWeeklyDarkDay` exception for `2026-09-07` so the app does
  **not** skip `/api/entries` and paint "Dark day at Saratoga".

## Chip: Cloudflare dashboard var

GitHub Action `deploy-worker` deploys `wrangler.toml` vars on push to
`master` that touches `worker.js` / `wrangler.toml`. If the dashboard
`DATA_SOURCE` does not flip to `free`, set it there:

1. Cloudflare Dashboard → Workers & Pages → `cloudflare-worker`
2. Settings → Variables and Secrets
3. Set `DATA_SOURCE` = `free` and save / redeploy

## Free stack

| Endpoint | Source |
|---|---|
| `/api/entries` | GitHub Pages `data/entries-{TRACK}-{DATE}.json` |
| `/api/scratches` | Equibase `eqbLateChangeXMLDownload.cfm` (live, 60s TTL) |
| `/api/odds` | empty stub (morning line on the card) |
| `/api/results` | empty stub |
| `/api/track-status` (no Perplexity key) | `confirmed_live` / `static_card_present` when the static card has runners |

If `DATA_SOURCE=theracingapi` is still set in the dashboard, `401` /
`"Subscription inactive"` uses the same free path via
`isPaidUpstreamAuthFailure`.
