# Group 13 — Esports Tournament Live Anti-Cheat & Match Integrity Monitor

## One-Week MVP Build Plan

**Sprint:** Sunday, September 27, 2026 → Saturday, October 3, 2026  
**Team lead:** Emmanuel  
**Day 1 dependency:** Emmanuel publishes the Live Telemetry + Odds Simulator on Sunday so every team builds against the live simulator from the first day.  
**Target:** A complete, tested, demo-ready MVP by Saturday.

---

## 1. Product Goal

Build a live tournament integrity system that:

1. Receives simulated match telemetry and betting-odds events through an API.
2. Normalizes and stores incoming events.
3. Compares player behaviour with historical baselines.
4. Detects anomalies and calculates an explainable risk score.
5. Produces an AI-assisted evidence summary.
6. Alerts tournament administrators in Slack.
7. Requires a human decision before a case is marked resolved.
8. Displays live match health, alerts, evidence, and review status on a dashboard.

> The system flags suspicious activity for human investigation. It does not declare that a player cheated or that a match was fixed.

---

## 2. MVP Scope and Guardrails

### In scope

- Live simulator with normal and suspicious scenarios.
- Telemetry and odds ingestion through an n8n webhook.
- Validation, normalization, event IDs, timestamps, and duplicate handling.
- Persistent storage for matches, players, events, baselines, alerts, evidence, and reviews.
- Simple explainable anomaly rules and weighted risk scoring.
- AI-generated evidence summaries based only on stored facts.
- Slack alerting with a link or case ID for review.
- Human approve/dismiss/escalate decision path.
- Dashboard for live activity, risk, alerts, evidence, and review status.
- End-to-end testing, documentation, and a repeatable final demo.

### Out of scope for this sprint

- Direct integration with a commercial game publisher.
- Production-grade machine learning or automatic bans.
- Real-money betting actions.
- Large-scale infrastructure, advanced identity verification, or mobile apps.
- Claims that an anomaly proves cheating or match-fixing.

---

## 3. Project Architecture

```text
┌──────────────────────────────────────────────┐
│ Live Telemetry + Odds Simulator — Emmanuel   │
│ Normal / suspicious / match-fixing scenarios │
└──────────────────────┬───────────────────────┘
                       │ JSON over HTTP
                       ▼
┌──────────────────────────────────────────────┐
│ n8n Ingestion & Workflow — Team A            │
│ Webhook → validate → normalize → deduplicate  │
└───────────────┬───────────────────┬──────────┘
                │                   │
                ▼                   ▼
┌──────────────────────────┐  ┌────────────────────────────┐
│ Database — Team B        │  │ Error/dead-letter handling │
│ Events, baselines, cases │  │ Logging and replay         │
└─────────────┬────────────┘  └────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────┐
│ Detection & Risk Engine — Team B             │
│ Baseline comparison → anomaly flags → score  │
└──────────────────────┬───────────────────────┘
                       │ suspicious case
                       ▼
┌──────────────────────────────────────────────┐
│ Evidence & Review Workflow — Team C          │
│ Evidence packet → AI summary → Slack alert   │
│ → human approve / dismiss / escalate         │
└──────────────────────┬───────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────┐
│ Admin Dashboard — Team D                     │
│ Live match → risk → evidence → review status │
└──────────────────────────────────────────────┘
```

### Recommended shared event contract

All teams should freeze this contract on Sunday. Fields may be added later, but existing field names should not change after the freeze.

```json
{
  "event_id": "evt_000123",
  "event_type": "player_action",
  "schema_version": "1.0",
  "timestamp": "2026-09-27T12:00:00Z",
  "match_id": "match_001",
  "tournament_id": "tournament_001",
  "round_id": "round_04",
  "player_id": "player_07",
  "team_id": "team_blue",
  "metrics": {
    "reaction_time_ms": 168,
    "accuracy_pct": 82.5,
    "headshot_pct": 61.0,
    "actions_per_minute": 215,
    "kills": 1,
    "deaths": 0
  },
  "odds": {
    "provider": "simulator",
    "team_blue": 1.85,
    "team_red": 2.10,
    "movement_pct": 18.0
  },
  "scenario": "normal",
  "simulator_run_id": "run_20260927_001"
}
```

