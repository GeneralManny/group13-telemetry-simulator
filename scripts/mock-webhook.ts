/**
 * Local stand-in for Team A's n8n webhook. Prints one line per event and validates it
 * against the contract. Use it for local runs or if the hosted n8n is unreachable.
 *
 *   npm run mock-webhook            # listens on :4000
 *   MOCK_PORT=4100 MOCK_FAIL_RATE=0.2 npm run mock-webhook
 *
 * Then run the simulator with N8N_WEBHOOK_URL=http://localhost:4000/webhook/telemetry
 */
import { createServer } from "node:http";
import { validateEvent } from "../src/contracts/validation.js";

const port = Number(process.env.MOCK_PORT ?? 4000);
const failRate = Number(process.env.MOCK_FAIL_RATE ?? 0);
const seen = new Set<string>();
let count = 0;

createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    count++;
    if (Math.random() < failRate) {
      console.log(`#${count} -> 503 (simulated failure)`);
      return res.writeHead(503).end();
    }
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(body);
    } catch {
      console.log(`#${count} invalid JSON`);
      return res.writeHead(400).end();
    }
    const valid = validateEvent(event).success;
    const id = String(event.event_id);
    const dup = seen.has(id);
    seen.add(id);
    const token = req.headers["x-simulator-token"] ? "token" : "no-token";
    const m = (event.metrics ?? {}) as Record<string, unknown>;
    const o = (event.odds ?? {}) as Record<string, unknown>;
    const detail =
      event.event_type === "odds_update"
        ? `blue=${o.team_blue} red=${o.team_red} move=${o.movement_pct}%`
        : m.reaction_time_ms !== undefined
          ? `rt=${m.reaction_time_ms} acc=${m.accuracy_pct ?? "-"}`
          : "";
    console.log(
      [
        `#${count}`,
        `seq=${event.sequence_number}`,
        String(event.event_type).padEnd(16),
        String(event.player_id ?? "").padEnd(9),
        detail,
        valid ? "" : "INVALID",
        dup ? "DUPLICATE" : "",
        token,
      ]
        .filter(Boolean)
        .join("  "),
    );
    res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
}).listen(port, () =>
  console.log(`mock webhook listening on http://localhost:${port}/webhook/telemetry`),
);
