# 03. n8n ingestion: "G13 1 - Ingest telemetry"

## What this part does

This workflow is the front door. Every event from the simulator arrives here, is checked, and is either handed to the monitor for storage and scoring, or recorded as a dead letter with the reason it was rejected. When the monitor says a case needs an alert, this workflow starts the evidence and Slack workflow. It never stops for a bad event: the next event is processed normally.

## Where it lives

```
scripts/build-n8n-workflows.ts        readable source of all three workflows (edit this)
n8n/workflows/1-ingest-telemetry.json generated file that n8n imports (do not edit by hand)
n8n/Dockerfile, n8n/start.sh          how the n8n service is built and started
```

Open the live editor at https://n8n-production-d5d3.up.railway.app (Emmanuel shares the login). The node names below are exactly what you will see.

## The nodes, in order

```
Receive simulator event
        |
Validate and normalise
        |
   Valid event? --- false ---> Dead letter: invalid event
        | true
Store and score in monitor --- error ---> Dead letter: rejected by monitor
        | success
One item per alert
        |
Start evidence and alert  (launches "G13 2 - Evidence, AI summary and Slack alert")
```

### 1. Receive simulator event

A Webhook node listening for POST requests on the path `telemetry`. Its production address inside Railway is `http://n8n.railway.internal:5678/webhook/telemetry`, which is what the simulator's `N8N_WEBHOOK_URL` points at.

It answers 200 as soon as the request arrives ("respond on received"). The simulator therefore never waits for storage, scoring, AI or Slack, and never retries an event that n8n has already accepted.

### 2. Validate and normalise

A Code node (a box that runs a short JavaScript program). For each event it checks:

- the `X-Simulator-Token` header matches the `SIMULATOR_WEBHOOK_TOKEN` variable, so only our simulator is accepted;
- the body is a JSON object;
- these required fields are present and not empty: `event_id`, `event_type`, `schema_version`, `timestamp`, `match_id`, `sequence_number`, `simulator_run_id`;
- `timestamp` is a real date;
- `sequence_number` is a whole number;
- `metrics`, if present, is an object;
- `schema_version` is "1.0".

Normalising here means one small change: `event_type` is lower-cased so the monitor always sees the same spelling. Nothing else in the event is altered.

The node also creates the trace ID, `n8n-` plus the execution number (for example `n8n-4812`). It travels with the event into the database, onto the risk result, and onto any case the event opens.

It outputs `valid` (true or false), the list of `errors`, the `event`, its `event_id` and the `trace_id`.

### 3. Valid event?

An If node. True goes to storage, false goes to "Dead letter: invalid event".

### 4. Store and score in monitor

An HTTP Request node that posts the event and trace ID to the monitor:

```
POST {MONITOR_API_URL}/api/v1/monitor/events
Header: x-api-key = MONITOR_INGEST_KEY
Body:   { "event": { ...the event... }, "trace_id": "n8n-4812" }
```

The monitor checks the event again against the full contract (every field and type, per event type), stores it, scores it and answers with what happened, for example:

```json
{
  "stored": true,
  "duplicate": false,
  "event_id": "evt_20260930_130000_a1b2_000196",
  "results": [
    {
      "subject": "player_07",
      "status": "scored",
      "score": 95,
      "severity": "critical",
      "case_id": "CASE-7KQ2XM"
    }
  ],
  "alerts": [
    {
      "needed": true,
      "case_id": "CASE-7KQ2XM",
      "severity": "critical",
      "score": 95,
      "reason": "severity_increase"
    }
  ]
}
```

Settings: 10 second timeout, retry on failure up to 5 tries with 3 seconds between them, which covers a short database restart. If all tries fail, the node's error output leads to "Dead letter: rejected by monitor".

### 5. One item per alert

A Code node. The monitor's answer holds zero, one, or occasionally more alert instructions. This node turns each one into its own item and adds the trace ID. For almost every event there is no alert, so nothing comes out and the workflow ends here.