### Shared interface rules

- Use ISO 8601 UTC timestamps.
- Every event must have a unique `event_id` and a `schema_version`.
- Re-sending an `event_id` must not create a second database record.
- Unknown optional fields may be ignored; missing required fields must be rejected and logged.
- Internal services should return a traceable `case_id` for suspicious activity.
- Risk outputs must contain the score, severity, triggered rules, and source event IDs.
- AI output may summarize evidence but may not invent facts or make a guilty verdict.

---

## 4. Team Ownership

| Owner | Primary responsibility | Required handoff |
|---|---|---|
| **Emmanuel — Team Lead** | Simulator, interface contract, coordination, integration decisions, final demo control | Live endpoint, sample payloads, scenario controls, shared credentials/config guidance |
| **Team A** | n8n webhook, validation, normalization, routing, retries, logging, replay | Clean normalized events and workflow status to Team B; trigger suspicious-case flow for Team C |
| **Team B** | Database, historical baselines, anomaly rules, risk scoring, case persistence | Queryable risk result and evidence data to Teams C and D |
| **Team C** | Evidence packet, AI summary, Slack alert, human approval workflow | Review status and reviewer notes to database/dashboard |
| **Team D** | Dashboard, documentation, test coordination, demo support | Visible end-to-end state, test report, setup guide, demo script |

### Decision ownership

- Emmanuel resolves interface and scope disagreements.
- Each team appoints one person as its integration contact.
- Any blocker lasting more than two hours is raised in the group channel with: owner, impact, attempted fix, and needed decision.
- No team changes a shared field, endpoint, or status value without notifying every dependent team.

---

## 5. MVP Acceptance Criteria

The MVP is accepted only when all of the following pass:

- [ ] The simulator sends live events continuously to the published n8n webhook.
- [ ] At least one normal, one performance-anomaly, and one odds-integrity scenario can be selected or replayed.
- [ ] Valid events are acknowledged, normalized, deduplicated, and stored.
- [ ] Invalid events are rejected safely, logged, and do not stop later valid events.
- [ ] Player baselines exist and are used in anomaly calculations.
- [ ] Every suspicious case has an explainable score, severity, triggered rules, and linked evidence.
- [ ] Normal play remains below the alert threshold in the agreed test run.
- [ ] High-risk activity creates one Slack alert per case, not one alert per raw event.
- [ ] The AI evidence summary uses supplied evidence and includes cautious, non-accusatory language.
- [ ] An administrator can approve, dismiss, or escalate a case, with reviewer and timestamp recorded.
- [ ] The dashboard displays live match state, player risk, open cases, evidence, and review status.
- [ ] The complete demo can be reset and repeated without manual database editing.
- [ ] Setup, configuration, architecture, test evidence, and known limitations are documented.
- [ ] No secrets are stored in the repository, screenshots, exported workflow, or demo data.

---

## 6. Severity and Risk-Scoring Contract

Team B owns the final implementation, but all teams will use these common outputs:

| Score | Severity | Expected action |
|---:|---|---|
| 0–29 | Normal | Store only; no alert |
| 30–59 | Monitor | Show on dashboard; collect more evidence |
| 60–79 | High | Create/update a case and notify admins |
| 80–100 | Critical | Immediate alert and priority human review |

### Suggested MVP signals

- Reaction time is unusually low compared with the player's baseline.
- Accuracy or headshot percentage is unusually high compared with baseline.
- Actions per minute changes sharply or exceeds an agreed threshold.
- Multiple performance anomalies occur within a rolling time window.
- Betting odds move sharply without a corresponding match event.
- Odds movement and unusual player underperformance occur close together.

### Suggested explainable calculation

```text
performance anomaly component: 0–60
odds integrity component:       0–30
repeat/cluster component:       0–10
final score: min(100, sum of components)
```

Each component must list the rule and measured values that contributed to it. Thresholds should be configurable rather than buried in multiple workflows.

---

## 7. Daily Working Rhythm

