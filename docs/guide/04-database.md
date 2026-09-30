# 04. The database

## What this part does

Postgres is the system's memory. It keeps every valid event exactly once, each player's baseline, every risk result, the cases, the evidence behind them, the human decisions, and a history of every status change. The dashboard reads from it and n8n writes to it, always through the monitor API, never directly.

## Where it lives

```
src/monitor/db/migrations.ts   the table definitions (SQL), applied in order
src/monitor/db/database.ts     connection pool, transactions, migrations, reference data seeding
src/monitor/service.ts         every query the monitor runs
```

A migration is a numbered set of database changes. On every start the monitor applies any migration that has not run yet and records it in `monitor.schema_migrations`. Migrations are append only: an applied one is never edited. There are two: `001_init` (the tables) and `002_status_checks` (allowed values for status, severity and review action).

All monitor tables live in the schema `monitor`. n8n keeps its own tables in the schema `n8n` in the same database, so the two never collide.

## The tables in plain words

Reference data (filled once, kept across resets):

- `players`: the ten players with display name, team and role. Example: player_07, "Blue Seven", team_blue, attacker.
- `baselines`: one row per player per metric, 40 rows in total. Each has the sample size, mean, standard deviation, minimum, maximum and where it came from. Example: player_07, reaction_time_ms, 572 samples, mean 228.54, standard deviation 21.5, source "simulated history: 20 normal matches (seeds 5001-5020)".
- `settings`: the risk thresholds as one JSON value under the key `thresholds` (chapter 05). Changing them here changes scoring without a code change.

Match data (cleared by a reset):

- `matches`: one row per match: scenario, run ID, live or ended, score, current round, match clock, number of events stored, start and end times.
- `events`: every stored event, with its metrics, odds and data as JSON, the time it was received and its trace ID.
- `odds_checks`: one verdict per odds update, given once 5 seconds of match time have passed: `unexplained` (a signal), `explained` (a big move next to a round event) or `normal` (a small move). Example: the final demo's 1:30 move is `unexplained`, 30.1%, Team Blue shortened, 30 points.
- `risk_results`: one row every time something is scored, with score, severity, the points per component, the rules with their measured values, and the source event IDs. This is what the "Risk score over the match" chart on a case is drawn from.
- `cases`: one row per match and subject (explained below). Holds status, severity, current score, peak score, the rules that explain the peak, the time window, alert delivery status, AI summary, reviewer, notes and timestamps.
- `evidence`: links a case to the events that produced it, with the kind (`player_action` or `odds_update`). Evidence is never deleted by a review.
- `reviews`: every human decision: action, reviewer name, notes, channel (`dashboard`, `slack` or `api`) and time.
- `case_audit`: every status change on a case: from, to, who, note and time.
- `dead_letters`: every rejected event with reason, error, payload, event ID, trace ID and retry status.

## Why event_id is the primary key

A primary key is a column the database guarantees is unique. Making `event_id` the primary key of `events` means the database itself refuses a second row with the same ID. The insert is written as "insert, and do nothing if it already exists", then the monitor checks whether a row was actually added:

- added: continue to scoring;
- not added: answer `duplicate: true` and stop. No second score, no second alert.

This is stronger than checking in n8n, because it still holds if two copies of the same event arrive at the same moment, or after a restart.

The whole ingest (event row, match update, odds verdicts, risk result, case update, evidence links) runs inside one transaction: if any step fails, none of it is saved, so the event can safely be retried later.

## One case per match and subject

The `cases` table has a unique rule on the pair (`match_id`, `subject_key`). The subject key is the player ID, or `market` for the betting market. So player_07 can have only one case in a given match, however many times they score High.

When a new High result arrives for a subject that already has a case, the case is updated instead: the score follows the latest result, and if the new score is a new peak, the severity, rules and score breakdown are replaced by the peak's. This is why the final demo produces one case, not dozens.

Because every run gets a new `match_id`, a replayed demo opens a fresh case instead of piling onto the old one.

## The audit trail

Every status change writes a row to `case_audit`. A typical final demo case shows:

```
Open                          by risk-engine        Opened at score 62
Open to Pending review        by evidence-workflow  Summary generated
Pending review to Escalated   by Admin Ada          Needs a second look
Escalated to Dismissed        by Admin Ada          Explained by hardware
```

The Cases tab shows this list at the bottom of each case. Together with `reviews`, it answers "who decided what, and when" for every case.

## What reset clears and keeps

Reset is available on the Risk tab as "Clear monitor data" (control key needed) and as `POST /api/v1/monitor/reset`.

It clears: `events`, `risk_results`, `cases`, `evidence`, `reviews`, `case_audit`, `odds_checks`, `dead_letters`, `matches`.

It keeps: `players`, `baselines`, `settings` (thresholds) and `schema_migrations`.

Baselines are only calculated when the table is empty, so a reset or restart never changes them, and the demo scores stay the same.

Reset does not touch the simulator (reset that separately on the Overview tab), n8n's execution history, or messages already posted in Slack.

## How to check it works

1. Clear monitor data on the Risk tab. Events stored drops to 0; Dead letters drops to 0.
2. Start `demo_normal`. Events stored rises by about 2 per second and matches the simulator's Events generated (demo_normal sends 242 in total).
3. The Cases tab says "No cases yet".
4. The automated tests in `tests/monitor/service.test.ts` check the duplicate rule, one case per match, reset keeping 40 baselines and 10 players, and the audit order (chapter 09).

## Common problems

| Symptom                                                   | Likely cause                                | Fix                                                                            |
| --------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| Dashboard says "The monitor database is still connecting" | Postgres restarting or `DATABASE_URL` wrong | Check the Postgres service and the variable; the monitor retries automatically |
| Old cases still showing before the demo                   | Only the simulator was reset                | Also select "Clear monitor data" on the Risk tab                               |

## What to say in the demo

"Postgres stores every event once, because the event ID is the primary key. Each player has one case per match that is updated rather than duplicated, and every status change is written to an audit trail. A reset clears the match data but keeps the baselines, so the demo is repeatable."
