# 09. Testing

## What this part covers

The plan lists 18 required test scenarios, T01 to T18 (section 10 of the build plan). This chapter maps each one to the automated test that proves it, or to the manual step that shows it when no automated test exists, and explains how to run the tests.

## How the tests are organised

The tests use Vitest, a JavaScript test runner. They live in `tests/`:

```
tests/unit/          event contract, scenarios, fault injection, delivery queue, run validation, webhook store
tests/api/           the HTTP API: health, keys, run lifecycle, counters, webhooks, dashboard
tests/integration/   a full match delivered over HTTP to a fake webhook
tests/monitor/engine.test.ts    baselines, risk rules, severity bands, alert decision, language check
tests/monitor/service.test.ts   the monitor against a real Postgres: storage, cases, reviews, reset
tests/helpers/       shared helpers (simulate a whole match in memory, a fake webhook)
```

There are 165 tests and all pass. The 11 tests in `tests/monitor/service.test.ts` need a real database and are skipped when none is configured.

The n8n workflows are not run by the automated tests. Their behaviour was verified by the lead in a local end-to-end run through real n8n 2.41.4: 302 of 302 events stored once, one case for player_07 at Critical 95, exactly two Slack messages ("New HIGH integrity case", then "rose to CRITICAL"), invalid events recorded as dead letters (`validation_failed` or `monitor_rejected`) while later events kept flowing, signed Slack clicks recorded as reviews, repeated clicks changing nothing, and a forged signature rejected.

## Running the tests

Without a database (148 run, 11 skipped):

```
npm install
npm test
```

With a database, start a throwaway Postgres in Docker (the command is in the header of `tests/monitor/service.test.ts`), then point the tests at it:

```
docker run -d --name g13-test-pg -e POSTGRES_PASSWORD=testpass -e POSTGRES_DB=monitor_test -p 55432:5432 postgres:17-alpine
TEST_DATABASE_URL=postgres://postgres:testpass@localhost:55432/monitor_test npm test
```

`testpass` is a local, throwaway test password, not a project secret. The service tests drop and recreate the `monitor` schema in that database, so never point `TEST_DATABASE_URL` at the Railway database.

The full pre-release check (types, lint, formatting and tests):

```
npm run check
```

## T01 to T18