- **09:00:** 15-minute stand-up: yesterday, today, blocker, required handoff.
- **13:00:** integration check: endpoints, sample data, schema, and blocking defects.
- **17:00:** daily checkpoint using the live simulator; record pass/fail and owners.
- **End of day:** every team posts its deliverable link, known issues, and first task for tomorrow.
- Merge or export working changes daily. Keep a known-good demo configuration.

---

# 8. Day-by-Day Sprint Plan

## Sunday, September 27 — Foundation and Live Simulator

**Daily objective:** Publish the live simulator, freeze the v1 event contract, and prove that one event travels from the simulator to n8n and into storage.

### Emmanuel — Team Lead and Simulator

- [ ] Confirm active team members and one integration contact per team.
- [ ] Create the shared project channel, repository/workspace, task board, and decision log.
- [ ] Publish the Live Telemetry + Odds Simulator today.
- [ ] Provide the simulator base URL, health endpoint, start/stop/reset controls, and event endpoint behaviour.
- [ ] Implement at least three selectable modes: `normal`, `performance_anomaly`, and `odds_integrity`.
- [ ] Provide sample JSON, required fields, enums, event frequency, and error behaviour.
- [ ] Ensure unique event IDs, UTC timestamps, stable player IDs, and a simulator run ID.
- [ ] Add a replay/reset method so the same demo can be repeated.
- [ ] Run a 15-minute onboarding showing every team how to connect to the live simulator.
- [ ] Freeze event contract v1 by the afternoon integration checkpoint.

### Team A — n8n Ingestion and Workflow

- [ ] Create the n8n webhook endpoint and share its URL/configuration with Emmanuel.
- [ ] Accept and acknowledge live simulator POST requests.
- [ ] Add required-field validation for event ID, type, timestamp, match, and player identifiers.
- [ ] Create a first-pass normalization node that outputs the agreed v1 contract.
- [ ] Add execution logging with event ID and simulator run ID.
- [ ] Route malformed events to an error path without breaking the workflow.
- [ ] Send one normalized test event to Team B's temporary or final storage interface.

### Team B — Database, Baselines, Anomaly and Risk

- [ ] Select and initialize the sprint database.
- [ ] Create minimum tables/collections: `players`, `matches`, `events`, `baselines`, `risk_results`, `cases`, `evidence`, and `reviews`.
- [ ] Add unique protection for `event_id`.
- [ ] Define case and review status enums with Teams C and D.
- [ ] Provide Team A with a storage endpoint, database node configuration, or agreed handoff payload.
- [ ] Seed a small player roster and placeholder baseline records.
- [ ] Prove one normalized live event can be stored and retrieved.

### Team C — AI Evidence, Slack and Human Approval

- [ ] Define the evidence packet contract with Team B.
- [ ] Define Slack alert fields: severity, score, match, player, reasons, time, case ID, and review link/instructions.
- [ ] Create the Slack test channel and confirm the bot/webhook can post.
- [ ] Draft the AI prompt with a strict instruction to use evidence only and avoid a guilt conclusion.
- [ ] Define review actions: `approve_for_investigation`, `dismiss`, and `escalate`.
- [ ] Agree with Team B on how review decisions will be written back.

### Team D — Dashboard, Documentation and Testing

- [ ] Create the dashboard shell and navigation.
- [ ] Agree on views: Live Match, Players/Risk, Cases, Case Detail, and Review Status.
- [ ] Start the README with product goal, scope, owners, architecture, and setup placeholders.
- [ ] Create the test-case tracker with IDs, steps, expected result, actual result, owner, and status.
- [ ] Record the v1 architecture and event contract.
- [ ] Prepare mock dashboard data matching the shared contract while live queries are being connected.

### Sunday dependencies

- Team A cannot complete live ingestion until Emmanuel publishes the simulator.
- Team B needs Team A's normalized payload before finalizing event storage.
- Teams C and D need Team B's case, evidence, and review contracts.

### Sunday integration checkpoint

- [ ] Simulator health check passes.
- [ ] One live event reaches n8n.
- [ ] The event is normalized and stored once.
- [ ] Every team can access the sample payload and contract.

