# Group 13 Esports Integrity Monitor

Live anti-cheat and match integrity monitoring for esports tournaments. The system watches live match telemetry and
betting odds, compares each player with their own history, opens a case when the signals add up, writes an evidence
summary, alerts tournament administrators in Slack, and records their decision with a full audit trail.

The system flags signals for human review. No part of it states or implies that a player cheated or that a match was
fixed; a person makes every decision, and the wording of every alert, summary and screen is checked for this.

For examiners:

- [Final deliverables](deliverables/README.md): README files, documentation and project assets (the team member list
  is submitted separately)
- [Team guide](docs/guide/README.md): how every part works, in plain language; start with chapter 00
- [Test results](deliverables/TEST_RESULTS.md): 178 of 178 automated tests pass, plus dated end-to-end runs
- [Live dashboard](https://telemetry-simulator-production-bf55.up.railway.app)

## How it works

```text
Simulator ──one event per request──▶ n8n "G13 1 Ingest telemetry"
(live match + odds)                    validate token and contract ──invalid──▶ dead letter
                                       │
                                       ▼
                                     Monitor API: store once (event_id), score risk
                                       │ case reaches High
                                       ▼
                                     n8n "G13 2 Evidence and alert"
                                       evidence packet ─▶ AI summary (checked) or template
                                       │
                                       ▼
                                     Slack alert with Approve / Escalate / Dismiss
                                       │                                   │
                                       ▼                                   ▼
                       n8n "G13 3 Slack review buttons"           Dashboard Cases tab
                       (verifies Slack's signature)               (control key)
                                       └──────────▶ review + audit trail ◀─┘
```

1. The simulator plays a match: player actions, combat, 30-second player snapshots and betting-odds updates, about two
   events a second. Saved presets inject a performance change, an unexplained odds move, or pipeline faults.
2. n8n receives each event, checks the shared token and the event contract, and passes valid events to the monitor.
   Anything invalid is recorded as a dead letter with its reason; later events keep flowing.
3. The monitor stores each event once (the `event_id` is the primary key, so retries and duplicates are harmless) and
   scores every player from 0 to 100 against their own baseline: performance up to 60 points, an unexplained odds
   move up to 30, several signals at once up to 10. Every point names its rule and the measured values.
4. At 60 (High) a case opens and n8n builds the evidence packet, asks a free AI model for a plain-language summary,
   checks the wording and the facts, and falls back to a fixed template if the summary fails a check or no model
   answers. One Slack message goes out when the case opens and one more only if it becomes more severe.
5. An administrator approves it for investigation, escalates or dismisses it, in Slack or in the dashboard. The
   decision, reviewer, notes and time are stored; repeating a click changes nothing, and a final decision cannot be
   overwritten.

In the `final_demo` preset, Blue Seven (player_07) changes at 1:00 of match time, a case opens at High a few seconds
later, the odds shorten 30.1% for Blue Seven's team at 1:30 with no round result nearby, and the case rises to
Critical 95. The preset is seeded, so it gives the same result every time.

## Architecture

Three services on Railway, one project:

| Service               | What it runs                                                                                          | Code                                     |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `telemetry-simulator` | One Node.js service: the simulator, the monitor API and the dashboard (served at `/`)                 | `src/`, `dashboard/`, root `Dockerfile`  |
| `n8n`                 | Self-hosted n8n 2.41.4 with the three workflows, imported and published from this repository on start | `n8n/`, `scripts/build-n8n-workflows.ts` |
| `Postgres`            | One database, two schemas: `monitor` (events, baselines, cases, evidence, reviews, audit) and `n8n`   | `src/monitor/db/`                        |

The simulator and the monitor share a process but stay separate: the simulator behaves like an outside telemetry
provider and knows nothing about the monitor. n8n reaches the monitor over Railway's private network.

Stack: Node.js 20.9+, TypeScript, Fastify 5, Zod 4, Pino, PostgreSQL, n8n 2.41.4, Next.js 16 (static export), Vitest.
AI summaries use free models on OpenRouter. Alerts and review buttons use a Slack app.

## The parts

### Simulator

A hosted API that behaves like a live esports telemetry and betting-odds provider. It streams schema version 1.0
events, one per webhook request, and supports normal, performance-anomaly, odds-integrity, combined, and
pipeline-failure scenarios. It supplies test evidence only and never sends a verdict downstream. One active run at a
time; match state is in memory; the same scenario, seed and configuration always produce the same match content.
Guide: [chapter 02](docs/guide/02-simulator.md).

### n8n workflows

| Workflow                                     | Does                                                                                                                    |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| G13 1 - Ingest telemetry                     | Answers the simulator at once, checks `X-Simulator-Token` and the contract, stores and scores, or records a dead letter |
| G13 2 - Evidence, AI summary and Slack alert | Builds the evidence packet, gets the AI or template summary, posts the Slack alert, records delivery                    |
| G13 3 - Slack review buttons                 | Verifies the Slack signature and timestamp, records the decision in the monitor, replies in Slack                       |

The workflows are written as readable code in `scripts/build-n8n-workflows.ts` and generated with `npm run n8n:build`.
Every secret is read through `$env`, so the JSON in `n8n/workflows/` holds none. Guide:
[chapters 03](docs/guide/03-n8n-ingestion.md), [06](docs/guide/06-cases-evidence-and-ai.md) and
[07](docs/guide/07-slack-and-human-review.md).

The three workflows in the n8n editor:

![G13 1 - Ingest telemetry: receive, validate, store and score, or record a dead letter](docs/images/n8n-1-ingest-telemetry.png)

![G13 2 - Evidence, AI summary and Slack alert: a successful run](docs/images/n8n-2-evidence-and-alert.png)

![G13 3 - Slack review buttons: a successful run](docs/images/n8n-3-slack-review.png)

### Monitor and risk engine

Baselines for every player are learned from 20 simulated normal matches. The engine looks at a rolling 30-second window
of match time and measures how many standard deviations each metric sits from that player's baseline. Thresholds:
Monitor 30, High 60, Critical 80. The rules are pure functions with no I/O, so every score can be recomputed from the
stored evidence. Guide: [chapters 04](docs/guide/04-database.md) and [05](docs/guide/05-baselines-and-risk-engine.md).

### Evidence summaries

The AI receives only the evidence packet, with the direction of each odds move stated in plain words. Its answer is
rejected if it uses accusing language, reverses the odds direction, favours one decision, or describes timing in its
own words instead of the match times given; the next free model is then tried, and the
deterministic template is used if none passes. Every case is reviewable even with no AI available. Guide:
[chapter 06](docs/guide/06-cases-evidence-and-ai.md).

### Slack and human review

Alerts carry the severity, score, subject, time window, every rule that scored, the summary and the line "Signals for
human review only. No conclusion has been made." Guide: [chapter 07](docs/guide/07-slack-and-human-review.md).

The two alerts for one `final_demo` case, first at High and then at Critical:

![Slack alerts for CASE-V0N2LG at High and then Critical](docs/images/slack-alerts.png)

Decisions made with the buttons (reviewer names blurred): an escalation, a repeated click that changes nothing, and a
refused change to a case that was already approved:

![Slack replies to review button clicks](docs/images/slack-review-replies.png)

### Dashboard

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

The Overview tab, idle and ready for a match:

![Dashboard Overview tab: current match, controls with the saved presets, delivery counters, odds chart and player metrics](docs/images/dashboard-console.png)

Access keys are entered in the browser and kept in that tab only (sessionStorage):

| Key                  | Can do                                                                      |
| -------------------- | --------------------------------------------------------------------------- |
| `CONTROL_API_KEY`    | Everything: run control, test events, webhooks, case reviews, monitor reset |
| `TEAM_ACCESS_KEY`    | Add, test, pause and remove webhooks. Cannot touch runs or cases            |
| `MONITOR_INGEST_KEY` | Used by n8n only: write events, summaries, alerts and Slack decisions       |
| None                 | View the dashboard, status, charts, live events, cases and risk             |

Guide: [chapter 08](docs/guide/08-dashboard.md).

## Quick start (local)

Simulator and dashboard only:

```bash
npm install && npm run install:dashboard
npm run mock-webhook          # terminal 1: fake n8n on http://localhost:4000
cp .env.example .env          # then edit: NODE_ENV=development, N8N_WEBHOOK_URL=http://localhost:4000/webhook/telemetry
npm run dev                   # terminal 2: simulator API on http://localhost:3000
npm run dev:dashboard         # terminal 3: dashboard with hot reload on http://localhost:3001
```

With the monitor, add a local Postgres and point `DATABASE_URL` at it:

```bash
npm run build:dashboard
docker run -d --name g13-local-pg -e POSTGRES_PASSWORD=localpass -p 55433:5432 postgres:17-alpine
DATABASE_URL=postgres://postgres:localpass@localhost:55433/postgres NODE_ENV=development npm run dev
```

`localpass` is a throwaway password for a database on your own machine. On first start the monitor creates its
tables and computes the baselines.

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
| `npm run build:dashboard`     | Static export to `dashboard/out/`, served at `/` by the service            |
| `npm run build` / `npm start` | Production build to `dist/`, then run it                                   |
| `npm test`                    | Unit, API, webhook, monitor and end-to-end tests (Vitest)                  |
| `npm run check`               | Typecheck, lint, format check and tests                                    |
| `npm run n8n:build`           | Generate the three n8n workflow files in `n8n/workflows/`                  |
| `npm run samples`             | Write sample payloads for every scenario to `samples/`                     |
| `npm run schema`              | Export the event contract as JSON Schema to `docs/event-schema.json`       |
| `npm run mock-webhook`        | Local stand-in for n8n. `MOCK_FAIL_RATE=0.2` makes it fail 20% of requests |

## Simulator API

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

## Monitor API

Base path `/api/v1/monitor`. Returns 503 `monitor_unavailable` until the database is connected.

| Method | Path                                     | Key               | Purpose                                                                 |
| ------ | ---------------------------------------- | ----------------- | ----------------------------------------------------------------------- |
| GET    | `/overview`                              | none              | Pipeline health, events stored, dead letters, cases by status           |
| GET    | `/cases`                                 | none              | Case list                                                               |
| GET    | `/cases/:id`                             | none              | One case with evidence, score history, reviews and audit trail          |
| GET    | `/cases/:id/evidence`                    | none              | The evidence packet the summary and alert are built from                |
| GET    | `/players`                               | none              | Every player's current risk score, rules and baseline                   |
| GET    | `/dead-letters?limit=`                   | none              | Rejected events with their reason                                       |
| GET    | `/events/recent?limit=`                  | none              | Most recently stored events                                             |
| GET    | `/settings`                              | none              | Risk thresholds                                                         |
| POST   | `/events`                                | ingest or control | Store and score one event (idempotent on `event_id`)                    |
| POST   | `/dead-letters`                          | ingest or control | Record a rejected event and its reason                                  |
| POST   | `/cases/:id/summary`, `/cases/:id/alert` | ingest or control | Record the summary and the Slack delivery result                        |
| POST   | `/cases/:id/review`                      | ingest or control | Approve for investigation, escalate or dismiss, with reviewer and notes |
| POST   | `/reset`                                 | control           | Clear run data (events, cases, dead letters); baselines are kept        |

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

Every secret lives in the hosting platform's variables, never in this repository. The example files list the names
only: [.env.example](.env.example) for the main service and [n8n/.env.example](n8n/.env.example) for n8n.

Main service (`telemetry-simulator`):

| Variable                         | Required in production | Default         | Notes                                                         |
| -------------------------------- | ---------------------- | --------------- | ------------------------------------------------------------- |
| `PORT`                           | no                     | 3000            | Railway sets this                                             |
| `HOST`                           | no                     | 0.0.0.0         | `::` on Railway, so n8n can reach it over the private network |
| `NODE_ENV`                       | yes                    | development     | Set to `production` on Railway                                |
| `LOG_LEVEL`                      | no                     | info            | `debug` also logs health and status requests                  |
| `N8N_WEBHOOK_URL`                | yes                    |                 | The ingestion workflow's production webhook URL               |
| `N8N_WEBHOOK_TOKEN`              | recommended            |                 | Sent as `X-Simulator-Token`                                   |
| `CONTROL_API_KEY`                | yes                    |                 | 16+ characters. Protects control, review and reset endpoints  |
| `DATABASE_URL`                   | for the monitor        |                 | Postgres connection. Without it only the simulator runs       |
| `MONITOR_INGEST_KEY`             | for the monitor        |                 | 16+ characters. The key n8n uses to write to the monitor      |
| `PUBLIC_BASE_URL`                | recommended            |                 | This service's public address, for "Open case" links          |
| `DEFAULT_EVENT_RATE`             | no                     | 2               | Events per second                                             |
| `DEFAULT_MATCH_DURATION_SECONDS` | no                     | 300             |                                                               |
| `DELIVERY_TIMEOUT_MS`            | no                     | 5000            |                                                               |
| `MAX_DELIVERY_ATTEMPTS`          | no                     | 4               | Including the first attempt                                   |
| `MAX_QUEUE_SIZE`                 | no                     | 1000            |                                                               |
| `DELIVERY_CONCURRENCY`           | no                     | 4               |                                                               |
| `RETRY_DELAYS_MS`                | no                     | 1000,3000,10000 |                                                               |
| `ALLOWED_ORIGIN`                 | no                     |                 | Comma-separated dashboard origins for browser access          |
| `TEAM_ACCESS_KEY`                | no                     |                 | Webhook management only. Share with team leads                |
| `DATA_DIR`                       | recommended            |                 | Where dashboard webhooks are saved. `/data` on Railway        |
| `MAX_WEBHOOKS`                   | no                     | 20              |                                                               |
| `OPENROUTER_API_KEY`             | no                     |                 | AI case summaries. Without it, the template is used           |
| `OPENROUTER_MODELS`              | no                     | free models     | Comma-separated OpenRouter models, tried in order             |

n8n service, the variables the workflows read (n8n's own settings are in `n8n/.env.example`):

| Variable                  | Notes                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------- |
| `SIMULATOR_WEBHOOK_TOKEN` | Must equal `N8N_WEBHOOK_TOKEN` on the main service                                  |
| `MONITOR_API_URL`         | The main service's private address                                                  |
| `MONITOR_INGEST_KEY`      | Same value as on the main service                                                   |
| `DASHBOARD_URL`           | Used in alert links                                                                 |
| `SLACK_WEBHOOK_URL`       | The Slack app's incoming webhook. Without it, alerts are recorded as not configured |
| `SLACK_SIGNING_SECRET`    | Verifies that button clicks came from Slack                                         |
| `SLACK_INTERACTIVE`       | `true` adds the Approve, Escalate and Dismiss buttons                               |

`/ready` returns 503 and lists variable names (never values) when required variables are missing,
invalid, or still set to the `.env.example` placeholders. Logs redact API keys, tokens and
authorization headers, and status shows only the webhook host, never its path.

## Deploying to Railway

1. Create a Railway project with a Postgres database.
2. Main service: create a service from this repository. `railway.json` selects the Dockerfile, sets the health check
   to `/health`, and keeps one replica. Add the variables above, set `NODE_ENV=production`, generate a public domain,
   and add a volume mounted at `/data` with `DATA_DIR=/data` (also set `RAILWAY_RUN_UID=0`, because Railway volumes
   are owned by root and the image runs as the `node` user). Deploy with
   `railway up --service telemetry-simulator --detach`.
3. n8n service: deploy the `n8n/` folder as its own service with
   `railway up n8n --path-as-root --service n8n --detach`, and set the variables from `n8n/.env.example`. On every
   start it imports and publishes the three workflows from `n8n/workflows/`, so the repository is the source of
   truth. Create the n8n owner account once in the browser.
4. Slack: create a Slack app with an incoming webhook to the alerts channel, turn Interactivity on with the Request
   URL `https://<n8n domain>/webhook/slack-actions` (Socket Mode off), and copy the webhook URL and signing secret
   into the n8n variables. Step by step: [chapter 07](docs/guide/07-slack-and-human-review.md).
5. Verify:
   1. `GET /health` returns 200 and `GET /ready` returns `"status": "ready"` with `"monitor": "ready"`.
   2. The n8n editor shows the three workflows published.
   3. `POST /api/v1/test-event` returns `"delivery": {"ok": true}` and the Risk tab's events stored rises.
   4. Run `final_demo`: one case reaches Critical 95 and two Slack messages arrive.
   5. Reset both halves: Overview, Reset; then Risk, "Clear monitor data".

The service starts idle, never starts a scenario on its own, and on SIGTERM stops the ticker, gives in-flight
deliveries 3 s to finish, and exits. Railway is not linked to GitHub, so a push does not deploy. Keep a known-good
release deployed and do not deploy right before a demo.

## Final demo

The full timed script with speaking roles is in [chapter 10](docs/guide/10-demo-runbook.md). In short, always using
the saved presets:

1. Reset both halves. `GET /health` and `GET /api/v1/status`: healthy and idle; events stored 0, no cases.
2. Run `demo_normal`. The counters rise, every player stays Normal, no case and no Slack message.
3. Reset the simulator and run `final_demo`. Blue Seven changes at 1:00, a case opens at High about 1:08 with the
   first Slack alert, the odds move 30.1% at 1:30, and the case rises to Critical 95 about 1:38 with the second alert.
4. Open the case: rules, measured values against the baseline, score breakdown 55 / 30 / 10, and the summary.
5. An administrator records a decision in Slack or the dashboard; a second click changes nothing.
6. Reset to leave a clean state.

Fallback: `samples/` holds a payload set for every scenario, and the whole service runs locally (Quick start above).

## Testing

```bash
npm run check   # typecheck, lint, format check and tests
TEST_DATABASE_URL=postgres://postgres:testpass@localhost:55432/monitor_test npm test   # include the Postgres tests
```

178 tests cover the simulator, delivery, webhooks, the API, the risk engine, the AI summary checks, and the monitor
against a real Postgres (11 tests, skipped when `TEST_DATABASE_URL` is not set). Each plan scenario T01 to T18 is
mapped to its test in [chapter 09](docs/guide/09-testing.md); dated results are in
[deliverables/TEST_RESULTS.md](deliverables/TEST_RESULTS.md).

## Troubleshooting

| Problem                           | Check                                                                      | Fix                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Service unavailable               | Railway service status, `/health`                                          | Read the startup log line "simulator starting"; confirm the port binding                                              |
| `/ready` is 503                   | `missing_variables` / `invalid_variables` in the response                  | Add the named variable and redeploy                                                                                   |
| Events generated but not received | `webhook_status`, `last_response_code`, `recent_delivery_failures`         | 404: wrong URL or n8n workflow inactive (test vs production URL). 401/403: token mismatch                             |
| `webhook_status: disabled`        | `webhook_target.mode`                                                      | `N8N_WEBHOOK_URL` is not set, or the run used `"webhook_url": "none"`                                                 |
| Duplicate downstream records      | Are they the same `event_id`?                                              | Retries reuse IDs by design. Team A must deduplicate on `event_id`                                                    |
| Alerts do not trigger             | `GET /api/v1/runs/current` shows the truth record with exact start seconds | Check the selected player, thresholds and rolling window against `metadata.match_clock_seconds`                       |
| Demo results change               | Status `seed` and `preset`                                                 | Use the `final_demo` preset                                                                                           |
| 409 on start                      | Status shows `running` or `paused`                                         | Stop or reset the current run first                                                                                   |
| 401 on control calls              | `X-API-Key` header                                                         | Use the `CONTROL_API_KEY` from Railway                                                                                |
| `events_dropped` rising           | Queue full because n8n is slow or down                                     | Fix n8n, or lower the event rate                                                                                      |
| No case appears                   | Risk tab: events stored and dead letters                                   | Dead letters saying "missing or wrong X-Simulator-Token": the two tokens differ. Nothing stored: check n8n is running |
| Summary always "Template"         | Risk tab "AI summaries", service logs                                      | `OPENROUTER_API_KEY` missing, or every free model busy; the log names the reason                                      |
| Slack alert not delivered         | Case page, "Slack alert"                                                   | `SLACK_WEBHOOK_URL` not set on the n8n service, or the app was removed from the channel                               |
| Slack click does nothing          | n8n "G13 3 - Slack review buttons" executions                              | Request URL wrong, Socket Mode on, or `SLACK_SIGNING_SECRET` wrong                                                    |

More in [chapter 11](docs/guide/11-setup-and-operations.md).

## Known limitations

- One instance of each service. The simulator keeps run state in memory, so a restart returns it to idle; any run can
  be recreated from its preset or seed.
- Case pages are readable without a key, which is acceptable only because all the data is simulated. Real player data
  would need login and role-based access. Decisions, resets and settings need a key.
- Baselines come from 20 simulated matches, not real history.
- A database outage longer than the ingestion retries (about 15 seconds) loses the events sent during it.
- An unexplained odds move on its own reaches at most 30 (Monitor), so it shows on the Risk tab but never opens a case.
- Free AI models change availability without notice; the template is used when none answers.

## Project layout

```text
src/
  server.ts, app.ts, config.ts
  routes/       health, status, runs, events, webhooks, auth
  simulator/    engine (state machine), match-state, scheduler, random, ids
  generators/   telemetry, combat, odds
  scenarios/    normal, performance-anomaly, odds-integrity, combined, pipeline-failure, presets
  delivery/     webhook-client, retry-queue, subscriptions (dashboard webhooks)
  contracts/    events (schema 1.0), validation
  data/         teams, players, baselines
  monitor/
    db/         Postgres connection and migrations
    engine/     baselines, risk rules, thresholds, replay
    service.ts  storage, scoring, cases, reviews, audit trail
    evidence.ts evidence packet, AI prompt, checks, fallback template
    ai.ts       OpenRouter summaries with model fallback
    routes.ts   monitor API
dashboard/      Next.js console (static export served at /)
n8n/            n8n service: Dockerfile, start script, workflows/ (generated JSON)
scripts/        build-n8n-workflows, generate-samples, export-schema, mock-webhook
tests/          unit, api, integration, monitor
docs/           guide/ (team guide), plans/, event-schema.json, HANDOFF.md
deliverables/   submission index and test results
samples/        generated example payloads
```
