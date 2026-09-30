# 10. Demo runbook: Saturday 2026-10-03

## The plan in one paragraph

Seven to ten minutes, following the plan's final demo flow (section 12). We reset everything, show a normal match with no alert, then run the `final_demo` preset: player_07's performance changes at 1:00, a case opens at High around 1:08, the odds move 30.1% at 1:30, and the case rises to Critical 95 around 1:38. We show the evidence, the AI summary and the two Slack messages, a human makes the decision, and we close on reliability and limitations. Every number in this runbook is deterministic because the preset uses seed 13027.

## Roles

| Segment                       | Speaker               | Driver (clicks)                               |
| ----------------------------- | --------------------- | --------------------------------------------- |
| 1. Problem and guardrail      | Emmanuel              | Emmanuel                                      |
| 2. Architecture               | Team A                | Emmanuel                                      |
| 3. Normal scenario            | Team A                | Emmanuel                                      |
| 4. Performance anomaly        | Team B                | Emmanuel                                      |
| 5. Odds integrity             | Team B                | Emmanuel                                      |
| 6. Evidence and Slack         | Team C                | Emmanuel                                      |
| 7. Human review               | Team C                | Team C reviewer on the dashboard, or in Slack |
| 8. Reliability and conclusion | Team D, then Emmanuel | Emmanuel                                      |

One laptop drives, so nobody has to type a key on the projector. Speakers hand over with the cue in each segment.

## Pre-demo checklist

The day before:

- [ ] Two full timed rehearsals from a clean reset, both reaching Critical 95 and exactly two Slack messages.
- [ ] Every speaker has read chapters 00 and 01 and their own chapter, and knows their handoff cue.
- [ ] Backup screenshots of each step saved on the demo laptop (Risk tab at Critical 95, the case page, both Slack messages, the audit trail). Check them for keys before saving.

Thirty minutes before:

- [ ] Open the dashboard. The header pill says Online.
- [ ] Open `https://telemetry-simulator-production-bf55.up.railway.app/ready`. Expect `"status": "ready"`, `"monitor": "ready"`, `"ai_summaries": "configured"`.
- [ ] Open the n8n editor, logged in, showing the three workflows "G13 1 - Ingest telemetry", "G13 2 - Evidence, AI summary and Slack alert" and "G13 3 - Slack review buttons", all published.
- [ ] Open the Slack alert channel. Post a divider message such as "Final demo run, 3 October" so old alerts are clearly separate.
- [ ] Unlock the dashboard with the control key before the projector is on. The key field is hidden, but do it off screen anyway.
- [ ] Optional smoke test: press "Send test event" on the Overview tab and confirm the message says every webhook answered 2xx (for example "Test event: 1 of 1 webhooks answered 2xx"). Then reset (next step), because the test event is stored as its own match.
- [ ] Reset both halves: Overview tab, Reset (if a run exists), then Risk tab, "Clear monitor data". Check Events stored 0, Dead letters 0, Cases "No cases yet".
- [ ] Risk tab shows "AI summaries: AI connected".
- [ ] Cases tab: type the reviewer name into the review panel once in rehearsal so the browser remembers it.
- [ ] Close any tab showing Railway variables, `.env` files or keys.
- [ ] Browser zoom about 125%, tabs in this order: dashboard, Slack, n8n editor.

## The script

Target: about 8 minutes 15 seconds. Clock times in brackets are from the start of the talk.

### 1. Problem and guardrail, 45 seconds [0:00]

Emmanuel says: "Esports administrators need fast, evidence-based signals when something in a match looks unusual. Our system watches live telemetry and betting odds, compares each player with their own history, and flags anomalies for human review. It never declares that anyone cheated or that a match was fixed. Every case is decided by a person."

Click: Overview tab, showing the idle state.

Cue: "Team A will show how the data flows."

### 2. Architecture, 45 seconds [0:45]