### Sunday deliverable

**Live simulator + frozen v1 contract + first simulator → n8n → database event.**

---

## Monday, September 28 — Reliable Ingestion and Data Model

**Daily objective:** Build a stable data pipeline and create usable historical baselines.

### Emmanuel

- [ ] Keep the simulator available during agreed development hours.
- [ ] Fix contract-breaking simulator defects immediately.
- [ ] Add adjustable event rate and scenario duration if not completed Sunday.
- [ ] Publish a short simulator runbook and known limitations.
- [ ] Confirm each team has successfully consumed live or stored simulator data.

### Team A

- [ ] Complete normalization for telemetry and odds event types.
- [ ] Add idempotency/deduplication using `event_id`.
- [ ] Add retry handling for temporary database/network failures.
- [ ] Add a dead-letter/error store containing payload, error, timestamp, and retry status.
- [ ] Add environment/config variables for endpoints and credentials.
- [ ] Demonstrate continuous ingestion for at least 15 minutes without manual intervention.

### Team B

- [ ] Finalize database relationships, indexes, and required fields.
- [ ] Create baseline values for the demo players from seeded or generated history.
- [ ] Store baseline sample size, mean, standard deviation or acceptable range, and last-updated time.
- [ ] Implement baseline lookup by player and metric.
- [ ] Define configurable thresholds for the first performance anomaly rules.
- [ ] Return a structured preliminary risk result for a stored event.

### Team C

- [ ] Build the evidence packet template from a mock Team B risk result.
- [ ] Create a first AI summary and verify every claim maps to an evidence field.
- [ ] Build the Slack message layout using mock case data.
- [ ] Add a correlation/case ID across AI, Slack, and review records.
- [ ] Document fallback behaviour if the AI or Slack service is unavailable.

### Team D

- [ ] Connect the Live Match view to stored data or the agreed API.
- [ ] Display match, teams, round/time, event count, and pipeline health.
- [ ] Connect the Players/Risk view to baseline and risk placeholders.
- [ ] Add loading, empty, and error states.
- [ ] Write test cases for validation, duplicates, invalid JSON, missing fields, and temporary failures.

### Monday integration checkpoint

- [ ] A duplicate event is stored only once.
- [ ] An invalid event is logged and the next valid event is processed.
- [ ] A live player's baseline can be retrieved during processing.
- [ ] Dashboard shows recent stored events.

### Monday deliverable

**Reliable normalized ingestion, persistent schema, seeded baselines, and a live-data dashboard view.**

---

## Tuesday, September 29 — Anomaly Detection and Risk Scoring

**Daily objective:** Turn live events into explainable risk results and cases.

### Emmanuel

- [ ] Validate that simulator scenarios produce clearly different but believable data.
- [ ] Add deterministic scenario seeds or replay fixtures for repeatable tests.
- [ ] Coordinate agreement on risk thresholds and case creation rules.
- [ ] Keep a stable simulator version while Teams A and B integrate.

### Team A

- [ ] Call or trigger Team B's anomaly/risk logic after successful storage.
- [ ] Route normal results to storage/dashboard only.
- [ ] Route high and critical results to Team C's case workflow.
- [ ] Add a trace/correlation ID through all workflow stages.
- [ ] Prevent workflow failure when baseline data is unavailable; mark result as `insufficient_data`.
- [ ] Export or back up the known-good n8n workflow.

### Team B

- [ ] Implement reaction-time, accuracy/headshot, and activity-rate anomaly rules.
- [ ] Implement odds-movement anomaly detection.
- [ ] Implement the weighted 0–100 risk score.
- [ ] Return severity, rule IDs, observed values, baseline values, deviation, and source event IDs.
- [ ] Add rolling-window or repeated-anomaly logic to reduce one-event false alarms.
- [ ] Create or update one case per player/match/window instead of producing duplicate cases.
- [ ] Store the complete risk result and its calculation time.

### Team C

