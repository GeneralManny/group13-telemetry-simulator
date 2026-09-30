# Live Telemetry + Odds Simulator Build Plan

## Group 13 - Esports Tournament Live Anti-Cheat & Match Integrity Monitor

**Owner:** Emmanuel, Team Lead  
**Deployment target:** Dixon Railway  
**Priority:** Make the live simulator available on Day 1 so Teams A-D can integrate immediately.  
**Primary consumers:** n8n ingestion workflow, database/risk engine, AI evidence workflow, and admin dashboard.

---

## 1. Simulator Goal

Build and host a reliable API that behaves like a live esports telemetry and betting-odds provider.

The simulator must:

- Generate realistic match, player, combat, performance, and odds events.
- Stream events continuously to the Group 13 n8n webhook.
- Support normal and suspicious scenarios.
- Allow a match to be started, paused, resumed, stopped, reset, and replayed.
- Produce predictable demo results when a deterministic seed is supplied.
- Expose its current status so other teams can confirm that it is online.
- Preserve a stable versioned event contract throughout the sprint.

The simulator supplies evidence for testing. It does not label a player as a cheater or prove that match-fixing occurred.

---

## 2. Recommended MVP Stack

| Area | Recommended choice | Reason |
|---|---|---|
| Runtime | Node.js 20+ | Simple JSON APIs, timers, and deployment |
| Language | TypeScript | Safer shared event contracts and easier maintenance |
| HTTP framework | Fastify or Express | Lightweight API and webhook delivery |
| Validation | Zod or JSON Schema | Validates configuration and generated events |
| Event scheduler | In-process interval/queue | Sufficient for the one-week MVP |
| Logging | Pino or structured JSON logs | Easy debugging in hosted logs |
| Testing | Vitest or Jest + Supertest | Unit and API testing |
| Hosting | Dixon Railway | Public, continuously available simulator service |
| Persistence | In-memory for active runs; optional hosted database for history | Keeps MVP simple while allowing later expansion |

### MVP simplification

Use one application instance and one active match at a time. Keep active match state in memory. The service must be able to recreate a known demonstration using a scenario name and seed after a restart.

---

## 3. High-Level Architecture

```text
Dashboard / Emmanuel / Demo Controls
                  |
                  v
        Simulator Control API
       start | pause | reset | replay
                  |
                  v
        Match State and Game Clock
                  |
        +---------+----------+
        |                    |
        v                    v
 Telemetry Generator    Odds Generator
        |                    |
        +---------+----------+
                  |
                  v
        Scenario Rule Engine
  normal | performance anomaly | odds integrity
                  |
                  v
       Event Validation and Queue
                  |
                  v
        Webhook Delivery Worker
        retry | log | delivery status
                  |
                  v
          Team A n8n Webhook
```

---

## 4. Functional Scope

### Required for the MVP

- One tournament containing at least one match.
- Two teams with at least five players each.
- Match start, round start, player action, combat, round end, odds update, and match end events.
- Configurable event rate.
- Configurable webhook destination.
- Normal scenario.
- Performance-anomaly scenario.
- Odds-integrity scenario.
- Combined high-risk demo scenario.
- Health and status endpoints.
- Delivery retries and visible delivery failures.
- Unique event IDs and UTC timestamps.
- Reset and deterministic replay.
- Basic API protection for control endpoints.
- Structured hosted logs.

### Optional after the MVP works

- Multiple simultaneous matches.
- Browser-based control panel.
- Persistent run history.
- Server-Sent Events or WebSocket preview.
- More game types and maps.
- Adjustable player personalities or skill profiles.
- Network delay, packet loss, and out-of-order-event test modes.

---

## 5. Shared Event Envelope

Every emitted event must use the same top-level envelope.

```json
{
  "event_id": "evt_000123",
  "event_type": "player_action",
  "schema_version": "1.0",
  "timestamp": "2026-09-27T12:00:00.000Z",
  "tournament_id": "tournament_001",
  "match_id": "match_001",
  "round_id": "round_04",
  "player_id": "player_07",
  "team_id": "team_blue",
  "sequence_number": 123,
  "scenario": "normal",
  "simulator_run_id": "run_20260927_001",
  "metrics": {},
  "odds": {},
  "metadata": {
    "map": "arena_alpha",
    "source": "group13_simulator"
  }
}
```

