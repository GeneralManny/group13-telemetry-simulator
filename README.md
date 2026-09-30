# Group 13 Telemetry + Odds Simulator

A hosted API that behaves like a live esports telemetry and betting-odds provider. It streams
schema version 1.0 events, one per webhook request, to the Group 13 n8n webhook, and supports
normal, performance-anomaly, odds-integrity, combined, and pipeline-failure scenarios.

The simulator supplies test evidence only. It never labels a player as a cheater and never sends
a verdict downstream.

- Runtime: Node.js 20.9+, TypeScript, Fastify 5, Zod 4, Pino
- Dashboard: Next.js 16 static export, served by the same service at `/`
- One instance, one active run. Match state in memory; dashboard webhooks saved to `DATA_DIR`
- Deterministic: the same scenario, seed and configuration always produce the same match content

## Dashboard

Open the service URL in a browser. The console has six tabs:

- Overview: current match, score and clock, delivery counters, live odds chart, player metrics
  against their baseline range, and a players table. With the control key: preset buttons,
  a custom run form, pause, resume, stop, replay, reset, and a test event.
- Cases: integrity cases with their evidence (rules, measured values against baseline, score
  breakdown and history, AI or template summary, Slack delivery) and the human review panel.
- Risk: every player's live risk score, pipeline health, and dead letters.
- Webhooks: teams add their own n8n Webhook URL (with an optional shared token and an event
  type filter), press Test, and see delivery health per destination. Every enabled webhook
  receives every event from the next event onwards, in addition to `N8N_WEBHOOK_URL`.
- Live events: the event stream with type and player filters, and the exact JSON payload.
- API guide: base URL, copyable curl commands and the endpoint list.

Access keys are entered in the browser and kept in that tab only (sessionStorage):

| Key               | Can do                                                  |
| ----------------- | ------------------------------------------------------- |
| `CONTROL_API_KEY` | Everything: run control, test events, webhooks          |
| `TEAM_ACCESS_KEY` | Add, test, pause and remove webhooks. Cannot touch runs |
| None              | View the dashboard, status, charts and live events      |

## Quick start (local)

```bash
npm install && npm run install:dashboard
npm run mock-webhook          # terminal 1: fake n8n on http://localhost:4000
cp .env.example .env          # then edit: NODE_ENV=development, N8N_WEBHOOK_URL=http://localhost:4000/webhook/telemetry
npm run dev                   # terminal 2: simulator API on http://localhost:3000
npm run dev:dashboard         # terminal 3: dashboard with hot reload on http://localhost:3001
```

`npm run dev:dashboard` proxies `/api` to the simulator (set `SIMULATOR_URL` to point elsewhere).
To see the production setup instead, run `npm run build:dashboard` once; the simulator then
serves the built dashboard at http://localhost:3000.

`npm run dev` does not load `.env` automatically. Either export the variables in your shell, or run
`node --env-file=.env --import tsx src/server.ts`.

Without `N8N_WEBHOOK_URL` in development, runs are dry runs: events are generated and visible at
`/api/v1/events/recent` but not delivered. Without `CONTROL_API_KEY` in development, control
endpoints are open. Neither shortcut applies in production.

## Scripts

| Command                       | Purpose                                                                    |
| ----------------------------- | -------------------------------------------------------------------------- |
| `npm run dev`                 | Run from source with reload and pretty logs                                |
| `npm run dev:dashboard`       | Next.js dashboard with hot reload on port 3001                             |
| `npm run build:dashboard`     | Static export to `dashboard/out/`, served at `/` by the simulator          |
| `npm run build` / `npm start` | Production build to `dist/`, then run it                                   |
| `npm test`                    | Unit, API, webhook and end-to-end tests (Vitest)                           |
| `npm run check`               | Typecheck, lint, format check and tests                                    |
| `npm run samples`             | Write sample payloads for every scenario to `samples/`                     |
| `npm run schema`              | Export the event contract as JSON Schema to `docs/event-schema.json`       |
| `npm run mock-webhook`        | Local stand-in for n8n. `MOCK_FAIL_RATE=0.2` makes it fail 20% of requests |

## API

Base URL: the Railway public domain, for example `https://<service>.up.railway.app`.

### Public

