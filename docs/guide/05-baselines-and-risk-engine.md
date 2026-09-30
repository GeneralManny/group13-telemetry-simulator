# 05. Baselines and the risk engine

## What this part does

The risk engine turns raw events into a score from 0 to 100 that a person can check by hand. It compares each player's recent play with that player's own history, adds points for each rule that fires, and records exactly which values earned which points. It never decides anything about a person; it only measures how unusual the numbers are.

## Where it lives

```
src/monitor/engine/baselines.ts    learns baselines from 20 simulated historical matches
src/monitor/engine/thresholds.ts   every tunable number, and the severity bands
src/monitor/engine/risk.ts         the rules and the score (pure functions)
src/monitor/engine/replay.ts       runs a whole match through the engine (tests and tuning)
src/monitor/service.ts             calls the engine for each stored event and manages cases
```

"Pure functions" means no database, no clock and no randomness inside the rules. The same inputs always give the same score, which is what makes the scores reproducible and testable.

## How baselines are learned

A baseline is a player's normal range for one metric. The monitor learns it the first time it starts:

1. It plays 20 normal matches through the simulator, using fixed seeds 5001 to 5020, 5 minutes each.
2. It collects every `player_action` value for each player and each of the four metrics: reaction time, accuracy, headshot rate and actions per minute.
3. For each player and metric it stores the mean (average), the standard deviation, the minimum, the maximum and the sample size.

That gives 40 rows (10 players x 4 metrics). player_07's baselines:

| Metric             | Mean   | Standard deviation | Samples |
| ------------------ | ------ | ------------------ | ------- |
| Reaction time (ms) | 228.54 | 21.5               | 572     |
| Accuracy (%)       | 46.09  | 5.88               | 572     |
| Headshot rate (%)  | 29.29  | 7.44               | 572     |
| Actions per minute | 145.64 | 17.74              | 572     |

Because the history uses fixed seeds, the baselines are identical on every machine and after every reset. In a real deployment they would come from the player's real past matches.

## The rolling 30-second window

A single fast reaction proves nothing: anyone can have one great moment. So the engine never scores one event on its own. Each time a `player_action` arrives, it takes all of that player's actions from the last 30 seconds of match time and averages them.

- The window uses `match_clock_seconds`, so pausing the match does not distort it.
- If the window holds fewer than 4 actions, the performance rules stay silent and the result carries a note such as "Only 3 action(s) in the window; at least 4 are needed".

## Standard deviations, simply

Standard deviation is the typical distance between a player's individual values and their average. For player_07's reaction time it is 21.5 ms.

To say how unusual a window average is, the engine divides the gap from the baseline by the standard deviation:

```
deviation = (window average - baseline mean) / baseline standard deviation
          = (118 - 228.5) / 21.5
          = -5.14
```

So player_07's average of 118 ms is 5.14 standard deviations below normal. For comparison, the simulator keeps normal play within 2.5 standard deviations, which is why the rules start at 2.5.

Using each player's own baseline matters: a sniper with a naturally high headshot rate (player_09, mean about 40%) is not flagged for being a sniper.

## The rules

Rule IDs appear on the dashboard, in Slack and in the evidence, so learn them.

| Rule ID               | Component   | Fires when                                                                                                                                               | Maximum points |
| --------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| PERF_REACTION_TIME    | performance | window average reaction time is 2.5 or more standard deviations from baseline                                                                            | 25             |
| PERF_ACCURACY         | performance | window average accuracy is 2.5 or more standard deviations from baseline                                                                                 | 15             |
| PERF_HEADSHOT         | performance | window average headshot rate is 2.5 or more standard deviations from baseline                                                                            | 15             |
| PERF_ACTIVITY         | performance | window average actions per minute is 2.5 or more standard deviations from baseline                                                                       | 5              |
| ODDS_UNEXPLAINED_MOVE | odds        | a market update moved the odds 20% or more with no round start or end within 5 seconds, and it was within 60 seconds of this player's performance change | 30             |
| CLUSTER_MULTI_SIGNAL  | cluster     | 2 or more independent signals in the same window                                                                                                         | 10             |

How performance points scale: a rule starts at 2.5 standard deviations and earns its full points at 4 or more. In between, points grow in a straight line measured from 2: at 2.5 a rule earns a quarter of its points, at 3 half, at 3.5 three quarters. Example: PERF_HEADSHOT at 3.6 standard deviations earns 12 of 15.

How odds points scale: 20% earns 15 points, 25% earns 23, 30% or more earns the full 30.

How the odds move is judged: only an update with reason `market_update` can count (a move after a round result is expected). The engine waits until 5 seconds of match time have passed, so a round event arriving just after the move still explains it, then records the verdict in `odds_checks`.

What counts as independent signals for the cluster rule: each performance rule that fired counts as one, and an attached odds signal counts as one more. Three performance rules on their own are enough, which is why `performance_demo` includes the 10 cluster points.

## The 0 to 100 formula