### Contract rules

- `event_id` must be unique across all runs.
- `sequence_number` must increase within a simulator run.
- `timestamp` must be an ISO 8601 UTC timestamp.
- `schema_version` begins at `1.0`.
- `simulator_run_id` identifies one start-to-finish simulation.
- `player_id`, `team_id`, and `round_id` may be `null` when they do not apply.
- Unknown optional fields may be ignored by consumers.
- Required fields must never be renamed during the sprint.
- Every webhook request should contain one event for simple tracing during the MVP.

---

## 6. Event Types

| Event type | When it is emitted | Important data |
|---|---|---|
| `match_started` | A simulation starts | Teams, roster, map, start time, scenario |
| `round_started` | A new round begins | Round number, score, active players |
| `player_action` | A player performs an action | Reaction time, accuracy, APM, position/action type |
| `combat_event` | Damage, kill, assist, or death occurs | Actor, target, weapon/action, result |
| `player_snapshot` | Periodic player summary | Accuracy, headshot rate, kills, deaths, APM |
| `odds_update` | Simulated odds change | Current odds, previous odds, movement percentage |
| `round_ended` | A round finishes | Winner, score, player summaries |
| `match_ended` | The match finishes | Winner, final score, final player summaries |
| `simulator_status` | Optional operational event | Run state, event count, delivery health |

### Player metrics

```json
{
  "reaction_time_ms": 215,
  "accuracy_pct": 48.5,
  "headshot_pct": 31.0,
  "actions_per_minute": 142,
  "kills": 4,
  "deaths": 3,
  "assists": 2,
  "damage": 620
}
```

### Odds data

```json
{
  "provider": "simulator",
  "team_blue": 1.85,
  "team_red": 2.10,
  "previous_team_blue": 2.05,
  "previous_team_red": 1.92,
  "movement_pct": 10.8,
  "market_timestamp": "2026-09-27T12:02:30.000Z"
}
```

---

## 7. Scenario Design

### Scenario 1: Normal match

**Purpose:** Prove that realistic play does not generate a high-risk alert.

- Reaction time stays within each player's normal range.
- Accuracy, headshot rate, and APM vary gradually.
- Odds respond reasonably to match score and momentum.
- No large unexplained odds changes occur.
- Expected downstream result: normal or monitor risk only.

### Scenario 2: Performance anomaly

**Purpose:** Trigger explainable performance rules.

- One selected player's reaction time drops sharply.
- Accuracy and/or headshot rate rises above the historical range.
- The pattern occurs repeatedly within a rolling time window.
- The change begins at a known round or elapsed time.
- Expected downstream result: high or critical performance-risk case.

### Scenario 3: Odds integrity anomaly

**Purpose:** Trigger match-integrity monitoring.

- Odds move sharply without a corresponding match event.
- The movement exceeds the agreed percentage threshold.
- The event includes previous odds, new odds, movement, and time.
- Expected downstream result: high odds-integrity risk or monitor case.

### Scenario 4: Combined suspicious pattern

**Purpose:** Produce the strongest final-demo case.

- A selected player begins unusual underperformance or overperformance.
- A large odds movement occurs close to the performance change.
- Both signals share the same match and time window.
- Expected downstream result: a higher combined score, one case, one Slack alert, and human review.

### Scenario 5: Pipeline failure tests

**Purpose:** Test Team A's reliability handling.

- Duplicate an existing `event_id`.
- Omit one required field.
- Send malformed or wrong-type data.
- Delay an event.
- Send an event with an older timestamp.
- Temporarily send faster than the normal event rate.

Failure modes must be explicitly enabled and disabled. They must never appear unexpectedly during the final demo.

---

## 8. Player Profiles and Baseline-Friendly Data

Create stable player profiles so Team B can establish meaningful baselines.

```json
{
  "player_id": "player_07",
  "display_name": "Blue Seven",
  "team_id": "team_blue",
  "role": "attacker",
  "baseline": {
    "reaction_time_ms": { "mean": 230, "stddev": 22 },
    "accuracy_pct": { "mean": 46, "stddev": 6 },
    "headshot_pct": { "mean": 29, "stddev": 7 },
    "actions_per_minute": { "mean": 145, "stddev": 18 }
  }
}
```