| ID  | Scenario                                                    | Automated proof                                                                                                                                                                                                                                                                        | Manual step                                                                                                              |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| T01 | Normal full match: stored, normal or monitor only, no alert | engine.test "keeps normal play below the monitor threshold (T01)" (25 seeds); service.test "stores a normal match once and opens no case (T01)"; scenarios.test "keeps every metric within hard limits and the baseline band"                                                          | Run `demo_normal`: Risk tab all Normal 0, Cases empty, no Slack message                                                  |
| T02 | Unrealistically fast reactions                              | engine.test "flags fast reactions and an accuracy spike as high, with exact values (T02, T03)": PERF_REACTION_TIME fires, direction below, observed under 160 ms, deviation beyond 2.5                                                                                                 | `final_demo`: case shows reaction 118 ms vs 228.5 ms, -5.14 sd                                                           |
| T03 | Accuracy or headshot spike                                  | Same test: PERF_ACCURACY fires above baseline with observed and baseline values recorded                                                                                                                                                                                               | Case baseline table shows accuracy 79.5% vs 46.1%                                                                        |
| T04 | Multiple anomalies in a window: one case, no flood          | engine.test "alerts once when a case reaches high, again only when it becomes more severe (T04)"; service.test "turns the final demo into one critical case with at most two alerts (T04, T06)"                                                                                        | Slack shows exactly two messages for one run                                                                             |
| T05 | Sharp odds move without a match event                       | engine.test "flags an unexplained odds move on the market, with the time relationship (T05)" (30% or more, "no round result within 5 seconds", Monitor); engine.test "treats an odds move next to a round result as explained"; scenarios.test odds integrity tests                    | Run `odds_demo`: Risk tab Betting market row Monitor 30 with ODDS_UNEXPLAINED_MOVE                                       |
| T06 | Odds move plus unusual play                                 | engine.test "scores odds plus unusual play higher than either alone, explaining both (T06)"; engine.test "does not attach the market signal to players who played normally"; service.test final demo test                                                                              | `final_demo`: score breakdown 55 / 30 / 10                                                                               |
| T07 | Duplicate event_id                                          | service.test "stores a duplicate event_id only once (T07)"; failure-modes.test "duplicates keep the original event ID and sequence number"; delivery.test "retries temporary failures and keeps the original event ID and body"                                                        | `pipeline_test`: Events stored does not count duplicates                                                                 |
| T08 | Missing required field or invalid payload                   | failure-modes.test "missing-field and malformed events fail the contract"; api.test "can send a deliberately invalid event"; service.test "stores dead letters and clears run data on reset while keeping baselines"                                                                   | `pipeline_test`: Dead letters list fills with reasons while Events stored keeps rising                                   |
| T09 | Out-of-order timestamp                                      | failure-modes.test "stale events carry an older timestamp but remain valid"; delivery.test "holds delayed events until their delay passes". Rule: windows use `match_clock_seconds`, never arrival order or `timestamp`, and the match clock only moves forward                        | `pipeline_test` includes delayed and stale events; no dead letters for them and no cases                                 |
| T10 | Unknown player, no baseline                                 | engine.test "returns insufficient_data when the player has no baseline (T10)"; service.test "marks an unknown player as insufficient_data instead of inventing a baseline (T10)"                                                                                                       | Not shown in the demo                                                                                                    |
| T11 | Database temporarily unavailable                            | No automated test. Design: "Store and score in monitor" retries 3 times; each event is one transaction, so a failed attempt leaves nothing half-written; `event_id` as primary key means a later retry cannot duplicate; the monitor reconnects on its own                             | Local only: stop the test Postgres during a run, restart it, check Events stored has no duplicates. See limitation below |
| T12 | AI service unavailable                                      | service.test "uses the fallback summary without an AI key, then moves the case to pending review (T12)"; engine.test "produces a fallback summary that is grounded and non-accusatory (T12)"                                                                                           | Remove `OPENROUTER_API_KEY`: Risk tab says "Template only", case summary labelled Template                               |
| T13 | Slack unavailable                                           | service.test "records a failed Slack delivery while keeping the case reviewable (T13)"; n8n nodes "Record alert failed" and "Record Slack not configured"                                                                                                                              | Unset `SLACK_WEBHOOK_URL`: case shows "Not delivered: slack_not_configured" and can still be reviewed                    |
| T14 | Human approves investigation                                | service.test "records reviews with reviewer and notes, keeps evidence, and is idempotent (T14-T17)" and "approves a case for investigation directly from pending review (T14)" cover reviewer, notes, status and timestamps for all three actions                                      | Approve a case in the Cases tab; decision shows reviewer, time and notes                                                 |
| T15 | Human dismisses                                             | Same test: dismissed, evidence count unchanged                                                                                                                                                                                                                                         | Dismiss a case; evidence and audit remain                                                                                |
| T16 | Human escalates                                             | Same test: status escalated, audit row written                                                                                                                                                                                                                                         | Escalate; status badge and Risk tab Open cases update                                                                    |
| T17 | Duplicate review                                            | Same test: repeat escalate returns duplicate, a different action on a final case is refused (409)                                                                                                                                                                                      | Click Escalate in Slack twice: "was already escalated; nothing changed."                                                 |
| T18 | Reset and replay                                            | service.test "keeps scores reproducible: the same replay gives the same case score (T18)"; events.test "replays the same content for the same seed and configuration"; integration "replays an identical demo sequence"; api.test "starts, pauses, resumes, stops, resets and replays" | Reset both, run `final_demo` twice: 95 both times                                                                        |

Also tested: the severity boundaries 29/30, 59/60 and 79/80 (engine.test "uses the agreed severity bands at the boundaries"), baselines identical on every run, and no one-event alarms below 4 samples.

## Known gaps

- T11: events that arrive while the database is down for longer than the retry window (5 tries, 3 seconds apart, about 15 seconds) are not stored, and their dead letter cannot be written because it also needs the database. The simulator does not resend them, because n8n already answered 200. Recovery never duplicates data, but those events are missed.
- The simulator's invalid events have wrong types or missing fields. A body that is not valid JSON at all is handled by the check "body is not a JSON object", but no automated test sends one through n8n.
- The n8n workflows are verified by the lead's end-to-end run, not by `npm test`.

## What to say in the demo

"We have 165 automated tests, including eleven that run against a real Postgres. They cover every required scenario except the database outage, which we tested by design and document as a limitation. The n8n pipeline was verified end to end: 302 of 302 events stored once, one case, exactly two Slack messages."