- [ ] Consume a real high-risk result from Team B.
- [ ] Convert it into a structured evidence packet.
- [ ] Generate an AI evidence summary from the structured packet.
- [ ] Verify that the summary states uncertainty and recommends human review.
- [ ] Reject or safely handle missing evidence fields.

### Team D

- [ ] Replace mock risk values with real Team B results.
- [ ] Add severity colours/labels that remain understandable without colour alone.
- [ ] Add risk-score explanation and triggered-rule display.
- [ ] Add filters for match, player, severity, status, and time.
- [ ] Test that the dashboard does not label a player as a confirmed cheater.

### Tuesday integration checkpoint

- [ ] Normal scenario produces normal/monitor outcomes.
- [ ] Performance-anomaly scenario produces an explainable high or critical result.
- [ ] Odds-integrity scenario produces an odds-related result.
- [ ] A high-risk result creates one persisted case and evidence packet.

### Tuesday deliverable

**Live explainable anomaly detection, risk scoring, and case creation.**

---

## Wednesday, September 30 — Evidence, Slack and Human Review

**Daily objective:** Complete the alert-to-human-decision loop.

### Emmanuel

- [ ] Run a midday end-to-end scenario and list integration failures by owner.
- [ ] Freeze shared status values and the case lifecycle.
- [ ] Confirm who acts as tournament administrator during the demo.
- [ ] Decide the demo fallback if Slack or the AI service is unavailable.

### Team A

- [ ] Trigger Team C only when a case first crosses the alert threshold or materially increases in severity.
- [ ] Add Slack/AI failure branches with retry and visible status.
- [ ] Ensure repeated events update an existing case rather than spamming alerts.
- [ ] Persist workflow timestamps for ingestion, scoring, alerting, and review.

### Team B

- [ ] Provide a complete evidence query by `case_id`.
- [ ] Store AI summary, Slack message status, review action, reviewer, notes, and timestamps.
- [ ] Implement case lifecycle: `open` → `pending_review` → `approved`, `dismissed`, or `escalated`.
- [ ] Ensure the original evidence remains available after review.
- [ ] Add an audit record for each status change.

### Team C

- [ ] Generate the production-shaped AI evidence summary.
- [ ] Send a real Slack alert to the test channel.
- [ ] Implement approve, dismiss, and escalate actions through the chosen form/webhook/interface.
- [ ] Write the human decision back to the case record.
- [ ] Require reviewer identity and optional/required notes as agreed.
- [ ] Make repeated approval submissions idempotent.
- [ ] Demonstrate AI-service fallback using a deterministic evidence template.

### Team D

- [ ] Build the Cases list and Case Detail view.
- [ ] Display source metrics, baselines, deviations, triggered rules, and the AI summary separately.
- [ ] Display Slack delivery and human review state.
- [ ] Add approve/dismiss/escalate controls if the dashboard owns them; otherwise link to the review interface.
- [ ] Document the complete case lifecycle and admin instructions.

### Wednesday integration checkpoint

- [ ] Suspicious live data creates one case.
- [ ] Evidence summary is generated and Slack alert arrives.
- [ ] A human decision is submitted and stored.
- [ ] Dashboard updates to the final review status.

### Wednesday deliverable

**Complete live event → risk → evidence → Slack → human decision → dashboard loop.**

---

## Thursday, October 1 — Dashboard Completion and Full Integration

**Daily objective:** Make the entire system coherent, observable, and ready for structured testing.

### Emmanuel

- [ ] Freeze MVP features at midday; move nonessential ideas to a post-sprint list.
- [ ] Lead a full integration walkthrough and assign every defect.
- [ ] Confirm the final demo scenario order and expected outcomes.
- [ ] Verify the system can be reset to a clean demo state.

### Team A

- [ ] Add workflow health/error status consumed by the dashboard.
- [ ] Confirm timestamps and trace IDs are visible across the full pipeline.
- [ ] Verify restart/recovery does not duplicate processed events.
- [ ] Clean node names and add notes so another team member can understand the workflow.
- [ ] Export the current workflow into the project deliverables.

### Team B

