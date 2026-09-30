# 07. Slack alerts and human review

## What this part does

A case is only a question until a person answers it. This part tells tournament administrators about a case in Slack, lets them open the evidence, and records their decision (approve for investigation, dismiss, or escalate) with their name, notes and the time. Decisions can be made in the dashboard or with buttons in Slack.

## What the Slack alert contains

The message is built by the node "Build Slack message" from stored evidence only. For the final demo the channel receives two messages: first "New HIGH integrity case CASE-7KQ2XM", then "Case CASE-7KQ2XM rose to CRITICAL". Each message has:

- Header: the title above.
- Severity: for example "CRITICAL (95/100)".
- Subject: "Blue Seven (player_07, Team Blue)", or "Match-winner betting market".
- Match: the match ID.
- Window: the match time the case covers, from the start of the window that first reached High to the latest update, for example "0:37 to 1:37 match time".
- Why this was flagged: one line per rule that earned points, using the engine's sentences.
- Evidence summary: the AI or template text, labelled "(AI, from stored evidence)" or "(template)".
- A footer: "Signals for human review only. No conclusion has been made. Case CASE-7KQ2XM, trace n8n-4812."
- Buttons: "Open case" (a link to the case in the dashboard, when `PUBLIC_BASE_URL` is set). When `SLACK_INTERACTIVE` is `true`, also "Approve for investigation", "Escalate" and "Dismiss".

There is never one message per event. The engine sends one alert when a case first reaches High and one more only if it becomes more severe (chapter 05).

## Reviewing in the dashboard

1. Open the Cases tab. The list shows each case with its ID, severity and peak score, subject, status, number of rules and when it was last updated. Filters at the top narrow by Status and Severity.
2. Select a case. The detail panel shows: the "No conclusion has been made about anyone" notice, match, window, evidence event count, the score breakdown (Performance of 60, Odds of 30, Repeated signals of 10), "Why this was flagged", the baseline table, the "Risk score over the match" chart, the evidence summary, Slack delivery status and trace ID.
3. Review needs the control key. If you are not unlocked, the panel says "Unlock with the control key to approve, dismiss or escalate this case."
4. Under "Human review", type your name in Reviewer (at least 2 characters; the browser remembers it) and optionally a note in "Notes (recorded with the decision)".
5. Select one of the three buttons: Approve for investigation, Escalate, or Dismiss.
6. A message confirms, for example "CASE-7KQ2XM: escalate recorded." The status badge changes, and the audit trail at the bottom adds a line such as "Pending review to Escalated by Admin Ada: Needs a second look".

After approve or dismiss, the review panel is replaced by "Decision: Dismissed by Admin Ada ... Notes: ...". The Escalate button is disabled while a case is already escalated.

Repeating a decision is harmless: the confirmation says "Already escalated; nothing changed." and no second review row is written.

## Workflow "G13 3 - Slack review buttons"

This workflow receives Slack button clicks. Its public address is:

```
https://n8n-production-d5d3.up.railway.app/webhook/slack-actions
```

1. Receive Slack button click. A Webhook node on the path `slack-actions`, set to keep the raw request body, which the signature check needs. It answers Slack straight away.
2. Verify Slack request. A Code node that proves the click really came from Slack:
   - it reads the `x-slack-request-timestamp` header and refuses anything older than five minutes, which stops someone replaying an old click;
   - it computes an HMAC signature (a fingerprint made with a shared secret) of "v0:" + timestamp + ":" + raw body, using `SLACK_SIGNING_SECRET`;
   - it compares that with the `x-slack-signature` header in constant time. Any mismatch stops the workflow with "Slack signature does not match";
   - it reads the clicked button. Only `approve_for_investigation`, `dismiss` and `escalate` are accepted. The "Open case" button is ignored here.
   - it takes the case ID from the button and the reviewer from the Slack user's name.
3. Record review in monitor. Posts `{ action, reviewer, notes: "Decided in Slack", channel: "slack" }` to `/api/v1/monitor/cases/{case_id}/review` with the ingest key. It never fails on an error response, so the next node can report the problem.
4. Build Slack reply. Writes one of three replies: "emmanuel escalated CASE-7KQ2XM.", "CASE-7KQ2XM was already escalated; nothing changed.", or "Could not record the decision for CASE-7KQ2XM: ..." with the reason.
5. Reply in Slack. Posts the reply into the channel through the click's `response_url`.

The lead verified this end to end: signed clicks were recorded as reviews, repeating a click changed nothing, and a forged signature was rejected.

## Setting up the Slack app

Only needed once per Slack workspace. The Slack side is done on api.slack.com; the Railway side is on the n8n service's Variables tab. Never paste the webhook URL or signing secret into chat, the repository or a screenshot.

1. Go to https://api.slack.com/apps and select Create New App, then From scratch. Name it, for example "G13 Integrity Monitor", and choose the workspace.
2. Open Incoming Webhooks, switch Activate Incoming Webhooks on, select Add New Webhook to Workspace, choose the alert channel, and allow it.
3. Copy the new webhook URL. In Railway, on the n8n service, set it as `SLACK_WEBHOOK_URL`.
4. Open Interactivity & Shortcuts and switch Interactivity on. Set the Request URL to `https://n8n-production-d5d3.up.railway.app/webhook/slack-actions` and save.
5. Open Basic Information, find App Credentials, and reveal the Signing Secret. In Railway, on the n8n service, set it as `SLACK_SIGNING_SECRET`.
6. In Railway, on the n8n service, set `SLACK_INTERACTIVE` to `true`. This is what adds the three review buttons to the alert.
7. Make sure `PUBLIC_BASE_URL` is set on the telemetry-simulator service to the dashboard address, so the "Open case" button works.
8. Let Railway redeploy the services so the new variables take effect.
9. Test: run `final_demo`, wait for the first alert, and click Escalate. The channel should show "your-name escalated CASE-...", and the dashboard's audit trail should show the change with channel Slack.

Without steps 4 to 6, alerts still arrive with the "Open case" button and reviews happen in the dashboard.

## If Slack is down or not set up

The case is still created, summarised and moved to pending_review. The node "Record alert failed" (or "Record Slack not configured") stores the failure, and the case page shows "Slack alert: Not delivered" with the error. The reviewer works from the dashboard instead. This is test T13.

## How to check it works

- Case page, "Slack alert": Delivered.
- Two messages in the channel for one final demo run, never more.
- A Slack click appears in the case's audit trail with the Slack user as actor.

## What to say in the demo

"Here is the Slack alert: severity, score, the player, the window, the reasons and the summary, and a clear line that these are signals for review, not a conclusion. Notice there are only two messages for the whole match: one when the case opened at High and one when it rose to Critical. The decision is always a person's. I will enter my name and a note and escalate it; the reviewer, time and note are stored, and clicking again changes nothing."
