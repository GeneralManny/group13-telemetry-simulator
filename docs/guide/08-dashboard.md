# 08. The dashboard

## What this part does

The dashboard is the window onto the whole system: the live match, the event stream, each player's risk, the cases with their evidence, and the human review. It is a Next.js website (a React framework) exported as static files and served by the telemetry-simulator service at `/`. It only talks to that same service's API.

Address: https://telemetry-simulator-production-bf55.up.railway.app

## Where it lives

```
dashboard/components/Console.tsx    header, tabs, connection pill, unlock, offline banner
dashboard/components/Overview.tsx   match card, controls, counters, odds chart, player charts and table
dashboard/components/Cases.tsx      case list, case detail, human review panel, audit trail
dashboard/components/Risk.tsx       pipeline health, risk by player, dead letters, clear monitor data
dashboard/components/Webhooks.tsx   extra webhook destinations
dashboard/components/LiveEvents.tsx live event feed and JSON viewer
dashboard/components/ApiGuide.tsx   copyable commands and endpoint list
```

## Keys and what they unlock

Anyone can view every tab. Actions need a key, entered with the Unlock button (top right). The key is kept only in that browser tab and is forgotten when the tab closes.

| Key                             | Unlocks                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Control key (`CONTROL_API_KEY`) | Start, pause, reset and replay matches; test event; review cases; clear monitor data; manage webhooks |
| Team key (`TEAM_ACCESS_KEY`)    | Manage webhooks only                                                                                  |
| None                            | Viewing everything                                                                                    |

When unlocked, the button shows "Control" or "Team"; selecting it locks again.

## The tabs

### Overview

- Current match: state badge, Team Blue vs Team Red score, match clock (for example 1:37 / 4:00), round number, progress bar, seed and run ID.
- Controls (control key): the five preset buttons, Custom run, Pause, Resume, Stop, Replay, Reset, and "Send test event".
- Delivery counters: Events generated, Deliveries, Failed, Pending, Retries, and webhook health.
- Match-winner odds: a chart of both teams' decimal odds over the match clock. Large unexplained moves are labelled on the chart, for example "30.1% move" at 1:30. A button switches the chart to a table.
- Player charts: reaction time, accuracy and headshot rate for one player (player_07 by default) against their baseline range.
- Players table: each player's latest 30-second snapshot and how far it is from their baseline, or "Within range".

Point at during the demo: the counters rising together, the player_07 reaction-time chart dropping at 1:00, and the odds chart label at 1:30.

### Cases

- The case list with filters for Status and Severity.
- The case detail: severity chip with peak score, status, the "No conclusion has been made about anyone" notice, score breakdown, "Why this was flagged", the baseline table, the risk score chart (the shaded band is High and Critical, 60 and above), the evidence summary with its source label, Slack delivery, trace ID, the Human review panel and the Audit trail.
- A link of the form `/?case=CASE-7KQ2XM#cases` opens a case directly. Slack's "Open case" button uses it.

Point at: the score breakdown 55 / 30 / 10, the reaction time row "228.5 ± 21.5 | 118 | -5.14 sd", the summary label, then the review and the audit trail.

### Risk

- Pipeline health: Pipeline (Receiving, Idle or Waiting for events), Events stored ("Each event_id once"), Last minute, Dead letters ("Rejected, logged, pipeline kept going"), Open cases (open, pending review and escalated together), and AI summaries ("AI connected" or "Template only").
- Risk by player: every player plus "Betting market", with the current severity and score ("Now"), "Peak this match", and the rules triggered. It always shows the most recent match.
- Dead letters: the latest 20 rejected events with reason and detail.
- "Clear monitor data" (control key): clears events, cases, reviews and dead letters, keeping baselines and thresholds.

Point at: during the normal match, every row Normal 0; during the final demo, player_07's row turning High then Critical 95 while everyone else stays at 0, and the Betting market row at Monitor 30.

"Now" and "Peak" can differ: after about 2:30 in the final demo, player_07's latest score falls to 65 because the odds move is more than 60 seconds old, while the peak stays 95.

### Webhooks

Lets a team add its own n8n webhook address to receive a copy of every event, with an optional shared token and an event type filter, and press Test to check it. Our main n8n connection does not use this tab: it is set by the `N8N_WEBHOOK_URL` variable on the private network. In production this tab only accepts public https addresses.

### Live events

A live feed of events as the simulator emits them, with filters for event type and player, a "Pause feed" button, and the exact JSON of the selected event. The status reads "Live", "Connected, paused" or "Connecting". It shows what the simulator sent; the Risk tab shows what the monitor stored.

### API guide

The base URL, copyable commands for checking status, running the final demo and resetting, and the full endpoint list with the access each needs.

## Loading, empty and offline states

Every view handles four situations so the demo never shows a blank or broken screen.

- Loading: grey placeholder shapes (skeletons) in the shape of the content, for example "Loading cases".
- Empty: a sentence saying what will appear and how. Cases: "No cases yet. Normal play never opens one; run the Final demo preset to see a case appear." Dead letters: "None. Run the Pipeline failure test preset to see invalid events land here." Live events: "Waiting for events. Start a match on the Overview tab."
- Monitor not ready: "The monitor database is still connecting."
- Offline: the header pill changes from "Online" to "Simulator offline" and a banner says "The simulator is not answering. Retrying every few seconds; the page updates as soon as it is back." If configuration is incomplete, the pill says "Online, setup incomplete".

Data refreshes by polling: status every 1.5 seconds, the Risk tab every 2.5 seconds, cases every 3 seconds, charts every 2 seconds during a match. Polling pauses while the browser tab is hidden and resumes when you return.

## Mobile and projector support

- The layout adapts at 1100, 720 and 400 pixels wide. Cards stack into one column on phones.
- Wide tables scroll sideways with the first column pinned, and show "Swipe the table sideways to see every column."
- On narrow screens, selecting a case scrolls down to its detail.
- Touch screens get larger buttons.
- A light and dark theme toggle sits in the header. Severity is shown by label and score as well as colour, so it reads without colour.
- For the projector, zoom the browser to about 125% and use the light theme in a bright room.

## What to say in the demo

"The dashboard shows the live match, every player's risk against their own baseline, and the cases. Here the Risk tab shows player_07 at Critical 95 while every other player is at 0. The case page lays out exactly why, and this is where the administrator records the decision."