- [ ] Tune thresholds using normal and suspicious simulator runs.
- [ ] Add database queries/views needed by all dashboard panels.
- [ ] Confirm case grouping, ordering, and filtering work.
- [ ] Verify risk calculations are reproducible from stored evidence.
- [ ] Add database seed/reset instructions.

### Team C

- [ ] Improve Slack clarity and include the shortest useful evidence summary.
- [ ] Verify alert links or instructions open the correct case.
- [ ] Test AI timeout, Slack failure, repeated alerts, and repeated reviews.
- [ ] Confirm every message uses neutral language and calls for human review.

### Team D

- [ ] Complete Live Match, Players/Risk, Cases, Case Detail, and Review Status views.
- [ ] Add last-updated time and stale-data indicator.
- [ ] Add responsive and projector-friendly layout checks.
- [ ] Add clear empty, loading, disconnected, and failed-service states.
- [ ] Finish architecture, setup, configuration, and user-flow documentation drafts.
- [ ] Create the first complete demo script.

### Thursday integration checkpoint

- [ ] Run all three simulator scenarios from a clean reset.
- [ ] Confirm displayed values match database values.
- [ ] Confirm one case can move through every review outcome.
- [ ] Record all defects with severity, owner, and target fix time.

### Thursday deliverable

**Feature-complete integrated MVP and complete first-pass documentation.**

---

## Friday, October 2 — Testing, Hardening and Rehearsal

**Daily objective:** Fix defects, prove reliability, and rehearse the final presentation.

### Emmanuel

- [ ] Run the test session and control scope.
- [ ] Prioritize defects: demo blocker, major, minor, post-sprint.
- [ ] Confirm backup demo data, screenshots, workflow export, and fallback recording if allowed.
- [ ] Lead at least two timed demo rehearsals.
- [ ] Assign speaking roles and handoff cues.

### Team A

- [ ] Test sustained event ingestion at the agreed peak rate.
- [ ] Test invalid payload, duplicate event, out-of-order event, database outage, and workflow restart.
- [ ] Fix every ingestion defect that blocks acceptance criteria.
- [ ] Capture workflow run evidence for the report.

### Team B

- [ ] Test missing baseline, zero variance, sparse history, repeated anomalies, and odds-only anomaly.
- [ ] Check for false alerts during a full normal run.
- [ ] Verify boundary scores at 29/30, 59/60, and 79/80.
- [ ] Validate case deduplication and audit history.
- [ ] Capture example risk calculations for documentation.

### Team C

- [ ] Test factual grounding of AI summaries against at least five evidence packets.
- [ ] Test AI unavailable and Slack unavailable fallbacks.
- [ ] Test all human review actions and duplicate submissions.
- [ ] Confirm no raw secret or unnecessary sensitive data appears in Slack.
- [ ] Capture alert and approval evidence for documentation.

### Team D

- [ ] Execute and record the full test suite.
- [ ] Test dashboard on the final demo laptop/browser and projector resolution.
- [ ] Verify accessible labels, readable contrast, clear timestamps, and usable filters.
- [ ] Finish README, architecture diagram, test report, user guide, and known limitations.
- [ ] Time the demo and remove unnecessary navigation.

### Friday integration checkpoint

- [ ] All MVP acceptance tests have recorded evidence.
- [ ] No open demo-blocking defects remain.
- [ ] Two consecutive end-to-end rehearsals pass from a clean reset.
- [ ] Backup/fallback material is ready but does not replace the live demo.

### Friday deliverable

**Tested release candidate, completed documentation, and rehearsed demo.**

---

## Saturday, October 3 — Release, Final Demo and Handover

**Daily objective:** Lock the build, verify the environment, deliver a confident live demo, and archive the project.

### Emmanuel

- [ ] Declare the release-candidate cutoff and stop noncritical changes.
- [ ] Confirm team attendance, speaking order, credentials, internet, and backup plan.
- [ ] Run the pre-demo checklist and clean reset.
- [ ] Lead the final demo and keep it within the assigned time.
- [ ] Collect final links/files and confirm the submission is complete.

### Team A

- [ ] Import/activate the final workflow and verify its production webhook.
- [ ] Send a smoke-test event and confirm successful processing.
- [ ] Monitor executions during the demo and handle workflow recovery if needed.
- [ ] Submit the final workflow export and configuration notes.