### Generation rules

- Generate normal values around each player's baseline.
- Clamp all values to valid ranges.
- Change metrics gradually during normal play.
- Apply anomaly multipliers only to the selected player and time window.
- Record the scenario truth internally for testing, but do not send a guilty verdict downstream.
- Use a seedable pseudo-random generator so tests are repeatable.

---

## 9. API Endpoints

### Public operational endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Confirms that the service is running |
| `GET` | `/ready` | Confirms that configuration is valid and the service can emit events |
| `GET` | `/api/v1/status` | Returns run state, scenario, counters, and webhook health |
| `GET` | `/api/v1/scenarios` | Lists supported scenarios and configuration options |

### Protected control endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/v1/runs` | Starts a new simulator run |
| `POST` | `/api/v1/runs/:runId/pause` | Pauses emission without losing state |
| `POST` | `/api/v1/runs/:runId/resume` | Resumes a paused run |
| `POST` | `/api/v1/runs/:runId/stop` | Stops the current run cleanly |
| `POST` | `/api/v1/runs/:runId/reset` | Clears the run and returns to the initial state |
| `POST` | `/api/v1/runs/:runId/replay` | Replays a run using the same seed/configuration |
| `POST` | `/api/v1/test-event` | Sends one controlled event for integration testing |

### Start-run request

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

### Start-run response

```json
{
  "run_id": "run_20260927_001",
  "status": "running",
  "scenario": "performance_anomaly",
  "started_at": "2026-09-27T12:00:00.000Z",
  "seed": 13027
}
```

### Status response

```json
{
  "service": "group13-telemetry-simulator",
  "status": "running",
  "run_id": "run_20260927_001",
  "scenario": "performance_anomaly",
  "events_generated": 128,
  "events_delivered": 126,
  "events_failed": 2,
  "last_event_at": "2026-09-27T12:02:15.000Z",
  "webhook_status": "degraded"
}
```

---

## 10. Webhook Delivery

### Delivery behaviour

- Send events to Team A using HTTP `POST` and `Content-Type: application/json`.
- Treat any `2xx` response as accepted.
- Use a short request timeout.
- Retry temporary failures with exponential backoff.
- Do not retry permanent `4xx` validation failures indefinitely.
- Keep the original event ID during retries.
- Track attempt count, last response code, and last error.
- Continue generating events when one delivery fails, within a bounded queue.
- Expose failed-delivery counts through `/api/v1/status`.

### Recommended retry schedule

```text
Attempt 1: immediately
Attempt 2: after 1 second
Attempt 3: after 3 seconds
Attempt 4: after 10 seconds
Final action: record as failed and continue
```

### Optional request authentication

Send a shared secret in a header agreed with Team A:

```text
X-Simulator-Token: <shared-secret>
```

Do not place the secret inside the JSON event or repository.

---

## 11. Simulator State Model

```text
IDLE
  |
  | start
  v
RUNNING <---- resume ---- PAUSED
  |                       ^
  | pause ----------------|
  |
  +---- stop ----> STOPPED
  |
  +---- natural end ----> COMPLETED

STOPPED / COMPLETED / FAILED
  |
  +---- reset ----> IDLE
  +---- replay ---> RUNNING
```

### State rules

- Only one active run is permitted in the MVP.
- Starting while a run is active returns a conflict response.
- Pause stops new event emission but preserves counters and match time.
- Reset clears active state and generates a new run ID on the next start.
- Replay uses the previous configuration and seed but a new run ID.
- Unexpected errors change the run to `failed` and remain visible in status.

---

## 12. Suggested Project Structure

