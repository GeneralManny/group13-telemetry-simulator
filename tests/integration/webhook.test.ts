import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type BuiltApp } from "../../src/app.js";
import { validateEvent } from "../../src/contracts/validation.js";
import { TEST_API_KEY, silentLogger, testConfig, waitFor } from "../helpers/index.js";

interface Received {
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

let receiver: Server | null = null;
let built: BuiltApp | null = null;

/** A stand-in for Team A's n8n webhook, over real HTTP. */
async function startReceiver(statusFor: (n: number) => number = () => 200) {
  const received: Received[] = [];
  let n = 0;
  receiver = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      received.push({ headers: req.headers, body: JSON.parse(data) });
      res.writeHead(statusFor(n++)).end("{}");
    });
  });
  await new Promise<void>((r) => receiver!.listen(0, "127.0.0.1", r));
  const { port } = receiver.address() as AddressInfo;
  return { received, url: `http://127.0.0.1:${port}/webhook/telemetry` };
}

afterEach(async () => {
  if (built) {
    await built.engine.shutdown(200);
    await built.app.close();
    built = null;
  }
  if (receiver) {
    receiver.closeAllConnections();
    await new Promise((r) => receiver!.close(r));
    receiver = null;
  }
});

async function startSimulator(webhookUrl: string) {
  built = await buildApp({
    config: testConfig({ N8N_WEBHOOK_URL: webhookUrl }),
    logger: silentLogger,
    tickIntervalMs: 2,
  });
  await built.app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = built.app.server.address() as AddressInfo;
  return { ...built, base: `http://127.0.0.1:${port}` };
}

async function control(base: string, path: string, body?: object) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("end to end over HTTP", () => {
  it("delivers a full valid match to the webhook with the shared token", async () => {
    const { received, url } = await startReceiver();
    const { base, engine } = await startSimulator(url);

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);

    const start = await control(base, "/api/v1/runs", {
      scenario: "combined",
      seed: 13027,
      duration_seconds: 60,
      anomaly_start_second: 20,
      odds_anomaly_start_second: 35,
    });
    expect(start.status).toBe(201);
    await waitFor(() => engine.state === "completed", 10_000);
    await waitFor(() => engine.status().events_pending === 0, 10_000);

    const status = (await (await fetch(`${base}/api/v1/status`)).json()) as Record<string, number>;
    expect(received).toHaveLength(status.events_generated!);
    expect(status.events_delivered).toBe(status.events_generated);

    for (const r of received) {
      expect(r.headers["content-type"]).toBe("application/json");
      expect(r.headers["x-simulator-token"]).toBe("test-webhook-token");
      expect(validateEvent(r.body).success).toBe(true);
    }
    const types = new Set(received.map((r) => r.body.event_type));
    for (const t of [
      "match_started",
      "round_started",
      "player_action",
      "combat_event",
      "player_snapshot",
      "odds_update",
      "round_ended",
      "match_ended",
    ]) {
      expect(types).toContain(t);
    }
    const seqs = received.map((r) => r.body.sequence_number as number).sort((a, b) => a - b);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("retries after a temporary webhook failure and keeps the event ID", async () => {
    const { received, url } = await startReceiver((n) => (n === 0 ? 503 : 200));
    const { base } = await startSimulator(url);
    const res = await control(base, "/api/v1/test-event");
    // The test endpoint makes one attempt so the result is immediate.
    expect(res.json.delivery).toMatchObject({ ok: false, status: 503, retryable: true });

    const { engine } = built!;
    await control(base, "/api/v1/runs", { scenario: "normal", duration_seconds: 10 });
    await waitFor(
      () => engine.state === "completed" && engine.status().events_pending === 0,
      10_000,
    );
    expect(engine.status().events_failed).toBe(0);
    expect(received.length).toBeGreaterThan(1);
  });

  it("replays an identical demo sequence", async () => {
    const { received, url } = await startReceiver();
    const { base, engine } = await startSimulator(url);

    const first = await control(base, "/api/v1/runs", {
      preset: "final_demo",
      duration_seconds: 60,
      anomaly_start_second: 20,
      odds_anomaly_start_second: 35,
    });
    await waitFor(
      () => engine.state === "completed" && engine.status().events_pending === 0,
      10_000,
    );
    const firstRun = received.filter((r) => r.body.simulator_run_id === first.json.run_id);

    await control(base, `/api/v1/runs/${first.json.run_id as string}/reset`);
    const replay = await control(base, `/api/v1/runs/${first.json.run_id as string}/replay`);
    await waitFor(
      () => engine.state === "completed" && engine.status().events_pending === 0,
      10_000,
    );
    const secondRun = received.filter((r) => r.body.simulator_run_id === replay.json.run_id);

    const content = (rs: Received[]) =>
      rs
        .map((r) => r.body)
        .sort((a, b) => (a.sequence_number as number) - (b.sequence_number as number))
        .map((b) => [
          b.event_type,
          b.player_id,
          JSON.stringify(b.metrics),
          (b.odds as { team_blue?: number }).team_blue,
        ]);
    expect(secondRun.length).toBe(firstRun.length);
    expect(content(secondRun)).toEqual(content(firstRun));
    // Every event ID is new, so downstream deduplication keeps both runs.
    const firstIds = new Set(firstRun.map((r) => r.body.event_id));
    expect(secondRun.some((r) => firstIds.has(r.body.event_id))).toBe(false);
  });
});
