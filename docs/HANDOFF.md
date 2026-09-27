# Simulator handoff notes

Share this page with Teams A-D. Share the API key
and webhook token through a private channel, never in this file or the repository.

- Public base URL: `https://telemetry-simulator-production-bf55.up.railway.app`
- Known-good release: Railway deployment `0cea91f6-4401-4761-a3d3-9b8250820677`, git commit `465845a`
- Event contract: schema version 1.0, frozen. See [event-schema.json](event-schema.json) and the
  README "Event contract" section.
- Status at any time: `GET <base>/api/v1/status` (no key needed).

## Dashboard and your own webhook

Open the public base URL in a browser for the simulator console: live match, odds and player
charts, the event feed, and an API guide. Any team can connect its own n8n workflow:

1. Open the Webhooks tab and select Unlock. Enter the team key (shared privately by Emmanuel).
2. Paste your n8n Webhook node's Production URL, optionally generate a shared token, and choose
   which event types you want (all by default).
3. Press Test on your destination. HTTP 200 means you are connected. You receive every event
   from then on, including during a match that is already running.

The team key can only manage webhooks. Starting, pausing and resetting matches needs the
control key.

## Team A: n8n ingestion

- One event per `POST`, `Content-Type: application/json`, to `N8N_WEBHOOK_URL`.
- Authenticate with the `X-Simulator-Token` header (shared secret, sent privately). Reject
  requests without it.
- Respond 2xx quickly. Non-2xx responses and timeouts over 5 s are retried up to 3 more times
  (1 s, 3 s, 10 s) with the same `event_id`. 4xx responses other than 408, 425 and 429 are not
  retried.
- Deduplicate on `event_id`. Retries and the `duplicate` test mode both reuse IDs.
- Order by `sequence_number` within `simulator_run_id`. Delivery runs up to 4 requests at a time, so
  arrival order can differ slightly.
- Reliability tests: start preset `pipeline_test`, or send single faults with
  `POST /api/v1/test-event {"fault":"missing_field"}` (also `malformed`, `stale_timestamp`).
  Examples of every fault: `samples/pipeline-failure-examples.json`.

## Team B: database and risk engine

- Player profiles and baselines: `GET <base>/api/v1/players` or `samples/player-profiles.json`.
  They will not change during the sprint.
- Normal play stays within mean plus or minus 2.5 stddev of each baseline.
- Performance signals: `player_action.metrics` (single samples) and `player_snapshot.metrics`
  (30-second rolling averages plus cumulative kills, deaths, assists, damage).
- Anomaly, direction `over`, for player_07 (baseline 230 ms, 46%, 29%): about 115 ms reaction,
  80% accuracy, 67% headshot rate. The player appears about 3x as often during the anomaly, so a
  30-second window holds roughly 7 to 10 action samples.
- Odds signals: `odds_update.odds.movement_pct` is the largest absolute percentage change of either
  team's odds versus the previous update. `data.reason` is `match_start`, `round_result` or
  `market_update`. Normal: round results under 12.5%, market updates under 6.5%. Injected shock:
  30% or more, always `market_update`, never within 3 s of a round boundary.
- Use `metadata.match_clock_seconds` for windows. It does not advance while a run is paused.

## Team C: AI evidence workflow

- Example suspicious sequences: `samples/performance-anomaly-sequence.json`,
  `samples/odds-integrity-sequence.json`, and the full final demo in
  `samples/combined-final-demo.json`. Each includes a `truth` block for your testing only; the live
  stream never contains it.
- In the final demo, player_07 (team_blue) changes at 60 s and team_blue's odds shorten by about
  30% at 90 s, with no round event nearby.
- Wording: the simulator provides evidence of unusual patterns. Summaries should not state that a
  player cheated or that a match was fixed.

## Team D: admin dashboard

- `GET /api/v1/status` for state, counters, `match` (clock, round, score) and `webhook_status`.
  Suggested polling interval: 2 s.
- `GET /api/v1/events/recent?limit=50` for a live feed, or the Server-Sent Events stream at
  `GET /api/v1/events/stream` (`event: telemetry`).
- Browser access needs the dashboard origin in `ALLOWED_ORIGIN`. Tell Emmanuel the exact origin.
- Control buttons, if any, call the protected endpoints with `X-API-Key`. Keep the key server-side,
  not in browser code.

## Demonstration checklist for the handoff call

1. `GET /health`, `GET /ready`, `GET /api/v1/status` (idle).
2. `POST /api/v1/test-event` and confirm Team A received it.
3. `POST /api/v1/runs {"preset":"demo_normal"}`, watch the counters.
4. `POST /api/v1/runs/current/pause`, then `resume`.
5. `POST /api/v1/runs/current/reset`.
6. `POST /api/v1/runs/<previous run id>/replay` and confirm the same sequence of metrics.

## Known limitations

- One active run and one instance. State is in memory; a restart returns to idle and the last run
  cannot be replayed from memory, but any run can be recreated from its preset or seed.
- Status counters describe the current run only. Reset clears them.
- The dashboard stream is a preview and is not guaranteed delivery.