Team A says: "The simulator plays the role of a live match feed. Each event goes to our n8n webhook, which validates it and hands it to the monitor. The monitor stores it in Postgres, scores it against the player's baseline, and opens a case at High. A second n8n workflow writes an evidence summary with a free AI model and alerts Slack, and an administrator decides. This dashboard shows every step."

Click: switch to the n8n editor tab and show "G13 1 - Ingest telemetry" for five seconds, then back to the dashboard.

Cue: "Let's start with a normal match."

### 3. Normal scenario, 60 seconds [1:30]

Click: Overview, Controls, "Normal match" (the `demo_normal` preset).

Team A says: "This is a normal match: 2 events per second. Events generated and deliveries rise together, with zero failures." Point at the counters.

Click: Risk tab. "The monitor has stored every event once. Every player is Normal at 0, the market too. No dead letters." Click: Cases tab. "No cases, and nothing in Slack. Across 40 different normal matches, every player scored 0."

Click: Overview, Reset, confirm. (Leave the monitor data; the normal match stays as proof there was no case.)

Cue: "Now the final demo scenario. Team B."

### 4. Performance anomaly, 90 seconds [2:30]

Click: Overview, "Final demo" (the `final_demo` preset). The match clock starts at 0:00. Player charts are on player_07 by default.

Team B says, while the first minute plays: "Each player has a baseline learned from 20 historical matches. player_07's normal reaction time is 228.5 ms with a standard deviation of 21.5. We average the last 30 seconds of play, so a single great moment never triggers anything. A rule fires at 2.5 standard deviations and earns full points at 4."

At match clock 1:00: point at the reaction-time chart. "At one minute, player_07's reactions drop well below their baseline band."

At about 1:08: Click: Risk tab. "player_07 is now High, 62. A case opens and the first Slack alert goes out. Everyone else is still 0."

Cue: "Watch the odds at one minute thirty."

### 5. Odds integrity, 90 seconds [4:00]

Click: Overview, point at the odds chart. At 1:30 the "30.1% move" label appears.

Team B says: "The odds moved 30.1% with no round starting or ending within 5 seconds, so nothing in the match explains it. On its own, that scores the market 30, Monitor, not enough for a case. But it happened 8 seconds from player_07's performance change, so it counts toward player_07."

At about 1:38: Click: Risk tab. "player_07 is now Critical, 95: performance 55, odds 30, and 10 for four independent signals in the same window. The market row shows Monitor 30."

Cue: "Team C will open the evidence."

### 6. Evidence and Slack, 60 seconds [5:30]

Click: Cases tab, select the case (CASE-XXXXXX, Critical 95, "Blue Seven (player_07)").

Team C says: "Everything here comes from the evidence packet. 'Why this was flagged' lists each rule with the measured value: average reaction time 118 ms, 5.1 standard deviations below this player's baseline of 229 ms; accuracy 79.5% against 46.1%; the unexplained odds move. The summary was written by an AI model from this packet only, and checked for accusing language. It ends by recommending human review."

Click: Slack tab. "Two messages for the whole match: 'New HIGH integrity case', then 'rose to CRITICAL'. Not one per event. Each says: signals for human review only, no conclusion has been made."

Cue: "Now the decision."

### 7. Human review, 60 seconds [6:30]

Click: back to the dashboard case. Reviewer name is filled in. Type a note: "Reaction times far outside history; refer to officials."

Click: Escalate (or click Escalate in Slack if the Slack buttons are set up).

Team C says: "The decision is recorded with my name, the time and my note. The status is now Escalated, and the audit trail shows every step from Open to Pending review to Escalated." Click Escalate again: "Already escalated; nothing changed." "Repeating a decision is harmless, and an approved or dismissed case cannot be silently changed. The evidence is never deleted."

Cue: "Team D on reliability."

### 8. Reliability and conclusion, 45 seconds [7:30]