```text
telemetry-simulator/
├── src/
│   ├── server.ts
│   ├── config.ts
│   ├── routes/
│   │   ├── health.ts
│   │   ├── status.ts
│   │   └── runs.ts
│   ├── simulator/
│   │   ├── engine.ts
│   │   ├── match-state.ts
│   │   ├── scheduler.ts
│   │   └── random.ts
│   ├── generators/
│   │   ├── telemetry.ts
│   │   ├── combat.ts
│   │   └── odds.ts
│   ├── scenarios/
│   │   ├── normal.ts
│   │   ├── performance-anomaly.ts
│   │   ├── odds-integrity.ts
│   │   └── combined.ts
│   ├── delivery/
│   │   ├── webhook-client.ts
│   │   └── retry-queue.ts
│   ├── contracts/
│   │   ├── events.ts
│   │   └── validation.ts
│   └── data/
│       ├── players.ts
│       ├── teams.ts
│       └── baselines.ts
├── tests/
│   ├── unit/
│   ├── api/
│   └── integration/
├── .env.example
├── Dockerfile
├── package.json
├── tsconfig.json
└── README.md
```

---

## 13. Environment Variables

```text
PORT=3000
NODE_ENV=production
LOG_LEVEL=info

N8N_WEBHOOK_URL=https://example.invalid/webhook/telemetry
N8N_WEBHOOK_TOKEN=replace-with-secret
CONTROL_API_KEY=replace-with-secret

DEFAULT_EVENT_RATE=2
DEFAULT_MATCH_DURATION_SECONDS=300
DELIVERY_TIMEOUT_MS=5000
MAX_DELIVERY_ATTEMPTS=4
MAX_QUEUE_SIZE=1000

ALLOWED_ORIGIN=https://dashboard.example.invalid
```

### Configuration rules

- Commit `.env.example`, never the real `.env` file.
- Store production secrets in Dixon Railway's environment configuration.
- Fail readiness when required production variables are missing.
- Log variable names when configuration is missing, never secret values.
- Use safe defaults only for non-secret development settings.

---

## 14. Build Checklist

### Phase 1 - Contract and project setup

- [ ] Create the repository and TypeScript application.
- [ ] Add formatting, linting, tests, and a production build command.
- [ ] Define the event envelope and all event types.
- [ ] Add runtime validation for events and control requests.
- [ ] Create stable teams, players, and baseline profiles.
- [ ] Share sample payloads with Teams A-D.
- [ ] Freeze schema version `1.0`.

### Phase 2 - Match engine

- [ ] Implement the simulator state machine.
- [ ] Implement the game clock, rounds, score, and match completion.
- [ ] Implement seedable random generation.
- [ ] Generate normal player actions and combat events.
- [ ] Generate periodic player snapshots.
- [ ] Generate odds updates based on match state.
- [ ] Add unique IDs, sequence numbers, UTC timestamps, and run IDs.

### Phase 3 - Suspicious scenarios

- [ ] Implement the normal scenario.
- [ ] Implement the performance-anomaly scenario.
- [ ] Implement the odds-integrity scenario.
- [ ] Implement the combined demo scenario.
- [ ] Implement controlled duplicate, invalid, delayed, and out-of-order modes.
- [ ] Verify that every anomaly begins at a known configurable point.

### Phase 4 - API and delivery

- [ ] Implement health, readiness, status, and scenario-list endpoints.
- [ ] Implement start, pause, resume, stop, reset, and replay endpoints.
- [ ] Protect control endpoints with an API key.
- [ ] Implement webhook POST delivery.
- [ ] Add timeouts, retries, queue limits, and failure counters.
- [ ] Add a single-event integration-test endpoint.
- [ ] Add structured logs containing event ID, run ID, and delivery result.

### Phase 5 - Deployment to Dixon Railway

- [ ] Create the Dixon Railway project and simulator service.
- [ ] Connect the source repository or deploy the container.
- [ ] Configure the build and start commands.
- [ ] Add all required production environment variables.
- [ ] Configure the service health check to use `/health`.
- [ ] Generate or attach the public service domain.
- [ ] Confirm HTTPS access to `/health`, `/ready`, and `/api/v1/status`.
- [ ] Set the n8n webhook URL and token.
- [ ] Review hosted logs after starting a test run.
- [ ] Restart the hosted service and confirm it returns safely to `idle`.

### Phase 6 - Team handoff

- [ ] Send the public base URL to all teams.
- [ ] Send Team A the webhook contract and shared-token method.
- [ ] Send Team B player profiles and baseline data.
- [ ] Send Team C example suspicious evidence sequences.
- [ ] Send Team D status endpoint details and sample dashboard data.
- [ ] Demonstrate start, status, reset, and replay.
- [ ] Publish a short troubleshooting guide.

