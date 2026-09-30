# Group 13 team guide

A plain-language guide to the Esports Integrity Monitor, written so every teammate can understand their part, present it in the live demo on Saturday 2026-10-03, and answer examiner questions. The system flags statistical signals for human review; it never concludes that a player cheated or a match was fixed, and neither does this guide.

Start with chapter 00, then 01, then your team's chapters, then 10.

| Chapter                                                              | What it covers                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [00. Start here](00-start-here.md)                                   | What the system does, the guardrail, which chapters each team reads, and the glossary                                    |
| [01. Architecture](01-architecture.md)                               | The three Railway services, the dashboard, and one player_07 event followed from simulator to dashboard                  |
| [02. The simulator](02-simulator.md)                                 | What it generates, the event contract, scenarios, presets, seeds and replay, and the run controls                        |
| [03. n8n ingestion](03-n8n-ingestion.md)                             | Workflow "G13 1 - Ingest telemetry" node by node: validation, dead letters, duplicates and retries                       |
| [04. The database](04-database.md)                                   | Every table in plain words, why event_id is the primary key, one case per match and subject, audit trail, reset          |
| [05. Baselines and the risk engine](05-baselines-and-risk-engine.md) | Baselines, the 30-second window, standard deviations, each rule, the 0 to 100 score, and the final demo worked example   |
| [06. Cases, evidence and AI](06-cases-evidence-and-ai.md)            | Case lifecycle, the evidence packet, workflow "G13 2", the AI prompt rules, the language check and the fallback template |
| [07. Slack and human review](07-slack-and-human-review.md)           | The Slack alert, reviewing in the Cases tab, workflow "G13 3", signature checks, and setting up the Slack app            |
| [08. The dashboard](08-dashboard.md)                                 | Each tab, what to point at in the demo, loading and offline states, mobile and projector use                             |
| [09. Testing](09-testing.md)                                         | Plan tests T01 to T18 mapped to automated tests or manual steps, and how to run the tests                                |
| [10. Demo runbook](10-demo-runbook.md)                               | Pre-demo checklist, the timed script with speaking roles and clicks, fallbacks, and examiner questions                   |
| [11. Setup and operations](11-setup-and-operations.md)               | Railway services and variables by name, deploying, rebuilding workflows, troubleshooting, known limitations              |