### 6. Start evidence and alert

An Execute Workflow node that starts "G13 2 - Evidence, AI summary and Slack alert" once per alert. It does not wait for the second workflow to finish, so a slow AI call or Slack outage never holds up ingestion.

### 7. Dead letter: invalid event

Posts to `/api/v1/monitor/dead-letters` with reason `validation_failed`, the joined error list (for example "timestamp is required"), the original payload, the event ID if there was one, and the trace ID.

### 8. Dead letter: rejected by monitor

Posts a dead letter with reason `monitor_rejected` and the monitor's error message. This catches events that passed the quick n8n checks but failed the monitor's full contract check, for example a `player_action` whose `reaction_time_ms` is the text "fast", or whose `player_id` is a number. It also catches the case where the monitor could not be reached after three tries.

Both dead-letter nodes are set to continue on error, so even a failure to write the dead letter never stops the workflow.

## Where invalid events go

Into the `monitor.dead_letters` table, with the time received, reason, error text, full payload, event ID, trace ID and a retry status. The Risk tab on the dashboard lists the latest 20 under "Dead letters: Events n8n rejected, with the reason. Later valid events are still processed."

## Duplicate handling

The simulator reuses the same `event_id` when it retries, and the `pipeline_test` preset deliberately sends duplicates. n8n does not try to remember which events it has seen. The monitor owns duplicate protection: `event_id` is the primary key of `monitor.events` (chapter 04), and the insert says "do nothing if this ID already exists". A duplicate returns `stored: false, duplicate: true`, is not scored again, and cannot create a second alert.

## Retries, in one place

| Where                        | What is retried                              | Schedule                              |
| ---------------------------- | -------------------------------------------- | ------------------------------------- |
| Simulator to n8n             | Network errors, timeouts, 5xx, 408, 425, 429 | Immediately, then 1 s, 3 s, 10 s      |
| "Store and score in monitor" | Any failure                                  | 5 tries, 3 s apart, 10 s timeout each |
| Dead letter nodes            | Not retried                                  | Continue on error                     |

Because n8n answers 200 straight away, the simulator's retries only happen when n8n itself is unreachable.

## Execution history

This workflow saves only failed executions in n8n's history. At 2 events per second, saving every successful run would fill the n8n database quickly. The other two workflows save every execution, so you can open any alert or Slack click in the editor's Executions list.

## How to check it works

1. Start the `pipeline_test` preset from the Overview tab.
2. On the Risk tab, "Events stored" rises and "Dead letters" starts to count up with reasons `validation_failed` and `monitor_rejected`.
3. Events keep arriving after each dead letter: the pipeline did not stop.
4. Duplicates do not raise "Events stored" twice. In the lead's end-to-end run through real n8n, 302 of 302 events were stored exactly once.

## Common problems

| Symptom                                                                                  | Likely cause                                         | Fix                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every event becomes a dead letter "missing or wrong X-Simulator-Token header"            | Token variables differ                               | `N8N_WEBHOOK_TOKEN` on the simulator must equal `SIMULATOR_WEBHOOK_TOKEN` on n8n                                                                                         |
| Risk tab says "The monitor database is still connecting" and Events stored does not rise | Monitor still connecting to Postgres after a restart | Wait; it retries every few seconds. Events sent in that gap are not stored, and their dead letter cannot be written either, so reset and restart the run once it is back |
| Simulator shows 404 from n8n                                                             | Workflow not published, or the test URL was used     | Restart the n8n service; the start script publishes all three                                                                                                            |
| A change made in the editor disappeared                                                  | The repository version is re-imported on every start | Make changes in `scripts/build-n8n-workflows.ts` (chapter 11)                                                                                                            |

## What to say in the demo

"Every event hits this n8n webhook, which answers straight away. We validate the token and the required fields; anything invalid goes to a dead letter with its reason and the pipeline keeps going. Valid events go to the monitor, which stores each event ID exactly once, so retries and duplicates are harmless."
