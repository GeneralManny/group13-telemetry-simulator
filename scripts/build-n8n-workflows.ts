/**
 * Generates the n8n workflow files in n8n/workflows/ from readable source.
 *
 *   npm run n8n:build
 *
 * The JavaScript inside each Code node is written here as normal code, so it can be read and
 * reviewed in the repository. The generated JSON is what the n8n service imports and publishes
 * on every start. Secrets are never written into these files: nodes read them with $env.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type Node = Record<string, unknown> & { name: string };
type Connections = Record<string, { main: { node: string; type: "main"; index: number }[][] }>;

const MONITOR = "={{ $env.MONITOR_API_URL }}/api/v1/monitor";
const INGEST_HEADER = {
  sendHeaders: true,
  headerParameters: {
    parameters: [{ name: "x-api-key", value: "={{ $env.MONITOR_INGEST_KEY }}" }],
  },
};
let idCounter = 0;
const nid = (prefix: string) =>
  `${prefix}-${String(++idCounter).padStart(4, "0")}-4000-8000-000000000000`;

function code(name: string, js: string, position: [number, number]): Node {
  return {
    parameters: { jsCode: js.trim() },
    id: nid("c0de0000"),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position,
  };
}

function http(
  name: string,
  params: Record<string, unknown>,
  position: [number, number],
  extra: Record<string, unknown> = {},
): Node {
  return {
    parameters: params,
    id: nid("a1100000"),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position,
    ...extra,
  };
}

function ifNode(name: string, leftValue: string, position: [number, number]): Node {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: "", typeValidation: "loose", version: 2 },
        conditions: [
          {
            id: nid("cond0000"),
            leftValue,
            rightValue: "",
            operator: { type: "boolean", operation: "true", singleValue: true },
          },
        ],
        combinator: "and",
      },
      options: {},
    },
    id: nid("1f000000"),
    name,
    type: "n8n-nodes-base.if",
    typeVersion: 2.2,
    position,
  };
}

function link(conn: Connections, from: string, to: string, output = 0): void {
  conn[from] ??= { main: [] };
  while (conn[from]!.main.length <= output) conn[from]!.main.push([]);
  conn[from]!.main[output]!.push({ node: to, type: "main", index: 0 });
}

function workflow(
  id: string,
  name: string,
  nodes: Node[],
  connections: Connections,
  saveSuccess: boolean,
) {
  return {
    id,
    name,
    active: false,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
      saveDataSuccessExecution: saveSuccess ? "all" : "none",
      saveDataErrorExecution: "all",
      saveManualExecutions: true,
      callerPolicy: "workflowsFromSameOwner",
    },
    pinData: {},
    meta: { templateCredsSetupCompleted: true },
    tags: [],
  };
}

// ---------------------------------------------------------------------------------------------
// 1. Ingestion: simulator -> validate -> monitor (store, dedupe, score) -> evidence workflow

const VALIDATE_JS = String.raw`
// Checks every event from the simulator before anything is stored.
// Invalid events are not dropped: they go to the dead-letter store with the reason.
const REQUIRED = ["event_id", "event_type", "schema_version", "timestamp", "match_id", "sequence_number", "simulator_run_id"];
const expectedToken = $env.SIMULATOR_WEBHOOK_TOKEN;
const traceId = "n8n-" + $execution.id;

return $input.all().map((item) => {
  const headers = item.json.headers || {};
  const event = item.json.body;
  const errors = [];

  if (expectedToken && headers["x-simulator-token"] !== expectedToken) {
    errors.push("missing or wrong X-Simulator-Token header");
  }
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    errors.push("body is not a JSON object");
  } else {
    for (const field of REQUIRED) {
      if (event[field] === undefined || event[field] === null || event[field] === "") errors.push(field + " is required");
    }
    if (event.timestamp && Number.isNaN(Date.parse(event.timestamp))) errors.push("timestamp is not a valid date");
    if (event.sequence_number !== undefined && !Number.isInteger(event.sequence_number)) errors.push("sequence_number must be a whole number");
    if (event.metrics !== undefined && (typeof event.metrics !== "object" || event.metrics === null || Array.isArray(event.metrics))) errors.push("metrics must be an object");
    if (event.schema_version && event.schema_version !== "1.0") errors.push("unsupported schema_version " + event.schema_version);
  }

  // Normalise: consistent casing for the event type, nothing else is changed.
  const normalized = errors.length ? event : { ...event, event_type: String(event.event_type).toLowerCase() };

  return {
    json: {
      valid: errors.length === 0,
      errors,
      event: normalized,
      event_id: event && typeof event === "object" ? event.event_id ?? null : null,
      trace_id: traceId,
    },
  };
});
`;

const SPLIT_ALERTS_JS = String.raw`
// The monitor answers with zero, one or two alert instructions (a new case, or a case that
// became more severe). Each one starts the evidence and Slack workflow. No alert, no output.
const out = [];
for (const item of $input.all()) {
  for (const alert of item.json.alerts || []) {
    out.push({ json: { ...alert, trace_id: item.json.trace_id } });
  }
}
return out;
`;

function ingestion() {
  const conn: Connections = {};
  const nodes: Node[] = [
    {
      parameters: {
        httpMethod: "POST",
        path: "telemetry",
        responseMode: "onReceived",
        options: {},
      },
      id: nid("3eb00000"),
      name: "Receive simulator event",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2.1,
      position: [0, 300],
      webhookId: "6e1e1e1e-0000-4000-8000-000000000001",
      notes:
        "Production URL /webhook/telemetry. Answers 200 immediately so the simulator is never slowed down.",
    },
    code("Validate and normalise", VALIDATE_JS, [240, 300]),
    ifNode("Valid event?", "={{ $json.valid }}", [480, 300]),
    http(
      "Store and score in monitor",
      {
        method: "POST",
        url: `${MONITOR}/events`,
        ...INGEST_HEADER,
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify({ event: $json.event, trace_id: $json.trace_id }) }}",
        options: { timeout: 10000 },
      },
      [720, 200],
      {
        retryOnFail: true,
        maxTries: 5,
        waitBetweenTries: 3000,
        onError: "continueErrorOutput",
        notes:
          "Duplicates are stored once by the monitor (event_id is the primary key). Retries 5 times, 3 seconds apart, which covers a short database restart. Failed runs stay in n8n's execution list and can be retried from there.",
      },
    ),
    code("One item per alert", SPLIT_ALERTS_JS, [960, 120]),
    {
      parameters: {
        source: "database",
        workflowId: { __rl: true, value: "g13Evidence00002", mode: "id" },
        mode: "each",
        options: { waitForSubWorkflow: false },
      },
      id: nid("e7ec0000"),
      name: "Start evidence and alert",
      type: "n8n-nodes-base.executeWorkflow",
      typeVersion: 1.2,
      position: [1200, 120],
    },
    http(
      "Dead letter: rejected by monitor",
      {
        method: "POST",
        url: `${MONITOR}/dead-letters`,
        ...INGEST_HEADER,
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ reason: 'monitor_rejected', error: String($json.error?.message ?? $json.error ?? 'unknown'), payload: $('Validate and normalise').item.json.event, event_id: $('Validate and normalise').item.json.event_id, trace_id: $('Validate and normalise').item.json.trace_id }) }}",
        options: { timeout: 10000 },
      },
      [960, 320],
      { onError: "continueRegularOutput" },
    ),
    http(
      "Dead letter: invalid event",
      {
        method: "POST",
        url: `${MONITOR}/dead-letters`,
        ...INGEST_HEADER,
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ reason: 'validation_failed', error: $json.errors.join('; '), payload: $json.event ?? null, event_id: $json.event_id, trace_id: $json.trace_id }) }}",
        options: { timeout: 10000 },
      },
      [720, 440],
      { onError: "continueRegularOutput" },
    ),
  ];
  link(conn, "Receive simulator event", "Validate and normalise");
  link(conn, "Validate and normalise", "Valid event?");
  link(conn, "Valid event?", "Store and score in monitor", 0);
  link(conn, "Valid event?", "Dead letter: invalid event", 1);
  link(conn, "Store and score in monitor", "One item per alert", 0);
  link(conn, "Store and score in monitor", "Dead letter: rejected by monitor", 1);
  link(conn, "One item per alert", "Start evidence and alert");
  return workflow("g13Ingestion0001", "G13 1 - Ingest telemetry", nodes, conn, false);
}

// ---------------------------------------------------------------------------------------------
// 2. Evidence and alert: summary (AI or fallback) -> Slack -> record delivery

const SLACK_MESSAGE_JS = String.raw`
// Builds the Slack alert from stored evidence only. It names measurements and asks for a
// human decision; it never says a player cheated or a match was fixed.
const detail = $json;
const c = detail.case;
const ev = detail.evidence;
const alert = $("When called by ingestion").first().json;

const team = (id) => (id === "team_blue" ? "Team Blue" : "Team Red");
const subject = ev.subject.type === "player"
  ? ev.subject.display_name + " (" + ev.subject.player_id + ", " + team(ev.subject.team_id) + ")"
  : "Match-winner betting market";
const clock = (s) => { s = Math.max(0, Math.floor(s || 0)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
const reasons = ev.rules.filter((r) => r.points > 0).map((r) => "- " + r.description).join("\n");
const summary = (c.ai_summary || "").slice(0, 2800);
const title = alert.reason === "severity_increase"
  ? "Case " + c.case_id + " rose to " + c.severity.toUpperCase()
  : "New " + c.severity.toUpperCase() + " integrity case " + c.case_id;

const blocks = [
  { type: "header", text: { type: "plain_text", text: title } },
  { type: "section", fields: [
    { type: "mrkdwn", text: "*Severity*\n" + c.severity.toUpperCase() + " (" + c.peak_score + "/100)" },
    { type: "mrkdwn", text: "*Subject*\n" + subject },
    { type: "mrkdwn", text: "*Match*\n" + ev.match.match_id },
    { type: "mrkdwn", text: "*Window*\n" + clock(ev.window.start) + " to " + clock(ev.window.end) + " match time" },
  ] },
  { type: "section", text: { type: "mrkdwn", text: "*Why this was flagged*\n" + reasons } },
  { type: "section", text: { type: "mrkdwn", text: "*Evidence summary* (" + (c.ai_status === "generated" ? "AI, from stored evidence" : "template") + ")\n" + summary } },
  { type: "context", elements: [{ type: "mrkdwn", text: "Signals for human review only. No conclusion has been made. Case " + c.case_id + ", trace " + (alert.trace_id || "n/a") + "." }] },
];

const actions = [];
if (ev.case_url) actions.push({ type: "button", text: { type: "plain_text", text: "Open case" }, url: ev.case_url, action_id: "open_case" });
if ($env.SLACK_INTERACTIVE === "true") {
  actions.push(
    { type: "button", text: { type: "plain_text", text: "Approve for investigation" }, style: "primary", action_id: "approve_for_investigation", value: c.case_id },
    { type: "button", text: { type: "plain_text", text: "Escalate" }, action_id: "escalate", value: c.case_id },
    { type: "button", text: { type: "plain_text", text: "Dismiss" }, style: "danger", action_id: "dismiss", value: c.case_id },
  );
}
if (actions.length) blocks.push({ type: "actions", elements: actions });

return [{ json: { case_id: c.case_id, slack_configured: Boolean($env.SLACK_WEBHOOK_URL), slack: { text: title, blocks } } }];
`;

function evidence() {
  const conn: Connections = {};
  const trigger = "When called by ingestion";
  const caseId = `$('${trigger}').item.json.case_id`;
  const nodes: Node[] = [
    {
      parameters: {},
      id: nid("7a100000"),
      name: trigger,
      type: "n8n-nodes-base.executeWorkflowTrigger",
      typeVersion: 1,
      position: [0, 300],
    },
    http(
      "Generate evidence summary",
      {
        method: "POST",
        url: `=${MONITOR.slice(1)}/cases/{{ ${caseId} }}/summary`,
        ...INGEST_HEADER,
        options: { timeout: 60000 },
      },
      [240, 300],
      {
        retryOnFail: true,
        maxTries: 2,
        waitBetweenTries: 2000,
        notes:
          "The monitor asks a free AI model for a grounded summary and falls back to a fixed template if the AI is unavailable, slow, or uses accusing words.",
      },
    ),
    http(
      "Load case and evidence",
      {
        method: "GET",
        url: `=${MONITOR.slice(1)}/cases/{{ ${caseId} }}`,
        options: { timeout: 10000 },
      },
      [480, 300],
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 },
    ),
    code("Build Slack message", SLACK_MESSAGE_JS, [720, 300]),
    ifNode("Slack configured?", "={{ $json.slack_configured }}", [960, 300]),
    http(
      "Send Slack alert",
      {
        method: "POST",
        url: "={{ $env.SLACK_WEBHOOK_URL }}",
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.slack) }}",
        options: { timeout: 10000 },
      },
      [1200, 200],
      { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: "continueErrorOutput" },
    ),
    ...(
      [
        ["Record alert sent", "{ status: 'sent' }", [1440, 100]],
        [
          "Record alert failed",
          "{ status: 'failed', error: String($json.error?.message ?? 'slack_error').slice(0, 900) }",
          [1440, 300],
        ],
        [
          "Record Slack not configured",
          "{ status: 'failed', error: 'slack_not_configured' }",
          [1200, 420],
        ],
      ] as [string, string, [number, number]][]
    ).map(([name, body, pos]) =>
      http(
        name,
        {
          method: "POST",
          url: `=${MONITOR.slice(1)}/cases/{{ $('Build Slack message').item.json.case_id }}/alert`,
          ...INGEST_HEADER,
          sendBody: true,
          specifyBody: "json",
          jsonBody: `={{ JSON.stringify(${body}) }}`,
          options: { timeout: 10000 },
        },
        pos,
        { retryOnFail: true, maxTries: 3, waitBetweenTries: 1000 },
      ),
    ),
  ];
  link(conn, trigger, "Generate evidence summary");
  link(conn, "Generate evidence summary", "Load case and evidence");
  link(conn, "Load case and evidence", "Build Slack message");
  link(conn, "Build Slack message", "Slack configured?");
  link(conn, "Slack configured?", "Send Slack alert", 0);
  link(conn, "Slack configured?", "Record Slack not configured", 1);
  link(conn, "Send Slack alert", "Record alert sent", 0);
  link(conn, "Send Slack alert", "Record alert failed", 1);
  return workflow(
    "g13Evidence00002",
    "G13 2 - Evidence, AI summary and Slack alert",
    nodes,
    conn,
    true,
  );
}

// ---------------------------------------------------------------------------------------------
// 3. Slack review buttons -> monitor review -> reply in Slack

const VERIFY_SLACK_JS = String.raw`
// Accepts only genuine Slack requests: the signature must match SLACK_SIGNING_SECRET and the
// request must be less than five minutes old (stops replays).
const crypto = require("crypto");
const item = $input.first();
const headers = item.json.headers || {};
const secret = $env.SLACK_SIGNING_SECRET;
if (!secret) throw new Error("SLACK_SIGNING_SECRET is not set");

// URLSearchParams is not available inside n8n's Code node sandbox, so the form body is parsed by hand.
const formValue = (body, key) => {
  for (const pair of body.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (decodeURIComponent(k.replace(/\+/g, " ")) === key) return decodeURIComponent(v.replace(/\+/g, " "));
  }
  return null;
};
if (!item.binary || !item.binary.data) throw new Error("raw request body missing; enable Raw Body on the webhook");
const raw = (await this.helpers.getBinaryDataBuffer(0, "data")).toString("utf8");
const ts = Number(headers["x-slack-request-timestamp"]);
if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) throw new Error("stale or missing Slack timestamp");
const expected = "v0=" + crypto.createHmac("sha256", secret).update("v0:" + ts + ":" + raw).digest("hex");
const given = String(headers["x-slack-signature"] || "");
if (given.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected))) {
  throw new Error("Slack signature does not match");
}

const payload = JSON.parse(formValue(raw, "payload") || "{}");
const action = (payload.actions || [])[0] || {};
const allowed = ["approve_for_investigation", "dismiss", "escalate"];
if (!allowed.includes(action.action_id)) return [];
return [{
  json: {
    case_id: action.value,
    action: action.action_id,
    reviewer: (payload.user && (payload.user.name || payload.user.username || payload.user.id)) || "slack-user",
    response_url: payload.response_url,
  },
}];
`;

const REPLY_JS = String.raw`
const r = $json;
const req = $("Verify Slack request").item.json;
const label = { approve_for_investigation: "approved for investigation", dismiss: "dismissed", escalate: "escalated" }[req.action];
const text = r.error
  ? "Could not record the decision for " + req.case_id + ": " + (r.message || r.error)
  : r.duplicate
    ? req.case_id + " was already " + r.status + "; nothing changed."
    : req.reviewer + " " + label + " " + req.case_id + ".";
return [{ json: { response_url: req.response_url, body: { response_type: "in_channel", replace_original: false, text } } }];
`;

function slackReview() {
  const conn: Connections = {};
  const nodes: Node[] = [
    {
      parameters: {
        httpMethod: "POST",
        path: "slack-actions",
        responseMode: "onReceived",
        options: { rawBody: true },
      },
      id: nid("3eb00000"),
      name: "Receive Slack button click",
      type: "n8n-nodes-base.webhook",
      typeVersion: 2.1,
      position: [0, 300],
      webhookId: "6e1e1e1e-0000-4000-8000-000000000003",
      notes: "Set this Production URL as the Interactivity Request URL of the Slack app.",
    },
    code("Verify Slack request", VERIFY_SLACK_JS, [240, 300]),
    http(
      "Record review in monitor",
      {
        method: "POST",
        url: `=${MONITOR.slice(1)}/cases/{{ $json.case_id }}/review`,
        ...INGEST_HEADER,
        sendBody: true,
        specifyBody: "json",
        jsonBody:
          "={{ JSON.stringify({ action: $json.action, reviewer: $json.reviewer, notes: 'Decided in Slack', channel: 'slack' }) }}",
        options: { timeout: 10000, response: { response: { neverError: true } } },
      },
      [480, 300],
    ),
    code("Build Slack reply", REPLY_JS, [720, 300]),
    http(
      "Reply in Slack",
      {
        method: "POST",
        url: "={{ $json.response_url }}",
        sendBody: true,
        specifyBody: "json",
        jsonBody: "={{ JSON.stringify($json.body) }}",
        options: { timeout: 10000 },
      },
      [960, 300],
      { onError: "continueRegularOutput" },
    ),
  ];
  link(conn, "Receive Slack button click", "Verify Slack request");
  link(conn, "Verify Slack request", "Record review in monitor");
  link(conn, "Record review in monitor", "Build Slack reply");
  link(conn, "Build Slack reply", "Reply in Slack");
  return workflow("g13SlackReview03", "G13 3 - Slack review buttons", nodes, conn, true);
}

const outDir = join(import.meta.dirname, "..", "n8n", "workflows");
mkdirSync(outDir, { recursive: true });
for (const [file, wf] of [
  ["1-ingest-telemetry.json", ingestion()],
  ["2-evidence-and-alert.json", evidence()],
  ["3-slack-review.json", slackReview()],
] as const) {
  writeFileSync(join(outDir, file), JSON.stringify(wf, null, 2) + "\n");
  console.log(`wrote n8n/workflows/${file}`);
}
