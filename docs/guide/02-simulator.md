# 02. The simulator

## What it does

We do not have access to a real game publisher's data feed, so the simulator plays that role. It generates a believable esports match between Team Blue and Team Red, five players each, with changing betting odds, and streams it as events to n8n. It can also inject known suspicious patterns at a known second, so we can prove the monitor notices them.

The simulator only produces test evidence. It never labels a player or a match, and the events it sends contain no "truth" flag. The monitor has to find the pattern on its own.

## Where it lives

```
src/simulator/     engine (start, pause, stop, reset, replay), match generator, ticker, seeded random, IDs
src/generators/    player metrics, fights, betting odds
src/scenarios/     the five scenarios and the saved presets (presets.ts)
src/contracts/     the event contract (events.ts) and run request validation
src/data/          teams, the ten players, their built-in profiles
src/delivery/      the queue that posts events to n8n with retries
samples/           example payloads for every scenario
```

## What it generates

A match runs for a set number of seconds at a set rate, usually 2 events per second. The final demo produces 482 events over 4 minutes:

| Event type      | What it describes                                                       | Count in final_demo |
| --------------- | ----------------------------------------------------------------------- | ------------------- |
| match_started   | Teams, roster, map, number of rounds                                    | 1                   |
| round_started   | Round number and current score                                          | 10                  |
| player_action   | One player's reaction time, accuracy, headshot rate, actions per minute | 231                 |
| combat_event    | A fight: damage or a kill, weapon, headshot                             | 125                 |
| player_snapshot | A player's 30-second averages plus kills, deaths, assists               | 72                  |
| odds_update     | Match-winner odds for both teams and how much they moved                | 32                  |
| round_ended     | Winner and score                                                        | 10                  |
| match_ended     | Final score and per-player summary                                      | 1                   |

A ninth type, `simulator_status`, exists but is only sent when a run asks for it.

The ten players are player_01 to player_05 (Team Red, "Red One" to "Red Five") and player_06 to player_10 (Team Blue, "Blue Six" to "Blue Ten"). The demo always focuses on player_07, "Blue Seven", on Team Blue.

## The event contract

The contract is the agreed shape of every event, schema version "1.0". It is frozen: fields may be added as optional, but existing names never change. Every event has these fields:

| Field                        | Meaning                                               | Example                         |
| ---------------------------- | ----------------------------------------------------- | ------------------------------- |
| event_id                     | Unique ID, reused on retries                          | evt_20260930_130000_a1b2_000196 |
| event_type                   | One of the types above                                | player_action                   |
| schema_version               | Always "1.0"                                          | 1.0                             |
| timestamp                    | Real time in ISO 8601 UTC                             | 2026-09-30T13:01:34.992Z        |
| tournament_id                | Tournament                                            | tournament_001                  |
| match_id                     | New for every run                                     | match_20260930_130000_a1b2      |
| round_id                     | Round, or null for match-level events                 | round_05                        |
| player_id, team_id           | Who, or null for match-level events                   | player_07, team_blue            |
| sequence_number              | 1, 2, 3 ... within a run                              | 196                             |
| scenario                     | Which scenario produced it                            | combined                        |
| simulator_run_id             | The run                                               | run_20260930_130000_a1b2        |
| metrics                      | Player measurements (empty for odds and round events) | reaction_time_ms: 129           |
| odds                         | Odds data (only on odds_update)                       | team_blue: 1.43                 |
| data                         | Event-specific details                                | reason: market_update           |
| metadata.match_clock_seconds | Simulated match time                                  | 97.5                            |

Two details matter for the monitor:

- `match_clock_seconds` is the match's own clock. It stops while a run is paused, so all rolling windows use it rather than the real `timestamp`.
- On an `odds_update`, `movement_pct` is the largest percentage change of either team's odds since the previous update, and `data.reason` says why the market moved: `match_start`, `round_result` or `market_update`.

The full field-by-field schema is in `docs/event-schema.json` and one example of each type is in `samples/event-types.json`.