| Method | Path                             | Purpose                                                                    |
| ------ | -------------------------------- | -------------------------------------------------------------------------- |
| GET    | `/health`                        | Liveness. Always fast, never depends on n8n                                |
| GET    | `/ready`                         | 200 when configuration is valid, 503 with missing variable names otherwise |
| GET    | `/api/v1/status`                 | Run state, scenario, counters, match clock and score, webhook health       |
| GET    | `/api/v1/scenarios`              | Scenarios, presets and every run option                                    |
| GET    | `/api/v1/players`                | Teams, player profiles and baselines                                       |
| GET    | `/api/v1/events/recent?limit=50` | Most recent emitted events, newest first                                   |
| GET    | `/api/v1/events/stream`          | Server-Sent Events stream of emitted events (dashboard preview)            |
| GET    | `/api/v1/timeline?player=<id>`   | Chart data: odds, one player's samples, latest snapshots                   |
| GET    | `/api/v1/session`                | Which role the sent key has (`admin`, `team` or none)                      |
| GET    | `/api`                           | JSON index of every endpoint                                               |

### Protected (header `X-API-Key: <CONTROL_API_KEY>` or `Authorization: Bearer <key>`)

| Method | Path                         | Purpose                                                                    |
| ------ | ---------------------------- | -------------------------------------------------------------------------- |
| POST   | `/api/v1/runs`               | Start a run (201). 409 if a run is running or paused                       |
| GET    | `/api/v1/runs/:runId`        | Run config, progress and the internal scenario truth record                |
| POST   | `/api/v1/runs/:runId/pause`  | Stop emitting, keep counters and match clock                               |
| POST   | `/api/v1/runs/:runId/resume` | Continue a paused run                                                      |
| POST   | `/api/v1/runs/:runId/stop`   | End the run cleanly. Queued deliveries still go out                        |
| POST   | `/api/v1/runs/:runId/reset`  | Clear the run from any state, cancel its queued deliveries, return to idle |
| POST   | `/api/v1/runs/:runId/replay` | New run ID, same configuration and seed (201)                              |
| POST   | `/api/v1/test-event`         | Send one controlled event and return n8n's response                        |

`:runId` can be `current` instead of the literal ID.

### Webhooks (team key or control key)

| Method | Path                        | Purpose                                                          |
| ------ | --------------------------- | ---------------------------------------------------------------- |
| GET    | `/api/v1/webhooks`          | Every destination with delivery stats. Tokens are never returned |
| POST   | `/api/v1/webhooks`          | Add `{name, url, token?, event_types?, enabled?}` (201)          |
| PATCH  | `/api/v1/webhooks/:id`      | Change any field, for example `{"enabled": false}`               |
| DELETE | `/api/v1/webhooks/:id`      | Remove (204)                                                     |
| POST   | `/api/v1/webhooks/:id/test` | One test event to that destination only (`default` = env URL)    |

In production a webhook URL must be public `https`: private, loopback, link-local and
`*.railway.internal` addresses are rejected. An n8n running on a laptop (`http://localhost:5678`)
cannot be reached from Railway; expose it with n8n Cloud, a hosted n8n, or a tunnel such as
`cloudflared tunnel --url http://localhost:5678`, and use the Production URL (`/webhook/...`). Each webhook gets its own token as
`X-Simulator-Token`; the `N8N_WEBHOOK_TOKEN` is only sent to `N8N_WEBHOOK_URL`. At most
`MAX_WEBHOOKS` (20). Delivery counters in `/api/v1/status` count each event once per
destination, so with three webhooks `events_delivered` is three times `events_generated`.

### Starting a run

```bash
curl -X POST "$BASE/api/v1/runs" -H "X-API-Key: $KEY" -H "content-type: application/json" \
  -d '{"preset":"final_demo"}'
```

Or with explicit values (all optional except `scenario` or `preset`; unknown fields are rejected):

```json
{
  "scenario": "performance_anomaly",
  "seed": 13027,
  "event_rate_per_second": 2,
  "duration_seconds": 300,
  "target_player_id": "player_07",
  "anomaly_start_second": 90,
  "webhook_url": "configured-default"
}
```