```
performance = sum of performance rule points, capped at 60
odds        = odds rule points, capped at 30
cluster     = cluster points, capped at 10
score       = performance + odds + cluster, capped at 100
```

These caps are the plan's "performance 0 to 60, odds 0 to 30, repeat or cluster 0 to 10".

## Severity bands

| Score     | Severity | What the system does                                    |
| --------- | -------- | ------------------------------------------------------- |
| 0 to 29   | Normal   | Store only                                              |
| 30 to 59  | Monitor  | Shown on the Risk tab; no case, no alert                |
| 60 to 79  | High     | Opens or updates a case and alerts Slack                |
| 80 to 100 | Critical | Same, and alerts again if the case was only High before |

The boundaries are tested exactly: 29 is Normal, 30 Monitor, 59 Monitor, 60 High, 79 High, 80 Critical.

## Worked example: final_demo for player_07

The anomaly starts at 1:00 match time and the odds shock happens at 1:30.

At 65 seconds (1:05) the window already holds enough unusual actions: score 39, Monitor. No case yet.

At 67.5 seconds (1:07) the score reaches 62, High (reaction 25, accuracy 15, headshot 12, cluster 10). A case opens and the first Slack alert is sent.

At 1:30 the odds move 30.1% (Team Blue 1.69 to 1.43, Team Red 2.19 to 2.85). The nearest round events are 18 seconds before and 6 seconds after, both outside the 5-second gap. At 1:35 the move is judged unexplained, worth 30 points. On its own the market scores 30, Monitor.

At 97.5 seconds (1:37) player_07's window, 67.5 to 97.5 seconds, holds 9 actions:

| Rule                  | Measured                                                               | Baseline           | Deviation  | Points |
| --------------------- | ---------------------------------------------------------------------- | ------------------ | ---------- | ------ |
| PERF_REACTION_TIME    | 118 ms                                                                 | 228.5 ms (sd 21.5) | 5.14 below | 25     |
| PERF_ACCURACY         | 79.5%                                                                  | 46.1% (sd 5.9)     | 5.67 above | 15     |
| PERF_HEADSHOT         | 67.1%                                                                  | 29.3% (sd 7.4)     | 5.08 above | 15     |
| ODDS_UNEXPLAINED_MOVE | 30.1% move, 8 seconds from this change, shortened for player_07's team |                    |            | 30     |
| CLUSTER_MULTI_SIGNAL  | 4 independent signals                                                  |                    |            | 10     |

Actions per minute stayed within range, so PERF_ACTIVITY earned nothing.

```
performance = 25 + 15 + 15 = 55   (cap 60)
odds        = 30                  (cap 30)
cluster     = 10                  (cap 10)
score       = 95, Critical
```

The case rises to Critical and the second Slack alert is sent. Later, once the odds move is more than 60 seconds old, player_07's latest score falls back to 65 (still High), but the case keeps its peak of 95 and the rules that explain it.

Every other player in the same match scores 0. Measured by the lead: normal play scored 0 for every player across 40 different normal matches, `performance_demo` peaks at 65 (High), `odds_demo` gives the market 30 (Monitor), and `final_demo` reaches 95 (Critical) with all five rules above.

## Why odds only count for a player who also changed

An odds move is a fact about the market, not about any one player. If every player inherited it, one market move would give all ten players 30 points, and a normal player would be one small wobble away from a case. So the odds points attach to a player only when that player also shows a performance change within 60 seconds of the move. On its own, the move is scored against the subject `market` (30, Monitor) and appears on the Risk tab as "Betting market".

## Alerts fire once per step

The engine decides whether a case needs a Slack alert:

- below High: never;
- first time High or above: alert, reason `new_case`;
- afterwards: alert again only if the severity is higher than the last alert (High to Critical), reason `severity_increase`;
- once a case is approved or dismissed: no more alerts.

The last alerted severity is saved on the case inside the same locked database update, so two events arriving together cannot both trigger it. That is why the final demo sends exactly two Slack messages ("New HIGH integrity case", then "rose to CRITICAL") instead of one per event.

## Missing baselines

If a player has no baseline (for example a `player_99` the monitor has never seen), the result is `insufficient_data` with score 0 and the note "No baseline exists for player_99, so no comparison was made." The engine never invents a baseline. The Risk tab shows "No baseline" for that player.

## Changing thresholds

All numbers above live in `DEFAULT_THRESHOLDS` in `thresholds.ts` and are copied into the `settings` table on first start. An administrator can change them with `PUT /api/v1/monitor/settings` (control key); the monitor picks up the change within 30 seconds. Do not change them before the demo: the expected scores in this guide depend on the defaults.

## What to say in the demo

"We compare each player with their own history, not with everyone else. We average the last 30 seconds so one lucky shot never triggers anything. Each rule adds points, and every point shows the measured value, the baseline and the distance in standard deviations. Here player_07's reaction time averaged 118 ms against a normal 228.5, which is 5.1 standard deviations. With the unexplained odds move 8 seconds away, the score is 95, Critical. That means a human should review it, not that anything has been proven."