## Scenarios

| Scenario            | What happens                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| normal              | Every player stays inside their normal band (within 2.5 standard deviations of their profile). Odds follow the score.                                                                                                        |
| performance_anomaly | From a chosen second, the target player's reaction time roughly halves (about 230 ms to about 115 ms for player_07), accuracy rises about 34 points, headshot rate about 38 points, and they act about three times as often. |
| odds_integrity      | At a chosen second, one odds update moves at least 30% with reason `market_update`, at least 3 seconds away from any round boundary. The market stays at the new level.                                                      |
| combined            | Both of the above in the same match: the target player changes first, then the odds move toward that player's team. This is the final demo.                                                                                  |
| pipeline_failure    | Normal play plus duplicates, missing fields, wrong types, delayed events, stale timestamps, and a 5x burst between 30 and 40 seconds. For testing ingestion.                                                                 |

An underperformance version also exists (`anomaly_direction: "under"`): slower, less accurate, dies more. The engine flags it too.

## Presets

A preset is a saved, tested run configuration. Always use presets in the demo, never typed values. They live in `src/scenarios/presets.ts`.

| Preset           | Scenario            | Seed  | Rate | Length | Details                                       |
| ---------------- | ------------------- | ----- | ---- | ------ | --------------------------------------------- |
| final_demo       | combined            | 13027 | 2/s  | 240 s  | player_07 changes at 60 s, odds shock at 90 s |
| demo_normal      | normal              | 13027 | 2/s  | 120 s  | No anomalies                                  |
| performance_demo | performance_anomaly | 13027 | 2/s  | 300 s  | player_07 changes at 90 s                     |
| odds_demo        | odds_integrity      | 13027 | 2/s  | 240 s  | Odds shock at 90 s                            |
| pipeline_test    | pipeline_failure    | 13027 | 2/s  | 120 s  | Faults on about 8% of player events           |

In `final_demo` the odds shock at 1:30 moves Team Blue from 1.69 to 1.43 and Team Red from 2.19 to 2.85. Team Red's change is the larger one, 30.1%, so `movement_pct` is 30.1. The nearest round events are at 1:12 and 1:36, so nothing in the match explains the move.

## Seeds and replay

The simulator's randomness comes from a seeded generator. The same seed and settings always produce the same match content: the same players, the same metrics, the same odds. Only the IDs and timestamps change, because each run gets a new run ID and a new `match_id`.

This gives us repeatable demos. Every rehearsal of `final_demo` produces the same 95 for player_07. It also means demo runs never merge in the database: each run is a new match, so it gets its own cases.

The Replay button starts a new run with the same configuration and seed as the previous one.

## Controlling it from the dashboard

1. Open the dashboard and select Unlock (top right). Enter the control key. It is kept in this browser tab only and forgotten when the tab closes.
2. On the Overview tab, the Controls card shows the preset buttons: Final demo, Normal match, Performance anomaly, Odds integrity, Pipeline failure test.
3. Select a preset to start it. Only one run can be active; starting a second one is refused until you stop or reset.
4. Pause freezes the match clock and stops sending. Resume continues. Stop ends the run cleanly (queued deliveries still go out).
5. Reset clears the current run and cancels anything still queued, returning to idle. It asks for confirmation.
6. Replay repeats the last run with the same seed.
7. "Send test event" sends one valid event to every destination and reports how many answered 2xx.

Reset here only resets the simulator. The monitor's stored events and cases are cleared separately on the Risk tab (chapter 04).

## How to check it works

- The header pill says Online, and the Current match card shows the clock moving.
- Events generated and Deliveries rise together on the Overview tab. Failed stays at 0.
- The Live events tab shows events arriving with their JSON.

## What to say in the demo

"Because we cannot use real tournament data, the simulator plays the live feed. It is seeded, so this final demo produces the same match every time. At one minute, player_07's performance changes sharply, and at one minute thirty the odds move 30% with no round event nearby. The simulator does not tell the monitor any of this; the monitor has to notice it."