---

## 15. Dixon Railway Deployment Runbook

### Required service behaviour

- Bind the HTTP server to `0.0.0.0`.
- Read the assigned port from the `PORT` environment variable.
- Provide a fast `/health` response that does not depend on n8n availability.
- Provide `/ready` for configuration readiness.
- Start in `idle`; do not automatically launch an anomaly scenario after deployment.
- Shut down cleanly when the hosting platform sends a termination signal.
- Stop timers and finish or cancel queued webhook attempts during shutdown.

### Build and start commands

Example commands for a TypeScript application:

```text
Build: npm ci && npm run build
Start: npm run start
```

### Deployment verification

```text
1. Open GET /health and confirm a 200 response.
2. Open GET /ready and confirm configuration is valid.
3. Call GET /api/v1/status and confirm state is idle.
4. Send one test event to Team A's n8n webhook.
5. Start a short normal run.
6. Confirm generated and delivered counters increase.
7. Reset and run the performance-anomaly scenario.
8. Confirm Team B receives the expected anomalous measurements.
9. Review hosted logs for failed deliveries or exposed secrets.
10. Record the public base URL and working configuration in the handoff notes.
```

### Safe deployment rule

Keep a known-good hosted release available during team integration. Do not deploy breaking changes immediately before an integration checkpoint or final demonstration.

---

## 16. Testing Plan

### Unit tests

- [ ] Unique event IDs are generated.
- [ ] Sequence numbers increase correctly.
- [ ] Timestamps are valid UTC ISO 8601 values.
- [ ] Normal values remain within allowed ranges.
- [ ] The same seed produces the same metric sequence.
- [ ] Anomaly rules affect only the configured player/window.
- [ ] Odds movement is calculated correctly.
- [ ] Invalid configuration is rejected.

### API tests

- [ ] `/health` returns success.
- [ ] `/ready` reports missing configuration correctly.
- [ ] Control endpoints reject missing or invalid API keys.
- [ ] A run can be started, paused, resumed, stopped, reset, and replayed.
- [ ] Starting a second active run returns a conflict.
- [ ] Invalid scenario names and parameters return clear errors.
- [ ] Status counters match emitted and delivered events.

### Webhook tests

- [ ] A successful `2xx` response records delivery success.
- [ ] Temporary failure causes the expected retries.
- [ ] Permanent validation failure is not retried indefinitely.
- [ ] Retries keep the original event ID.
- [ ] One failed event does not stop later events.
- [ ] Queue limits prevent uncontrolled memory use.

### End-to-end tests with other teams

- [ ] Normal run reaches n8n, database, and dashboard without a high alert.
- [ ] Performance anomaly produces an explainable risk result.
- [ ] Odds anomaly produces an odds-related risk result.
- [ ] Combined scenario produces one case and one Slack alert.
- [ ] Duplicate event is stored only once downstream.
- [ ] Invalid event enters Team A's error route without stopping the run.
- [ ] Reset and replay produce a repeatable final-demo sequence.

### Hosting tests

- [ ] Public HTTPS endpoints are reachable.
- [ ] Health checks remain successful while no match is active.
- [ ] Hosted logs show run and delivery information.
- [ ] Restarting the service does not automatically emit old events.
- [ ] Secrets do not appear in logs, API responses, or the repository.
- [ ] The service runs continuously for at least 30 minutes without crashing.

---

## 17. Observability and Troubleshooting

### Every delivery log should include

- Timestamp.
- Log level.
- Simulator run ID.
- Event ID and event type.
- Sequence number.
- Webhook attempt number.
- Response status or error category.
- Delivery duration.

### Do not log

- API keys.
- Webhook tokens.
- Full authorization headers.
- Hosting credentials.

### Common problems

| Problem | Check | Resolution |
|---|---|---|
| Service is unavailable | Hosted service status and `/health` | Review startup logs and port binding |
| Readiness fails | Missing environment variables | Add the named variable and redeploy |
| Events are generated but not received | Webhook URL, token, response status | Correct the endpoint or authentication |
| Duplicate downstream records | Event ID reuse or retry handling | Preserve IDs on retry and enable Team A deduplication |
| Alerts do not trigger | Scenario timing and anomaly values | Confirm selected player, thresholds, and rolling window |
| Demo results change | Missing or different seed | Reuse the approved demo seed and configuration |
| Too many Slack alerts | Repeated downstream case creation | Keep one case per player/match/window downstream |