### Team B

- [ ] Apply seed data and verify database connectivity.
- [ ] Confirm baselines, thresholds, queries, and case reset work.
- [ ] Validate the demo cases and risk results immediately before the demo.
- [ ] Submit schema, seed/reset instructions, and scoring explanation.

### Team C

- [ ] Confirm the Slack channel, AI service, review action, and fallback template work.
- [ ] Clear old test alerts or clearly label the final demo run.
- [ ] Act as or support the tournament administrator during the review step.
- [ ] Submit prompt, evidence template, alert format, and review-flow notes.

### Team D

- [ ] Open the dashboard on the final device and verify every view.
- [ ] Confirm the demo run is visually distinguishable from older data.
- [ ] Record final test status and known limitations.
- [ ] Package the README, architecture, screenshots, test report, and demo script.
- [ ] Archive the final version and label it clearly.

### Saturday release checkpoint

- [ ] Health checks are green.
- [ ] One normal smoke test is stored without an alert.
- [ ] The suspicious scenario produces the expected case and Slack alert.
- [ ] A human decision is recorded and visible.
- [ ] Final deliverables open correctly and contain no secrets.

### Saturday deliverable

**Submitted MVP, live demonstration, complete handover package, and archived release.**

---

# 9. Integration Dependency Map

| Producer | Output | Consumer | Due |
|---|---|---|---|
| Emmanuel | Live simulator URL, controls, payloads, scenarios | All teams | Sunday morning |
| Emmanuel + all teams | Frozen event contract v1 | Teams A–D | Sunday afternoon |
| Team A | Normalized event and error contract | Team B, Team D | Sunday evening |
| Team B | Database access/interface and baseline lookup | Team A, Team D | Monday |
| Team B | Risk result and evidence contract | Team C, Team D | Tuesday |
| Team C | Alert and review result contract | Team B, Team D | Wednesday |
| Team D | Dashboard queries/field requirements | Teams A–C | Monday, then frozen Thursday |
| All teams | Stable integrated release candidate | Emmanuel | Friday |

### Dependency rule

If a final interface is not ready by its deadline, the producing team must provide a contract-correct mock immediately so dependent work continues. The real interface must later pass the same contract tests.

---

# 10. Required Testing Scenarios

| ID | Scenario | Expected result |
|---|---|---|
| T01 | Normal full match | Events stored; risk remains normal/monitor; no high-risk Slack alert |
| T02 | Unrealistically fast reactions | Performance rule triggers; score and baseline deviation are visible |
| T03 | Accuracy/headshot spike | Risk increases with exact observed and baseline values recorded |
| T04 | Multiple anomalies in a rolling window | One case is created/updated; no alert flood |
| T05 | Sharp odds movement without match event | Odds-integrity rule triggers and evidence shows the time relationship |
| T06 | Odds movement plus unusual underperformance | Combined score is higher and both signal groups are explained |
| T07 | Duplicate `event_id` | Event is stored/processed once |
| T08 | Missing required field or invalid JSON | Payload enters error path; workflow continues |
| T09 | Out-of-order timestamp | Event is handled by the agreed rule and does not corrupt the case timeline |
| T10 | Unknown player/no baseline | Result is `insufficient_data`; system does not invent a baseline |
| T11 | Database temporarily unavailable | Retry/failure is logged; recovery does not duplicate data |
| T12 | AI service unavailable | Deterministic evidence summary is used or case remains reviewable |
| T13 | Slack unavailable | Case persists and alert delivery shows failed/retry status |
| T14 | Human approves investigation | Reviewer, timestamp, notes, and final status are stored and displayed |
| T15 | Human dismisses alert | Case is dismissed without deleting evidence |
| T16 | Human escalates case | Status updates to escalated and is visible on the dashboard |
| T17 | Duplicate review submission | Only one final action/auditable update is applied |
| T18 | System reset and scenario replay | Demo returns to a known state and produces repeatable results |

### Minimum performance target for the MVP

