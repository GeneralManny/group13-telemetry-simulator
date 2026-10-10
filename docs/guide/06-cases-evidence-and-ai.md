# 06. Cases, the evidence packet and the AI summary

## What this part does

When a score reaches High, the monitor opens a case. This part gathers the facts behind the case into an evidence packet, turns the packet into a short readable summary (written by the AI, or by a fixed template if the AI is unavailable), and hands it to Slack. The summary may describe the evidence but may never add facts or reach a verdict.

## Where it lives

```
src/monitor/service.ts    case creation and updates, evidence packet, summary, alert recording, review
src/monitor/evidence.ts   packet shape, AI prompt, fallback template, language check
src/monitor/ai.ts         the OpenRouter call and every fallback path
scripts/build-n8n-workflows.ts   workflow "G13 2 - Evidence, AI summary and Slack alert"
```

## Case lifecycle

A case has one of five statuses. The allowed values are enforced by the database.

```
open  --->  pending_review  --->  approved   (final)
                            --->  dismissed  (final)
                            --->  escalated  --->  approved or dismissed
```

- open: created by the risk engine when a subject first reaches High. The audit row reads "Opened at score 62".
- pending_review: set as soon as the evidence summary is written, whether by the AI or by the template. Recording the Slack delivery result also moves an open case here, so a case becomes reviewable even if Slack fails. From here the case is waiting for a person.
- approved: a reviewer chose "Approve for investigation". Shown as "Approved for investigation".
- dismissed: a reviewer chose "Dismiss". The evidence stays.
- escalated: a reviewer chose "Escalate", for example to a senior official. It is not final: an escalated case can still be approved or dismissed.

Approved and dismissed are final. Repeating the same decision changes nothing, and a different decision on a final case is refused with "Case CASE-7KQ2XM is already dismissed by Admin Ada. Final decisions are not changed." A reviewer can also act while a case is still open; the pending step is not required.

## The evidence packet

The packet is built fresh from the database whenever it is needed, by `evidencePacket()` in the monitor. Every statement in the summary, the Slack message and the case page must trace back to a field here.

| Field                                        | What it holds (final demo example)                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| case_id, severity, score, peak_score, status | CASE-7KQ2XM, critical, 95, 95, pending_review                                                                                           |
| match                                        | match_id, tournament, run ID, match clock, current score                                                                                |
| subject                                      | player_07, "Blue Seven", team_blue (or `market`)                                                                                        |
| components                                   | performance 55, odds 30, cluster 10                                                                                                     |
| rules                                        | each rule with points, measured value, baseline mean and standard deviation, deviation, sample count, and a plain sentence              |
| window                                       | the match time the case covers: from the start of the window that first reached High (37.5 s) to the latest update                      |
| metrics_vs_baseline                          | all four metrics: baseline mean, standard deviation, sample size, window average and deviation (empty where the metric stayed in range) |
| odds_moves                                   | the unexplained odds move: 30.1% at 90 s, Team Blue shortened, from and to odds                                                         |
| sample_events                                | up to 12 of the linked events with their metrics                                                                                        |
| evidence_event_count                         | how many events are linked to the case                                                                                                  |
| case_url                                     | the dashboard link for the case, built from `PUBLIC_BASE_URL`                                                                           |

A rule sentence looks like this, word for word from the engine: "Average reaction time was 118 ms across 9 actions in the last 30 seconds, 5.1 standard deviations below this player's baseline of 229 ms."

## Workflow "G13 2 - Evidence, AI summary and Slack alert"

Started by the ingestion workflow once per alert. Open it in the n8n editor to follow along.