Other options: `round_duration_seconds` (default 25), `anomaly_duration_seconds` (default: until the
end), `anomaly_direction` (`over` or `under`), `odds_anomaly_start_second`,
`odds_anomaly_movement_pct` (default 30), `odds_anomaly_direction` (`toward` or `against` the target
player's team), `match_id`, `failure_modes`, `emit_status_events`. `webhook_url` can be
`configured-default`, `none` (dry run) or an http(s) URL. The shared token is only sent to the
configured n8n origin, never to other URLs.

If `seed` is omitted a random one is chosen and returned, so any run can be replayed.

### Test event

```bash
curl -X POST "$BASE/api/v1/test-event" -H "X-API-Key: $KEY" -H "content-type: application/json" \
  -d '{"event_type":"player_action","fault":"none"}'
```

`event_type`: `player_action`, `combat_event`, `player_snapshot`, `odds_update`.
`fault`: `none`, `missing_field`, `malformed`, `stale_timestamp`. One attempt, no retries, so the
response shows exactly what n8n returned. Test events use `scenario: "integration_test"` and a
`test_` run ID.

## Scenarios and presets

| Scenario              | What happens                                                                                                                                                                                          | Expected downstream result                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `normal`              | Metrics stay within each player's baseline band and drift gradually. Odds follow the score                                                                                                            | Normal or monitor only                                    |
| `performance_anomaly` | From `anomaly_start_second`, the target player's reaction time halves (about 230 to 115 ms for player_07), accuracy rises about 34 points, headshot rate about 38 points, and they appear 3x as often | High or critical performance case                         |
| `odds_integrity`      | At `odds_anomaly_start_second`, one odds update moves at least 30% with `reason: "market_update"`, at least 3 s away from any round boundary. The market stays at the new level                       | High odds-integrity or monitor case                       |
| `combined`            | Both of the above for the same player, team, and match                                                                                                                                                | One case, one Slack alert, human review                   |
| `pipeline_failure`    | Normal play plus duplicates, missing fields, wrong types, delayed events, stale timestamps and a 5x burst at 30-40 s                                                                                  | Duplicates stored once, invalid events in the error route |

Failure modes never appear unless `pipeline_failure` is chosen or `failure_modes` is passed
explicitly, for example `"failure_modes": {"duplicate": true, "rate": 0.1}`.

Reference ranges for rule tuning (measured across 300 seeds): normal round-result odds moves stay
under 12.5%, normal market updates under 6.5%, injected shocks are at least 30%. After a shock the
market stays agitated and later round-result moves can reach about 20%.

Saved presets (`GET /api/v1/scenarios` lists them):

| Preset             | Configuration                                                                           |
| ------------------ | --------------------------------------------------------------------------------------- |
| `final_demo`       | combined, seed 13027, 2 events/s, 240 s, player_07, anomaly at 60 s, odds shock at 90 s |
| `demo_normal`      | normal, seed 13027, 2 events/s, 120 s                                                   |
| `performance_demo` | performance_anomaly, seed 13027, 2 events/s, 300 s, player_07 at 90 s                   |
| `odds_demo`        | odds_integrity, seed 13027, 2 events/s, 240 s, odds shock at 90 s                       |
| `pipeline_test`    | pipeline_failure, seed 13027, 2 events/s, 120 s                                         |

## Event contract (schema version 1.0, frozen)

Every webhook request carries exactly one event with this envelope:

```json
{
  "event_id": "evt_20260927_120000_a1b2_000123",
  "event_type": "player_action",
  "schema_version": "1.0",
  "timestamp": "2026-09-27T12:00:00.000Z",
  "tournament_id": "tournament_001",
  "match_id": "match_20260927_120000_a1b2",
  "round_id": "round_04",
  "player_id": "player_07",
  "team_id": "team_blue",
  "sequence_number": 123,
  "scenario": "normal",
  "simulator_run_id": "run_20260927_120000_a1b2",
  "metrics": {},
  "odds": {},
  "data": {},
  "metadata": {
    "map": "arena_alpha",
    "source": "group13_simulator",
    "simulator_version": "1.0.0",
    "match_clock_seconds": 61.5
  }
}
```

- `event_id` is unique across all runs and restarts (the run token includes date, time and a
  random suffix). Retries and injected duplicates reuse the same ID.
- `sequence_number` starts at 1 and increases by 1 within a run.
- `timestamp` is wall-clock UTC. `metadata.match_clock_seconds` is the simulated match clock; it
  does not advance while paused, so use it for rolling windows.
- `data` holds event-specific details (roster, score, combat target, odds reason, summaries).
- `match_id` is new for each run unless `match_id` is passed, so demo runs never merge downstream.
- Additions are optional fields only. Required fields are never renamed.

Full field-by-field schema: [docs/event-schema.json](docs/event-schema.json). One example of each
event type: `samples/event-types.json`.

Webhook headers: `Content-Type: application/json`, `X-Simulator-Token` (when
`N8N_WEBHOOK_TOKEN` is set), `X-Simulator-Event-Id`, `X-Simulator-Run-Id`, `X-Simulator-Attempt`.

## Delivery

- Any 2xx is accepted. Timeout per request: `DELIVERY_TIMEOUT_MS` (5 s).
- Retries: network errors, timeouts, 5xx, 408, 425, 429. Schedule: immediately, then after 1 s,
  3 s and 10 s, then recorded as failed. Other 4xx responses are not retried.
- Up to `DELIVERY_CONCURRENCY` (4) requests in flight, sent in sequence order. A failing event
  does not block later ones.
- The queue is bounded by `MAX_QUEUE_SIZE` (1000). When full, new events are dropped and counted.
- `/api/v1/status` shows `events_generated`, `events_delivered`, `events_failed`,
  `events_pending`, `events_dropped`, `delivery_retries`, `last_response_code`,
  `recent_delivery_failures` and `webhook_status` (`healthy`, `degraded`, `failing`, `unknown`,
  `disabled`).

## Configuration

| Variable                         | Required in production | Default         | Notes                                                  |
| -------------------------------- | ---------------------- | --------------- | ------------------------------------------------------ |
| `PORT`                           | no                     | 3000            | Railway sets this                                      |
| `NODE_ENV`                       | yes                    | development     | Set to `production` on Railway                         |
| `LOG_LEVEL`                      | no                     | info            | `debug` also logs health and status requests           |
| `N8N_WEBHOOK_URL`                | yes                    |                 | Team A's production webhook URL                        |
| `N8N_WEBHOOK_TOKEN`              | recommended            |                 | Sent as `X-Simulator-Token`                            |
| `CONTROL_API_KEY`                | yes                    |                 | 16+ characters. Protects control endpoints             |
| `DEFAULT_EVENT_RATE`             | no                     | 2               | Events per second                                      |
| `DEFAULT_MATCH_DURATION_SECONDS` | no                     | 300             |                                                        |
| `DELIVERY_TIMEOUT_MS`            | no                     | 5000            |                                                        |
| `MAX_DELIVERY_ATTEMPTS`          | no                     | 4               | Including the first attempt                            |
| `MAX_QUEUE_SIZE`                 | no                     | 1000            |                                                        |
| `DELIVERY_CONCURRENCY`           | no                     | 4               |                                                        |
| `RETRY_DELAYS_MS`                | no                     | 1000,3000,10000 |                                                        |
| `ALLOWED_ORIGIN`                 | no                     |                 | Comma-separated dashboard origins for browser access   |
| `TEAM_ACCESS_KEY`                | no                     |                 | Webhook management only. Share with team leads         |
| `DATA_DIR`                       | recommended            |                 | Where dashboard webhooks are saved. `/data` on Railway |
| `MAX_WEBHOOKS`                   | no                     | 20              |                                                        |
| `OPENROUTER_API_KEY`             | no                     |                 | AI case summaries. Without it, the template is used    |
| `OPENROUTER_MODELS`              | no                     | free models     | Comma-separated OpenRouter models, tried in order      |

`/ready` returns 503 and lists variable names (never values) when required variables are missing,
invalid, or still set to the `.env.example` placeholders. Logs redact API keys, tokens and
authorization headers, and status shows only the webhook host, never its path.

## Deploying to Railway

1. Create a project and a service from this repository (or from the Docker image). `railway.json`
   selects the Dockerfile, sets the health check to `/health`, and keeps one replica.
2. Without Docker, use build `npm ci && npm run build` and start `npm run start`.
3. Add the variables above in the service's Variables tab. Set `NODE_ENV=production`.
4. Generate a public domain under Settings, Networking.
5. Add a volume mounted at `/data` and set `DATA_DIR=/data`, so webhooks added in the dashboard
   survive restarts and redeploys. The image runs as the `node` user, so also set
   `RAILWAY_RUN_UID=0` (Railway volumes are owned by root).
6. Verify:
   1. `GET /health` returns 200.
   2. `GET /ready` returns `"status": "ready"`.
   3. `GET /api/v1/status` shows `"status": "idle"`.
   4. `POST /api/v1/test-event` returns `"delivery": {"ok": true}` and Team A sees the event.
   5. Start `demo_normal`, confirm `events_generated` and `events_delivered` rise together.
   6. Reset, start `performance_demo`, confirm Team B sees player_07's reaction time drop at 90 s.
   7. Check the Railway logs for delivery failures and confirm no secrets appear.
   8. Restart the service and confirm status returns to `idle` with no events sent.

The service binds to `0.0.0.0`, starts idle, never starts a scenario on its own, and on SIGTERM stops
the ticker, gives in-flight deliveries 3 s to finish, and exits.

Keep a known-good release deployed during integration. Do not deploy changes right before an
integration checkpoint or the final demo.

## Final demo

Use the saved preset, never typed values:

1. `GET /health` and `GET /api/v1/status`: healthy and idle.
2. `POST /api/v1/runs {"preset":"demo_normal"}`. Show the counters rising. No high-risk alert.
3. `POST /api/v1/runs/current/reset`.
4. `POST /api/v1/runs {"preset":"final_demo"}`. player_07 changes at 60 s, odds shock at 90 s.
5. Follow the case through n8n, risk scoring, evidence, Slack and the dashboard. Human review.
6. `POST /api/v1/runs/current/reset` to leave a clean state.

Fallback: `samples/` holds a payload set for every scenario, and the whole service runs locally with
`npm run mock-webhook` plus `npm run dev` (or `docker build -t sim . && docker run -p 3000:3000 sim`).

## Troubleshooting

| Problem                           | Check                                                                      | Fix                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Service unavailable               | Railway service status, `/health`                                          | Read the startup log line "simulator starting"; confirm the port binding                        |
| `/ready` is 503                   | `missing_variables` / `invalid_variables` in the response                  | Add the named variable and redeploy                                                             |
| Events generated but not received | `webhook_status`, `last_response_code`, `recent_delivery_failures`         | 404: wrong URL or n8n workflow inactive (test vs production URL). 401/403: token mismatch       |
| `webhook_status: disabled`        | `webhook_target.mode`                                                      | `N8N_WEBHOOK_URL` is not set, or the run used `"webhook_url": "none"`                           |
| Duplicate downstream records      | Are they the same `event_id`?                                              | Retries reuse IDs by design. Team A must deduplicate on `event_id`                              |
| Alerts do not trigger             | `GET /api/v1/runs/current` shows the truth record with exact start seconds | Check the selected player, thresholds and rolling window against `metadata.match_clock_seconds` |
| Demo results change               | Status `seed` and `preset`                                                 | Use the `final_demo` preset                                                                     |
| 409 on start                      | Status shows `running` or `paused`                                         | Stop or reset the current run first                                                             |
| 401 on control calls              | `X-API-Key` header                                                         | Use the `CONTROL_API_KEY` from Railway                                                          |
| `events_dropped` rising           | Queue full because n8n is slow or down                                     | Fix n8n, or lower the event rate                                                                |

## Project layout

```text
src/
  server.ts, app.ts, config.ts
  routes/       health, status, runs, events, auth
  simulator/    engine (state machine), match-state (match generator), scheduler, random, ids
  generators/   telemetry, combat, odds
  scenarios/    normal, performance-anomaly, odds-integrity, combined, pipeline-failure, presets
  delivery/     webhook-client, retry-queue
  contracts/    events (schema 1.0), validation (run requests)
  data/         teams, players, baselines
tests/          unit, api, integration
scripts/        generate-samples, export-schema, mock-webhook
docs/           event-schema.json, HANDOFF.md
samples/        generated example payloads
```