- Sustain the chosen demo event rate for 15 minutes.
- No unhandled workflow crash.
- No duplicate stored events.
- High-risk case and Slack notification appear within the team's agreed demo target, recommended under 10 seconds on the local/test setup.
- Dashboard reflects new case/review status within the team's agreed refresh target, recommended under 5 seconds.

---

# 11. Definition of Done

A task is done when:

- [ ] The implementation works against the live simulator, not only hard-coded samples.
- [ ] The owner has tested its normal path and at least one failure path.
- [ ] Shared contracts and status values are followed.
- [ ] Secrets and environment-specific values are outside exported code/workflows.
- [ ] Another team member can run or verify it using written instructions.
- [ ] Evidence of the result is recorded in the test tracker or documentation.
- [ ] Known limitations are documented.
- [ ] Dependent teams have confirmed the handoff works.

The project is done when:

- [ ] Every MVP acceptance criterion passes.
- [ ] Required testing scenarios pass or have an explicitly accepted limitation.
- [ ] The final demo succeeds twice from a clean reset.
- [ ] All workflow, schema, configuration, setup, test, and demo materials are included.
- [ ] Human review remains the final authority for every suspicious case.

---

# 12. Final Demo Flow

Target length: **7–10 minutes**.

1. **Problem and guardrail — 45 seconds**  
   Explain that esports administrators need fast, evidence-based signals, and that the system flags anomalies for human review rather than declaring guilt.

2. **Architecture — 45 seconds**  
   Show the simulator → n8n → database/risk → AI/Slack → human review → dashboard flow.

3. **Normal scenario — 60 seconds**  
   Reset the system, start a normal match, show live ingestion and storage, and confirm there is no high-risk alert.

4. **Performance-anomaly scenario — 90 seconds**  
   Trigger unusually fast reactions and/or an accuracy spike. Show the baseline comparison, triggered rules, explainable score, and created case.

5. **Odds-integrity scenario — 90 seconds**  
   Trigger an odds movement with correlated unusual play. Show the combined evidence and higher risk severity.

6. **Evidence and Slack — 60 seconds**  
   Open the evidence packet and AI summary, then show the Slack alert with case ID and reasons.

7. **Human review — 60 seconds**  
   Approve, dismiss, or escalate the case. Show the reviewer, timestamp, note, and updated dashboard state.

8. **Reliability and conclusion — 45 seconds**  
   Mention duplicate handling, error paths, audit trail, reset/replay, current limitations, and how the simulator could later be replaced by a real telemetry provider.

### Pre-demo checklist

- [ ] Final simulator, n8n, database, dashboard, AI integration, and Slack are reachable.
- [ ] Demo credentials are active and secrets are not visible on screen.
- [ ] Browser tabs and dashboard filters are prepared.
- [ ] Old alerts/cases are cleared or clearly separated.
- [ ] Test event IDs and simulator run IDs are unique.
- [ ] Normal and suspicious scenario controls are ready.
- [ ] Backup screenshots/data and the deterministic evidence-summary fallback are available.
- [ ] Every speaker knows the handoff cue and time limit.

---

# 13. Final Handover Package

- [ ] Source repository or shared project folder.
- [ ] n8n workflow export.
- [ ] Simulator source/configuration and runbook.
- [ ] Database schema, seed data, and reset instructions.
- [ ] Risk rules, thresholds, and scoring explanation.
- [ ] AI prompt, evidence template, and fallback template.
- [ ] Slack and human-review setup instructions.
- [ ] Dashboard source/configuration.
- [ ] Architecture diagram and data contracts.
- [ ] Test plan, test results, and evidence screenshots.
- [ ] README/setup guide and known limitations.
- [ ] Final demo script and speaking roles.
- [ ] Secret-free example environment/configuration file.

---

## Post-Sprint Improvements (Only After MVP Completion)

- Connect an approved real telemetry provider.
- Learn baselines from larger historical datasets.
- Add confidence calibration and more advanced anomaly models.
- Add role-based access, stronger authentication, and retention controls.
- Add case assignment, comments, exports, and tournament-level reporting.
- Add monitoring, automated deployment, and production incident response.
