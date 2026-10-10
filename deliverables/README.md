# Group 13 final deliverables

Esports Tournament Live Anti-Cheat and Match Integrity Monitor. Release `v1.0.0`, submitted 2026-10-10.

The system watches live match telemetry and betting odds, scores unusual patterns against each player's own history,
opens a case with the evidence, writes a plain-language summary, alerts tournament administrators in Slack, and records
their decision. It flags signals for human review only. Nothing in the system states or implies that a player cheated or
a match was fixed; a person makes every decision.

- Live dashboard: https://telemetry-simulator-production-bf55.up.railway.app (viewing needs no key; running matches
  and reviewing cases need the control key, which is shared privately)
- Source: this repository. No keys, tokens or passwords are stored in it; every secret lives in the hosting
  platform's variables, and the example files below list the names only.

## 1. Project README files

| File                                            | What it covers                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| [README.md](../README.md)                       | The service: dashboard tabs, access keys, quick start, API, event contract, deploy |
| [docs/guide/README.md](../docs/guide/README.md) | Index of the team guide and the order to read it in                                |
| [deliverables/README.md](README.md)             | This page                                                                          |

## 2. Project documentation

The team guide, written so every member can explain and present any part:

| Chapter                                                                            | Topic                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| [00. Start here](../docs/guide/00-start-here.md)                                   | What the system does, the guardrail, glossary                                 |
| [01. Architecture](../docs/guide/01-architecture.md)                               | Services, data flow, one event followed from simulator to dashboard           |
| [02. The simulator](../docs/guide/02-simulator.md)                                 | Event contract, scenarios, presets, seeds and replay                          |
| [03. n8n ingestion](../docs/guide/03-n8n-ingestion.md)                             | Validation, duplicates, retries, dead letters                                 |
| [04. The database](../docs/guide/04-database.md)                                   | Schema, keys, audit trail, reset                                              |
| [05. Baselines and the risk engine](../docs/guide/05-baselines-and-risk-engine.md) | Baselines, rules, thresholds, the 0 to 100 score, worked example              |
| [06. Cases, evidence and AI](../docs/guide/06-cases-evidence-and-ai.md)            | Case lifecycle, evidence packet, AI prompt, checks, fallback template         |
| [07. Slack and human review](../docs/guide/07-slack-and-human-review.md)           | Alert format, review buttons, signature checks, Slack app setup               |
| [08. The dashboard](../docs/guide/08-dashboard.md)                                 | Each tab and what it shows                                                    |
| [09. Testing](../docs/guide/09-testing.md)                                         | Test plan T01 to T18 and how to run the tests                                 |
| [10. Demo runbook](../docs/guide/10-demo-runbook.md)                               | Pre-demo checklist, timed script, speaking roles, fallbacks, likely questions |
| [11. Setup and operations](../docs/guide/11-setup-and-operations.md)               | Services and variables, deploying, troubleshooting, known limitations         |

Also:

- [Test results](TEST_RESULTS.md): automated suite and end-to-end runs, with dates.
- [Handoff notes](../docs/HANDOFF.md): integration notes for each team and the handoff demonstration checklist.
- [Build plans](../docs/plans/): the one-week sprint plan for the whole system and the simulator plan.

## 3. Active team members

The list of active team members is submitted separately by the team leader as a shared document, so members'
names and contact details are not published in this public repository.

## 4. Additional project assets

| Asset                                                                 | Location                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| n8n workflow exports (3 workflows)                                    | [n8n/workflows/](../n8n/workflows/), built from [scripts/build-n8n-workflows.ts](../scripts/build-n8n-workflows.ts) |
| Event contract (JSON Schema, v1.0)                                    | [docs/event-schema.json](../docs/event-schema.json)                                                                 |
| Sample events and demo sequences                                      | [samples/](../samples/)                                                                                             |
| Example configuration, names only                                     | [.env.example](../.env.example) (service and monitor), [n8n/.env.example](../n8n/.env.example) (n8n)                |
| Database schema and migrations                                        | [src/monitor/db/](../src/monitor/db/)                                                                               |
| Risk rules and thresholds                                             | [src/monitor/engine/](../src/monitor/engine/)                                                                       |
| AI prompt, evidence and fallback templates                            | [src/monitor/evidence.ts](../src/monitor/evidence.ts)                                                               |
| Dashboard source                                                      | [dashboard/](../dashboard/)                                                                                         |
| Automated tests                                                       | [tests/](../tests/)                                                                                                 |
| Screenshots: the three n8n workflows, Slack alerts and review replies | [docs/images/](../docs/images/), shown in the [README](../README.md)                                                |
| Hosting configuration                                                 | [Dockerfile](../Dockerfile), [railway.json](../railway.json), [n8n/](../n8n/)                                       |

## Handover checklist (plan section 13)

| Item                                               | Where                                                 |
| -------------------------------------------------- | ----------------------------------------------------- |
| Source repository                                  | This repository                                       |
| n8n workflow export                                | `n8n/workflows/`                                      |
| Simulator source, configuration and runbook        | `src/simulator/`, chapter 02, chapter 10              |
| Database schema, seed data and reset instructions  | `src/monitor/db/`, chapter 04, chapter 05 (baselines) |
| Risk rules, thresholds and scoring explanation     | Chapter 05                                            |
| AI prompt, evidence template and fallback template | Chapter 06, `src/monitor/evidence.ts`                 |
| Slack and human-review setup instructions          | Chapter 07                                            |
| Dashboard source and configuration                 | `dashboard/`, chapter 08                              |
| Architecture diagram and data contracts            | Chapter 01, `docs/event-schema.json`                  |
| Test plan, test results and evidence               | Chapter 09, [TEST_RESULTS.md](TEST_RESULTS.md)        |
| README, setup guide and known limitations          | `README.md`, chapter 11, `docs/HANDOFF.md`            |
| Final demo script and speaking roles               | Chapter 10                                            |
| Secret-free example configuration                  | `.env.example`, `n8n/.env.example`                    |

## Trying it

1. Open the live dashboard. The Overview tab shows the simulator state; the Cases and Risk tabs show the monitor.
2. With the control key: Overview, "Final demo". Within about two minutes of match time a case opens for Blue Seven,
   rises to Critical 95, and appears in the Cases tab with its evidence, score breakdown and summary.
3. To run locally, follow "Quick start (local)" in the [README](../README.md) and chapter 11.
