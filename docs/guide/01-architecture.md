# 01. Architecture: how the pieces fit

## The short version

A simulator pretends to be a live match feed. n8n receives each event, checks it, and hands it to the monitor. The monitor stores it in Postgres, scores it against the player's baseline, and opens a case when the score reaches High. n8n then writes an evidence summary (with a free AI model), posts a Slack alert, and records the human decision. The dashboard shows all of it.

## The three Railway services

Railway is the hosting platform. Our Railway project is called "group13-telemetry-simulator" and it holds three services. A service is one running program with its own settings.

1. telemetry-simulator. One Fastify program (Fastify is a Node.js web server framework) that does three jobs:
   - runs the simulator that generates match events,
   - runs the monitor API that stores events, scores risk and manages cases,
   - serves the dashboard website at the root address `/`.
     Public address: https://telemetry-simulator-production-bf55.up.railway.app

2. n8n. A self-hosted copy of n8n version 2.41.4. It runs the three workflows. The workflows are stored in the repository and imported and published every time the service starts. Public address: https://n8n-production-d5d3.up.railway.app

3. Postgres. The database. It holds the monitor's tables in a schema (a named folder of tables) called `monitor`, and n8n's own data in a schema called `n8n`. Same database, kept apart.

The simulator and n8n talk to each other over Railway's private network, which is not reachable from the internet. The simulator sends events to:

```
http://n8n.railway.internal:5678/webhook/telemetry
```

and n8n calls the monitor API over the private network too. Only the dashboard, the n8n editor, and the Slack button address are public.

Two outside services are used: OpenRouter (a free AI model writes the evidence summary) and Slack (alerts and review buttons).

## Diagram

```
 telemetry-simulator service                          n8n service
+------------------------------+   private   +------------------------------------+
| Simulator                    |  one event  | G13 1 - Ingest telemetry           |
|   generates events --------->+------------>+   validate, then store and score   |
|                              |  per POST   |                                    |
| Monitor API  <---------------+-------------+   (calls the monitor privately)    |
|   store once, score, cases   |             |                                    |
|   evidence, reviews, audit   |             | G13 2 - Evidence, AI summary and   |
|   calls AI for summaries     |             |         Slack alert  ---------------+--> Slack channel
|                              |             |                                    |
| Dashboard at /               |             | G13 3 - Slack review buttons <-----+--- button clicks
+--------------+---------------+             +-----------------+------------------+
               |                                               |
               v                                               v
      Postgres schema "monitor"                       Postgres schema "n8n"
```

## Follow one real event

This is a real `player_action` for player_07 from the `final_demo` preset, 97.5 seconds into the match. IDs and timestamps change every run; the metrics are the same every time because the seed is fixed.

```json
{
  "event_id": "evt_20260930_130000_a1b2_000196",
  "event_type": "player_action",
  "schema_version": "1.0",
  "timestamp": "2026-09-30T13:01:34.992Z",
  "tournament_id": "tournament_001",
  "match_id": "match_20260930_130000_a1b2",
  "round_id": "round_05",
  "player_id": "player_07",
  "team_id": "team_blue",
  "sequence_number": 196,
  "scenario": "combined",
  "simulator_run_id": "run_20260930_130000_a1b2",
  "metrics": {
    "reaction_time_ms": 129,
    "accuracy_pct": 74.4,
    "headshot_pct": 67.7,
    "actions_per_minute": 137
  },
  "odds": {},
  "data": { "action_type": "move", "position": { "x": 21.5, "y": 57.1 } },
  "metadata": {
    "map": "arena_alpha",
    "source": "group13_simulator",
    "simulator_version": "1.0.0",
    "match_clock_seconds": 97.5
  }
}
```

Step 1, simulator. The match generator creates the event and puts it in the delivery queue. The queue sends it to n8n with the header `X-Simulator-Token` (a shared password) and retries after 1, 3 and 10 seconds if n8n does not answer.

Step 2, n8n receives it. The node "Receive simulator event" answers 200 immediately so the simulator is never slowed down.

Step 3, n8n checks it. "Validate and normalise" checks the token, the required fields and the types, and creates a trace ID such as `n8n-4812`. "Valid event?" sends it down the good path. An invalid event would go to a dead letter instead (chapter 03).

Step 4, n8n hands it to the monitor. "Store and score in monitor" posts `{ event, trace_id }` to the monitor API at `/api/v1/monitor/events` with the ingest key.

Step 5, the monitor stores and scores it, all in one database transaction (either every write happens or none do):

- inserts the event into `monitor.events`. The `event_id` is the primary key, so a repeat is ignored;
- updates the match row (clock, score, events stored);
- settles any odds move that is now more than 5 seconds old. The 30.1% odds move at 1:30 was already judged "unexplained" at 1:35;
- scores player_07 over the last 30 seconds of match time (67.5 to 97.5 s): 9 actions, average reaction 118 ms against a baseline of 228.5 ms, and so on;
- the result is 95, Critical, with five rules (chapter 05);
- updates player_07's case for this match and links the 9 actions and the odds update as evidence;
- decides whether to alert. The case already alerted at High, and it is now Critical, so it returns one alert with reason `severity_increase`.

Step 6, n8n starts the second workflow. "One item per alert" turns the alert into one item and "Start evidence and alert" launches "G13 2 - Evidence, AI summary and Slack alert" without waiting for it, so ingestion keeps flowing.

Step 7, evidence and Slack. The second workflow asks the monitor for a summary (a free AI model, or the fixed template if the AI is unavailable), loads the case, builds the Slack message and posts it. The channel receives "Case CASE-7KQ2XM rose to CRITICAL". Delivery is recorded on the case.

Step 8, dashboard. The dashboard polls the monitor every 2.5 to 3 seconds. The Risk tab shows player_07 at Critical 95 and the Cases tab shows the case with its evidence.

Step 9, human decision. An administrator reviews the case in the dashboard or with a Slack button. The decision, reviewer name, notes and time are stored, and an audit row is written.

## Which part belongs to which team

| Part                                         | Where it lives                                                      | Plan owner |
| -------------------------------------------- | ------------------------------------------------------------------- | ---------- |
| Simulator and event contract                 | `src/simulator/`, `src/scenarios/`, `src/contracts/events.ts`       | Emmanuel   |
| Ingestion workflow, validation, dead letters | "G13 1 - Ingest telemetry", `scripts/build-n8n-workflows.ts`        | Team A     |
| Database, baselines, risk engine, cases      | `src/monitor/db/`, `src/monitor/engine/`, `src/monitor/service.ts`  | Team B     |
| Evidence, AI summary, Slack, human review    | "G13 2" and "G13 3", `src/monitor/evidence.ts`, `src/monitor/ai.ts` | Team C     |
| Dashboard, docs, tests, demo                 | `dashboard/`, `docs/`, `tests/`                                     | Team D     |

## Why it is built this way

- One event per request, with a unique `event_id`, makes duplicates easy to detect.
- n8n does the orchestration (routing, retries, AI and Slack calls) because the plan asks for an n8n pipeline, and because a teammate can see each step in the editor.
- The scoring lives in code as pure functions (same input, same output), so it can be unit tested and every point can be explained.
- The simulator knows nothing about the monitor. A real telemetry provider could replace it later without changing the monitor.

## What to say in the demo

"Events flow from the simulator into n8n, which validates them and hands them to our monitor. The monitor stores each event once, compares the player with their own baseline, and opens a case when the score reaches High. n8n then writes an evidence summary, alerts Slack, and a human makes the decision. The dashboard shows every step."
