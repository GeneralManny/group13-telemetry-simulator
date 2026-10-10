# Test results

Recorded 2026-10-10 against release `v1.0.0`. The test plan (T01 to T18) and how each test maps to code is in
[chapter 09 of the guide](../docs/guide/09-testing.md).

## Automated tests

| Check                                           | Command                                                                                                        | Result                         |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Type check, lint, formatting, unit tests        | `npm run check`                                                                                                | Pass                           |
| Full suite including the Postgres service tests | `TEST_DATABASE_URL=postgres://postgres:testpass@localhost:55432/monitor_test npm test` (Postgres 17 in Docker) | 178 of 178 pass, 12 test files |
| Dependency audit                                | `npm audit --omit=dev`                                                                                         | 0 vulnerabilities              |

Without `TEST_DATABASE_URL` the 11 Postgres tests are skipped and the other 167 run.

## End-to-end runs

The `final_demo` preset is seeded (seed 13027), so every run produces the same match: player_07 (Blue Seven, Team Blue)
changes at 1:00 and the betting odds move 30.1% toward Team Blue at 1:30 with no round result nearby.

| Date       | Where                                   | What was checked                                                           | Result                                                                                                                                                                                                                                                 |
| ---------- | --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-30 | Local n8n 2.41.4                        | Full pipeline through the three n8n workflows                              | 302 of 302 events stored once; one Critical case; exactly two alerts; invalid events in dead letters; signed Slack clicks recorded; forged signature rejected                                                                                          |
| 2026-09-30 | Production (Railway)                    | Simulator to n8n over the private network, monitor storage and scoring     | 212 of 212 events stored once; Critical 95 case for player_07                                                                                                                                                                                          |
| 2026-10-09 | Production with the Slack app           | Alerts in the Slack channel and a review from a Slack button               | Case opened at 62, rose to Critical 95; two Slack messages (High, then Critical); Approve for investigation recorded with channel "slack" and an audit row                                                                                             |
| 2026-10-10 | Production after the odds-direction fix | AI summary wording, repeated review click (T17), decision on a closed case | Critical 95; summary states the odds "shortened for Team Blue, the player's own team"; second Escalate click replied "was already escalated; nothing changed."; a new decision on an approved case was refused with "Final decisions are not changed." |

Evidence from the 2026-10-10 run (reviewer names blurred):

- [Slack alerts for CASE-V0N2LG](../docs/images/slack-alerts.png): High, then Critical 95, with the corrected odds sentence
- [Slack replies to review clicks](../docs/images/slack-review-replies.png): escalated, repeated click with no change
  (T17), and a refused change to an approved case
- n8n runs: [G13 1](../docs/images/n8n-1-ingest-telemetry.png), [G13 2](../docs/images/n8n-2-evidence-and-alert.png),
  [G13 3](../docs/images/n8n-3-slack-review.png)

## Defect found and fixed during testing

On 2026-10-09 the AI summary stated that the final demo's odds move favoured the opposing team, while the stored
evidence said the odds shortened for the player's own team. The model was reading the `shortened_team` field the wrong
way round. Fixed on 2026-10-10: each odds move sent to the model now states the direction in plain words, and a
direction check rejects any summary that reverses it (the next model is tried, then the template). Seven tests cover
it. See [chapter 06](../docs/guide/06-cases-evidence-and-ai.md), "The odds direction check".

A second defect was found on 2026-10-10 in a later production run: the summary ended "I recommend approving for
investigation", which leans toward one decision, and placed signals at 1:30 to 1:37 "in the final minutes of the match".
Fixed the same day: the prompt forbids recommending a decision and limits timing to the match times given, the packet
carries the window as match time, and a neutrality check rejects steering or vague timing (next model, then template).
Six tests cover it. See chapter 06, "The neutrality check".

## Not covered by automated tests

- T11, database unavailable: tested by design and documented as a limitation (chapter 09).
- The n8n workflows are verified by the end-to-end runs above, not by the automated suite.
- Free AI models change availability without notice. When none answers, the deterministic template is used (T12).