---

## 18. Acceptance Criteria

The simulator is ready for team use when:

- [ ] The service is publicly reachable on Dixon Railway.
- [ ] `/health`, `/ready`, and `/api/v1/status` work over HTTPS.
- [ ] Emmanuel can start, pause, resume, stop, reset, and replay a run.
- [ ] The service sends schema version `1.0` events to the live n8n webhook.
- [ ] Every event contains a unique ID, UTC timestamp, run ID, and sequence number.
- [ ] Normal, performance-anomaly, odds-integrity, and combined scenarios work.
- [ ] A deterministic seed produces a repeatable demonstration.
- [ ] Delivery failure triggers bounded retries and visible status counters.
- [ ] Duplicate and invalid test modes can be deliberately enabled.
- [ ] A 15-minute continuous run completes without an unhandled crash.
- [ ] Team A confirms live ingestion.
- [ ] Team B confirms it can calculate a risk result from the emitted metrics.
- [ ] Team C confirms the suspicious sequence contains enough evidence for a summary.
- [ ] Team D confirms it can display status and live match data.
- [ ] Setup, API, configuration, deployment, and troubleshooting instructions are documented.
- [ ] No secret is committed or exposed.

---

## 19. Day 1 Delivery Schedule

### Morning - Foundation

- [ ] Create the application and shared event types.
- [ ] Implement health, readiness, and status endpoints.
- [ ] Add stable teams, players, baselines, and seeded randomness.
- [ ] Implement a short normal match run.

### Early afternoon - Integration

- [ ] Implement webhook delivery to Team A.
- [ ] Deploy the first working version to Dixon Railway.
- [ ] Send a single test event and confirm n8n receives it.
- [ ] Freeze the version `1.0` event envelope.

### Late afternoon - Scenarios

- [ ] Add performance-anomaly and odds-integrity scenarios.
- [ ] Add reset and deterministic replay.
- [ ] Run a 15-minute live integration test.
- [ ] Fix any contract-breaking or delivery-blocking issues.

### End-of-day handoff

- [ ] Share the hosted base URL.
- [ ] Share authentication details securely.
- [ ] Share sample normal and suspicious payloads.
- [ ] Demonstrate the control endpoints.
- [ ] Record known limitations and the next planned update.

---

## 20. Final Demo Configuration

Use a saved, tested configuration rather than entering values manually during the presentation.

```json
{
  "scenario": "combined",
  "seed": 13027,
  "event_rate_per_second": 2,
  "duration_seconds": 240,
  "target_player_id": "player_07",
  "anomaly_start_second": 60,
  "odds_anomaly_start_second": 90
}
```

### Demo sequence

1. Show that the hosted simulator is healthy and idle.
2. Start a short normal run.
3. Show live event and delivery counters.
4. Confirm no high-risk alert appears.
5. Reset the simulator.
6. Start the saved combined scenario.
7. Show the performance change and odds movement.
8. Follow the data through n8n, risk scoring, evidence, Slack, and the dashboard.
9. Complete the human review action.
10. Reset the simulator to a clean state.

### Demo fallback

- Keep one successful sample payload for each scenario.
- Keep the approved seed and configuration in the README.
- Keep screenshots of the hosted health/status responses.
- Keep a short local run command available if the hosted service becomes unreachable.
- Do not change the simulator contract or scenario values on demo day.

---

## 21. Definition of Done

- [ ] The simulator works from its public Dixon Railway address.
- [ ] All required scenarios can be controlled and replayed.
- [ ] Events follow the frozen version `1.0` contract.
- [ ] Team A has completed a live ingestion test.
- [ ] All critical automated and end-to-end tests pass.
- [ ] Health, readiness, status, logs, retries, and failure counters work.
- [ ] The final demo configuration produces the expected downstream result twice consecutively.
- [ ] The repository contains a README and secret-free `.env.example`.
- [ ] The handoff notes contain the public URL, API contract, scenario guide, and troubleshooting steps.
- [ ] Emmanuel has a known-good deployed release ready for the group demonstration.

