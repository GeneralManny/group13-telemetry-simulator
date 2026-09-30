# 00. Start here

## What the system does

The Group 13 Esports Integrity Monitor watches a live esports match and its betting odds, and compares every player with their own history. When a player's numbers move far away from their normal range, or the odds move sharply with nothing in the match to explain it, the system gives that player a risk score from 0 to 100 and, at High or Critical, opens a case with the evidence attached. An administrator is alerted in Slack and makes the decision on every case: approve for investigation, dismiss, or escalate.

## The guardrail

This is the one rule every teammate must follow when speaking, writing, or answering questions.

The system flags statistical signals for human review. It never says that a player cheated or that a match was fixed, and neither do we. Use words like "flagged", "risk score", "unusual compared with the player's own baseline", and "needs review". A case is a question for a human, not an answer.

If an examiner asks "so player_07 was cheating?", the correct answer is: "The system cannot and does not decide that. It measured reaction times 5.1 standard deviations faster than player_07's own history and flagged it for a human to review. The reviewer decides what happens next."

The same rule is enforced in the code: the AI summary is checked for accusing words, the Slack message says "Signals for human review only", and the dashboard shows "No conclusion has been made about anyone" on every case.

## How to use this guide

Each chapter covers one part of the system. Read them in order if you can, but you only need your own chapters plus the shared ones to present on Saturday.

1. Read this chapter and the glossary below.
2. Read chapter 01 (architecture). Everyone needs to be able to follow one event from start to finish.
3. Read the chapters for your team (table below).
4. Read chapter 10 (demo runbook). It tells you what you say, what you click, and what to do when something breaks.
5. Open the live dashboard while you read and look at the thing being described. Seeing it is faster than reading about it.

Live addresses:

```
Dashboard and monitor API: https://telemetry-simulator-production-bf55.up.railway.app
n8n editor:                https://n8n-production-d5d3.up.railway.app
```

Keys (the control key, team key and others) are never written in this guide or the repository. Emmanuel shares them privately.

## Which chapters each team reads first

The team split comes from the build plan (docs/plans/group-13-esports-integrity-monitor-build-plan.md, section 4).

| Team            | Plan responsibility                                     | Read first | Then   |
| --------------- | ------------------------------------------------------- | ---------- | ------ |
| Emmanuel (lead) | Simulator, contract, integration, demo control          | 02, 10     | All    |
| Team A          | n8n webhook, validation, routing, retries, logging      | 03         | 04, 09 |
| Team B          | Database, baselines, anomaly rules, risk scoring, cases | 05         | 04, 02 |
| Team C          | Evidence packet, AI summary, Slack alert, human review  | 06         | 07     |
| Team D          | Dashboard, documentation, testing, demo support         | 08         | 09, 11 |

Everyone reads 00, 01 and 10.

## Glossary

Each term is explained with an example from this system.

Event: one message from the simulator describing one thing that happened in the match, sent as JSON. Example: a `player_action` for player_07 at 97.5 seconds with `reaction_time_ms: 129`. Every event has a unique `event_id` such as `evt_20260930_130000_a1b2_000196`.

Webhook: a web address that accepts incoming messages. The simulator pushes each event to n8n's webhook at `/webhook/telemetry`, one event per request.

n8n workflow: n8n is a visual automation tool. A workflow is a chain of steps drawn as boxes and arrows. We have three: "G13 1 - Ingest telemetry", "G13 2 - Evidence, AI summary and Slack alert", and "G13 3 - Slack review buttons".

Node: one box in an n8n workflow that does one job. Example: the node "Validate and normalise" checks each event before it is stored.

Baseline: a player's normal range for one measurement, learned from past matches. Example: player_07's baseline reaction time is 228.5 ms on average, learned from 572 actions across 20 simulated historical matches.

Standard deviation: a measure of how much a player's numbers usually vary around their average. player_07's reaction time has a standard deviation of 21.5 ms, so most of their reactions fall between roughly 185 ms and 270 ms. We describe how unusual a value is by counting standard deviations: 118 ms is 5.1 standard deviations below 228.5 ms.

Risk score: a number from 0 to 100 that adds up the points from every rule that fired, so it can always be explained line by line. Example: player_07 in the final demo reaches 95.

Severity: the band a score falls into. 0 to 29 Normal, 30 to 59 Monitor, 60 to 79 High, 80 to 100 Critical. A case opens at High.

Case: a record that groups the evidence about one subject (a player, or the betting market) in one match, with an ID such as `CASE-7KQ2XM`. It has a status that moves from open to pending_review to a human decision.

Evidence packet: the bundle of facts behind a case (rules, measured values, baselines, odds moves, sample events). The AI summary, the Slack alert and the case page are all built only from this packet.

Dead letter: an event that could not be processed, stored with the reason instead of being thrown away. Example: an event missing its `timestamp` is stored in `monitor.dead_letters` with reason `validation_failed` and the error "timestamp is required".

Idempotent: doing the same thing twice has the same effect as doing it once. Sending the same `event_id` twice stores one row. Clicking "Escalate" twice records one decision.

Trace ID: a label that follows one event through every step so it can be found in logs. n8n creates it as `n8n-` plus its execution number, for example `n8n-4812`, and it is saved on the stored event, the risk result and the case.

Seed: a starting number for the simulator's random generator. The same seed and settings always produce the same match. Every demo preset uses seed 13027, which is why the final demo gives the same scores every time.