Team D says: "Event IDs are the database's primary key, so retries and duplicates are stored once. Invalid events go to a dead-letter store with their reason and the pipeline keeps going. Every case has an audit trail. The whole demo resets and replays to the same result because the simulator is seeded. We have 165 automated tests. Current limitations: one instance, simulated baselines, and case pages readable without a key because the data is simulated."

Emmanuel closes: "The simulator can be replaced by a real telemetry provider without changing the monitor. The system gives administrators fast, explainable signals; people make the decisions. Thank you."

After the demo: Overview, Reset; Risk tab, "Clear monitor data".

## If something goes wrong

| Problem                                    | What you see                                          | What to do                                                                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack is down or not delivering            | Case shows "Slack alert: Not delivered"               | Say: "Slack is unavailable, so delivery is recorded as failed and the case stays reviewable." Review in the dashboard. Show the backup Slack screenshot. This is test T13 working. |
| AI is down or slow                         | Summary labelled "Template"; Risk tab "Template only" | Say: "The AI is unavailable, so the deterministic template built from the same evidence is used." Carry on; nothing else changes. This is test T12.                                |
| No case appears by 1:20 match time         | Risk tab player_07 still Normal                       | Check the Overview counters. If Deliveries are not rising, open the n8n tab. If stuck, Reset both halves and start `final_demo` again; tell the audience the result is repeatable. |
| Dashboard shows "Simulator offline"        | Red banner                                            | Wait 10 seconds; it retries on its own. If it persists, switch to the backup screenshots and narrate.                                                                              |
| "The monitor database is still connecting" | Notice on Cases or Risk                               | Wait; it reconnects automatically.                                                                                                                                                 |
| Start is refused                           | "A match is in progress"                              | Press Reset first.                                                                                                                                                                 |
| Old cases on screen                        | Cases list not empty before step 4                    | Risk tab, "Clear monitor data".                                                                                                                                                    |

Never edit the database, n8n workflows or presets during the demo.

## Likely examiner questions

Does this prove player_07 cheated?
No. It shows statistical signals: reaction times 5.1 standard deviations faster than their own history and an unexplained odds move nearby. The system flags the case for a human to review; the reviewer decides.

How do you avoid false alarms?
Each player is compared with their own baseline, we average 30 seconds of play, we need at least 4 actions, and a rule only fires at 2.5 standard deviations. Normal play scored 0 for every player across 40 normal matches.

Why 2.5 standard deviations?
Normal play in the simulator stays within 2.5, so anything beyond it is outside the normal range. All thresholds are in one settings record and can be tuned without code changes.

Why does the odds move only count for player_07?
An odds move is about the market, not a person. It only counts toward a player who also changed within 60 seconds; otherwise every player would inherit the points.

What if the AI makes something up?
It only receives the evidence packet, its prompt forbids new facts and verdicts, and its output is scanned for accusing language. Any failure falls back to a template built from the same packet. The rules and numbers are shown separately from the summary.

What stops Slack spam?
One case per player per match, and an alert only when the case first reaches High and again if it rises in severity. The final demo sends exactly two.

What happens if the same event arrives twice?
The event ID is the primary key, so it is stored once and scored once.

What happens to bad data?
It is stored as a dead letter with the reason, and the next event is processed normally.

Can a reviewer change their mind?
Escalated can move to approved or dismissed. Approved and dismissed are final; repeating the same decision changes nothing, and a different one is refused. Every change is in the audit trail.

Where do the baselines come from?
From 20 simulated historical matches with fixed seeds, so they are the same on every run. With a real provider they would come from real past matches.

How would this work with real data?
The simulator knows nothing about the monitor. A real feed that sends the same event contract to the n8n webhook would work without changing the monitor.

Where are the keys?
Only in Railway variables. Nothing secret is in the repository, the workflows, the screenshots or this guide.

Why n8n?
The plan asks for an n8n pipeline, and it makes routing, retries and the AI and Slack steps visible to the whole team. The scoring is in tested code so it is exact and reproducible.
