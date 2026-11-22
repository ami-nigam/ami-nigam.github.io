# Vision Art Studio (server)

Backend for "Stochastic by Design" (Vision Art Magazine Vol 7). One always-on Node service on Railway: API, login, OpenRouter client, spend guard, in-process scheduler, agents, storage.

## Railway setup

1. New project > Deploy from GitHub repo > `ami-nigam/ami-nigam.github.io`. In the service Settings: Root Directory `studio-server`, Config file path `/studio-server/railway.json` (watch paths limit redeploys to `studio-server/**`).
2. Add a **Volume** mounted at `/data`.
3. Variables:
   - `OPENROUTER_API_KEY` (set in the dashboard only)
   - `STUDIO_PASSWORD` (8+ chars)
   - `SESSION_SECRET` (any long random string)
   - `DATA_DIR=/data`
   - optional: `ALLOWED_ORIGINS` (default `https://ami-nigam.com,https://www.ami-nigam.com,https://ami-nigam.github.io`), `SPEND_CEILING_USD` (can only lower the $20 hard cap), `IMAGE_MODEL`, `SONNET_MODEL`, `OPUS_MODEL`, `AUTOSTART=1`
4. Settings > Networking > Generate domain. Keep replicas at 1 (the scheduler is in-process).
5. On OpenRouter, set a $20 credit limit on the key as the outside backstop.

The studio boots **paused**. Log in from `ami-nigam.com/vision-art-mag/`, run the connection check, then press Resume.

## Safety

- Ceiling: $20 max, enforced before every billable call using max(local ledger, key usage delta) plus in-flight reservations, and the key's `limit_remaining`. Hitting it stops everything and sets `ceiling_hit`.
- Kill switch: `POST /api/pause` aborts in-flight calls.
- 503/502/429 retried with exponential backoff, max 3.
- Engineer: max 3 attempts per incident, may only edit whitelisted runtime keys (models must exist, drafts stay low/medium). Never touches caps, pause or briefs.

## Data (on the volume, never committed)

`log.jsonl` (append-only events), `ledger.jsonl` (costs), `images.jsonl` (image index), `state.json`, `runtime.json`, `images/`, `thumbs/`, `finals/`.

## Config

`config/studio.json`: stance, schedule, personas, default limits. `config/voice-samples.md`: Ami's real writing for the voice agents.