1. When called by ingestion. The trigger. It receives the alert: case ID, severity, score, reason (`new_case` or `severity_increase`) and trace ID.
2. Generate evidence summary. Calls `POST /api/v1/monitor/cases/{case_id}/summary` with the ingest key. The monitor builds the packet, asks the AI, applies the checks below, saves the summary on the case, and moves the case from open to pending_review. 60 second timeout, 2 tries.
3. Load case and evidence. Calls `GET /api/v1/monitor/cases/{case_id}` to fetch the case, its packet, score history, reviews and audit trail. 3 tries.
4. Build Slack message. A Code node that builds the Slack message from the loaded case only (chapter 07). It uses "rose to CRITICAL" wording for a severity increase and "New HIGH integrity case" for a new case.
5. Slack configured? If the `SLACK_WEBHOOK_URL` variable is not set, it skips sending.
6. Send Slack alert. Posts the message to the Slack incoming webhook. 3 tries, 2 seconds apart.
7. Record alert sent, Record alert failed, Record Slack not configured. Each calls `POST /api/v1/monitor/cases/{case_id}/alert` with `sent` or `failed` and the error (`slack_not_configured` for the last one). The dashboard shows this as Delivered, Not delivered, or Pending.

The summary is regenerated for each alert, so when the case rises to Critical the summary is rewritten with the new evidence.

## The AI call

The monitor calls free models on OpenRouter, a service that gives one API for many AI models, using the `OPENROUTER_API_KEY` variable. The models are tried in order and listed in `OPENROUTER_MODELS`; the default order is Google Gemma 4 31B, Qwen 3.8 27B, NVIDIA Nemotron 3 Super, Google Gemma 4 26B, then `openrouter/free`, OpenRouter's router that picks any free model that is available. Settings chosen for this job:

- low temperature (0.2), because a 150-word grounded summary needs consistency, not creativity;
- every free model today is a reasoning model that thinks before it answers, so the call asks for low reasoning effort, keeps the thinking out of the reply, and allows 2000 tokens so the thinking cannot use up the space for the answer;
- 20 seconds per model and 45 seconds in total, then the next model or the template;
- if a model is busy, rate limited, times out, or answers with accusing words, the next model is tried; a wrong key stops at once;
- some free models "think out loud" inside `<think>` tags; that part is removed and only the answer is kept;
- the packet is sent without the sample events and the case link, which the summary does not need.

Free models have limits: about 20 requests a minute and a daily cap that depends on the OpenRouter account. A demo needs only a handful of summaries, and the template covers anything beyond the cap.

## The prompt rules

The system prompt (`AI_SYSTEM_PROMPT` in `evidence.ts`) tells the model:

- use only facts present in the packet; do not add causes, motives, history or events;
- never state or suggest that anyone cheated, fixed a match, used software, or is guilty; describe measurements and how unusual they are;
- do not use the accusing words at all, not even to deny them ("this does not prove cheating" still fails the check below), and say "signals for review" instead;
- refer to a player by display name or as "the player", with no gendered pronouns;
- odds direction: shortened odds mean the market now rates that team more likely to win; state the `market_moved_toward` direction exactly as given and mention only moves marked `flagged`;
- state the uncertainty plainly: these are signals for review, not proof;
- timing: describe when something happened only with the match times given (`window_match_time`, such as "0:37 to 1:37 match time", and each odds move's `match_time`), never in other words such as "early" or "the final minutes";
- never recommend, suggest or favour a decision; end by stating that a human administrator reviews the case and chooses one of approve for investigation, dismiss, or escalate;
- plain text, at most 150 words;
- structure: one sentence naming case, severity, score and subject; the key measurements with numbers; the timing relationship between signals; the uncertainty statement and recommendation.

## The language check

After the model answers, `languageViolations()` scans the text for accusing words: cheat and its forms, match-fixing, "fixed the match", guilt or guilty, rigged, hack and its forms, aimbot, wallhack, and "threw" or "throwing" the match, game or round. Any hit rejects the AI text and the template is used instead, with the reason `ai_language_check_failed` written to the log. Neutral sentences such as "These signals do not prove wrongdoing" pass.

## The odds direction check

"Shortened odds" is betting language that models often read backwards. In early production runs the model wrote that the 30.1% move favoured the opposing team, while the evidence said the odds shortened for Blue Seven's own team. Two things now prevent that:

- The AI is no longer left to interpret `shortened_team`. Each odds move it receives carries a plain sentence, `market_moved_toward`, for example "Team Blue, the player's own team", plus `match_time` ("1:30") and `flagged`, which is true only for the move the odds rule actually counted. The raw from and to odds are left out of the AI message; the case page still shows them.
- `directionViolations()` reads the answer. If it says the flagged move favoured, went toward, or shifted to the wrong side (the other team by name, or "the opposing team" when the odds shortened for the player's own team, and the mirror case), the answer is rejected with the reason `ai_grounding_check_failed`, the next model is tried, and the template is used if none passes. Correct sentences that mention the other team, such as "the opposing team's odds lengthened", pass.

## The neutrality check

The decision belongs to the reviewer, so the summary must not lean toward one. In a production run on 2026-10-10 the model ended with "I recommend approving for investigation" and said the signals came "in the final minutes of the match", when they were at 1:30 to 1:37 of a 4-minute match. The prompt then asked the model to end "by recommending" review, and the window reached it only as raw seconds (37.5 to 97.5).

Now the prompt forbids recommending any decision and limits timing to the match times given, and the packet carries `window_match_time` ("0:37 to 1:37 match time"). `neutralityViolations()` then rejects summaries that steer the decision ("I recommend approving", "should be escalated", "warrants an investigation") or use timing the packet never states ("final minutes", "late in the match", "end of the match"), with the reason `ai_neutrality_check_failed`. The next model is tried, and the template is used if none passes. Naming all three choices neutrally passes, and so does "in the last 30 seconds", which is how the rules describe the window.

## The fallback template

If anything goes wrong, `fallbackSummary()` writes the summary from the packet alone. It is used when:

- no API key is set (`ai_not_configured`);
- the call times out, is rate limited, fails authentication, or errors (`ai_timeout`, `ai_rate_limited`, `ai_auth_failed`, `ai_error_...`, `ai_unreachable`);
- every model returns empty text (`ai_empty_response`);
- the language check fails;
- the odds direction check fails (`ai_grounding_check_failed`);
- the neutrality check fails (`ai_neutrality_check_failed`).

What the template produces for the final demo, in outline:

```
Case CASE-7KQ2XM: CRITICAL risk, score 95 of 100, for Blue Seven (player_07, Team Blue) in match match_...

What was measured:
- Average reaction time was 118 ms across 9 actions in the last 30 seconds, 5.1 standard deviations below this player's baseline of 229 ms. (PERF_REACTION_TIME, 25 points)
- ... one line per rule ...

Score breakdown: performance 55, odds 30, repeated signals 10.

These are statistical signals compared with the player's own history. They do not establish that any rule was broken. Recommended next step: a tournament administrator reviews the evidence and chooses approve for investigation, dismiss, or escalate.
```

Either way the case reaches pending_review and stays reviewable. The dashboard labels the summary "AI, grounded in stored evidence" or "Template", and Slack labels it "AI, from stored evidence" or "template", so nobody mistakes one for the other.

## How to check it works

- Risk tab, "AI summaries" tile: "AI connected" means the key is set; "Template only" means every summary will use the template.
- `GET /ready` on the service shows `ai_summaries: openrouter` or `fallback_template_only`.
- On a case, the Evidence summary heading shows which source was used.
- Tests: `tests/monitor/service.test.ts` proves the template is used without a key and the case still moves to pending_review; `tests/monitor/engine.test.ts` proves the template passes the language check and that accusing sentences are caught; `tests/monitor/ai.test.ts` proves the model order, rate-limit and timeout fallthrough, thinking-tag removal, and the bad-key stop.

## What to say in the demo

"The evidence packet is the single source of truth: rules, measured values, baselines and the odds move. A free AI model writes a short summary from that packet only, under strict rules: no new facts, no verdict, state the uncertainty, recommend human review. We scan its answer for accusing language, and if anything fails, or the AI is down, a fixed template built from the same packet is used. The case is reviewable either way."
